/**
 * createTestApp — main entry point for the VeloJS testing toolkit.
 *
 * Builds an in-memory Hono app from your `routes` import, isolates side effects
 * via AsyncLocalStorage so multiple test apps coexist, and exposes a
 * FastAPI-TestClient-style API on top.
 */

import type { EventStream } from "../events.js";
import { getRegisteredStreams } from "../events.js";
import { abortAllSocketSessions, injectWebSocketServer } from "../sockets.js";
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
 *
 * Pass `port` to also serve the same app over real TCP — for external actors
 * (a worker in another process) that cannot call `hono.fetch` in-memory:
 *
 * ```typescript
 * const app = await createTestApp({ routes, port: 0 });
 * await handToWorker(`${app.url}/_action/Jobs/notify`);
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

        // Optional TCP listener, created before returning so `app.port` is the
        // real bound port and no external request can race the bind.
        const tcp = opts.port !== undefined
            ? await startTcpListener(hono, opts.port, opts.hostname)
            : undefined;

        return buildTestAppApi(hono, ctx, conventions, opts, undefined, tcp);
    });
}

// ============================================
// TCP LISTENER — optional real-socket mode
// ============================================

interface TcpListener {
    /** Real bound port (`port: 0` asks the kernel for a free one). */
    readonly port: number;
    /** Base URL a client in this process can dial. */
    readonly url: string;
    /** Stop the listener and drop every connection still open on it. */
    close(): Promise<void>;
}

/**
 * Serves `hono` over real TCP — the testing twin of `startServer`'s production
 * path: same `serve({ fetch, port, hostname })`, same `'listening'` wait, same
 * WebSocket injection and `onServer` flush. No static/SSR-for-`dist` branch:
 * the listener must serve the app exactly as the in-memory path does.
 *
 * Runs inside the isolated context, so `onServer()` callbacks registered in
 * `bootstrap` land on this server (parity with `startServer`).
 */
async function startTcpListener(
    hono: import("hono").Hono,
    port: number,
    hostname: string | undefined
): Promise<TcpListener> {
    const { serve } = await import("@hono/node-server");
    const { flushServerCallbacks, clearActiveServer } = await import("../server.js");

    const server = serve({
        fetch: hono.fetch,
        port,
        ...(hostname ? { hostname } : {}),
    }) as unknown as import("http").Server;

    // Track raw sockets from the start: `close()` must be able to drop them.
    // The `upgrade` path detaches the socket from the HTTP server's own
    // connection list, so `closeAllConnections()` alone leaves WebSockets
    // behind and the teardown hangs.
    const sockets = new Set<import("node:net").Socket>();
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });

    await waitForListening(server, port, hostname);

    // Same wire-up as the production path: `upgrade` requests route through the
    // app's registered `socket_*` handlers, and callbacks registered with
    // `onServer()` receive the real server.
    await injectWebSocketServer(hono, server);
    flushServerCallbacks(server);

    const address = server.address();
    const boundPort = address && typeof address === "object" ? address.port : port;
    // Wildcard hostnames are not dialable — hand out a usable address; a test
    // that needs the exact interface composes it from `app.port`.
    const urlHost = hostname && hostname !== "0.0.0.0" && hostname !== "::"
        ? hostname
        : "localhost";

    let stopped = false;
    return {
        port: boundPort,
        url: `http://${urlHost}:${boundPort}`,
        async close() {
            // Idempotent: a second close() resolves instead of rejecting with
            // ERR_SERVER_NOT_RUNNING.
            if (stopped) return;
            stopped = true;

            // close() only refuses NEW connections; the callback waits for the
            // sockets still open (keep-alive, SSE, WebSocket) and would never
            // fire with a stream in progress. Drop them, then wait.
            const closed = new Promise<void>((resolve) => {
                server.close(() => resolve());
            });
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            server.closeAllConnections();
            await closed;

            // Parity with `startServer`'s `server.once("close", …)`: a late
            // `onServer()` registrant must queue for the next server instead of
            // receiving this dead instance.
            clearActiveServer(server);
        },
    };
}

/**
 * `serve()` returns before `listen()` completes, so the socket may not be
 * bound yet and a failed bind would only surface later. Waits for
 * `'listening'` — or for `'error'`, so `EADDRINUSE` rejects `createTestApp`
 * with the port and hostname in the message instead of hanging until the
 * first request.
 */
function waitForListening(
    server: import("http").Server,
    port: number,
    hostname: string | undefined
): Promise<void> {
    if (server.listening) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
        const target = `${hostname ?? "0.0.0.0"}:${port}`;
        const cleanup = () => {
            server.off("listening", onListening);
            server.off("error", onError);
        };
        const onListening = () => {
            cleanup();
            resolve();
        };
        const onError = (err: NodeJS.ErrnoException) => {
            cleanup();
            const detail = err.code ? `${err.code}: ${err.message}` : err.message;
            reject(new Error(
                `[velojs/testing] could not bind the test server on ${target} — ${detail}`
            ));
        };
        server.once("listening", onListening);
        server.once("error", onError);
    });
}

function buildTestAppApi(
    hono: import("hono").Hono,
    ctx: AppContext,
    conventions: ConventionRegistry,
    opts: CreateTestAppOptions,
    boundCookies: Cookies | undefined,
    tcp: TcpListener | undefined
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
        // `undefined` unless `port` was passed — no listener, no behavior change.
        port: tcp?.port,
        url: tcp?.url,

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
                port: api.port,
                url: api.url,
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
            // Then the TCP listener, if any: it drops the connections still
            // open on it (SSE, WebSocket) so close() resolves promptly even
            // mid-stream, and releases the global activeServer.
            await tcp?.close();
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
