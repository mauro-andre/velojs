/**
 * Live loader — operation and observability (slice 3), exercised through
 * `createTestApp` and raw streams.
 *
 * Deterministic by construction: idle and heartbeat run under fake timers with
 * explicit windows; the connect snapshot is the clock of every subscription.
 * The toolkit's own defaults (`idleMs: 0`, `heartbeatMs: 0`) keep every other
 * suite untouched — the production defaults are verified here against a pure
 * `registerChannels` without options, mirroring the option-less call the app
 * entry injects, never through the toolkit's `channelOptions`.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { createTestApp } from "../src/testing/index.js";
import { emit, inspectChannels, registerChannels } from "../src/channels.js";
import type { AppRoutes, RouteModule } from "../src/types.js";

// ============================================
// Fixture — a public channel, two modules
// ============================================

const store: Record<number, number> = {};

const CHANNELS = {
    public: { scope: () => "all" },
    teamExpenses: { scope: (ctx: any) => `team:${ctx.teamId}` },
};

const teamTotal = async ({ c }: any) => ({
    teamTotal: store[(c.get as any)("user")?.teamId] ?? 0,
});

function makeModule(opts: {
    moduleId: string;
    fullPath?: string;
    loader?: (args: any) => unknown;
    channels?: string[];
}): RouteModule {
    const mod: any = {
        Component: () => null,
        metadata: { moduleId: opts.moduleId, fullPath: opts.fullPath },
    };
    if (opts.loader) mod.loader = opts.loader;
    if (opts.channels) mod.channels = opts.channels;
    return mod as RouteModule;
}

function expensesRoutes(): AppRoutes {
    const Expenses = makeModule({
        moduleId: "expenses/Expenses",
        fullPath: "/expenses",
        loader: teamTotal,
        channels: ["teamExpenses"],
    });
    return [{ path: "/expenses", module: Expenses, middlewares: [requireUser] }];
}

const getSessionCookie = async ({ user }: { user: { id: number; teamId: number } }) => ({
    user: JSON.stringify(user),
});

/** Materializes the principal under the house key ("user"). */
const requireUser: MiddlewareHandler = async (c, next) => {
    const raw = getCookie(c, "user");
    if (!raw) return c.json({ error: "unauthorized" }, 401);
    (c.set as unknown as (k: string, v: unknown) => void)("user", JSON.parse(raw));
    await next();
};

/**
 * Opens the SSE route raw — no subscription helper — and taps the wire into a
 * growing buffer, so a test can observe transport artifacts (the `: ping`
 * comment, the close reason) that carry no event and no data.
 */
function tapRaw(app: Awaited<ReturnType<typeof createTestApp>>, path: string) {
    let buffer = "";
    const reader = (app.hono.request(path) as unknown as Promise<Response>).then(
        (res) => {
            const body = res.body!;
            const r = body.getReader();
            const decoder = new TextDecoder();
            const pump = (async () => {
                try {
                    while (true) {
                        const { value, done } = await r.read();
                        if (done) return;
                        buffer += decoder.decode(value, { stream: true });
                    }
                } catch {
                    // canceled by the test teardown
                }
            })();
            return {
                get text(): string {
                    return buffer;
                },
                async close(): Promise<void> {
                    await r.cancel().catch(() => {});
                    await pump.catch(() => {});
                },
            };
        },
    );
    return {
        ready: async () => await reader,
        async close(): Promise<void> {
            const tap = await reader;
            await tap.close();
        },
        async text(): Promise<string> {
            return (await reader).text;
        },
    };
}

afterEach(() => {
    vi.useRealTimers();
});

// ============================================
// Transport headers (CA4)
// ============================================

describe("live loader — transport headers", () => {
    it("the channel SSE answer carries Cache-Control: no-store", async () => {
        const Mod = makeModule({
            moduleId: "pub/Module",
            loader: async () => ({ ok: 1 }),
            channels: ["public"],
        });
        const app = await createTestApp({
            routes: [{ path: "/p", module: Mod }],
            channels: CHANNELS,
        });

        const res = await app.hono.request("/_channel/pub/Module/public");
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");

        await res.body!.cancel();
        await app.close();
    });
});

// ============================================
// Idle timeout (CA2)
// ============================================

describe("live loader — idle timeout", () => {
    it("closes a connection with no deliveries past idleMs, and frees the group", async () => {
        vi.useFakeTimers();
        store[7] = 1;
        const routes = expensesRoutes();
        const app = await createTestApp({
            routes,
            channels: CHANNELS,
            getSessionCookie,
            channelOptions: { idleMs: 100 },
        });
        const Expenses = routes[0]!.module!;
        const user = app.as({ user: { id: 1, teamId: 7 } });

        const sub = await user.channel(Expenses, "teamExpenses");
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 1 });

        await vi.advanceTimersByTimeAsync(100);
        expect(sub.closed).toBe(true);
        // The group is gone — an empty group does not exist.
        expect(inspectChannels().totalConnections).toBe(0);

        // The client half of the cycle: the reconnect is a new connection and
        // gets a snapshot on connect — the state is repaired.
        store[7] = 2;
        const again = await user.channel(Expenses, "teamExpenses");
        expect(await again.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 2 });

        await again.close();
        await app.close();
    });

    it("a delivery inside the window restarts the count", async () => {
        vi.useFakeTimers();
        store[7] = 1;
        const routes = expensesRoutes();
        const app = await createTestApp({
            routes,
            channels: CHANNELS,
            getSessionCookie,
            channelOptions: { idleMs: 100 },
        });
        const Expenses = routes[0]!.module!;

        const sub = await app
            .as({ user: { id: 1, teamId: 7 } })
            .channel(Expenses, "teamExpenses");
        await sub.next({ timeoutMs: 1000 });

        await vi.advanceTimersByTimeAsync(60);
        store[7] = 2;
        await emit("teamExpenses", { teamId: 7 });
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 2 });

        // 60 + 60 > 100 since the last delivery: still open.
        await vi.advanceTimersByTimeAsync(60);
        expect(sub.closed).toBe(false);

        // 100 without any delivery after the last one: closed.
        await vi.advanceTimersByTimeAsync(40);
        expect(sub.closed).toBe(true);

        await sub.close();
        await app.close();
    });

    it("idleMs: 0 disables it — the toolkit's default keeps connections alive", async () => {
        vi.useFakeTimers();
        const Mod = makeModule({
            moduleId: "pub/Module",
            loader: async () => ({ ok: 1 }),
            channels: ["public"],
        });
        const app = await createTestApp({
            routes: [{ path: "/p", module: Mod }],
            channels: CHANNELS,
        });

        const sub = await app.channel(Mod, "public");
        await sub.next({ timeoutMs: 1000 });

        await vi.advanceTimersByTimeAsync(600000);
        expect(sub.closed).toBe(false);
        expect(inspectChannels().totalConnections).toBe(1);

        await sub.close();
        await app.close();
    });

    it("the default 300000 applies on a registration without options — server-side, not via the toolkit", async () => {
        vi.useFakeTimers();
        const Mod = makeModule({
            moduleId: "pub/Module",
            loader: async () => ({ ok: 1 }),
            channels: ["public"],
        });
        const app = await createTestApp({
            routes: [{ path: "/p", module: Mod }],
            channels: CHANNELS,
        });
        // Mirror the option-less call the app entry injects.
        registerChannels(CHANNELS);

        const tap = tapRaw(app, "/_channel/pub/Module/public");
        const raw = await tap.ready();

        // 299999ms of silence: the default idle has not elapsed.
        await vi.advanceTimersByTimeAsync(299999);
        expect(raw.text).not.toContain("event: close");

        // The last millisecond closes it.
        await vi.advanceTimersByTimeAsync(1);
        expect(raw.text).toContain("event: close");
        expect(raw.text).toContain('"reason":"idle"');

        await tap.close();
        await app.close();
    });

    it("heartbeats do not reset the idle clock", async () => {
        vi.useFakeTimers();
        const Mod = makeModule({
            moduleId: "pub/Module",
            loader: async () => ({ ok: 1 }),
            channels: ["public"],
        });
        const app = await createTestApp({
            routes: [{ path: "/p", module: Mod }],
            channels: CHANNELS,
            channelOptions: { idleMs: 100, heartbeatMs: 20 },
        });

        const tap = tapRaw(app, "/_channel/pub/Module/public");
        const raw = await tap.ready();

        // Pings at 20, 40, 60, 80, 100 — and the connection still dies at 100:
        // the interval firing at the deadline is transport, not a delivery.
        await vi.advanceTimersByTimeAsync(100);
        const text = raw.text;
        expect(text.split(": ping").length - 1).toBe(5);
        expect(text).toContain('"reason":"idle"');

        await tap.close();
        await app.close();
    });
});

// ============================================
// Heartbeat (CA3)
// ============================================

describe("live loader — heartbeat", () => {
    it("writes the `: ping` comment through the write chain on the interval", async () => {
        vi.useFakeTimers();
        const Mod = makeModule({
            moduleId: "pub/Module",
            loader: async () => ({ ok: 1 }),
            channels: ["public"],
        });
        const app = await createTestApp({
            routes: [{ path: "/p", module: Mod }],
            channels: CHANNELS,
            channelOptions: { heartbeatMs: 50 },
        });

        const tap = tapRaw(app, "/_channel/pub/Module/public");
        const raw = await tap.ready();

        await vi.advanceTimersByTimeAsync(49);
        expect(raw.text).not.toContain(": ping");
        await vi.advanceTimersByTimeAsync(1);
        expect(raw.text).toContain(": ping");
        await vi.advanceTimersByTimeAsync(100);
        // Two more intervals fired (50 → 100, 150): three pings total.
        expect(raw.text.split(": ping").length - 1).toBe(3);

        await tap.close();
        await app.close();
    });

    it("heartbeatMs: 0 disables it", async () => {
        vi.useFakeTimers();
        const Mod = makeModule({
            moduleId: "pub/Module",
            loader: async () => ({ ok: 1 }),
            channels: ["public"],
        });
        const app = await createTestApp({
            routes: [{ path: "/p", module: Mod }],
            channels: CHANNELS,
            channelOptions: { heartbeatMs: 0 },
        });

        const tap = tapRaw(app, "/_channel/pub/Module/public");
        const raw = await tap.ready();

        await vi.advanceTimersByTimeAsync(60000);
        expect(raw.text).not.toContain(": ping");

        await tap.close();
        await app.close();
    });

    it("the default 20000 applies on a registration without options — one ruler with stream_*", async () => {
        vi.useFakeTimers();
        const Mod = makeModule({
            moduleId: "pub/Module",
            loader: async () => ({ ok: 1 }),
            channels: ["public"],
        });
        const app = await createTestApp({
            routes: [{ path: "/p", module: Mod }],
            channels: CHANNELS,
        });
        registerChannels(CHANNELS);

        const tap = tapRaw(app, "/_channel/pub/Module/public");
        const raw = await tap.ready();

        await vi.advanceTimersByTimeAsync(19999);
        expect(raw.text).not.toContain(": ping");
        await vi.advanceTimersByTimeAsync(1);
        expect(raw.text).toContain(": ping");

        await tap.close();
        await app.close();
    });
});

// ============================================
// Inspector (CA5)
// ============================================

describe("live loader — inspectChannels", () => {
    it("reports the groups by (moduleId, partition), connections and last delivery", async () => {
        store[7] = 5;
        store[8] = 6;
        const Layout = makeModule({
            moduleId: "expenses/Layout",
            loader: teamTotal,
            channels: ["teamExpenses"],
        });
        const Page = makeModule({
            moduleId: "expenses/Expenses",
            fullPath: "/expenses",
            loader: teamTotal,
            channels: ["teamExpenses"],
        });
        const app = await createTestApp({
            routes: [
                {
                    path: "/expenses",
                    module: Layout,
                    middlewares: [requireUser],
                    children: [{ path: "/", module: Page }],
                },
            ],
            channels: CHANNELS,
            getSessionCookie,
        });
        const user = app.as({ user: { id: 1, teamId: 7 } });
        const other = app.as({ user: { id: 2, teamId: 8 } });

        const layoutSub = await user.channel(Layout, "teamExpenses");
        const pageSub = await user.channel(Page, "teamExpenses");
        const otherSub = await other.channel(Page, "teamExpenses");
        await layoutSub.next({ timeoutMs: 1000 });
        await pageSub.next({ timeoutMs: 1000 });
        await otherSub.next({ timeoutMs: 1000 });

        const report = inspectChannels();
        console.log('DBG1', JSON.stringify(report));
        expect(report.totalConnections).toBe(3);
        const channel = report.channels.find((c) => c.channel === "teamExpenses")!;
        expect(channel.connections).toBe(3);
        // Groups are (moduleId, partition) pairs — which page holds what.
        const group = (moduleId: string, partition: string) =>
            channel.groups.find((g) => g.moduleId === moduleId && g.partition === partition);
        expect(group("expenses/Layout", "team:7")!.connections).toBe(1);
        expect(group("expenses/Expenses", "team:7")!.connections).toBe(1);
        expect(group("expenses/Expenses", "team:8")!.connections).toBe(1);
        // The connect snapshot is a delivery: the timestamp is set, ISO.
        for (const g of channel.groups) {
            expect(g.lastDeliveryAt).not.toBeNull();
            expect(new Date(g.lastDeliveryAt!).toISOString()).toBe(g.lastDeliveryAt);
        }

        await layoutSub.close();
        await pageSub.close();
        await otherSub.close();
        await app.close();
    });

    it("reflects emits and terminations", async () => {
        const Mod = makeModule({
            moduleId: "pub/Module",
            loader: async () => ({ ok: 1 }),
            channels: ["public"],
        });
        const app = await createTestApp({
            routes: [{ path: "/p", module: Mod }],
            channels: CHANNELS,
        });

        const sub = await app.channel(Mod, "public");
        await sub.next({ timeoutMs: 1000 });
        console.log('DBG2', JSON.stringify(inspectChannels()));
        expect(inspectChannels().totalConnections).toBe(1);

        // Terminated (here: idle window) — the inspector sees the group go.
        await sub.close();
        const after = inspectChannels();
        expect(after.totalConnections).toBe(0);
        expect(after.channels.find((c) => c.channel === "public")).toBeUndefined();
        expect(after.openCoalesceWindows).toEqual([]);

        await app.close();
    });

    it("reports the coalescing windows still open, and their close", async () => {
        vi.useFakeTimers();
        const Mod = makeModule({
            moduleId: "expenses/Expenses",
            fullPath: "/expenses",
            loader: teamTotal,
            channels: ["teamExpenses"],
        });
        const app = await createTestApp({
            routes: [{ path: "/expenses", module: Mod, middlewares: [requireUser] }],
            channels: CHANNELS,
            getSessionCookie,
            channelOptions: { coalesceMs: 50 },
        });

        const sub = await app
            .as({ user: { id: 1, teamId: 7 } })
            .channel(Mod, "teamExpenses");
        await sub.next({ timeoutMs: 1000 });

        await emit("teamExpenses", { teamId: 7 });
        expect(inspectChannels().openCoalesceWindows).toEqual([
            { channel: "teamExpenses", partition: "team:7" },
        ]);

        await vi.advanceTimersByTimeAsync(50);
        expect(inspectChannels().openCoalesceWindows).toEqual([]);

        await sub.close();
        await app.close();
    });

    it("the empty registry reports empty — no channels, no totals", () => {
        const report = inspectChannels();
        expect(report.channels).toEqual([]);
        expect(report.openCoalesceWindows).toEqual([]);
        expect(report.totalConnections).toBe(0);
    });
});

// ============================================
// Dev endpoint (CA6)
// ============================================

describe("GET /_channel-inspect", () => {
    it("answers the inspector JSON in a non-production environment", async () => {
        const Mod = makeModule({
            moduleId: "pub/Module",
            loader: async () => ({ ok: 1 }),
            channels: ["public"],
        });
        const app = await createTestApp({
            routes: [{ path: "/p", module: Mod }],
            channels: CHANNELS,
        });
        const sub = await app.channel(Mod, "public");
        await sub.next({ timeoutMs: 1000 });

        const res = await app.get("/_channel-inspect");
        expect(res.status).toBe(200);
        const json: any = await res.json();
        expect(json).toEqual(inspectChannels());
        expect(json.totalConnections).toBe(1);
        expect(json.channels[0].groups[0].moduleId).toBe("pub/Module");

        await sub.close();
        await app.close();
    });

    it("does not exist in a production build", async () => {
        const prev = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";
        try {
            const Mod = makeModule({
                moduleId: "pub/Module",
                loader: async () => ({ ok: 1 }),
                channels: ["public"],
            });
            const app = await createTestApp({
                routes: [{ path: "/p", module: Mod }],
                channels: CHANNELS,
            });

            const res = await app.get("/_channel-inspect");
            expect(res.status).toBe(404);

            await app.close();
        } finally {
            process.env.NODE_ENV = prev;
        }
    });
});