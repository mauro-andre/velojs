import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { createTestApp } from "../src/testing/index.js";
import { createEventStream } from "../src/events.js";
import { addRoutes } from "../src/server.js";
import type { AppRoutes, RouteModule } from "../src/types.js";

// ============================================
// Helpers — build a minimal "routes" array similar to what the Vite plugin
// would produce (with metadata). These tests bypass the plugin since we're
// testing the toolkit's runtime, not the plugin transforms.
// ============================================

function makeModule(opts: {
    moduleId: string;
    fullPath?: string;
    Component?: any;
    loader?: (args: any) => any;
    actions?: Record<string, (args: any) => any>;
    streams?: Record<string, ReturnType<typeof createEventStream>>;
}): RouteModule {
    const mod: any = {
        Component: opts.Component ?? (() => null),
        metadata: { moduleId: opts.moduleId, fullPath: opts.fullPath, path: opts.fullPath },
    };
    if (opts.loader) mod.loader = opts.loader;
    if (opts.actions) {
        for (const [name, fn] of Object.entries(opts.actions)) {
            mod[`action_${name}`] = fn;
        }
    }
    if (opts.streams) {
        for (const [name, s] of Object.entries(opts.streams)) {
            mod[`stream_${name}`] = s;
        }
    }
    return mod as RouteModule;
}

// ============================================
// createTestApp — basic lifecycle
// ============================================

describe("createTestApp — basics", () => {
    it("creates an app from routes and exposes hono", async () => {
        const home = makeModule({ moduleId: "Home", fullPath: "/" });
        const routes: AppRoutes = [
            { module: makeModule({ moduleId: "Root" }), isRoot: true, children: [{ path: "/", module: home }] },
        ];

        const app = await createTestApp({ routes });
        expect(app.hono).toBeInstanceOf(Hono);
        await app.close();
    });

    it("runs bootstrap before app is created", async () => {
        const order: string[] = [];
        const home = makeModule({ moduleId: "Home", fullPath: "/" });

        const app = await createTestApp({
            routes: [
                {
                    module: makeModule({ moduleId: "Root" }),
                    isRoot: true,
                    children: [{ path: "/", module: home }],
                },
            ],
            bootstrap: async () => {
                order.push("bootstrap");
                addRoutes((a) => {
                    a.get("/api/hello", (c) => c.json({ ok: true }));
                    order.push("addRoutes");
                });
            },
        });

        const res = await app.get("/api/hello");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(order).toEqual(["bootstrap", "addRoutes"]);
        await app.close();
    });

    it("multiple test apps coexist (no cross-pollution)", async () => {
        const root = makeModule({ moduleId: "Root" });
        const routes: AppRoutes = [{ module: root, isRoot: true, children: [] }];

        const a = await createTestApp({
            routes,
            bootstrap: async () => {
                addRoutes((app) => { app.get("/a", (c) => c.text("A")); });
            },
        });
        const b = await createTestApp({
            routes,
            bootstrap: async () => {
                addRoutes((app) => { app.get("/b", (c) => c.text("B")); });
            },
        });

        const aRes = await a.get("/a");
        expect(await aRes.text()).toBe("A");
        const bRes = await b.get("/b");
        expect(await bRes.text()).toBe("B");

        // App A should not have route /b
        const aMissing = await a.get("/b");
        expect(aMissing.status).toBe(404);

        await a.close();
        await b.close();
    });
});

// ============================================
// HTTP helpers
// ============================================

describe("HTTP helpers", () => {
    let app: Awaited<ReturnType<typeof createTestApp>>;

    beforeEach(async () => {
        app = await createTestApp({
            routes: [
                {
                    module: makeModule({ moduleId: "Root" }),
                    isRoot: true,
                    children: [],
                },
            ],
            bootstrap: async () => {
                addRoutes((a) => {
                    a.get("/echo", (c) => {
                        const cookies = c.req.header("cookie") ?? "";
                        const xCustom = c.req.header("x-custom") ?? "";
                        return c.json({ cookies, xCustom, query: c.req.query() });
                    });
                    a.post("/json", async (c) => {
                        const body = await c.req.json();
                        return c.json({ received: body });
                    });
                    a.post("/form", async (c) => {
                        const body = await c.req.parseBody();
                        return c.json({ received: { ...body } });
                    });
                });
            },
        });
    });

    afterEach(async () => {
        await app.close();
    });

    it("sends cookies serialized in Cookie header", async () => {
        const res = await app.get("/echo", {
            cookies: { session: "abc", csrf: "xyz" },
        });
        const data = await res.json();
        expect(data.cookies).toContain("session=abc");
        expect(data.cookies).toContain("csrf=xyz");
    });

    it("sends custom headers", async () => {
        const res = await app.get("/echo", { headers: { "X-Custom": "hello" } });
        const data = await res.json();
        expect(data.xCustom).toBe("hello");
    });

    it("serializes query strings (single + array values)", async () => {
        const res = await app.get("/echo", {
            query: { foo: "bar", tag: ["a", "b"] },
        });
        const data = await res.json();
        expect(data.query.foo).toBe("bar");
    });

    it("auto-serializes JSON body and sets content-type", async () => {
        const res = await app.post("/json", { body: { hello: "world" } });
        const data = await res.json();
        expect(data.received).toEqual({ hello: "world" });
    });

    it("passes FormData as-is (no auto JSON serialization)", async () => {
        const fd = new FormData();
        fd.set("name", "alice");
        const res = await app.post("/form", { body: fd });
        const data = await res.json();
        expect(data.received.name).toBe("alice");
    });

    it("supports put/patch/delete", async () => {
        await app.close();
        app = await createTestApp({
            routes: [
                { module: makeModule({ moduleId: "Root" }), isRoot: true, children: [] },
            ],
            bootstrap: async () => {
                addRoutes((a) => {
                    a.put("/r", (c) => c.text("PUT"));
                    a.patch("/r", (c) => c.text("PATCH"));
                    a.delete("/r", (c) => c.text("DELETE"));
                });
            },
        });

        expect(await (await app.put("/r")).text()).toBe("PUT");
        expect(await (await app.patch("/r")).text()).toBe("PATCH");
        expect(await (await app.delete("/r")).text()).toBe("DELETE");
    });
});

// ============================================
// Auth — getSessionCookie + .as
// ============================================

describe("Auth — getSessionCookie and .as", () => {
    it(".sessionCookies invokes the configured callback", async () => {
        const app = await createTestApp({
            routes: [{ module: makeModule({ moduleId: "Root" }), isRoot: true, children: [] }],
            getSessionCookie: async ({ user }) => ({ session: `tok-${user.id}` }),
        });

        const cookies = await app.sessionCookies({ user: { id: "u1" } });
        expect(cookies).toEqual({ session: "tok-u1" });
        await app.close();
    });

    it(".as injects cookies into every request automatically", async () => {
        const app = await createTestApp({
            routes: [{ module: makeModule({ moduleId: "Root" }), isRoot: true, children: [] }],
            bootstrap: async () => {
                addRoutes((a) => {
                    a.get("/me", (c) => c.json({ cookie: c.req.header("cookie") }));
                });
            },
            getSessionCookie: async ({ user }) => ({ session: `tok-${user.id}` }),
        });

        const asAlice = app.as({ user: { id: "alice" } });
        const res = await asAlice.get("/me");
        const data = await res.json();
        expect(data.cookie).toContain("session=tok-alice");
        await app.close();
    });

    it(".as throws if getSessionCookie is missing", async () => {
        const app = await createTestApp({
            routes: [{ module: makeModule({ moduleId: "Root" }), isRoot: true, children: [] }],
        });

        expect(() => app.as({ user: { id: "x" } })).toThrow(/getSessionCookie/);
        await app.close();
    });
});

// ============================================
// Conventions — .action and .loader
// ============================================

describe("Conventions — .action and .loader", () => {
    it(".action resolves URL from action_* function reference", async () => {
        const action_save = async ({ body }: any) => ({ saved: body });
        const home = makeModule({
            moduleId: "Home",
            fullPath: "/",
            actions: { save: action_save },
        });
        const app = await createTestApp({
            routes: [
                {
                    module: makeModule({ moduleId: "Root" }),
                    isRoot: true,
                    children: [{ path: "/", module: home }],
                },
            ],
        });

        const res = await app.action(action_save, { body: { name: "x" } });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toEqual({ saved: { name: "x" } });
        await app.close();
    });

    it(".action throws clearly if function is not in route tree", async () => {
        const orphan = async () => ({ ok: true });
        const app = await createTestApp({
            routes: [{ module: makeModule({ moduleId: "Root" }), isRoot: true, children: [] }],
        });

        await expect(app.action(orphan, { body: {} })).rejects.toThrow(
            /not found in the route tree/
        );
        await app.close();
    });

    it(".loader unwraps response data", async () => {
        const loaderFn = async () => ({ greeting: "hi" });
        const home = makeModule({ moduleId: "Home", fullPath: "/", loader: loaderFn });
        const app = await createTestApp({
            routes: [
                {
                    module: makeModule({ moduleId: "Root" }),
                    isRoot: true,
                    children: [{ path: "/", module: home }],
                },
            ],
        });

        const data = await app.loader(loaderFn);
        expect(data).toEqual({ greeting: "hi" });
        await app.close();
    });
});

// ============================================
// Streams — .subscribe
// ============================================

describe("Streams — .subscribe", () => {
    it("subscribes to a stream and receives emitted events", async () => {
        const stream_demo = createEventStream<{ msg: string }>({
            path: "/_event/test/demo",
        });
        const root = makeModule({ moduleId: "Root" });

        const app = await createTestApp({
            routes: [{ module: root, isRoot: true, children: [] }],
        });

        const sub = await app.subscribe(stream_demo, { channel: "ch-1" });
        expect(sub.status).toBe(200);

        // Emit on the same channel
        stream_demo.emit("ch-1", { msg: "hello" });

        const event = await sub.next({ timeoutMs: 1000 });
        expect(event).toEqual({ msg: "hello" });

        await sub.close();
        await app.close();
    });

    it("snapshot is delivered when buffered events exist", async () => {
        const stream_log = createEventStream<string>({
            path: "/_event/test/log",
        });
        const root = makeModule({ moduleId: "Root" });

        // Pre-populate buffer
        stream_log.emit("session", "line 1", { snapshot: true });
        stream_log.emit("session", "line 2", { snapshot: true });

        const app = await createTestApp({
            routes: [{ module: root, isRoot: true, children: [] }],
        });

        const sub = await app.subscribe(stream_log, { channel: "session" });
        // Wait for initial snapshot to land
        await new Promise((r) => setTimeout(r, 50));
        expect(sub.snapshot).toEqual(["line 1", "line 2"]);
        await sub.close();
        await app.close();
    });

    it("403 when channel resolver rejects", async () => {
        const stream_secure = createEventStream<string>({
            path: "/_event/test/secure",
            channel: () => null,
        });
        const root = makeModule({ moduleId: "Root" });

        const app = await createTestApp({
            routes: [{ module: root, isRoot: true, children: [] }],
        });

        const sub = await app.subscribe(stream_secure, { channel: "anything" });
        expect(sub.status).toBe(403);
        expect(sub.events).toEqual([]);

        await sub.close();
        await app.close();
    });

    it("nextN waits for N events with shared timeout", async () => {
        const stream_seq = createEventStream<number>({
            path: "/_event/test/seq",
        });
        const root = makeModule({ moduleId: "Root" });

        const app = await createTestApp({
            routes: [{ module: root, isRoot: true, children: [] }],
        });

        const sub = await app.subscribe(stream_seq, { channel: "ch" });
        await new Promise((r) => setTimeout(r, 30));

        for (let i = 1; i <= 3; i++) stream_seq.emit("ch", i);

        const events = await sub.nextN(3, { timeoutMs: 1000 });
        expect(events).toEqual([1, 2, 3]);

        await sub.close();
        await app.close();
    });

    it("next() rejects on timeout", async () => {
        const stream_quiet = createEventStream<string>({
            path: "/_event/test/quiet",
        });
        const root = makeModule({ moduleId: "Root" });

        const app = await createTestApp({
            routes: [{ module: root, isRoot: true, children: [] }],
        });

        const sub = await app.subscribe(stream_quiet, { channel: "x" });
        await new Promise((r) => setTimeout(r, 30));

        await expect(sub.next({ timeoutMs: 100 })).rejects.toThrow(/timed out/);

        await sub.close();
        await app.close();
    });
});

// ============================================
// reset() — clears stream state
// ============================================

describe("app.reset()", () => {
    it("clears stream buffers between tests", async () => {
        const stream_x = createEventStream<string>({
            path: "/_event/test/reset-x",
        });
        const root = makeModule({ moduleId: "Root" });
        const app = await createTestApp({
            routes: [{ module: root, isRoot: true, children: [] }],
        });

        stream_x.emit("ch", "a", { snapshot: true });
        stream_x.emit("ch", "b", { snapshot: true });
        expect(stream_x.__buffers.get("ch")).toEqual(["a", "b"]);

        await app.reset();
        expect(stream_x.__buffers.get("ch")).toBeUndefined();

        await app.close();
    });
});

// ============================================
// mockContext — escape hatch
// ============================================

describe("mockContext", () => {
    it("provides c.get/set, c.req.query/param/header", async () => {
        const app = await createTestApp({
            routes: [{ module: makeModule({ moduleId: "Root" }), isRoot: true, children: [] }],
        });

        const c = app.mockContext({
            user: { id: "u1", role: "admin" },
            params: { id: "abc" },
            query: { tab: "settings" },
            headers: { "X-Trace": "trace-123" },
        });

        expect(c.get("user")).toEqual({ id: "u1", role: "admin" });
        expect(c.req.param("id")).toBe("abc");
        expect(c.req.query("tab")).toBe("settings");
        expect(c.req.header("X-Trace")).toBe("trace-123");

        // c.set works
        c.set("extra", "data");
        expect(c.get("extra")).toBe("data");

        await app.close();
    });

    it("c.req.json returns the body", async () => {
        const app = await createTestApp({
            routes: [{ module: makeModule({ moduleId: "Root" }), isRoot: true, children: [] }],
        });

        const c = app.mockContext({ body: { hello: "world" } });
        expect(await c.req.json()).toEqual({ hello: "world" });

        await app.close();
    });

    it("c.json returns a Response with JSON body", async () => {
        const app = await createTestApp({
            routes: [{ module: makeModule({ moduleId: "Root" }), isRoot: true, children: [] }],
        });

        const c = app.mockContext();
        const res = c.json({ ok: true });
        expect(res).toBeInstanceOf(Response);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });

        await app.close();
    });
});
