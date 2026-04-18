import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import {
    createEventStream,
    flushPendingStreamRoutes,
    registerStreamHandler,
} from "../src/events.js";

describe("createEventStream", () => {
    describe("basic factory", () => {
        it("returns an object with the EventStream shape", () => {
            const stream = createEventStream<{ msg: string }>();

            expect(stream.__isVeloEventStream).toBe(true);
            expect(typeof stream.emit).toBe("function");
            expect(stream.__listeners).toBeInstanceOf(Map);
            expect(stream.__config).toBeDefined();
        });

        it("stores the assigned path when provided", () => {
            const stream = createEventStream({ path: "/api/test" });
            expect(stream.__path).toBe("/api/test");
        });

        it("__path is undefined for convention-based streams (no path)", () => {
            const stream = createEventStream();
            expect(stream.__path).toBeUndefined();
        });
    });

    describe("emit() — broadcast (no channel)", () => {
        it("delivers event to all broadcast listeners", () => {
            const stream = createEventStream<number>();
            const received: number[] = [];

            const listener = (event: number) => received.push(event);
            const broadcastSet = new Set<(e: number) => void>([listener]);
            stream.__listeners.set("", broadcastSet);

            stream.emit(42);
            stream.emit(99);

            expect(received).toEqual([42, 99]);
        });

        it("delivers to multiple listeners on broadcast channel", () => {
            const stream = createEventStream<string>();
            const received: string[] = [];

            const a = (e: string) => received.push("a:" + e);
            const b = (e: string) => received.push("b:" + e);
            stream.__listeners.set("", new Set([a, b]));

            stream.emit("hello");

            expect(received).toEqual(["a:hello", "b:hello"]);
        });

        it("does nothing when no listeners exist", () => {
            const stream = createEventStream<number>();
            expect(() => stream.emit(1)).not.toThrow();
        });
    });

    describe("emit() — channel-targeted", () => {
        it("delivers event only to matching channel listeners", () => {
            const stream = createEventStream<string>();
            const a: string[] = [];
            const b: string[] = [];

            stream.__listeners.set("room-1", new Set([(e) => a.push(e)]));
            stream.__listeners.set("room-2", new Set([(e) => b.push(e)]));

            stream.emit("room-1", "hello");
            stream.emit("room-2", "world");

            expect(a).toEqual(["hello"]);
            expect(b).toEqual(["world"]);
        });

        it("does not deliver channel events to broadcast listeners", () => {
            const stream = createEventStream<string>();
            const broadcast: string[] = [];
            const channel: string[] = [];

            stream.__listeners.set("", new Set([(e) => broadcast.push(e)]));
            stream.__listeners.set("foo", new Set([(e) => channel.push(e)]));

            stream.emit("foo", "channel-event");

            expect(broadcast).toEqual([]);
            expect(channel).toEqual(["channel-event"]);
        });
    });

    describe("standalone usage (with path)", () => {
        it("queues route registration when path is provided", () => {
            const app = new Hono();
            createEventStream({ path: "/api/test-1" });

            // Route should be in the pending queue, not yet on app
            const beforeFlush = app.routes.filter((r) => r.path === "/api/test-1");
            expect(beforeFlush.length).toBe(0);

            flushPendingStreamRoutes(app);

            const afterFlush = app.routes.filter((r) => r.path === "/api/test-1");
            expect(afterFlush.length).toBeGreaterThan(0);
        });

        it("does not queue anything when path is not provided", () => {
            const app = new Hono();
            createEventStream({});
            flushPendingStreamRoutes(app);
            // No assertion needed — just confirm no error
            expect(app.routes.length).toBe(0);
        });

        it("flushes only once — second call is empty", () => {
            const app1 = new Hono();
            const app2 = new Hono();
            createEventStream({ path: "/api/test-flush-once" });

            flushPendingStreamRoutes(app1);
            flushPendingStreamRoutes(app2);

            const a1 = app1.routes.filter((r) => r.path === "/api/test-flush-once");
            const a2 = app2.routes.filter((r) => r.path === "/api/test-flush-once");

            expect(a1.length).toBeGreaterThan(0);
            expect(a2.length).toBe(0);
        });

        it("applies middlewares from config when standalone", async () => {
            const app = new Hono();
            let middlewareCalled = false;

            const authMw = async (_c: any, next: () => Promise<void>) => {
                middlewareCalled = true;
                await next();
            };

            createEventStream({
                path: "/api/secure-stream",
                middlewares: [authMw],
            });
            flushPendingStreamRoutes(app);

            const ctrl = new AbortController();
            const fetchPromise = app.fetch(
                new Request("http://localhost/api/secure-stream", {
                    signal: ctrl.signal,
                })
            );

            await new Promise((r) => setTimeout(r, 50));
            expect(middlewareCalled).toBe(true);

            ctrl.abort();
            await fetchPromise.catch(() => {});
        });

        it("middleware can block the connection (e.g., 401)", async () => {
            const app = new Hono();

            const authMw = async (c: any) => {
                return c.json({ error: "unauthorized" }, 401);
            };

            createEventStream({
                path: "/api/blocked-stream",
                middlewares: [authMw],
            });
            flushPendingStreamRoutes(app);

            const res = await app.fetch(
                new Request("http://localhost/api/blocked-stream")
            );
            expect(res.status).toBe(401);
        });
    });

    describe("config defaults", () => {
        it("preserves channel function in config", () => {
            const channelFn = (c: any) => c.req.param("id");
            const stream = createEventStream({ channel: channelFn });
            expect(stream.__config.channel).toBe(channelFn);
        });

        it("preserves snapshot function in config", () => {
            const snapshotFn = (channel: string | undefined) => ({ data: channel });
            const stream = createEventStream({ snapshot: snapshotFn });
            expect(stream.__config.snapshot).toBe(snapshotFn);
        });

        it("preserves closeOn function in config", () => {
            const closeOnFn = (event: any) => event.done;
            const stream = createEventStream({ closeOn: closeOnFn });
            expect(stream.__config.closeOn).toBe(closeOnFn);
        });

        it("preserves heartbeatMs in config", () => {
            const stream = createEventStream({ heartbeatMs: 5000 });
            expect(stream.__config.heartbeatMs).toBe(5000);
        });

        it("allows heartbeatMs: false to disable heartbeat", () => {
            const stream = createEventStream({ heartbeatMs: false });
            expect(stream.__config.heartbeatMs).toBe(false);
        });
    });
});

describe("registerStreamHandler — SSE responses", () => {
    let app: Hono;

    beforeEach(() => {
        app = new Hono();
    });

    it("responds with SSE content-type", async () => {
        const stream = createEventStream<{ n: number }>();
        registerStreamHandler(app, "/sse-test", stream);

        const res = await app.fetch(new Request("http://localhost/sse-test"));
        expect(res.headers.get("content-type")).toContain("text/event-stream");
    });

    it("sends snapshot on connect when snapshot is configured", async () => {
        const stream = createEventStream<number, { current: number }>({
            snapshot: () => ({ current: 42 }),
        });
        registerStreamHandler(app, "/sse-snap", stream);

        const res = await app.fetch(new Request("http://localhost/sse-snap"));
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();

        // Read initial chunk
        const { value } = await reader.read();
        const text = decoder.decode(value);

        expect(text).toContain("event: snapshot");
        expect(text).toContain('{"current":42}');

        await reader.cancel();
    });

    it("does not send snapshot when snapshot returns undefined", async () => {
        const stream = createEventStream<number, { current: number }>({
            snapshot: () => undefined,
            heartbeatMs: false,
        });
        registerStreamHandler(app, "/sse-no-snap", stream);

        const res = await app.fetch(new Request("http://localhost/sse-no-snap"));
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();

        // Race: nothing should be written immediately
        const readPromise = reader.read();
        const timeoutPromise = new Promise<{ done: true; value: undefined }>(
            (resolve) =>
                setTimeout(
                    () => resolve({ done: true, value: undefined }),
                    100
                )
        );

        const result = await Promise.race([readPromise, timeoutPromise]);
        // If a chunk arrived quickly, it should not contain "event: snapshot"
        if (!result.done && result.value) {
            const text = decoder.decode(result.value);
            expect(text).not.toContain("event: snapshot");
        }

        await reader.cancel();
    });

    it("registers route at the given path", () => {
        const stream = createEventStream<number>();
        registerStreamHandler(app, "/my-route", stream);

        const route = app.routes.find((r) => r.path === "/my-route");
        expect(route).toBeDefined();
        expect(route?.method).toBe("GET");
    });

    it("uses channel function when configured", async () => {
        const stream = createEventStream<string>({
            channel: (c) => c.req.query("id") ?? "default",
        });
        registerStreamHandler(app, "/sse-channel", stream);

        // Connect with channel id=foo, do not consume — just verify a listener gets added
        const ctrl = new AbortController();
        const fetchPromise = app.fetch(
            new Request("http://localhost/sse-channel?id=foo", {
                signal: ctrl.signal,
            })
        );

        // Give the handler a tick to subscribe
        await new Promise((r) => setTimeout(r, 50));

        expect(stream.__listeners.has("foo")).toBe(true);

        ctrl.abort();
        await fetchPromise.catch(() => {});
    });

    it("applies middlewares when provided", async () => {
        const stream = createEventStream<number>();
        let middlewareCalled = false;

        const mw = async (_c: any, next: () => Promise<void>) => {
            middlewareCalled = true;
            await next();
        };

        registerStreamHandler(app, "/sse-mw", stream, [mw]);

        const ctrl = new AbortController();
        const fetchPromise = app.fetch(
            new Request("http://localhost/sse-mw", { signal: ctrl.signal })
        );

        await new Promise((r) => setTimeout(r, 50));
        expect(middlewareCalled).toBe(true);

        ctrl.abort();
        await fetchPromise.catch(() => {});
    });
});
