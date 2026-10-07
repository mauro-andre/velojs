/**
 * Native telemetry — collection (slice 1).
 *
 * Every bottleneck of the framework (page SSR, `?_data=1` refetch, action,
 * endpoint, stream connect, socket setup, channel connect) and the emit chain
 * outside the request cycle produce one JSONL trace each: duration, status,
 * response bytes, child spans; long connections add one delivery line per frame
 * and a final close line. The file is read back from disk — the assertions are
 * about what an operator would see.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { createTestApp } from "../src/testing/index.js";
import { createEventStream } from "../src/events.js";
import { emit } from "../src/channels.js";
import { __resetTelemetry, flushTelemetry, type TelemetryEvent } from "../src/telemetry.js";
import type { AppRoutes, LoaderArgs, RouteModule } from "../src/types.js";

// ============================================
// Fixtures
// ============================================

function moduleFixture(opts: {
    moduleId: string;
    fullPath?: string;
    loader?: (args: any) => any;
    extras?: Record<string, unknown>;
}): RouteModule {
    const mod: any = {
        Component: () => null,
        metadata: { moduleId: opts.moduleId, fullPath: opts.fullPath, path: opts.fullPath },
    };
    if (opts.loader) mod.loader = opts.loader;
    Object.assign(mod, opts.extras ?? {});
    return mod as RouteModule;
}


/**
 * Materializes the principal under the house key ("user") — the same shape the
 * live-loader tests use; a channel scope reads it.
 */
const requireUser: MiddlewareHandler = async (c, next) => {
    const raw = getCookie(c, "user");
    if (!raw) return c.json({ error: "unauthorized" }, 401);
    (c.set as unknown as (k: string, v: unknown) => void)("user", JSON.parse(raw));
    await next();
};

let dir: string;
let base: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "velo-telemetry-"));
    base = path.join(dir, "telemetry.jsonl");
    savedEnv = {
        file: process.env.VELO_TELEMETRY_FILE,
        sink: process.env.VELO_TELEMETRY_SINK_URL,
        max: process.env.VELO_TELEMETRY_MAX_MB,
    };
    process.env.VELO_TELEMETRY_FILE = base;
    delete process.env.VELO_TELEMETRY_SINK_URL;
    delete process.env.VELO_TELEMETRY_MAX_MB;
    await __resetTelemetry();
});

afterEach(async () => {
    await __resetTelemetry();
    for (const [key, value] of [
        ["VELO_TELEMETRY_FILE", savedEnv.file],
        ["VELO_TELEMETRY_SINK_URL", savedEnv.sink],
        ["VELO_TELEMETRY_MAX_MB", savedEnv.max],
    ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
});

/** The effective file of this process (instance suffix applied). */
function effectiveFile(): string {
    const name = fs
        .readdirSync(dir)
        .find((entry) => entry.startsWith("telemetry.") && entry.endsWith(".jsonl"));
    if (!name) throw new Error(`no effective telemetry file in ${dir}`);
    return path.join(dir, name);
}

async function readEvents(): Promise<TelemetryEvent[]> {
    await flushTelemetry();
    return fs
        .readFileSync(effectiveFile(), "utf-8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as TelemetryEvent);
}

const ofType = (events: TelemetryEvent[], type: string): TelemetryEvent[] =>
    events.filter((event) => event.type === type);

// ============================================
// Pages and `?_data=1`
// ============================================

describe("telemetry — page and data traces", () => {
    const layout = moduleFixture({
        moduleId: "RootLayout",
        loader: async () => ({ title: "root" }),
    });
    const page = moduleFixture({
        moduleId: "MesPage",
        fullPath: "/mes/:id",
        loader: async ({ params }: LoaderArgs) => ({ value: Number(params.id) }),
    });
    const routes: AppRoutes = [
        { module: layout, isRoot: true, children: [{ path: "/mes/:id", module: page }] },
    ];

    it("a page request produces one trace with the route pattern, bytes, one span per loader and the render span (CA4)", async () => {
        const app = await createTestApp({ routes });
        const res = await app.get("/mes/7");
        const html = await res.text();

        const events = await readEvents();
        const pageTraces = ofType(events, "page");
        expect(pageTraces).toHaveLength(1);
        const trace = pageTraces[0]!;

        // The path pattern, never the materialized URL.
        expect(trace.route).toBe("/mes/:id");
        expect(trace.module).toBe("MesPage");
        expect(trace.status).toBe("ok");
        expect(typeof trace.duration).toBe("number");
        expect(trace.duration).toBeGreaterThanOrEqual(0);
        // Bytes of the response body: time and weight travel together.
        expect(trace.bytes).toBe(Buffer.byteLength(html));

        const spans = trace.spans ?? [];
        const names = spans.map((span) => span.name);
        expect(names).toContain("loader:RootLayout");
        expect(names).toContain("loader:MesPage");
        expect(names).toContain("render");
        for (const span of spans) {
            expect(typeof span.start).toBe("number");
            expect(span.start).toBeGreaterThanOrEqual(0);
            expect(typeof span.duration).toBe("number");
            expect(span.status).toBe("ok");
        }
        await app.close();
    });

    it("the loader span carries its own duration (loaders run in parallel)", async () => {
        const slow = moduleFixture({
            moduleId: "SlowPage",
            fullPath: "/slow",
            loader: async () => {
                await new Promise((resolve) => setTimeout(resolve, 25));
                return { ok: true };
            },
        });
        const app = await createTestApp({ routes: [{ path: "/slow", module: slow }] });
        await app.get("/slow");

        const events = await readEvents();
        const trace = ofType(events, "page")[0]!;
        const loaderSpan = (trace.spans ?? []).find((span) => span.name === "loader:SlowPage")!;
        expect(loaderSpan.duration).toBeGreaterThanOrEqual(20);
        await app.close();
    });

    it("the `?_data=1` refetch is its own trace (type data), with module and bytes (CA6)", async () => {
        const app = await createTestApp({ routes });
        await app.get("/mes/9");
        const res = await app.get("/mes/9", { query: { _data: "1" } });
        const json = await res.json();

        const events = await readEvents();
        expect(ofType(events, "page")).toHaveLength(1);
        const dataTraces = ofType(events, "data");
        expect(dataTraces).toHaveLength(1);
        const trace = dataTraces[0]!;
        expect(trace.route).toBe("/mes/:id");
        expect(trace.module).toBe("MesPage");
        expect(trace.status).toBe("ok");
        expect(trace.bytes).toBe(Buffer.byteLength(JSON.stringify(json)));
        // The refetch runs loaders, it does not render.
        const names = (trace.spans ?? []).map((span) => span.name);
        expect(names).toContain("loader:MesPage");
        expect(names).not.toContain("render");
        await app.close();
    });

    it("a loader that throws marks the trace and its span as error", async () => {
        const broken = moduleFixture({
            moduleId: "BrokenPage",
            fullPath: "/broken",
            loader: async () => {
                throw new Error("boom");
            },
        });
        const app = await createTestApp({ routes: [{ path: "/broken", module: broken }] });
        await app.get("/broken");

        const events = await readEvents();
        const trace = ofType(events, "page")[0]!;
        expect(trace.status).toBe("error");
        expect((trace.spans ?? []).find((span) => span.name === "loader:BrokenPage")!.status).toBe("error");
        await app.close();
    });
});

// ============================================
// Actions
// ============================================

describe("telemetry — action traces", () => {
    it("an action produces a trace with module, name, duration, status and bytes (CA6)", async () => {
        const jobs = moduleFixture({
            moduleId: "Jobs",
            fullPath: "/jobs",
            extras: {
                action_notify: async ({ body }: any) => ({ echoed: body ?? null }),
            },
        });
        const app = await createTestApp({ routes: [{ path: "/jobs", module: jobs }] });
        const res = await app.post("/_action/Jobs/notify", { body: { hello: "world" } });
        const json = await res.json();

        const events = await readEvents();
        const traces = ofType(events, "action");
        expect(traces).toHaveLength(1);
        const trace = traces[0]!;
        expect(trace.module).toBe("Jobs");
        expect(trace.name).toBe("notify");
        expect(trace.route).toBe("/jobs");
        expect(trace.status).toBe("ok");
        expect(typeof trace.duration).toBe("number");
        expect(trace.bytes).toBe(Buffer.byteLength(JSON.stringify(json)));
        await app.close();
    });

    it("an action that throws registers error (CA6)", async () => {
        const jobs = moduleFixture({
            moduleId: "Jobs",
            fullPath: "/jobs",
            extras: {
                action_boom: async () => {
                    throw new Error("nope");
                },
            },
        });
        const app = await createTestApp({ routes: [{ path: "/jobs", module: jobs }] });
        const res = await app.post("/_action/Jobs/boom");
        expect(res.status).toBe(500);

        const events = await readEvents();
        const trace = ofType(events, "action")[0]!;
        expect(trace.status).toBe("error");
        expect(trace.module).toBe("Jobs");
        expect(trace.name).toBe("boom");
        await app.close();
    });
});

// ============================================
// Endpoints
// ============================================

describe("telemetry — endpoint traces", () => {
    it("a declarative endpoint produces a trace with method, route, duration, status and bytes (CA7)", async () => {
        const routes: AppRoutes = [
            {
                path: "/api/health",
                method: "GET",
                handler: ({ c }) => c.json({ ok: true }),
            },
        ];
        const app = await createTestApp({ routes });
        const res = await app.get("/api/health");
        const json = await res.json();

        const events = await readEvents();
        const traces = ofType(events, "endpoint");
        expect(traces).toHaveLength(1);
        const trace = traces[0]!;
        expect(trace.method).toBe("GET");
        expect(trace.route).toBe("/api/health");
        expect(trace.status).toBe("ok");
        expect(typeof trace.duration).toBe("number");
        expect(trace.bytes).toBe(Buffer.byteLength(JSON.stringify(json)));
        await app.close();
    });
});

// ============================================
// Streams
// ============================================

describe("telemetry — event streams", () => {
    it("a stream connect is a trace, every frame a delivery line and the end a close line (CA7, CA8)", async () => {
        const stream = createEventStream<{ n: number }>({ heartbeatMs: false });
        const mod = moduleFixture({
            moduleId: "Metrics",
            fullPath: "/metrics",
            extras: { stream_updates: stream },
        });
        const app = await createTestApp({ routes: [{ path: "/metrics", module: mod }] });

        const sub = await app.subscribe(stream, { channel: "metrics-1" });
        expect(sub.status).toBe(200);

        stream.emit("metrics-1", { n: 1 });
        await sub.next({ timeoutMs: 500 });

        stream.close("metrics-1");
        await sub.close();

        const events = await readEvents();
        const connect = ofType(events, "stream-connect")[0]!;
        expect(connect.route).toBe("/_event/Metrics/updates");
        expect(connect.module).toBe("Metrics");
        expect(connect.channel).toBe("metrics-1");
        expect(connect.status).toBe("ok");
        expect(typeof connect.duration).toBe("number");

        const deliveries = ofType(events, "delivery");
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]!.deliveries).toBe(1);
        expect(deliveries[0]!.bytes).toBe(Buffer.byteLength(JSON.stringify({ n: 1 })));
        expect(deliveries[0]!.trace).toBe(connect.trace);

        const close = ofType(events, "close")[0]!;
        expect(close.trace).toBe(connect.trace);
        expect(close.deliveries).toBe(1);
        // Delivery/close lines are light by design: no spans (CA5).
        expect(deliveries[0]!.spans).toBeUndefined();
        expect(close.spans).toBeUndefined();
        expect(typeof close.duration).toBe("number");
        expect(close.duration).toBeGreaterThanOrEqual(0);

        await app.close();
    });
});

// ============================================
// Channels (live loader)
// ============================================

describe("telemetry — channels", () => {
    it("the connect carries the snapshot span, each delivery its ordinal, and the close line the lifetime total (CA8)", async () => {
        const teamStore: Record<number, number> = { 7: 10 };
        const CHANNELS = { teamExpenses: { scope: ({ user }: any) => `team:${user.teamId}` } };
        const mod = moduleFixture({
            moduleId: "Expenses",
            fullPath: "/expenses",
            loader: async ({ c }: LoaderArgs) => {
                const user = (c.get as any)("user");
                return { total: teamStore[user.teamId] ?? 0 };
            },
            extras: { channels: ["teamExpenses"] },
        });

        const app = await createTestApp({
            routes: [{ path: "/expenses", module: mod, middlewares: [requireUser] }],
            channels: CHANNELS,
            getSessionCookie: async ({ user }) => ({ user: JSON.stringify(user) }),
            channelOptions: { idleMs: 50 },
        });
        const asUser = app.as({ user: { teamId: 7 } });

        vi.useFakeTimers();
        try {
            const sub = await asUser.channel(mod, "teamExpenses");
            // The connect snapshot is the first delivery.
            expect(await sub.next({ timeoutMs: 500 })).toEqual({ total: 10 });

            // Invalidation: the loader re-executes and pushes a new snapshot.
            teamStore[7] = 12;
            await emit("teamExpenses", { user: { teamId: 7 } });
            expect(await sub.next({ timeoutMs: 500 })).toEqual({ total: 12 });

            // Past the idle timeout the connection is closed by the server.
            await vi.advanceTimersByTimeAsync(80);
        } finally {
            vi.useRealTimers();
        }

        const events = await readEvents();
        const connect = ofType(events, "channel-connect")[0]!;
        expect(connect.route).toBe("/_channel/Expenses/teamExpenses");
        expect(connect.module).toBe("Expenses");
        expect(connect.channel).toBe("teamExpenses");
        expect(connect.status).toBe("ok");
        const snapshotSpan = (connect.spans ?? []).find((span) => span.name === "snapshot")!;
        expect(snapshotSpan).toBeTruthy();
        expect(snapshotSpan.status).toBe("ok");
        expect(typeof snapshotSpan.duration).toBe("number");

        const deliveries = ofType(events, "delivery").filter((event) => event.channel === "teamExpenses");
        expect(deliveries.map((event) => event.deliveries)).toEqual([1, 2]);
        expect(deliveries[0]!.bytes).toBe(Buffer.byteLength(JSON.stringify({ total: 10 })));
        expect(deliveries[1]!.bytes).toBe(Buffer.byteLength(JSON.stringify({ total: 12 })));

        const close = ofType(events, "close")[0]!;
        expect(close.channel).toBe("teamExpenses");
        expect(close.deliveries).toBe(2);
        expect(typeof close.duration).toBe("number");

        await app.close();
    });
});

// ============================================
// The emit chain
// ============================================

describe("telemetry — emit chain", () => {
    const CHANNELS = { teamExpenses: { scope: ({ user }: any) => `team:${user.teamId}` } };

    function expensesModule(): RouteModule {
        return moduleFixture({
            moduleId: "Expenses",
            fullPath: "/expenses",
            loader: async () => ({ total: 1 }),
            extras: { channels: ["teamExpenses"] },
        });
    }

    it("an invalidation emit is a trace of its own with one span per loader re-execution, no request involved (CA9)", async () => {
        const mod = expensesModule();
        const app = await createTestApp({
            routes: [{ path: "/expenses", module: mod, middlewares: [requireUser] }],
            channels: CHANNELS,
            getSessionCookie: async ({ user }) => ({ user: JSON.stringify(user) }),
        });
        const subA = await app.as({ user: { teamId: 7 } }).channel(mod, "teamExpenses");
        const subB = await app.as({ user: { teamId: 7 } }).channel(mod, "teamExpenses");

        await emit("teamExpenses", { user: { teamId: 7 } });
        await subA.next({ timeoutMs: 500 });
        await subB.next({ timeoutMs: 500 });

        const events = await readEvents();
        const traces = ofType(events, "emit");
        expect(traces).toHaveLength(1);
        const trace = traces[0]!;
        expect(trace.channel).toBe("teamExpenses");
        expect(trace.partition).toBe("team:7");
        expect(trace.mode).toBe("invalidate");
        expect(trace.connections).toBe(2);
        expect(trace.status).toBe("ok");
        // One child span per re-execution: two connections, two loaders.
        const spans = trace.spans ?? [];
        expect(spans).toHaveLength(2);
        for (const span of spans) {
            expect(span.name).toBe("loader:Expenses");
            expect(span.status).toBe("ok");
            expect(typeof span.duration).toBe("number");
            expect(typeof span.start).toBe("number");
        }
        await app.close();
    });

    it("a slice emit is a trace with the reached connections and no spans (CA9)", async () => {
        const mod = expensesModule();
        const app = await createTestApp({
            routes: [{ path: "/expenses", module: mod, middlewares: [requireUser] }],
            channels: CHANNELS,
            getSessionCookie: async ({ user }) => ({ user: JSON.stringify(user) }),
        });
        const sub = await app.as({ user: { teamId: 7 } }).channel(mod, "teamExpenses");
        await emit(mod, "teamExpenses", { user: { teamId: 7 } }, { total: 5 });
        await sub.next({ timeoutMs: 500 });

        const events = await readEvents();
        const trace = ofType(events, "emit")[0]!;
        expect(trace.mode).toBe("slice");
        expect(trace.channel).toBe("teamExpenses");
        expect(trace.partition).toBe("team:7");
        expect(trace.connections).toBe(1);
        expect(trace.spans ?? []).toHaveLength(0);
        await app.close();
    });

    it("an emit that reaches nobody is still a trace, with zero connections (CA9)", async () => {
        const mod = expensesModule();
        const app = await createTestApp({
            routes: [{ path: "/expenses", module: mod, middlewares: [requireUser] }],
            channels: CHANNELS,
            getSessionCookie: async ({ user }) => ({ user: JSON.stringify(user) }),
        });
        await emit("teamExpenses", { user: { teamId: 99 } });

        const events = await readEvents();
        const trace = ofType(events, "emit")[0]!;
        expect(trace.partition).toBe("team:99");
        expect(trace.connections).toBe(0);
        await app.close();
    });

    it("gestures sharing a coalescing window each get a trace with the round's spans", async () => {
        const mod = expensesModule();
        const app = await createTestApp({
            routes: [{ path: "/expenses", module: mod, middlewares: [requireUser] }],
            channels: CHANNELS,
            getSessionCookie: async ({ user }) => ({ user: JSON.stringify(user) }),
            channelOptions: { coalesceMs: 50 },
        });
        const sub = await app.as({ user: { teamId: 7 } }).channel(mod, "teamExpenses");
        await sub.next({ timeoutMs: 500 }); // connect snapshot

        vi.useFakeTimers();
        try {
            // Two gestures inside one window: one re-execution round serves both.
            await emit("teamExpenses", { user: { teamId: 7 } });
            await emit("teamExpenses", { user: { teamId: 7 } });
            await vi.advanceTimersByTimeAsync(60);
        } finally {
            vi.useRealTimers();
        }

        const events = await readEvents();
        const traces = ofType(events, "emit");
        expect(traces).toHaveLength(2);
        for (const trace of traces) {
            expect(trace.mode).toBe("invalidate");
            expect(trace.connections).toBe(1);
            expect(trace.spans ?? []).toHaveLength(1);
        }
        // One round: one snapshot beyond the connect one.
        const deliveries = ofType(events, "delivery").filter((event) => event.channel === "teamExpenses");
        expect(deliveries.map((event) => event.deliveries)).toEqual([1, 2]);
        await app.close();
    });
});

// ============================================
// Sockets (over a real listener — the in-memory toolkit bypasses the upgrade)
// ============================================

describe("telemetry — sockets", () => {
    it("a socket setup is a trace, sends are delivery lines and the disconnect a close line (CA7, CA8)", async () => {
        const terminal = async ({ send, incoming, keepOpen }: any) => {
            send({ type: "ready" });
            keepOpen();
            for await (const raw of incoming) {
                const msg = JSON.parse(typeof raw === "string" ? raw : "");
                if (msg.type === "echo") send({ type: "echo", payload: msg.payload });
            }
        };
        const mod = moduleFixture({
            moduleId: "Jobs",
            fullPath: "/jobs",
            extras: { socket_terminal: terminal },
        });
        const app = await createTestApp({
            routes: [{ path: "/jobs", module: mod }],
            port: 0,
            hostname: "127.0.0.1",
        });

        const socket = new WebSocket(`ws://127.0.0.1:${app.port}/_socket/Jobs/terminal?channel=t1`);
        socket.on("error", () => {});
        const messages: string[] = [];
        socket.on("message", (data: any) => messages.push(data.toString()));
        await new Promise<void>((resolve, reject) => {
            socket.once("open", resolve);
            socket.once("error", reject);
        });
        await vi.waitFor(() => expect(messages.length).toBeGreaterThanOrEqual(1), { timeout: 3000 });
        expect(JSON.parse(messages[0]!)).toEqual({ type: "ready" });

        socket.send(JSON.stringify({ type: "echo", payload: "hi" }));
        await vi.waitFor(() => expect(messages.length).toBeGreaterThanOrEqual(2), { timeout: 3000 });

        socket.close();
        await new Promise<void>((resolve) => socket.once("close", () => resolve()));
        await vi.waitFor(async () => {
            const events = await readEvents();
            expect(ofType(events, "close").length).toBeGreaterThanOrEqual(1);
        }, { timeout: 3000 });

        const events = await readEvents();
        const connect = ofType(events, "socket-connect")[0]!;
        expect(connect.route).toBe("/_socket/Jobs/terminal");
        expect(connect.module).toBe("Jobs");
        expect(connect.name).toBe("terminal");
        expect(connect.status).toBe("ok");
        expect(typeof connect.duration).toBe("number");

        const deliveries = ofType(events, "delivery");
        expect(deliveries.map((event) => event.deliveries)).toEqual([1, 2]);
        expect(deliveries[0]!.bytes).toBe(Buffer.byteLength(JSON.stringify({ type: "ready" })));
        expect(deliveries[1]!.bytes).toBe(Buffer.byteLength(JSON.stringify({ type: "echo", payload: "hi" })));

        const close = ofType(events, "close")[0]!;
        expect(close.trace).toBe(connect.trace);
        expect(close.deliveries).toBe(2);
        expect(typeof close.duration).toBe("number");

        await app.close();
    });
});