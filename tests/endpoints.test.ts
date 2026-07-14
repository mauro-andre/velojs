import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestApp } from "../src/testing/index.js";
import type {
    AppRoutes,
    RouteModule,
    EndpointHandler,
} from "../src/types.js";

function makeModule(opts: {
    moduleId: string;
    fullPath?: string;
    loader?: (args: any) => any;
}): RouteModule {
    const mod: any = {
        Component: () => null,
        metadata: {
            moduleId: opts.moduleId,
            fullPath: opts.fullPath,
            path: opts.fullPath,
        },
    };
    if (opts.loader) mod.loader = opts.loader;
    return mod as RouteModule;
}

// ============================================
// EndpointRoute — basic HTTP
// ============================================

describe("EndpointRoute — basic HTTP", () => {
    it("registers a GET endpoint", async () => {
        const routes: AppRoutes = [
            {
                path: "/health",
                method: "GET",
                handler: ({ c }) => c.text("ok"),
            },
        ];
        const app = await createTestApp({ routes });
        const res = await app.get("/health");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("ok");
        await app.close();
    });

    it("registers a POST endpoint and reads JSON body via c.req.json()", async () => {
        const routes: AppRoutes = [
            {
                path: "/api/echo",
                method: "POST",
                handler: async ({ c }) => {
                    const body = await c.req.json();
                    return c.json({ received: body });
                },
            },
        ];
        const app = await createTestApp({ routes });
        const res = await app.post("/api/echo", { body: { hello: "world" } });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ received: { hello: "world" } });
        await app.close();
    });

    it("supports PUT/PATCH/DELETE", async () => {
        const handler: EndpointHandler = ({ c }) => c.json({ method: c.req.method });
        const routes: AppRoutes = [
            { path: "/put", method: "PUT", handler },
            { path: "/patch", method: "PATCH", handler },
            { path: "/del", method: "DELETE", handler },
        ];
        const app = await createTestApp({ routes });
        expect((await (await app.put("/put")).json()).method).toBe("PUT");
        expect((await (await app.patch("/patch")).json()).method).toBe("PATCH");
        expect((await (await app.delete("/del")).json()).method).toBe("DELETE");
        await app.close();
    });

    it("exposes params from path matches", async () => {
        const routes: AppRoutes = [
            {
                path: "/api/verify/:token",
                method: "GET",
                handler: ({ c, params }) => c.json({ token: params.token }),
            },
        ];
        const app = await createTestApp({ routes });
        const res = await app.get("/api/verify/abc123");
        expect(await res.json()).toEqual({ token: "abc123" });
        await app.close();
    });

    it("exposes query params", async () => {
        const routes: AppRoutes = [
            {
                path: "/search",
                method: "GET",
                handler: ({ c, query }) => c.json({ q: query.q ?? null }),
            },
        ];
        const app = await createTestApp({ routes });
        const res = await app.get("/search", { query: { q: "velojs" } });
        expect(await res.json()).toEqual({ q: "velojs" });
        await app.close();
    });

    it("supports handler returning a redirect Response", async () => {
        const routes: AppRoutes = [
            {
                path: "/old",
                method: "GET",
                handler: ({ c }) => c.redirect("/new", 302),
            },
        ];
        const app = await createTestApp({ routes });
        const res = await app.get("/old");
        expect(res.status).toBe(302);
        expect(res.headers["location"]).toBe("/new");
        await app.close();
    });
});

// ============================================
// EndpointRoute — middleware inheritance
// ============================================

describe("EndpointRoute — middleware inheritance", () => {
    it("inherits parent middlewares", async () => {
        const calls: string[] = [];
        const parentMw = async (_c: any, next: () => Promise<void>) => {
            calls.push("parent");
            await next();
        };

        const routes: AppRoutes = [
            {
                path: "/api",
                middlewares: [parentMw],
                children: [
                    {
                        path: "/ping",
                        method: "GET",
                        handler: ({ c }) => c.text("pong"),
                    },
                ],
            },
        ];

        const app = await createTestApp({ routes });
        const res = await app.get("/api/ping");
        expect(await res.text()).toBe("pong");
        expect(calls).toEqual(["parent"]);
        await app.close();
    });

    it("composes parent + endpoint-own middlewares in order", async () => {
        const calls: string[] = [];
        const parentMw = async (_c: any, next: () => Promise<void>) => {
            calls.push("parent");
            await next();
        };
        const ownMw = async (_c: any, next: () => Promise<void>) => {
            calls.push("own");
            await next();
        };

        const routes: AppRoutes = [
            {
                path: "/api",
                middlewares: [parentMw],
                children: [
                    {
                        path: "/ping",
                        method: "GET",
                        middlewares: [ownMw],
                        handler: ({ c }) => c.text("pong"),
                    },
                ],
            },
        ];

        const app = await createTestApp({ routes });
        await app.get("/api/ping");
        expect(calls).toEqual(["parent", "own"]);
        await app.close();
    });

    it("middleware can short-circuit with a response", async () => {
        const authMw = async (c: any, _next: () => Promise<void>) => {
            return c.json({ error: "unauthorized" }, 401);
        };

        const routes: AppRoutes = [
            {
                path: "/api",
                middlewares: [authMw],
                children: [
                    {
                        path: "/secret",
                        method: "GET",
                        handler: ({ c }) => c.text("top secret"),
                    },
                ],
            },
        ];

        const app = await createTestApp({ routes });
        const res = await app.get("/api/secret");
        expect(res.status).toBe(401);
        await app.close();
    });
});

// ============================================
// EndpointRoute — coexistence with pages
// ============================================

describe("EndpointRoute — coexistence with pages", () => {
    it("page GET coexists with endpoint POST on the same path", async () => {
        const foo = makeModule({
            moduleId: "pages/Foo",
            fullPath: "/foo",
            loader: async () => ({ from: "loader" }),
        });

        const routes: AppRoutes = [
            { path: "/foo", module: foo },
            {
                path: "/foo",
                method: "POST",
                handler: async ({ c }) => {
                    const body = await c.req.json();
                    return c.json({ from: "endpoint", body });
                },
            },
        ];

        const app = await createTestApp({ routes });

        // Page GET hits the loader (via _data=1 it returns JSON of loader data)
        const pageRes = await app.get("/foo", { query: { _data: "1" } });
        expect(pageRes.status).toBe(200);
        const pageJson: any = await pageRes.json();
        expect(pageJson["pages/Foo"]).toEqual({ from: "loader" });

        // Endpoint POST hits the handler
        const post = await app.post("/foo", { body: { v: 1 } });
        expect(post.status).toBe(200);
        expect(await post.json()).toEqual({
            from: "endpoint",
            body: { v: 1 },
        });

        await app.close();
    });

    it("endpoint-only tree (no pages) works", async () => {
        const routes: AppRoutes = [
            {
                path: "/ping",
                method: "GET",
                handler: ({ c }) => c.text("pong"),
            },
        ];
        const app = await createTestApp({ routes });
        const res = await app.get("/ping");
        expect(await res.text()).toBe("pong");
        await app.close();
    });
});

// ============================================
// EndpointRoute — validation warns
// ============================================

describe("EndpointRoute — validation warns", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
        warnSpy.mockRestore();
    });

    it("warns and skips when handler has no method", async () => {
        // `method` and `handler` are both optional on RouteNode — declaring one
        // without the other is exactly the mistake under test, so it needs no
        // cast to express.
        const routes: AppRoutes = [
            {
                path: "/bad",
                handler: ({ c }) => c.text("never"),
            },
        ];
        const app = await createTestApp({ routes });
        const res = await app.get("/bad");
        expect(res.status).toBe(404);
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining(`"handler" set without "method"`)
        );
        await app.close();
    });

    it("warns and skips when method has no handler", async () => {
        const routes: AppRoutes = [
            { path: "/bad", method: "GET" },
        ];
        const app = await createTestApp({ routes });
        const res = await app.get("/bad");
        expect(res.status).toBe(404);
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining(`"method" set without "handler"`)
        );
        await app.close();
    });

    it("warns when both module and handler are set (endpoint ignored)", async () => {
        const page = makeModule({ moduleId: "pages/X", fullPath: "/x" });
        const routes: AppRoutes = [
            {
                path: "/x",
                module: page,
                method: "POST",
                handler: ({ c }) => c.text("ignored"),
            },
        ];
        const app = await createTestApp({ routes });
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining(`both "module" and "handler" set`)
        );
        // Endpoint is NOT registered
        const res = await app.post("/x", { body: {} });
        expect(res.status).toBe(404);
        await app.close();
    });

    it("warns when endpoint GET conflicts with a page GET, and the PAGE wins", async () => {
        // Pages register before endpoints (createApp), and the page handler
        // returns a Response without calling next(), so Hono stops there. The
        // page has to win: it also serves `?_data=1`, the JSON every SPA
        // navigation fetches. An endpoint taking the path over would silently
        // make the page unnavigable client-side.
        const page = makeModule({ moduleId: "pages/Dup", fullPath: "/dup" });
        (page as any).Component = () => "PAGE-HTML";
        const routes: AppRoutes = [
            { path: "/dup", module: page },
            {
                path: "/dup",
                method: "GET",
                handler: ({ c }) => c.text("ENDPOINT"),
            },
        ];
        const app = await createTestApp({ routes });

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining(`has both a page GET and an endpoint GET`)
        );
        // The warning must name the actual winner, not the opposite.
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining(`the page wins`)
        );

        const res = await app.get("/dup");
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain("PAGE-HTML");
        expect(body).not.toContain("ENDPOINT");

        await app.close();
    });
});
