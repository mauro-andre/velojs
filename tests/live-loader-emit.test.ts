/**
 * Live loader — rich emission (slice 2), exercised through `createTestApp`.
 *
 * Covers the slice mode addressed to the (module, channel) pair, the merge
 * contract on the arrival side (client, jsdom — see
 * `live-loader-client.test.tsx`), the server-side coalescing window, the emit
 * log, the partition revalidation on every emit and the new guards.
 *
 * Everything is deterministic: a channel subscription registers on the server
 * before its connect snapshot is written, so awaiting the next event is the
 * clock — no sleep, no retry, no timing assertion. The coalescing window is
 * driven by fake timers, never by waiting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import { createTestApp } from "../src/testing/index.js";
import { emit, registerChannels } from "../src/channels.js";
import type { AppRoutes, LoaderArgs, RouteModule } from "../src/types.js";

// ============================================
// Fixture — a team-scoped channel with a shaped loader
// ============================================

interface ExpensesData {
    teamTotal: number;
    items: string[];
}

/** Per-team state the loader reads — mutable, so an emit changes the value. */
let store: Record<number, ExpensesData> = {};

const CHANNELS = {
    teamExpenses: { scope: (ctx: any) => `team:${ctx.teamId}` },
};

const getSessionCookie = async ({ user }: { user: any }) => ({
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
 * A page module whose loader returns a shaped value — the shape the typed
 * slice is checked against. `calls` counts loader executions, which is how the
 * tests prove a slice does not re-execute anything.
 */
function expensesModule(opts: {
    moduleId: string;
    channels?: readonly string[];
    calls?: { n: number };
}) {
    const loader = async ({ c }: LoaderArgs): Promise<ExpensesData> => {
        if (opts.calls) opts.calls.n++;
        const teamId = (c.get as unknown as (k: string) => any)("user").teamId;
        const value = store[teamId]!;
        return { teamTotal: value.teamTotal, items: [...value.items] };
    };

    return {
        Component: () => null,
        metadata: { moduleId: opts.moduleId, fullPath: "/expenses" },
        channels: opts.channels ?? ["teamExpenses"],
        loader,
    };
}

function routesFor(module: RouteModule): AppRoutes {
    return [{ path: "/expenses", module, middlewares: [requireUser] }];
}

async function appWith(
    routes: AppRoutes,
    channelOptions?: { coalesceMs?: number; logEmits?: boolean },
) {
    return await createTestApp({
        routes,
        channels: CHANNELS,
        getSessionCookie,
        ...(channelOptions ? { channelOptions } : {}),
    });
}

beforeEach(() => {
    store = { 7: { teamTotal: 10, items: ["a"] }, 8: { teamTotal: 20, items: ["b"] } };
});

// ============================================
// Slice mode — addressed to the (module, channel) pair (CA2)
// ============================================

describe("live loader — slice mode", () => {
    it("delivers the slice to the pair's connection without re-executing the loader (CA2)", async () => {
        const calls = { n: 0 };
        const Page = expensesModule({ moduleId: "expenses/Expenses", calls });
        const app = await appWith(routesFor(Page));

        const sub = await app
            .as({ user: { id: 1, teamId: 7 } })
            .channel(Page, "teamExpenses");
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 10, items: ["a"] });
        expect(calls.n).toBe(1); // the connect snapshot ran the loader

        await emit(Page, "teamExpenses", { teamId: 7 }, { teamTotal: 880 });

        // The wire carries the raw slice, and the loader did not run again.
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 880 });
        expect(calls.n).toBe(1);

        await sub.close();
        await app.close();
    });

    it("only the connections of that module merge it — the same channel in another module is untouched (CA2)", async () => {
        const calls = { n: 0 };
        // A layout and a page sharing the channel name, with different shapes:
        // the reason the slice is addressed to a module at all.
        const Layout = expensesModule({ moduleId: "expenses/Layout", calls });
        const Page = expensesModule({ moduleId: "expenses/Expenses", calls });
        const app = await appWith([
            {
                path: "/expenses",
                module: Layout as RouteModule,
                middlewares: [requireUser],
                children: [{ path: "/", module: Page as RouteModule }],
            },
        ]);
        const user = app.as({ user: { id: 1, teamId: 7 } });

        const layoutSub = await user.channel(Layout, "teamExpenses");
        const pageSub = await user.channel(Page, "teamExpenses");
        expect(await layoutSub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 10, items: ["a"] });
        expect(await pageSub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 10, items: ["a"] });

        await emit(Page, "teamExpenses", { teamId: 7 }, { teamTotal: 15 });

        expect(await pageSub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 15 });
        expect(layoutSub.events).toHaveLength(1); // connect only — no slice, no snapshot

        await layoutSub.close();
        await pageSub.close();
        await app.close();
    });

    it("the invalidation mode by name keeps reaching every module of the channel (CA2)", async () => {
        const Layout = expensesModule({ moduleId: "expenses/Layout" });
        const Page = expensesModule({ moduleId: "expenses/Expenses" });
        const app = await appWith([
            {
                path: "/expenses",
                module: Layout as RouteModule,
                middlewares: [requireUser],
                children: [{ path: "/", module: Page as RouteModule }],
            },
        ]);
        const user = app.as({ user: { id: 1, teamId: 7 } });

        const layoutSub = await user.channel(Layout, "teamExpenses");
        const pageSub = await user.channel(Page, "teamExpenses");
        await layoutSub.next({ timeoutMs: 1000 });
        await pageSub.next({ timeoutMs: 1000 });

        store[7] = { teamTotal: 33, items: ["z"] };
        await emit("teamExpenses", { teamId: 7 });

        expect(await layoutSub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 33, items: ["z"] });
        expect(await pageSub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 33, items: ["z"] });

        await layoutSub.close();
        await pageSub.close();
        await app.close();
    });

    it("does not reach a connection of another partition (CA2)", async () => {
        const calls = { n: 0 };
        const Page = expensesModule({ moduleId: "expenses/Expenses", calls });
        const app = await appWith(routesFor(Page));

        const a = await app.as({ user: { id: 1, teamId: 7 } }).channel(Page, "teamExpenses");
        const b = await app.as({ user: { id: 2, teamId: 8 } }).channel(Page, "teamExpenses");
        await a.next({ timeoutMs: 1000 });
        await b.next({ timeoutMs: 1000 });

        await emit(Page, "teamExpenses", { teamId: 7 }, { teamTotal: 111 });
        expect(await a.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 111 });
        expect(b.events).toHaveLength(1);

        await a.close();
        await b.close();
        await app.close();
    });
});

// ============================================
// Typing (CA3) — compile-time, checked by `tsc -p tsconfig.test.json`
// ============================================

/**
 * Compile-time only; never called. The slice is a `Partial` of the module's
 * loader return: an unknown key or a wrong value type is a type error, and an
 * unused `@ts-expect-error` (the line below failing to be an error) is too.
 */
function __typeOnlySliceChecks(): void {
    const Page = expensesModule({ moduleId: "expenses/Expenses" });

    // A valid slice: known keys, right types.
    void emit(Page, "teamExpenses", { teamId: 7 }, { teamTotal: 880 });
    // Partial: sending one key is the point.
    void emit(Page, "teamExpenses", { teamId: 7 }, { items: ["a", "b"] });
    // @ts-expect-error — the key does not exist in the loader's return
    void emit(Page, "teamExpenses", { teamId: 7 }, { unknownKey: 1 });
    // @ts-expect-error — the value type does not match the loader's return
    void emit(Page, "teamExpenses", { teamId: 7 }, { teamTotal: "880" });
    // @ts-expect-error — the slice is required in the module form
    void emit(Page, "teamExpenses", { teamId: 7 });
}

describe("live loader — slice typing (CA3)", () => {
    it("types the slice as a Partial of the module's loader return", () => {
        // The assertions are the `@ts-expect-error` lines above: `npm run
        // typecheck` compiles this file (tsconfig.test.json) and would fail on
        // an accepted wrong key or an unused directive.
        expect(__typeOnlySliceChecks).toBeTypeOf("function");
    });
});

// ============================================
// Guards — error immediately, never silence (CA10)
// ============================================

describe("live loader — slice guards", () => {
    it("throws when the module does not declare that channel, naming both", async () => {
        const Page = expensesModule({ moduleId: "expenses/Expenses" });
        await expect(emit(Page, "notDeclared", {}, { teamTotal: 1 })).rejects.toThrow(
            /does not declare channel "notDeclared"/,
        );
        await expect(emit(Page, "notDeclared", {}, { teamTotal: 1 })).rejects.toThrow(
            /expenses\/Expenses/,
        );
    });

    it("throws when the module has no loader", async () => {
        const NoLoader = {
            Component: () => null,
            metadata: { moduleId: "no/Loader" },
            channels: ["teamExpenses"],
        };
        await expect(
            emit(NoLoader as any, "teamExpenses", {}, { teamTotal: 1 }),
        ).rejects.toThrow(/no\/Loader.*no `loader`/);
    });

    it("throws when the module has no metadata.moduleId", async () => {
        const Anonymous = { channels: ["teamExpenses"], loader: async () => ({}) };
        await expect(emit(Anonymous as any, "teamExpenses", {}, {})).rejects.toThrow(
            /metadata\.moduleId/,
        );
    });

    it("throws when the channel has no entry in app/channels.ts", async () => {
        const Page = expensesModule({
            moduleId: "expenses/Expenses",
            channels: ["teamExpenses", "notInMap"],
        });
        await expect(
            emit(Page, "notInMap", { teamId: 7 }, { teamTotal: 1 }),
        ).rejects.toThrow(/notInMap/);
    });

    it("throws when the slice is not an object of changed keys", async () => {
        const Page = expensesModule({ moduleId: "expenses/Expenses" });
        await expect(
            emit(Page, "teamExpenses", { teamId: 7 }, [1, 2] as any),
        ).rejects.toThrow(/slice must be the object of changed keys/);
        await expect(
            emit(Page, "teamExpenses", { teamId: 7 }, 7 as any),
        ).rejects.toThrow(/slice must be the object/);
    });
});

// ============================================
// Coalescing (CA7)
// ============================================

describe("live loader — coalescing (CA7)", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("folds N invalidation emits of one (channel, partition) into one round per connection", async () => {
        vi.useFakeTimers();
        const calls = { n: 0 };
        const Page = expensesModule({ moduleId: "expenses/Expenses", calls });
        const app = await appWith(routesFor(Page), { coalesceMs: 20 });

        const sub = await app
            .as({ user: { id: 1, teamId: 7 } })
            .channel(Page, "teamExpenses");
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 10, items: ["a"] });
        calls.n = 0;

        store[7] = { teamTotal: 2, items: ["a"] };
        await emit("teamExpenses", { teamId: 7 });
        store[7] = { teamTotal: 3, items: ["a"] };
        await emit("teamExpenses", { teamId: 7 });
        store[7] = { teamTotal: 4, items: ["a"] };
        await emit("teamExpenses", { teamId: 7 });

        // Inside the window nothing ran: three gestures, zero rounds.
        expect(calls.n).toBe(0);

        // The window closes: one round, carrying the effect of the three.
        await vi.advanceTimersByTimeAsync(20);
        expect(calls.n).toBe(1);
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 4, items: ["a"] });

        // An emit after the close opens a new window.
        store[7] = { teamTotal: 5, items: ["a"] };
        await emit("teamExpenses", { teamId: 7 });
        expect(calls.n).toBe(1);
        await vi.advanceTimersByTimeAsync(20);
        expect(calls.n).toBe(2);
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 5, items: ["a"] });

        await sub.close();
        await app.close();
    });

    it("coalesces per (channel, partition) — another partition still gets its own round", async () => {
        vi.useFakeTimers();
        const calls = { n: 0 };
        const Page = expensesModule({ moduleId: "expenses/Expenses", calls });
        const app = await appWith(routesFor(Page), { coalesceMs: 20 });

        const a = await app.as({ user: { id: 1, teamId: 7 } }).channel(Page, "teamExpenses");
        const b = await app.as({ user: { id: 2, teamId: 8 } }).channel(Page, "teamExpenses");
        await a.next({ timeoutMs: 1000 });
        await b.next({ timeoutMs: 1000 });
        calls.n = 0;

        await emit("teamExpenses", { teamId: 7 });
        await emit("teamExpenses", { teamId: 8 });
        await emit("teamExpenses", { teamId: 7 });

        await vi.advanceTimersByTimeAsync(20);
        // One round per connection: two connections, two loader executions.
        expect(calls.n).toBe(2);

        await a.close();
        await b.close();
        await app.close();
    });

    it("window 0 (the toolkit default) keeps the immediate behavior", async () => {
        const calls = { n: 0 };
        const Page = expensesModule({ moduleId: "expenses/Expenses", calls });
        const app = await appWith(routesFor(Page)); // no channelOptions → 0

        const sub = await app
            .as({ user: { id: 1, teamId: 7 } })
            .channel(Page, "teamExpenses");
        await sub.next({ timeoutMs: 1000 });
        calls.n = 0;

        store[7] = { teamTotal: 11, items: ["a"] };
        await emit("teamExpenses", { teamId: 7 });
        // The round already happened when `emit` resolved — no timer to wait for.
        expect(calls.n).toBe(1);
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 11, items: ["a"] });

        await sub.close();
        await app.close();
    });

    it("registerChannels without options uses the 50ms default", async () => {
        vi.useFakeTimers();
        const calls = { n: 0 };
        const Page = expensesModule({ moduleId: "expenses/Expenses", calls });
        const app = await appWith(routesFor(Page), { coalesceMs: 0 });

        // Re-register the map without options: the default window applies.
        registerChannels(CHANNELS);

        const sub = await app
            .as({ user: { id: 1, teamId: 7 } })
            .channel(Page, "teamExpenses");
        await sub.next({ timeoutMs: 1000 });
        calls.n = 0;

        store[7] = { teamTotal: 12, items: ["a"] };
        await emit("teamExpenses", { teamId: 7 });
        await emit("teamExpenses", { teamId: 7 });
        expect(calls.n).toBe(0);

        await vi.advanceTimersByTimeAsync(49);
        expect(calls.n).toBe(0); // still inside the default 50ms window
        await vi.advanceTimersByTimeAsync(2);
        expect(calls.n).toBe(1); // one round for both gestures

        await sub.close();
        await app.close();
    });

    it("a slice does not wait for the window — it is pushed directly", async () => {
        vi.useFakeTimers();
        const calls = { n: 0 };
        const Page = expensesModule({ moduleId: "expenses/Expenses", calls });
        const app = await appWith(routesFor(Page), { coalesceMs: 10_000 });

        const sub = await app
            .as({ user: { id: 1, teamId: 7 } })
            .channel(Page, "teamExpenses");
        await sub.next({ timeoutMs: 1000 });
        calls.n = 0;

        // Nowhere near the window closing (10s away): the slice travels now.
        await emit(Page, "teamExpenses", { teamId: 7 }, { teamTotal: 42 });
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 42 });
        expect(calls.n).toBe(0);

        await sub.close();
        await app.close();
    });
});

// ============================================
// Emit log (CA8)
// ============================================

function emitLines(log: { mock: { calls: unknown[][] } }): string[] {
    return log.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("[velojs] emit"));
}

describe("live loader — emit log (CA8)", () => {
    it("logs one line per gesture with channel, partition, kind, connections and timestamp", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
            const Page = expensesModule({ moduleId: "expenses/Expenses" });
            const app = await appWith(routesFor(Page));

            const sub = await app
                .as({ user: { id: 1, teamId: 7 } })
                .channel(Page, "teamExpenses");
            await sub.next({ timeoutMs: 1000 });

            await emit("teamExpenses", { teamId: 7 });
            await emit(Page, "teamExpenses", { teamId: 7 }, { teamTotal: 1 });

            const lines = emitLines(log);
            expect(lines).toHaveLength(2);

            expect(lines[0]).toContain('channel="teamExpenses"');
            expect(lines[0]).toContain('partition="team:7"');
            expect(lines[0]).toContain("kind=invalidate");
            expect(lines[0]).toContain("connections=1");
            expect(lines[0]).toMatch(/at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

            expect(lines[1]).toContain("kind=slice");
            expect(lines[1]).toContain("connections=1");

            await sub.close();
            await app.close();
        } finally {
            log.mockRestore();
        }
    });

    it("counts the group at the gesture — before coalescing and revalidation — and never twice", async () => {
        vi.useFakeTimers();
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
            const Page = expensesModule({ moduleId: "expenses/Expenses" });
            const app = await appWith(routesFor(Page), { coalesceMs: 20 });

            const a = await app.as({ user: { id: 1, teamId: 7 } }).channel(Page, "teamExpenses");
            const b = await app.as({ user: { id: 2, teamId: 7 } }).channel(Page, "teamExpenses");
            await a.next({ timeoutMs: 1000 });
            await b.next({ timeoutMs: 1000 });

            await emit("teamExpenses", { teamId: 7 });
            await emit("teamExpenses", { teamId: 7 });
            await emit("teamExpenses", { teamId: 7 });
            expect(emitLines(log)).toHaveLength(3);
            expect(emitLines(log)[0]).toContain("connections=2");

            // The consolidated delivery adds no line.
            await vi.advanceTimersByTimeAsync(20);
            expect(emitLines(log)).toHaveLength(3);

            await a.close();
            await b.close();
            await app.close();
        } finally {
            log.mockRestore();
            vi.useRealTimers();
        }
    });

    it("logs an emit whose scope resolves to nothing — reaching nobody is what the log is for", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
            const Page = expensesModule({ moduleId: "expenses/Expenses" });
            const app = await createTestApp({
                routes: routesFor(Page),
                channels: { teamExpenses: { scope: () => null } },
                getSessionCookie,
            });

            await emit("teamExpenses", { teamId: 7 });
            await emit(Page, "teamExpenses", { teamId: 7 }, { teamTotal: 1 });

            const lines = emitLines(log);
            expect(lines).toHaveLength(2);
            expect(lines[0]).toContain("partition=null");
            expect(lines[0]).toContain("connections=0");
            expect(lines[1]).toContain("kind=slice");

            await app.close();
        } finally {
            log.mockRestore();
        }
    });

    it("logs nothing when logEmits is false", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
            const Page = expensesModule({ moduleId: "expenses/Expenses" });
            const app = await appWith(routesFor(Page), { logEmits: false });

            const sub = await app
                .as({ user: { id: 1, teamId: 7 } })
                .channel(Page, "teamExpenses");
            await sub.next({ timeoutMs: 1000 });

            await emit("teamExpenses", { teamId: 7 });
            await emit(Page, "teamExpenses", { teamId: 7 }, { teamTotal: 1 });
            expect(await sub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 10, items: ["a"] });
            expect(await sub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 1 });

            expect(emitLines(log)).toHaveLength(0);

            await sub.close();
            await app.close();
        } finally {
            log.mockRestore();
        }
    });
});

// ============================================
// Partition revalidation on every emit (CA9)
// ============================================

describe("live loader — partition revalidation (CA9)", () => {
    /** The principal's current membership — the answer can move between subscribe and emit. */
    const membership = new Map<number, string | null>();

    const memberChannels = {
        teamExpenses: {
            // A producer that already knows the affected partition names it; a
            // connection resolves its own from the principal's membership.
            scope: (ctx: any) =>
                ctx?.producerPartition ?? membership.get(ctx?.userId) ?? null,
        },
    };

    async function memberApp(routes: AppRoutes) {
        return await createTestApp({ routes, channels: memberChannels, getSessionCookie });
    }

    beforeEach(() => {
        membership.set(1, "team:7");
        membership.set(2, "team:7");
    });

    it("drops and closes a connection whose partition moved — it receives nothing", async () => {
        const Page = expensesModule({ moduleId: "expenses/Expenses" });
        const app = await memberApp([
            { path: "/expenses", module: Page as RouteModule, middlewares: [requireUser] },
        ]);

        const a = await app.as({ user: { userId: 1, teamId: 7 } }).channel(Page, "teamExpenses");
        const b = await app.as({ user: { userId: 2, teamId: 7 } }).channel(Page, "teamExpenses");
        expect(await a.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 10, items: ["a"] });
        expect(await b.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 10, items: ["a"] });

        // The principal's membership moved between the subscription and the emit.
        membership.set(1, "team:9");
        store[7] = { teamTotal: 30, items: ["a"] };

        await emit("teamExpenses", { producerPartition: "team:7" });

        // A was re-derived to another partition: closed, and no snapshot of the
        // group it no longer belongs to.
        await expect(a.next({ timeoutMs: 1000 })).rejects.toThrow(/closed/);
        expect(a.events).toHaveLength(1);

        // B still belongs: it receives the snapshot.
        expect(await b.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 30, items: ["a"] });
        expect(b.events).toHaveLength(2);

        await b.close();
        await app.close();
    });

    it("drops and closes a connection whose scope now returns null", async () => {
        const Page = expensesModule({ moduleId: "expenses/Expenses" });
        const app = await memberApp([
            { path: "/expenses", module: Page as RouteModule, middlewares: [requireUser] },
        ]);

        const a = await app.as({ user: { userId: 1, teamId: 7 } }).channel(Page, "teamExpenses");
        const b = await app.as({ user: { userId: 2, teamId: 7 } }).channel(Page, "teamExpenses");
        await a.next({ timeoutMs: 1000 });
        await b.next({ timeoutMs: 1000 });

        membership.set(1, null);

        await emit("teamExpenses", { producerPartition: "team:7" });

        await expect(a.next({ timeoutMs: 1000 })).rejects.toThrow(/closed/);
        expect(a.events).toHaveLength(1);
        expect(await b.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 10, items: ["a"] });

        await b.close();
        await app.close();
    });

    it("revalidates before a slice too — the dropped connection gets no slice", async () => {
        const calls = { n: 0 };
        const Page = expensesModule({ moduleId: "expenses/Expenses", calls });
        const app = await memberApp([
            { path: "/expenses", module: Page as RouteModule, middlewares: [requireUser] },
        ]);

        const a = await app.as({ user: { userId: 1, teamId: 7 } }).channel(Page, "teamExpenses");
        const b = await app.as({ user: { userId: 2, teamId: 7 } }).channel(Page, "teamExpenses");
        await a.next({ timeoutMs: 1000 });
        await b.next({ timeoutMs: 1000 });

        membership.set(1, "team:9");
        await emit(Page, "teamExpenses", { producerPartition: "team:7" }, { teamTotal: 77 });

        await expect(a.next({ timeoutMs: 1000 })).rejects.toThrow(/closed/);
        expect(a.events).toHaveLength(1);
        expect(await b.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 77 });

        await b.close();
        await app.close();
    });
});

// ============================================
// Toolkit (CA11)
// ============================================

describe("live loader — toolkit contract (CA11)", () => {
    it("next() keeps returning the raw data (snapshot or slice) as it travels", async () => {
        const Page = expensesModule({ moduleId: "expenses/Expenses" });
        const app = await appWith(routesFor(Page));

        const sub = await app
            .as({ user: { id: 1, teamId: 7 } })
            .channel(Page, "teamExpenses");
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 10, items: ["a"] });

        await emit(Page, "teamExpenses", { teamId: 7 }, { teamTotal: 99 });
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 99 }); // raw, unmerged

        await sub.close();
        await app.close();
    });

    it("nextEvent() discriminates the mode that delivered the update", async () => {
        const Page = expensesModule({ moduleId: "expenses/Expenses" });
        const app = await appWith(routesFor(Page));

        const sub = await app
            .as({ user: { id: 1, teamId: 7 } })
            .channel(Page, "teamExpenses");

        expect(await sub.nextEvent({ timeoutMs: 1000 })).toEqual({
            type: "snapshot",
            data: { teamTotal: 10, items: ["a"] },
        });

        store[7] = { teamTotal: 25, items: ["a"] };
        await emit("teamExpenses", { teamId: 7 });
        expect(await sub.nextEvent({ timeoutMs: 1000 })).toEqual({
            type: "snapshot",
            data: { teamTotal: 25, items: ["a"] },
        });

        await emit(Page, "teamExpenses", { teamId: 7 }, { items: ["x", "y"] });
        expect(await sub.nextEvent({ timeoutMs: 1000 })).toEqual({
            type: "slice",
            data: { items: ["x", "y"] },
        });

        await sub.close();
        await app.close();
    });
});
