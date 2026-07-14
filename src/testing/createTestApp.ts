/**
 * createTestApp — main entry point for the VeloJS testing toolkit.
 *
 * Builds an in-memory Hono app from your `routes` import, isolates side effects
 * via AsyncLocalStorage so multiple test apps coexist, and exposes a
 * FastAPI-TestClient-style API on top.
 */

import type { EventStream } from "../events.js";
import { getRegisteredStreams } from "../events.js";
import { abortAllSocketSessions } from "../sockets.js";
import {
    createIsolatedContext,
    withAppContext,
    type AppContext,
} from "../app-context.js";
import type {
    TestApp,
    TestResponse,
    Cookies,
    RequestOptions,
    BodyRequestOptions,
    LoaderRequestOptions,
    SubscribeOptions,
    MockContextOptions,
    CreateTestAppOptions,
    TestSubscription,
    TestSocketSession,
    SocketTestOptions,
} from "./types.js";
import type { SocketHandler, SocketStub } from "../sockets.js";
import { buildSocketSession } from "./socketSession.js";
import {
    serializeCookies,
    parseSetCookies,
    encodeBody,
    fromHeaders,
    buildUrl,
} from "./internal.js";
import {
    buildConventionRegistry,
    resolveActionUrl,
    resolveLoaderPath,
    type ConventionRegistry,
} from "./conventions.js";
import { buildSubscription } from "./subscription.js";
import { buildMockContext } from "./mockContext.js";

/**
 * Creates an isolated test app from your routes.
 *
 * ```typescript
 * import { createTestApp } from "@mauroandre/velojs/testing";
 * import routes from "../app/routes.js";
 *
 * const app = await createTestApp({
 *     routes,
 *     bootstrap: async () => { await connectDb(); },
 *     getSessionCookie: async ({ user }) => ({ session: await sign(user) }),
 * });
 * ```
 */
export async function createTestApp(opts: CreateTestAppOptions): Promise<TestApp> {
    const ctx = createIsolatedContext();

    return await withAppContext(ctx, async () => {
        // Run user bootstrap so any addRoutes/onServer/createEventStream
        // calls land in this isolated context.
        if (opts.bootstrap) await opts.bootstrap();

        // Build the actual Hono app
        const { createApp } = await import("../server.js");
        const hono = await createApp(opts.routes);

        const conventions = buildConventionRegistry(opts.routes);

        return buildTestAppApi(hono, ctx, conventions, opts, undefined);
    });
}

function buildTestAppApi(
    hono: import("hono").Hono,
    ctx: AppContext,
    conventions: ConventionRegistry,
    opts: CreateTestAppOptions,
    boundCookies: Cookies | undefined
): TestApp {
    async function rawRequest(
        method: string,
        path: string,
        reqOpts: BodyRequestOptions = {}
    ): Promise<TestResponse> {
        const url = buildUrl(path, reqOpts.query);
        const headers = new Headers(reqOpts.headers ?? {});

        // Merge bound cookies (from .as) with explicit cookies
        const merged = { ...(boundCookies ?? {}), ...(reqOpts.cookies ?? {}) };
        const cookieHeader = serializeCookies(merged);
        if (cookieHeader) headers.set("cookie", cookieHeader);

        let bodyInit: BodyInit | null = null;
        if (reqOpts.body !== undefined) {
            const enc = encodeBody(reqOpts.body);
            bodyInit = enc.body;
            if (enc.contentType && !headers.has("content-type")) {
                headers.set("content-type", enc.contentType);
            }
        }

        const init: RequestInit = { method, headers };
        if (bodyInit !== null) init.body = bodyInit;

        const request = new Request(url, init);
        const response = await hono.fetch(request);

        return await wrapResponse(response);
    }

    async function streamingRequest(
        method: string,
        path: string,
        reqOpts: SubscribeOptions = {}
    ): Promise<Response> {
        const url = buildUrl(path, {
            ...(reqOpts.query ?? {}),
            ...(reqOpts.channel ? { channel: reqOpts.channel } : {}),
        });
        const headers = new Headers(reqOpts.headers ?? {});
        const merged = { ...(boundCookies ?? {}), ...(reqOpts.cookies ?? {}) };
        const cookieHeader = serializeCookies(merged);
        if (cookieHeader) headers.set("cookie", cookieHeader);

        const request = new Request(url, { method, headers });
        return await hono.fetch(request);
    }

    const api: TestApp = {
        hono,

        // HTTP
        get: (path, o) => rawRequest("GET", path, o ?? {}),
        post: (path, o) => rawRequest("POST", path, o ?? {}),
        put: (path, o) => rawRequest("PUT", path, o ?? {}),
        patch: (path, o) => rawRequest("PATCH", path, o ?? {}),
        delete: (path, o) => rawRequest("DELETE", path, o ?? {}),

        async action(fn, o = {}) {
            const url = resolveActionUrl(conventions, fn);
            return await rawRequest("POST", url, {
                ...o,
                body: o.body ?? {},
            });
        },

        async loader(fn, o = {}) {
            const path = resolveLoaderPath(conventions, fn, (o as LoaderRequestOptions).params);
            const res = await rawRequest("GET", path, {
                ...o,
                query: { ...(o.query ?? {}), _data: "1" },
            });
            // Redirect or non-200 → return TestResponse
            if (res.status >= 300 && res.status < 400) return res;
            if (res.status >= 400) return res;
            // Loader's data is in the JSON response under metadata.moduleId
            const moduleId = typeof fn === "function"
                ? conventions.loaders.get(fn)?.moduleId
                : undefined;
            const json: any = await res.json();
            if (moduleId && json && typeof json === "object" && moduleId in json) {
                return json[moduleId];
            }
            return json;
        },

        async subscribe<TEvent = any, TSnapshot = any>(
            stream: EventStream<TEvent, TSnapshot> | string,
            o: SubscribeOptions = {}
        ): Promise<TestSubscription<TEvent, TSnapshot>> {
            const path = typeof stream === "string"
                ? stream
                : (stream.__path ?? throwNoStreamPath(stream));
            const response = await streamingRequest("GET", path, o);
            return await buildSubscription<TEvent, TSnapshot>({ response });
        },

        async socket(
            handlerInput: SocketHandler | SocketStub | { __path: string } | string,
            o: SocketTestOptions = {}
        ): Promise<TestSocketSession> {
            return await buildSocketSession(hono, handlerInput as any, o);
        },

        async sessionCookies({ user }) {
            if (!opts.getSessionCookie) {
                throw new Error(
                    "[velojs/testing] sessionCookies/as requires `getSessionCookie` " +
                    "in createTestApp options."
                );
            }
            return await opts.getSessionCookie({ user });
        },

        as({ user }) {
            if (!opts.getSessionCookie) {
                throw new Error(
                    "[velojs/testing] app.as() requires `getSessionCookie` in createTestApp options."
                );
            }
            // Return a sub-app whose requests carry these cookies automatically.
            // We resolve cookies eagerly on every request via a closure.
            let resolvedPromise: Promise<Cookies> | null = null;
            const getCookies = () => {
                if (!resolvedPromise) {
                    resolvedPromise = Promise.resolve(opts.getSessionCookie!({ user }));
                }
                return resolvedPromise;
            };

            // Build a new TestApp with bound cookies. Since cookies are async,
            // we create a wrapper that resolves before each request.
            const wrap = <T extends (...args: any[]) => Promise<any>>(method: T): T => {
                return (async (...args: any[]) => {
                    const cookies = await getCookies();
                    // Call the underlying method with cookies merged into the options.
                    // The first arg is path/fn/stream; second is opts.
                    const [first, second] = args;
                    const merged = {
                        ...(second ?? {}),
                        cookies: { ...cookies, ...(second?.cookies ?? {}) },
                    };
                    return await (method as any).call(api, first, merged);
                }) as unknown as T;
            };

            const sub: TestApp = {
                hono,
                get: wrap(api.get),
                post: wrap(api.post),
                put: wrap(api.put),
                patch: wrap(api.patch),
                delete: wrap(api.delete),
                action: wrap(api.action),
                loader: wrap(api.loader),
                subscribe: wrap(api.subscribe),
                socket: wrap(api.socket),
                sessionCookies: api.sessionCookies,
                as: api.as, // chaining .as.as works — last wins
                mockContext: api.mockContext,
                reset: api.reset,
                close: api.close,
            };
            return sub;
        },

        mockContext(o: MockContextOptions = {}) {
            return buildMockContext(o);
        },

        async reset() {
            // Reset every event stream registered in the registry
            for (const stream of getRegisteredStreams()) {
                try {
                    stream.__reset();
                } catch (err) {
                    console.error("[velojs/testing] stream.__reset failed:", err);
                }
            }
        },

        async close() {
            // Reset streams (also aborts active sources / heartbeats per stream)
            await api.reset();
            // Abort any open socket sessions on this app
            abortAllSocketSessions(hono);
            // Run any disposers registered with the context
            for (const dispose of ctx.disposers) {
                try { dispose(); } catch (err) {
                    console.error("[velojs/testing] disposer failed:", err);
                }
            }
            ctx.disposers.clear();
        },
    };

    return api;
}

async function wrapResponse(response: Response): Promise<TestResponse> {
    return {
        status: response.status,
        headers: fromHeaders(response.headers),
        cookies: parseSetCookies(response.headers),
        json: <T = any>() => response.clone().json() as Promise<T>,
        text: () => response.clone().text(),
        blob: () => response.clone().blob(),
        raw: response,
    };
}

function throwNoStreamPath(stream: EventStream<any, any>): never {
    void stream;
    throw new Error(
        "[velojs/testing] subscribe(stream) — stream has no __path. " +
        "If this is a stream_* declaration, make sure your routes import is processed " +
        "by the VeloJS Vite plugin (your vitest.config.ts must include `veloPlugin()`)."
    );
}
