/**
 * Live loader — server side (slice 1), exercised through `createTestApp`.
 *
 * Everything here is deterministic: a channel subscription registers on the
 * server before its connect snapshot is written, so awaiting the first `next()`
 * is the clock — no sleep, no retry, no timing assertion.
 */
import { describe, it, expect, vi } from "vitest";
import { getCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import { createTestApp } from "../src/testing/index.js";
import { createChannelWriteChain, emit, registerChannels } from "../src/channels.js";
import type { AppRoutes, RouteModule } from "../src/types.js";

// ============================================
// Fixture — an app with a team-scoped channel
// ============================================

type TeamUser = { id: number; teamId: number };

/** Per-team totals the loader reads — mutable, so an emit changes the state. */
const store: Record<number, number> = {};

const CHANNELS = {
    teamExpenses: { scope: (ctx: any) => `team:${ctx.teamId}` },
    public: { scope: () => "all" },
    partitioned: {
        scope: (ctx: any) => (ctx?.teamId != null ? `team:${ctx.teamId}` : null),
    },
};

const getSessionCookie = async ({ user }: { user: TeamUser }) => ({
    user: JSON.stringify(user),
});

/** Materializes the principal under the house key ("user"). */
const requireUser: MiddlewareHandler = async (c, next) => {
    const raw = getCookie(c, "user");
    if (!raw) return c.json({ error: "unauthorized" }, 401);
    (c.set as unknown as (k: string, v: unknown) => void)("user", JSON.parse(raw));
    await next();
};

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

const teamTotal = async ({ c }: any) => ({
    teamTotal: store[(c.get as any)("user").teamId] ?? 0,
});

function expensesRoutes(): AppRoutes {
    const Expenses = makeModule({
        moduleId: "expenses/Expenses",
        fullPath: "/expenses",
        loader: teamTotal,
        channels: ["teamExpenses", "public"],
    });
    return [{ path: "/expenses", module: Expenses, middlewares: [requireUser] }];
}

async function appWith(routes: AppRoutes) {
    return await createTestApp({ routes, channels: CHANNELS, getSessionCookie });
}

// ============================================
// Snapshot on connect
// ============================================

describe("live loader — snapshot on connect", () => {
    it("a fresh connection receives the current state, with its own principal", async () => {
        store[7] = 42;
        const routes = expensesRoutes();
        const app = await appWith(routes);
        const Expenses = routes[0]!.module!;

        const sub = await app.as({ user: { id: 1, teamId: 7 } }).channel(Expenses, "teamExpenses");
        expect(sub.status).toBe(200);
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 42 });

        await sub.close();
        await app.close();
    });

    it("a reconnect is a new connection and gets a new snapshot", async () => {
        store[7] = 1;
        const routes = expensesRoutes();
        const app = await appWith(routes);
        const Expenses = routes[0]!.module!;
        const user = app.as({ user: { id: 1, teamId: 7 } });

        const first = await user.channel(Expenses, "teamExpenses");
        expect(await first.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 1 });
        await first.close();

        // The server moved on while nobody was connected.
        store[7] = 99;
        const second = await user.channel(Expenses, "teamExpenses");
        expect(await second.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 99 });

        await second.close();
        await app.close();
    });

    it("two principals of different partitions receive distinct snapshots (CA4)", async () => {
        store[7] = 10;
        store[8] = 20;
        const routes = expensesRoutes();
        const app = await appWith(routes);
        const Expenses = routes[0]!.module!;

        const a = await app.as({ user: { id: 1, teamId: 7 } }).channel(Expenses, "teamExpenses");
        const b = await app.as({ user: { id: 2, teamId: 8 } }).channel(Expenses, "teamExpenses");

        expect(await a.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 10 });
        expect(await b.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 20 });

        await a.close();
        await b.close();
        await app.close();
    });
});

// ============================================
// Emit
// ============================================

describe("live loader — emit", () => {
    it("re-executes the loader and pushes the snapshot to the emitting partition (CA6a)", async () => {
        store[7] = 10;
        const routes = expensesRoutes();
        const app = await appWith(routes);
        const Expenses = routes[0]!.module!;

        const sub = await app.as({ user: { id: 1, teamId: 7 } }).channel(Expenses, "teamExpenses");
        await sub.next({ timeoutMs: 1000 });

        store[7] = 25;
        await emit("teamExpenses", { teamId: 7 });

        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 25 });

        await sub.close();
        await app.close();
    });

    it("does not reach a connection of another partition (CA6b)", async () => {
        store[7] = 1;
        store[8] = 2;
        const routes = expensesRoutes();
        const app = await appWith(routes);
        const Expenses = routes[0]!.module!;

        const a = await app.as({ user: { id: 1, teamId: 7 } }).channel(Expenses, "teamExpenses");
        const b = await app.as({ user: { id: 2, teamId: 8 } }).channel(Expenses, "teamExpenses");
        await a.next({ timeoutMs: 1000 });
        await b.next({ timeoutMs: 1000 });

        store[7] = 11;
        await emit("teamExpenses", { teamId: 7 });
        expect(await a.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 11 });

        // B's stream is FIFO: a snapshot wrongly pushed by A's emit would be
        // parsed before B's own, so the next event would not be B's value.
        store[8] = 22;
        await emit("teamExpenses", { teamId: 8 });
        expect(await b.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 22 });
        expect(b.events.length).toBe(2); // connect + own emit — nothing else

        await a.close();
        await b.close();
        await app.close();
    });

    it("reaches every module of the channel — layout and page (CA11)", async () => {
        store[7] = 5;
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
        const app = await appWith([
            {
                path: "/expenses",
                module: Layout,
                middlewares: [requireUser],
                children: [{ path: "/", module: Page }],
            },
        ]);
        const user = app.as({ user: { id: 1, teamId: 7 } });

        // One connection per (module, channel) — each feeds its own module.
        const layoutSub = await user.channel(Layout, "teamExpenses");
        const pageSub = await user.channel(Page, "teamExpenses");
        expect(await layoutSub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 5 });
        expect(await pageSub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 5 });

        store[7] = 15;
        await emit("teamExpenses", { teamId: 7 });

        expect(await layoutSub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 15 });
        expect(await pageSub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 15 });

        await layoutSub.close();
        await pageSub.close();
        await app.close();
    });

    it("is a no-op on a valid channel with no subscribers", async () => {
        const app = await appWith(expensesRoutes());
        await expect(emit("teamExpenses", { teamId: 7 })).resolves.toBeUndefined();
        await app.close();
    });

    it("throws immediately on a channel with no entry in the map, naming it (CA6)", async () => {
        const app = await appWith(expensesRoutes());
        await expect(emit("teamExpense", { teamId: 7 })).rejects.toThrow(/teamExpense/);
        await app.close();
    });
});

// ============================================
// Write chain
// ============================================

describe("live loader — write chain", () => {
    it("keeps the chain alive after a failed write and logs it — never silently", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const written: string[] = [];
            const enqueue = createChannelWriteChain("teamExpenses", async (payload) => {
                const data = typeof payload === "string" ? payload : payload.data;
                // A dead connection: the client went away mid-event.
                if (data === "boom") throw new Error("socket gone");
                written.push(data);
            });

            await enqueue({ event: "snapshot", data: "boom" });
            await enqueue({ event: "snapshot", data: "after" });

            // The failure is named (channel + that the snapshot did not land)…
            expect(warn).toHaveBeenCalledTimes(1);
            const message = String(warn.mock.calls[0]![0]);
            expect(message).toContain("teamExpenses");
            expect(message).toContain("SSE write failed");
            // …and the next write still goes through.
            expect(written).toEqual(["after"]);
        } finally {
            warn.mockRestore();
        }
    });
});

// ============================================
// Guards and inheritance
// ============================================

describe("live loader — guards", () => {
    it("inherits the route node middlewares: no session, no subscription (CA3)", async () => {
        const routes = expensesRoutes();
        const app = await appWith(routes);
        const Expenses = routes[0]!.module!;

        const anonymous = await app.channel(Expenses, "teamExpenses");
        expect(anonymous.status).toBe(401);
        expect(anonymous.closed).toBe(true);

        const authenticated = await app
            .as({ user: { id: 1, teamId: 7 } })
            .channel(Expenses, "teamExpenses");
        expect(authenticated.status).toBe(200);
        await authenticated.next({ timeoutMs: 1000 });

        await authenticated.close();
        await app.close();
    });

    it("denies with 403 when the scope returns null (CA5)", async () => {
        const Mod = makeModule({
            moduleId: "public/Mod",
            loader: async () => ({ ok: true }),
            channels: ["partitioned"],
        });
        const app = await appWith([{ path: "/p", module: Mod }]);

        const denied = await app.channel(Mod, "partitioned");
        expect(denied.status).toBe(403);
        expect(denied.closed).toBe(true);

        await app.close();
    });

    it("a channel with no principal is public when its scope ignores it (CA5)", async () => {
        const Mod = makeModule({
            moduleId: "public/Mod",
            loader: async () => ({ ok: true }),
            channels: ["public"],
        });
        const app = await appWith([{ path: "/p", module: Mod }]);

        const sub = await app.channel(Mod, "public");
        expect(sub.status).toBe(200);
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ ok: true });

        await sub.close();
        await app.close();
    });

    it("forging query input never changes the partition (CA5)", async () => {
        store[7] = 3;
        store[9] = 999;
        const routes = expensesRoutes();
        const app = await appWith(routes);
        const Expenses = routes[0]!.module!;

        // A client sending someone else's partition in the query string.
        const sub = await app
            .as({ user: { id: 1, teamId: 7 } })
            .channel(Expenses, "teamExpenses", {
                channel: "team:9",
                query: { partition: "team:9", scope: "9" },
            });
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 3 });

        // An emit for the forged partition reaches nobody on this connection.
        store[9] = 1234;
        await emit("teamExpenses", { teamId: 9 });

        store[7] = 4;
        await emit("teamExpenses", { teamId: 7 });
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 4 });
        expect(sub.events.length).toBe(2);

        await sub.close();
        await app.close();
    });

    it("a module without channels produces no channel route (CA12f)", async () => {
        const Mod = makeModule({
            moduleId: "no/Channels",
            fullPath: "/sem",
            loader: async () => ({ ok: true }),
        });
        const app = await appWith([{ path: "/sem", module: Mod }]);

        const res = await app.get("/_channel/no/Channels/teamExpenses");
        expect(res.status).toBe(404);

        await app.close();
    });

    it("throws a loud error for channels without a loader", async () => {
        const Mod = makeModule({ moduleId: "broken/Mod", channels: ["teamExpenses"] });
        await expect(appWith([{ path: "/q", module: Mod }])).rejects.toThrow(
            /without a `loader`/,
        );
    });

    it("throws a loud error for a channel missing from the app map", async () => {
        const Mod = makeModule({
            moduleId: "broken/Mod",
            loader: async () => ({}),
            channels: ["notInMap"],
        });
        await expect(appWith([{ path: "/q", module: Mod }])).rejects.toThrow(/notInMap/);
    });

    it("registerChannels() accepts the map from bootstrap too", async () => {
        const Mod = makeModule({
            moduleId: "boot/Module",
            loader: async () => ({ ok: 1 }),
            channels: ["public"],
        });
        const app = await createTestApp({
            routes: [{ path: "/b", module: Mod }],
            bootstrap: () => registerChannels(CHANNELS),
        });
        const sub = await app.channel(Mod, "public");
        expect(sub.status).toBe(200);
        await sub.close();
        await app.close();
    });
});
