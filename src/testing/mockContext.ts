/**
 * Escape hatch — build a partial Hono Context for direct invocation of
 * actions / loaders / jobs without going through HTTP.
 *
 * Middlewares do NOT run. This is intentional — pass `c.set("user", ...)` etc
 * via the `user` option if your handler reads from `c.get("user")`.
 */

import type { Context } from "hono";
import type { MockContextOptions } from "./types.js";
import { TEST_BASE_URL, buildQueryString, serializeCookies } from "./internal.js";

export function buildMockContext(opts: MockContextOptions = {}): Context {
    const { user, params = {}, query = {}, body, headers = {}, cookies } = opts;

    const cookieHeader = serializeCookies(cookies);
    const finalHeaders = new Headers(headers);
    if (cookieHeader && !finalHeaders.has("cookie")) {
        finalHeaders.set("cookie", cookieHeader);
    }

    const url = TEST_BASE_URL + "/_mock" + buildQueryString(query);

    const reqInit: RequestInit = {
        method: body == null ? "GET" : "POST",
        headers: finalHeaders,
    };
    if (body != null) {
        if (typeof body === "string" || body instanceof FormData || body instanceof Blob) {
            reqInit.body = body as BodyInit;
        } else {
            reqInit.body = JSON.stringify(body);
            if (!finalHeaders.has("content-type")) {
                finalHeaders.set("content-type", "application/json");
            }
        }
    }

    const request = new Request(url, reqInit);

    // Backing storage for c.set / c.get
    const store = new Map<string | symbol, unknown>();
    if (user !== undefined) store.set("user", user);

    // Build a minimal Context shape — enough for typical handlers
    const c: any = {
        req: {
            raw: request,
            url: request.url,
            method: request.method,
            param(name?: string) {
                return name === undefined ? params : params[name];
            },
            query(name?: string) {
                if (name === undefined) {
                    const out: Record<string, string> = {};
                    for (const [k, v] of Object.entries(query)) {
                        out[k] = String(v);
                    }
                    return out;
                }
                return query[name];
            },
            queries(name: string) {
                const v = query[name];
                if (v === undefined) return undefined;
                return Array.isArray(v) ? v : [v];
            },
            header(name?: string) {
                if (name === undefined) {
                    const out: Record<string, string> = {};
                    finalHeaders.forEach((v, k) => { out[k] = v; });
                    return out;
                }
                return finalHeaders.get(name) ?? undefined;
            },
            async json() {
                if (body == null) return null;
                if (typeof body === "object") return body;
                return JSON.parse(String(body));
            },
            async text() {
                if (body == null) return "";
                return typeof body === "string" ? body : JSON.stringify(body);
            },
            async parseBody() {
                return body ?? {};
            },
            path: "/_mock",
        },
        res: undefined as unknown as Response,
        env: {},
        finalized: false,
        get(key: string) {
            return store.get(key);
        },
        set(key: string, value: unknown) {
            store.set(key, value);
        },
        var: new Proxy({}, {
            get(_t, prop) {
                return store.get(prop as string);
            },
        }),
        json(data: unknown, status = 200) {
            return new Response(JSON.stringify(data), {
                status,
                headers: { "content-type": "application/json" },
            });
        },
        text(data: string, status = 200) {
            return new Response(data, { status });
        },
        html(data: string, status = 200) {
            return new Response(data, {
                status,
                headers: { "content-type": "text/html; charset=UTF-8" },
            });
        },
        body(data: BodyInit | null, status = 200) {
            return new Response(data, { status });
        },
        redirect(location: string, status = 302) {
            return new Response(null, { status, headers: { location } });
        },
        header(name: string, value: string) {
            // No-op for mock — would mutate response headers in real Hono
            void name; void value;
        },
        status(_status: number) {
            // No-op for mock
        },
    };

    return c as Context;
}
