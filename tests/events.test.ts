import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import {
    createEventStream,
    flushPendingStreamRoutes,
    registerStreamHandler,
    poll,
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

    describe("emit() — broadcast (broadcast: true)", () => {
        it("delivers event to all broadcast listeners", () => {
            const stream = createEventStream<number>({ broadcast: true });
            const received: number[] = [];

            const listener = Object.assign(
                (event: number) => received.push(event),
                { close: () => {} }
            );
            stream.__listeners.set("", new Set([listener]));

            stream.emit(42);
            stream.emit(99);

            expect(received).toEqual([42, 99]);
        });

        it("delivers to multiple listeners on broadcast channel", () => {
            const stream = createEventStream<string>({ broadcast: true });
            const received: string[] = [];

            const a = Object.assign(
                (e: string) => received.push("a:" + e),
                { close: () => {} }
            );
            const b = Object.assign(
                (e: string) => received.push("b:" + e),
                { close: () => {} }
            );
            stream.__listeners.set("", new Set([a, b]));

            stream.emit("hello");

            expect(received).toEqual(["a:hello", "b:hello"]);
        });

        it("does nothing when no listeners exist", () => {
            const stream = createEventStream<number>({ broadcast: true });
            expect(() => stream.emit(1)).not.toThrow();
        });

        it("warns when both broadcast: true and channel are set", () => {
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
            createEventStream({
                broadcast: true,
                channel: (c) => c.req.query("foo") ?? "",
            });
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining("ignores `channel`")
            );
            warn.mockRestore();
        });
    });

    describe("emit() — channel-targeted", () => {
        // REGRESSION: bug found in 0.0.20 where stream without explicit channel function
        // had inconsistent behavior — server handler used defaultChannelFn but emit
        // treated first arg as event (broadcast). Channel-first as default fixes it.
        it("default is channel-first (works without explicit channel config)", () => {
            const stream = createEventStream<string>();
            const received: string[] = [];

            const listener = Object.assign(
                (e: string) => received.push(e),
                { close: () => {} }
            );
            stream.__listeners.set("session-1", new Set([listener]));

            stream.emit("session-1", "hello");

            expect(received).toEqual(["hello"]);
        });

        it("delivers event only to matching channel listeners", () => {
            const stream = createEventStream<string>({
                channel: (c) => c.req.query("channel") ?? "",
            });
            const a: string[] = [];
            const b: string[] = [];

            const la = Object.assign((e: string) => a.push(e), { close: () => {} });
            const lb = Object.assign((e: string) => b.push(e), { close: () => {} });
            stream.__listeners.set("room-1", new Set([la]));
            stream.__listeners.set("room-2", new Set([lb]));

            stream.emit("room-1", "hello");
            stream.emit("room-2", "world");

            expect(a).toEqual(["hello"]);
            expect(b).toEqual(["world"]);
        });

        it("does not deliver channel events to broadcast listeners", () => {
            const stream = createEventStream<string>({
                channel: (c) => c.req.query("channel") ?? "",
            });
            const broadcast: string[] = [];
            const channelListener: string[] = [];

            const lb = Object.assign((e: string) => broadcast.push(e), { close: () => {} });
            const lc = Object.assign((e: string) => channelListener.push(e), { close: () => {} });
            stream.__listeners.set("", new Set([lb]));
            stream.__listeners.set("foo", new Set([lc]));

            stream.emit("foo", "channel-event");

            expect(broadcast).toEqual([]);
            expect(channelListener).toEqual(["channel-event"]);
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
            await Promise.resolve(fetchPromise).catch(() => {});
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
        await Promise.resolve(fetchPromise).catch(() => {});
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
        await Promise.resolve(fetchPromise).catch(() => {});
    });
});

// ============================================
// NEW: per-emit snapshot flag + buffer
// ============================================

describe("per-emit snapshot buffer", () => {
    it("appends events with { snapshot: true } to internal buffer", () => {
        const stream = createEventStream<string>({
            channel: (c) => c.req.query("channel") ?? "",
        });

        stream.emit("session-1", "line 1", { snapshot: true });
        stream.emit("session-1", "line 2", { snapshot: true });
        stream.emit("session-1", "ephemeral");  // no snapshot

        expect(stream.__buffers.get("session-1")).toEqual(["line 1", "line 2"]);
    });

    it("does not buffer when snapshot is false or omitted", () => {
        const stream = createEventStream<string>({
            channel: (c) => c.req.query("channel") ?? "",
        });
        stream.emit("session-1", "ephemeral");
        stream.emit("session-1", "also ephemeral", { snapshot: false });

        expect(stream.__buffers.get("session-1")).toBeUndefined();
    });

    it("buffers per channel independently", () => {
        const stream = createEventStream<string>({
            channel: (c) => c.req.query("channel") ?? "",
        });
        stream.emit("a", "from-a", { snapshot: true });
        stream.emit("b", "from-b", { snapshot: true });

        expect(stream.__buffers.get("a")).toEqual(["from-a"]);
        expect(stream.__buffers.get("b")).toEqual(["from-b"]);
    });

    it("works for broadcast streams (broadcast: true)", () => {
        const stream = createEventStream<number>({ broadcast: true });
        stream.emit(1, { snapshot: true });
        stream.emit(2, { snapshot: true });

        expect(stream.__buffers.get("")).toEqual([1, 2]);
    });
});

// ============================================
// NEW: close() method
// ============================================

describe("close()", () => {
    it("notifies current listeners via close()", () => {
        const stream = createEventStream<string>({
            channel: (c) => c.req.query("channel") ?? "",
        });
        let closed = false;
        const listener = Object.assign(() => {}, {
            close: () => { closed = true; },
        });
        stream.__listeners.set("foo", new Set([listener]));

        stream.close("foo");
        expect(closed).toBe(true);
    });

    it("is idempotent — calling close twice is a no-op", () => {
        const stream = createEventStream<string>({
            channel: (c) => c.req.query("channel") ?? "",
            retainMs: 100,
        });
        let closeCount = 0;
        const listener = Object.assign(() => {}, {
            close: () => { closeCount++; },
        });
        stream.__listeners.set("foo", new Set([listener]));

        stream.close("foo");
        stream.close("foo");

        expect(closeCount).toBe(1);
    });

    it("ignores subsequent emits to closed channel (warns)", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const stream = createEventStream<string>({
            channel: (c) => c.req.query("channel") ?? "",
        });
        stream.emit("foo", "before close", { snapshot: true });
        stream.close("foo");
        stream.emit("foo", "after close", { snapshot: true });

        expect(stream.__buffers.get("foo")).toEqual(["before close"]);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining("closed channel")
        );
        warn.mockRestore();
    });

    it("clears buffer after retainMs", async () => {
        const stream = createEventStream<string>({
            channel: (c) => c.req.query("channel") ?? "",
            retainMs: 50,
        });
        stream.emit("foo", "data", { snapshot: true });
        stream.close("foo");

        expect(stream.__buffers.get("foo")).toEqual(["data"]);

        await new Promise((r) => setTimeout(r, 80));
        expect(stream.__buffers.get("foo")).toBeUndefined();
    });

    it("close() with no arg closes the broadcast channel", () => {
        const stream = createEventStream<string>();
        let closed = false;
        const listener = Object.assign(() => {}, {
            close: () => { closed = true; },
        });
        stream.__listeners.set("", new Set([listener]));

        stream.close();
        expect(closed).toBe(true);
    });
});

// ============================================
// NEW: source with AbortSignal lifecycle
// ============================================

describe("source lifecycle", () => {
    it("does not invoke source until first subscriber", async () => {
        let started = false;
        createEventStream<number>({
            source: async () => { started = true; },
        });

        await new Promise((r) => setTimeout(r, 20));
        expect(started).toBe(false);
    });

    it("invokes source on first subscriber", async () => {
        let started = false;
        const stream = createEventStream<number>({
            source: async () => { started = true; },
        });

        // Simulate subscriber via __onConnect
        const listener = Object.assign(() => {}, { close: () => {} });
        stream.__onConnect("", listener);

        await new Promise((r) => setTimeout(r, 20));
        expect(started).toBe(true);

        stream.__onDisconnect("", listener);
    });

    it("aborts signal when last subscriber disconnects", async () => {
        let aborted = false;
        const stream = createEventStream<number>({
            source: async (_emit, { abortSignal }) => {
                abortSignal.addEventListener("abort", () => {
                    aborted = true;
                });
                await new Promise((r) => abortSignal.addEventListener("abort", r));
            },
        });

        const listener = Object.assign(() => {}, { close: () => {} });
        stream.__onConnect("foo", listener);

        await new Promise((r) => setTimeout(r, 10));

        stream.__onDisconnect("foo", listener);
        await new Promise((r) => setTimeout(r, 10));

        expect(aborted).toBe(true);
    });

    it("does not abort when at least one subscriber remains", async () => {
        let aborted = false;
        const stream = createEventStream<number>({
            source: async (_emit, { abortSignal }) => {
                abortSignal.addEventListener("abort", () => { aborted = true; });
                await new Promise((r) => abortSignal.addEventListener("abort", r));
            },
        });

        const a = Object.assign(() => {}, { close: () => {} });
        const b = Object.assign(() => {}, { close: () => {} });
        stream.__onConnect("foo", a);
        stream.__onConnect("bar", b);

        await new Promise((r) => setTimeout(r, 10));

        // Disconnect only one — source should still run
        stream.__onDisconnect("foo", a);
        await new Promise((r) => setTimeout(r, 20));

        expect(aborted).toBe(false);

        stream.__onDisconnect("bar", b);
    });

    it("source can emit values via the provided emit fn", async () => {
        const received: number[] = [];
        const stream = createEventStream<number>({
            broadcast: true,
            source: async (emit) => {
                emit(1);
                emit(2);
                emit(3);
            },
        });

        const listener = Object.assign(
            (n: number) => received.push(n),
            { close: () => {} }
        );
        stream.__onConnect("", listener);

        await new Promise((r) => setTimeout(r, 20));
        expect(received).toEqual([1, 2, 3]);
    });

    it("re-invokes source with fresh signal after all unsubscribe and new sub arrives", async () => {
        let invocations = 0;
        const stream = createEventStream<number>({
            source: async (_emit, { abortSignal }) => {
                invocations++;
                await new Promise((r) => abortSignal.addEventListener("abort", r));
            },
        });

        const a = Object.assign(() => {}, { close: () => {} });
        stream.__onConnect("", a);
        await new Promise((r) => setTimeout(r, 10));

        stream.__onDisconnect("", a);
        await new Promise((r) => setTimeout(r, 10));

        const b = Object.assign(() => {}, { close: () => {} });
        stream.__onConnect("", b);
        await new Promise((r) => setTimeout(r, 10));

        expect(invocations).toBe(2);
        stream.__onDisconnect("", b);
    });
});

// ============================================
// NEW: poll helper
// ============================================

describe("poll() helper", () => {
    it("calls tick repeatedly until aborted", async () => {
        const ticks: number[] = [];
        let i = 0;
        const source = poll<number>({
            intervalMs: 20,
            tick: async (emit) => {
                i++;
                ticks.push(i);
                emit(i);
            },
        });

        const ctrl = new AbortController();
        const promise = source(() => {}, { abortSignal: ctrl.signal });

        await new Promise((r) => setTimeout(r, 90));
        ctrl.abort();
        await promise;

        expect(ticks.length).toBeGreaterThanOrEqual(3);
    });

    it("stops immediately when aborted", async () => {
        let calls = 0;
        const source = poll<void>({
            intervalMs: 1000,
            tick: async () => { calls++; },
        });

        const ctrl = new AbortController();
        const promise = source(() => {}, { abortSignal: ctrl.signal });

        await new Promise((r) => setTimeout(r, 5));
        ctrl.abort();
        await promise;

        // Only one synchronous tick should have run
        expect(calls).toBe(1);
    });

    it("logs error from tick but keeps looping", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        let runs = 0;
        const source = poll<void>({
            intervalMs: 10,
            tick: async () => {
                runs++;
                throw new Error("boom");
            },
        });

        const ctrl = new AbortController();
        const promise = source(() => {}, { abortSignal: ctrl.signal });

        await new Promise((r) => setTimeout(r, 50));
        ctrl.abort();
        await promise;

        expect(runs).toBeGreaterThan(1);
        expect(errSpy).toHaveBeenCalled();
        errSpy.mockRestore();
    });
});

// ============================================
// NEW: default channel function
// ============================================

describe("default channel function", () => {
    it("registers default channel handler that reads ?channel=...", async () => {
        const app = new Hono();
        // Stream without explicit channel function still works for client connections
        const stream = createEventStream<string>();
        registerStreamHandler(app, "/sse-default-chan", stream);

        const ctrl = new AbortController();
        const fetchPromise = app.fetch(
            new Request("http://localhost/sse-default-chan?channel=xyz", {
                signal: ctrl.signal,
            })
        );

        await new Promise((r) => setTimeout(r, 50));
        // The handler should have subscribed under channel "xyz" (via default fn)
        expect(stream.__listeners.has("xyz")).toBe(true);

        ctrl.abort();
        await Promise.resolve(fetchPromise).catch(() => {});
    });
});

// ============================================
// END-TO-END: zero-config channel-aware (regression for the 0.0.20 bug)
// ============================================

describe("end-to-end: zero-config channel-aware", () => {
    it("emit(channel, value) reaches a real HTTP SSE subscriber on that channel", async () => {
        // This is the exact scenario that broke in 0.0.20:
        //   - createEventStream<string>() with no config
        //   - HTTP client connects with ?channel=...
        //   - Server-side service emits with stream.emit(channel, value, { snapshot: true })
        //   - Client should receive the event via SSE (not silently drop into broadcast bucket)
        const app = new Hono();
        const stream = createEventStream<string>(); // ← zero config
        registerStreamHandler(app, "/sse-e2e", stream);

        const ctrl = new AbortController();
        const res = await app.fetch(
            new Request("http://localhost/sse-e2e?channel=session-1", {
                signal: ctrl.signal,
            })
        );

        // Wait until handler subscribes the listener
        await new Promise((r) => setTimeout(r, 30));
        expect(stream.__listeners.has("session-1")).toBe(true);

        // Service emits to the same channel
        stream.emit("session-1", "Connecting...", { snapshot: true });
        stream.emit("session-1", "Worker ready", { snapshot: true });

        // Read the SSE response body and check the data lines
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        const chunks: string[] = [];

        // Read with a timeout so the test fails if nothing arrives
        const readWithTimeout = async () => {
            const start = Date.now();
            while (Date.now() - start < 200) {
                const result = await Promise.race([
                    reader.read(),
                    new Promise<{ done: true; value: undefined }>((r) =>
                        setTimeout(() => r({ done: true, value: undefined }), 50)
                    ),
                ]);
                if (result.done || !result.value) break;
                chunks.push(decoder.decode(result.value));
            }
        };
        await readWithTimeout();

        const fullText = chunks.join("");
        // Both events should arrive on the SSE stream as data: "..." lines
        expect(fullText).toContain("Connecting...");
        expect(fullText).toContain("Worker ready");

        ctrl.abort();
        await reader.cancel().catch(() => {});
    });

    it("emit(channel, value) does NOT leak to a different channel", async () => {
        const app = new Hono();
        const stream = createEventStream<string>();
        registerStreamHandler(app, "/sse-iso", stream);

        const ctrl = new AbortController();
        const res = await app.fetch(
            new Request("http://localhost/sse-iso?channel=alice", {
                signal: ctrl.signal,
            })
        );

        await new Promise((r) => setTimeout(r, 30));

        // Emit to a different channel
        stream.emit("bob", "for bob only", { snapshot: true });

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        const chunks: string[] = [];

        const readWithTimeout = async () => {
            const start = Date.now();
            while (Date.now() - start < 100) {
                const result = await Promise.race([
                    reader.read(),
                    new Promise<{ done: true; value: undefined }>((r) =>
                        setTimeout(() => r({ done: true, value: undefined }), 30)
                    ),
                ]);
                if (result.done || !result.value) break;
                chunks.push(decoder.decode(result.value));
            }
        };
        await readWithTimeout();

        const fullText = chunks.join("");
        // alice should NOT receive bob's event
        expect(fullText).not.toContain("for bob only");

        ctrl.abort();
        await reader.cancel().catch(() => {});
    });
});

// ============================================
// NEW: bufferSize ring (FIFO)
// ============================================

describe("bufferSize (FIFO ring buffer)", () => {
    it("keeps only the last N events when bufferSize is set", () => {
        const stream = createEventStream<number>({
            channel: (c) => c.req.query("channel") ?? "",
            bufferSize: 3,
        });

        for (let i = 0; i < 10; i++) {
            stream.emit("logs", i, { snapshot: true });
        }

        expect(stream.__buffers.get("logs")).toEqual([7, 8, 9]);
    });

    it("default Infinity preserves all events (existing behavior)", () => {
        const stream = createEventStream<number>({
            channel: (c) => c.req.query("channel") ?? "",
        });
        for (let i = 0; i < 100; i++) {
            stream.emit("logs", i, { snapshot: true });
        }
        expect(stream.__buffers.get("logs")?.length).toBe(100);
    });

    it("applies per channel independently", () => {
        const stream = createEventStream<string>({
            channel: (c) => c.req.query("channel") ?? "",
            bufferSize: 2,
        });
        stream.emit("a", "a1", { snapshot: true });
        stream.emit("a", "a2", { snapshot: true });
        stream.emit("a", "a3", { snapshot: true });
        stream.emit("b", "b1", { snapshot: true });

        expect(stream.__buffers.get("a")).toEqual(["a2", "a3"]);
        expect(stream.__buffers.get("b")).toEqual(["b1"]);
    });

    it("does not affect ephemeral emits (snapshot:false)", () => {
        const stream = createEventStream<number>({
            channel: (c) => c.req.query("channel") ?? "",
            bufferSize: 2,
        });
        for (let i = 0; i < 5; i++) {
            stream.emit("x", i); // no snapshot
        }
        expect(stream.__buffers.get("x")).toBeUndefined();
    });
});

// ============================================
// NEW: async channel resolver
// ============================================

describe("async channel resolver", () => {
    it("awaits an async channel function and uses the resolved value", async () => {
        const app = new Hono();
        const stream = createEventStream<string>({
            channel: async (c) => {
                await new Promise((r) => setTimeout(r, 10));
                return c.req.query("channel") ?? "";
            },
        });
        registerStreamHandler(app, "/sse-async-chan", stream);

        const ctrl = new AbortController();
        const fetchPromise = app.fetch(
            new Request("http://localhost/sse-async-chan?channel=hello", {
                signal: ctrl.signal,
            })
        );

        await new Promise((r) => setTimeout(r, 60));
        expect(stream.__listeners.has("hello")).toBe(true);

        ctrl.abort();
        await Promise.resolve(fetchPromise).catch(() => {});
    });

    it("responds 403 when resolver returns null", async () => {
        const app = new Hono();
        const stream = createEventStream<string>({
            channel: async () => null,
        });
        registerStreamHandler(app, "/sse-deny", stream);

        const res = await app.fetch(new Request("http://localhost/sse-deny"));
        expect(res.status).toBe(403);
    });

    it("responds 403 when resolver returns undefined", async () => {
        const app = new Hono();
        const stream = createEventStream<string>({
            channel: async () => undefined,
        });
        registerStreamHandler(app, "/sse-deny-undef", stream);

        const res = await app.fetch(new Request("http://localhost/sse-deny-undef"));
        expect(res.status).toBe(403);
    });

    it("responds 500 when resolver throws", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const app = new Hono();
        const stream = createEventStream<string>({
            channel: async () => {
                throw new Error("boom");
            },
        });
        registerStreamHandler(app, "/sse-err", stream);

        const res = await app.fetch(new Request("http://localhost/sse-err"));
        expect(res.status).toBe(500);
        expect(errSpy).toHaveBeenCalled();
        errSpy.mockRestore();
    });

    it("supports sync resolver returning string (backward compat)", async () => {
        const app = new Hono();
        const stream = createEventStream<string>({
            channel: (c) => c.req.query("channel") ?? "",
        });
        registerStreamHandler(app, "/sse-sync-chan", stream);

        const ctrl = new AbortController();
        const fetchPromise = app.fetch(
            new Request("http://localhost/sse-sync-chan?channel=foo", {
                signal: ctrl.signal,
            })
        );

        await new Promise((r) => setTimeout(r, 30));
        expect(stream.__listeners.has("foo")).toBe(true);

        ctrl.abort();
        await Promise.resolve(fetchPromise).catch(() => {});
    });

    it("does not subscribe a listener when rejected", async () => {
        const app = new Hono();
        const stream = createEventStream<string>({
            channel: async () => null,
        });
        registerStreamHandler(app, "/sse-deny-no-sub", stream);

        await app.fetch(new Request("http://localhost/sse-deny-no-sub"));
        expect(stream.__listeners.size).toBe(0);
    });
});

// ============================================
// NEW: perChannelSource lifecycle
// ============================================

describe("perChannelSource", () => {
    it("does not invoke source until first subscriber on a channel", async () => {
        let invoked = false;
        createEventStream<string>({
            channel: (c) => c.req.query("channel") ?? "",
            perChannelSource: async () => {
                invoked = true;
            },
        });

        await new Promise((r) => setTimeout(r, 20));
        expect(invoked).toBe(false);
    });

    it("invokes source with the channelKey when first subscriber connects", async () => {
        const invocations: string[] = [];
        const stream = createEventStream<string>({
            channel: (c) => c.req.query("channel") ?? "",
            perChannelSource: async (channelKey) => {
                invocations.push(channelKey);
            },
        });

        const a = Object.assign(() => {}, { close: () => {} });
        stream.__onConnect("alpha", a);
        await new Promise((r) => setTimeout(r, 10));

        expect(invocations).toEqual(["alpha"]);

        stream.__onDisconnect("alpha", a);
    });

    it("invokes source separately for each new channel", async () => {
        const invocations: string[] = [];
        const stream = createEventStream<string>({
            channel: (c) => c.req.query("channel") ?? "",
            perChannelSource: async (channelKey) => {
                invocations.push(channelKey);
            },
        });

        const a = Object.assign(() => {}, { close: () => {} });
        const b = Object.assign(() => {}, { close: () => {} });
        stream.__onConnect("alpha", a);
        stream.__onConnect("beta", b);
        await new Promise((r) => setTimeout(r, 10));

        expect(invocations.sort()).toEqual(["alpha", "beta"]);

        stream.__onDisconnect("alpha", a);
        stream.__onDisconnect("beta", b);
    });

    it("does NOT invoke source again if same channel gets a second subscriber", async () => {
        const invocations: string[] = [];
        const stream = createEventStream<string>({
            channel: (c) => c.req.query("channel") ?? "",
            perChannelSource: async (channelKey, _emit, { abortSignal }) => {
                invocations.push(channelKey);
                await new Promise((r) => abortSignal.addEventListener("abort", r));
            },
        });

        const a = Object.assign(() => {}, { close: () => {} });
        const b = Object.assign(() => {}, { close: () => {} });
        stream.__onConnect("ch", a);
        await new Promise((r) => setTimeout(r, 10));
        stream.__onConnect("ch", b);
        await new Promise((r) => setTimeout(r, 10));

        expect(invocations).toEqual(["ch"]);

        stream.__onDisconnect("ch", a);
        stream.__onDisconnect("ch", b);
    });

    it("aborts the per-channel signal when last subscriber of THAT channel leaves", async () => {
        const aborted: string[] = [];
        const stream = createEventStream<string>({
            channel: (c) => c.req.query("channel") ?? "",
            perChannelSource: async (channelKey, _emit, { abortSignal }) => {
                abortSignal.addEventListener("abort", () => aborted.push(channelKey));
                await new Promise((r) => abortSignal.addEventListener("abort", r));
            },
        });

        const a = Object.assign(() => {}, { close: () => {} });
        const b = Object.assign(() => {}, { close: () => {} });
        stream.__onConnect("alpha", a);
        stream.__onConnect("beta", b);
        await new Promise((r) => setTimeout(r, 10));

        // Disconnect alpha — only its source should abort
        stream.__onDisconnect("alpha", a);
        await new Promise((r) => setTimeout(r, 10));
        expect(aborted).toEqual(["alpha"]);

        // Now disconnect beta — its source aborts too
        stream.__onDisconnect("beta", b);
        await new Promise((r) => setTimeout(r, 10));
        expect(aborted.sort()).toEqual(["alpha", "beta"]);
    });

    it("re-invokes source if same channel gets a fresh subscriber after all left", async () => {
        const invocations: string[] = [];
        const stream = createEventStream<string>({
            channel: (c) => c.req.query("channel") ?? "",
            perChannelSource: async (channelKey, _emit, { abortSignal }) => {
                invocations.push(channelKey);
                await new Promise((r) => abortSignal.addEventListener("abort", r));
            },
        });

        const a = Object.assign(() => {}, { close: () => {} });
        stream.__onConnect("ch", a);
        await new Promise((r) => setTimeout(r, 10));
        stream.__onDisconnect("ch", a);
        await new Promise((r) => setTimeout(r, 10));

        const b = Object.assign(() => {}, { close: () => {} });
        stream.__onConnect("ch", b);
        await new Promise((r) => setTimeout(r, 10));

        expect(invocations).toEqual(["ch", "ch"]);
        stream.__onDisconnect("ch", b);
    });

    it("channel-bound emit delivers to subscribers of the same channel", async () => {
        const received: string[] = [];
        const stream = createEventStream<string>({
            channel: (c) => c.req.query("channel") ?? "",
            perChannelSource: async (channelKey, emit) => {
                emit("hello from " + channelKey);
            },
        });

        const listener = Object.assign(
            (e: string) => received.push(e),
            { close: () => {} }
        );
        stream.__onConnect("xyz", listener);
        await new Promise((r) => setTimeout(r, 20));

        expect(received).toEqual(["hello from xyz"]);
        stream.__onDisconnect("xyz", listener);
    });

    it("throws if both `source` and `perChannelSource` are provided", () => {
        expect(() =>
            createEventStream<string>({
                source: async () => {},
                perChannelSource: async () => {},
            })
        ).toThrow(/mutually exclusive/);
    });

    it("logs error if perChannelSource throws", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const stream = createEventStream<string>({
            channel: (c) => c.req.query("channel") ?? "",
            perChannelSource: async () => {
                throw new Error("ssh failed");
            },
        });

        const a = Object.assign(() => {}, { close: () => {} });
        stream.__onConnect("x", a);
        await new Promise((r) => setTimeout(r, 20));

        expect(errSpy).toHaveBeenCalledWith(
            expect.stringContaining("perChannelSource"),
            expect.any(Error)
        );
        stream.__onDisconnect("x", a);
        errSpy.mockRestore();
    });
});
