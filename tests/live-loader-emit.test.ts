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
// Fixture — a family-scoped channel with a shaped loader
// ============================================

interface GastosData {
    soma: number;
    itens: string[];
}

/** Per-family state the loader reads — mutable, so an emit changes the value. */
let store: Record<number, GastosData> = {};

const CHANNELS = {
    gastosFamilia: { scope: (ctx: any) => `familia:${ctx.familiaId}` },
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
function gastosModule(opts: {
    moduleId: string;
    channels?: readonly string[];
    calls?: { n: number };
}) {
    const loader = async ({ c }: LoaderArgs): Promise<GastosData> => {
        if (opts.calls) opts.calls.n++;
        const familiaId = (c.get as unknown as (k: string) => any)("user").familiaId;
        const value = store[familiaId]!;
        return { soma: value.soma, itens: [...value.itens] };
    };

    return {
        Component: () => null,
        metadata: { moduleId: opts.moduleId, fullPath: "/gastos" },
        channels: opts.channels ?? ["gastosFamilia"],
        loader,
    };
}

function routesFor(module: RouteModule): AppRoutes {
    return [{ path: "/gastos", module, middlewares: [requireUser] }];
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
    store = { 7: { soma: 10, itens: ["a"] }, 8: { soma: 20, itens: ["b"] } };
});

// ============================================
// Slice mode — addressed to the (module, channel) pair (CA2)
// ============================================

describe("live loader — slice mode", () => {
    it("delivers the slice to the pair's connection without re-executing the loader (CA2)", async () => {
        const calls = { n: 0 };
        const Page = gastosModule({ moduleId: "gastos/Gastos", calls });
        const app = await appWith(routesFor(Page));

        const sub = await app
            .as({ user: { id: 1, familiaId: 7 } })
            .channel(Page, "gastosFamilia");
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ soma: 10, itens: ["a"] });
        expect(calls.n).toBe(1); // the connect snapshot ran the loader

        await emit(Page, "gastosFamilia", { familiaId: 7 }, { soma: 880 });

        // The wire carries the raw slice, and the loader did not run again.
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ soma: 880 });
        expect(calls.n).toBe(1);

        await sub.close();
        await app.close();
    });

    it("only the connections of that module merge it — the same channel in another module is untouched (CA2)", async () => {
        const calls = { n: 0 };
        // A layout and a page sharing the channel name, with different shapes:
        // the reason the slice is addressed to a module at all.
        const Layout = gastosModule({ moduleId: "gastos/Layout", calls });
        const Page = gastosModule({ moduleId: "gastos/Gastos", calls });
        const app = await appWith([
            {
                path: "/gastos",
                module: Layout as RouteModule,
                middlewares: [requireUser],
                children: [{ path: "/", module: Page as RouteModule }],
            },
        ]);
        const user = app.as({ user: { id: 1, familiaId: 7 } });

        const layoutSub = await user.channel(Layout, "gastosFamilia");
        const pageSub = await user.channel(Page, "gastosFamilia");
        expect(await layoutSub.next({ timeoutMs: 1000 })).toEqual({ soma: 10, itens: ["a"] });
        expect(await pageSub.next({ timeoutMs: 1000 })).toEqual({ soma: 10, itens: ["a"] });

        await emit(Page, "gastosFamilia", { familiaId: 7 }, { soma: 15 });

        expect(await pageSub.next({ timeoutMs: 1000 })).toEqual({ soma: 15 });
        expect(layoutSub.events).toHaveLength(1); // connect only — no slice, no snapshot

        await layoutSub.close();
        await pageSub.close();
        await app.close();
    });

    it("the invalidation mode by name keeps reaching every module of the channel (CA2)", async () => {
        const Layout = gastosModule({ moduleId: "gastos/Layout" });
        const Page = gastosModule({ moduleId: "gastos/Gastos" });
        const app = await appWith([
            {
                path: "/gastos",
                module: Layout as RouteModule,
                middlewares: [requireUser],
                children: [{ path: "/", module: Page as RouteModule }],
            },
        ]);
        const user = app.as({ user: { id: 1, familiaId: 7 } });

        const layoutSub = await user.channel(Layout, "gastosFamilia");
        const pageSub = await user.channel(Page, "gastosFamilia");
        await layoutSub.next({ timeoutMs: 1000 });
        await pageSub.next({ timeoutMs: 1000 });

        store[7] = { soma: 33, itens: ["z"] };
        await emit("gastosFamilia", { familiaId: 7 });

        expect(await layoutSub.next({ timeoutMs: 1000 })).toEqual({ soma: 33, itens: ["z"] });
        expect(await pageSub.next({ timeoutMs: 1000 })).toEqual({ soma: 33, itens: ["z"] });

        await layoutSub.close();
        await pageSub.close();
        await app.close();
    });

    it("does not reach a connection of another partition (CA2)", async () => {
        const calls = { n: 0 };
        const Page = gastosModule({ moduleId: "gastos/Gastos", calls });
        const app = await appWith(routesFor(Page));

        const a = await app.as({ user: { id: 1, familiaId: 7 } }).channel(Page, "gastosFamilia");
        const b = await app.as({ user: { id: 2, familiaId: 8 } }).channel(Page, "gastosFamilia");
        await a.next({ timeoutMs: 1000 });
        await b.next({ timeoutMs: 1000 });

        await emit(Page, "gastosFamilia", { familiaId: 7 }, { soma: 111 });
        expect(await a.next({ timeoutMs: 1000 })).toEqual({ soma: 111 });
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
    const Page = gastosModule({ moduleId: "gastos/Gastos" });

    // A valid slice: known keys, right types.
    void emit(Page, "gastosFamilia", { familiaId: 7 }, { soma: 880 });
    // Partial: sending one key is the point.
    void emit(Page, "gastosFamilia", { familiaId: 7 }, { itens: ["a", "b"] });
    // @ts-expect-error — the key does not exist in the loader's return
    void emit(Page, "gastosFamilia", { familiaId: 7 }, { inexistente: 1 });
    // @ts-expect-error — the value type does not match the loader's return
    void emit(Page, "gastosFamilia", { familiaId: 7 }, { soma: "880" });
    // @ts-expect-error — the slice is required in the module form
    void emit(Page, "gastosFamilia", { familiaId: 7 });
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
        const Page = gastosModule({ moduleId: "gastos/Gastos" });
        await expect(emit(Page, "naoDeclarada", {}, { soma: 1 })).rejects.toThrow(
            /does not declare channel "naoDeclarada"/,
        );
        await expect(emit(Page, "naoDeclarada", {}, { soma: 1 })).rejects.toThrow(
            /gastos\/Gastos/,
        );
    });

    it("throws when the module has no loader", async () => {
        const NoLoader = {
            Component: () => null,
            metadata: { moduleId: "sem/Loader" },
            channels: ["gastosFamilia"],
        };
        await expect(
            emit(NoLoader as any, "gastosFamilia", {}, { soma: 1 }),
        ).rejects.toThrow(/sem\/Loader.*no `loader`/);
    });

    it("throws when the module has no metadata.moduleId", async () => {
        const Anonymous = { channels: ["gastosFamilia"], loader: async () => ({}) };
        await expect(emit(Anonymous as any, "gastosFamilia", {}, {})).rejects.toThrow(
            /metadata\.moduleId/,
        );
    });

    it("throws when the channel has no entry in app/channels.ts", async () => {
        const Page = gastosModule({
            moduleId: "gastos/Gastos",
            channels: ["gastosFamilia", "semMapa"],
        });
        await expect(
            emit(Page, "semMapa", { familiaId: 7 }, { soma: 1 }),
        ).rejects.toThrow(/semMapa/);
    });

    it("throws when the slice is not an object of changed keys", async () => {
        const Page = gastosModule({ moduleId: "gastos/Gastos" });
        await expect(
            emit(Page, "gastosFamilia", { familiaId: 7 }, [1, 2] as any),
        ).rejects.toThrow(/slice must be the object of changed keys/);
        await expect(
            emit(Page, "gastosFamilia", { familiaId: 7 }, 7 as any),
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
        const Page = gastosModule({ moduleId: "gastos/Gastos", calls });
        const app = await appWith(routesFor(Page), { coalesceMs: 20 });

        const sub = await app
            .as({ user: { id: 1, familiaId: 7 } })
            .channel(Page, "gastosFamilia");
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ soma: 10, itens: ["a"] });
        calls.n = 0;

        store[7] = { soma: 2, itens: ["a"] };
        await emit("gastosFamilia", { familiaId: 7 });
        store[7] = { soma: 3, itens: ["a"] };
        await emit("gastosFamilia", { familiaId: 7 });
        store[7] = { soma: 4, itens: ["a"] };
        await emit("gastosFamilia", { familiaId: 7 });

        // Inside the window nothing ran: three gestures, zero rounds.
        expect(calls.n).toBe(0);

        // The window closes: one round, carrying the effect of the three.
        await vi.advanceTimersByTimeAsync(20);
        expect(calls.n).toBe(1);
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ soma: 4, itens: ["a"] });

        // An emit after the close opens a new window.
        store[7] = { soma: 5, itens: ["a"] };
        await emit("gastosFamilia", { familiaId: 7 });
        expect(calls.n).toBe(1);
        await vi.advanceTimersByTimeAsync(20);
        expect(calls.n).toBe(2);
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ soma: 5, itens: ["a"] });

        await sub.close();
        await app.close();
    });

    it("coalesces per (channel, partition) — another partition still gets its own round", async () => {
        vi.useFakeTimers();
        const calls = { n: 0 };
        const Page = gastosModule({ moduleId: "gastos/Gastos", calls });
        const app = await appWith(routesFor(Page), { coalesceMs: 20 });

        const a = await app.as({ user: { id: 1, familiaId: 7 } }).channel(Page, "gastosFamilia");
        const b = await app.as({ user: { id: 2, familiaId: 8 } }).channel(Page, "gastosFamilia");
        await a.next({ timeoutMs: 1000 });
        await b.next({ timeoutMs: 1000 });
        calls.n = 0;

        await emit("gastosFamilia", { familiaId: 7 });
        await emit("gastosFamilia", { familiaId: 8 });
        await emit("gastosFamilia", { familiaId: 7 });

        await vi.advanceTimersByTimeAsync(20);
        // One round per connection: two connections, two loader executions.
        expect(calls.n).toBe(2);

        await a.close();
        await b.close();
        await app.close();
    });

    it("window 0 (the toolkit default) keeps the immediate behavior", async () => {
        const calls = { n: 0 };
        const Page = gastosModule({ moduleId: "gastos/Gastos", calls });
        const app = await appWith(routesFor(Page)); // no channelOptions → 0

        const sub = await app
            .as({ user: { id: 1, familiaId: 7 } })
            .channel(Page, "gastosFamilia");
        await sub.next({ timeoutMs: 1000 });
        calls.n = 0;

        store[7] = { soma: 11, itens: ["a"] };
        await emit("gastosFamilia", { familiaId: 7 });
        // The round already happened when `emit` resolved — no timer to wait for.
        expect(calls.n).toBe(1);
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ soma: 11, itens: ["a"] });

        await sub.close();
        await app.close();
    });

    it("registerChannels without options uses the 50ms default", async () => {
        vi.useFakeTimers();
        const calls = { n: 0 };
        const Page = gastosModule({ moduleId: "gastos/Gastos", calls });
        const app = await appWith(routesFor(Page), { coalesceMs: 0 });

        // Re-register the map without options: the default window applies.
        registerChannels(CHANNELS);

        const sub = await app
            .as({ user: { id: 1, familiaId: 7 } })
            .channel(Page, "gastosFamilia");
        await sub.next({ timeoutMs: 1000 });
        calls.n = 0;

        store[7] = { soma: 12, itens: ["a"] };
        await emit("gastosFamilia", { familiaId: 7 });
        await emit("gastosFamilia", { familiaId: 7 });
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
        const Page = gastosModule({ moduleId: "gastos/Gastos", calls });
        const app = await appWith(routesFor(Page), { coalesceMs: 10_000 });

        const sub = await app
            .as({ user: { id: 1, familiaId: 7 } })
            .channel(Page, "gastosFamilia");
        await sub.next({ timeoutMs: 1000 });
        calls.n = 0;

        // Nowhere near the window closing (10s away): the slice travels now.
        await emit(Page, "gastosFamilia", { familiaId: 7 }, { soma: 42 });
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ soma: 42 });
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
            const Page = gastosModule({ moduleId: "gastos/Gastos" });
            const app = await appWith(routesFor(Page));

            const sub = await app
                .as({ user: { id: 1, familiaId: 7 } })
                .channel(Page, "gastosFamilia");
            await sub.next({ timeoutMs: 1000 });

            await emit("gastosFamilia", { familiaId: 7 });
            await emit(Page, "gastosFamilia", { familiaId: 7 }, { soma: 1 });

            const lines = emitLines(log);
            expect(lines).toHaveLength(2);

            expect(lines[0]).toContain('channel="gastosFamilia"');
            expect(lines[0]).toContain('partition="familia:7"');
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
            const Page = gastosModule({ moduleId: "gastos/Gastos" });
            const app = await appWith(routesFor(Page), { coalesceMs: 20 });

            const a = await app.as({ user: { id: 1, familiaId: 7 } }).channel(Page, "gastosFamilia");
            const b = await app.as({ user: { id: 2, familiaId: 7 } }).channel(Page, "gastosFamilia");
            await a.next({ timeoutMs: 1000 });
            await b.next({ timeoutMs: 1000 });

            await emit("gastosFamilia", { familiaId: 7 });
            await emit("gastosFamilia", { familiaId: 7 });
            await emit("gastosFamilia", { familiaId: 7 });
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
            const Page = gastosModule({ moduleId: "gastos/Gastos" });
            const app = await createTestApp({
                routes: routesFor(Page),
                channels: { gastosFamilia: { scope: () => null } },
                getSessionCookie,
            });

            await emit("gastosFamilia", { familiaId: 7 });
            await emit(Page, "gastosFamilia", { familiaId: 7 }, { soma: 1 });

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
            const Page = gastosModule({ moduleId: "gastos/Gastos" });
            const app = await appWith(routesFor(Page), { logEmits: false });

            const sub = await app
                .as({ user: { id: 1, familiaId: 7 } })
                .channel(Page, "gastosFamilia");
            await sub.next({ timeoutMs: 1000 });

            await emit("gastosFamilia", { familiaId: 7 });
            await emit(Page, "gastosFamilia", { familiaId: 7 }, { soma: 1 });
            expect(await sub.next({ timeoutMs: 1000 })).toEqual({ soma: 10, itens: ["a"] });
            expect(await sub.next({ timeoutMs: 1000 })).toEqual({ soma: 1 });

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

    const membroChannels = {
        gastosFamilia: {
            // A producer that already knows the affected partition names it; a
            // connection resolves its own from the principal's membership.
            scope: (ctx: any) =>
                ctx?.producerPartition ?? membership.get(ctx?.userId) ?? null,
        },
    };

    async function membroApp(routes: AppRoutes) {
        return await createTestApp({ routes, channels: membroChannels, getSessionCookie });
    }

    beforeEach(() => {
        membership.set(1, "familia:7");
        membership.set(2, "familia:7");
    });

    it("drops and closes a connection whose partition moved — it receives nothing", async () => {
        const Page = gastosModule({ moduleId: "gastos/Gastos" });
        const app = await membroApp([
            { path: "/gastos", module: Page as RouteModule, middlewares: [requireUser] },
        ]);

        const a = await app.as({ user: { userId: 1, familiaId: 7 } }).channel(Page, "gastosFamilia");
        const b = await app.as({ user: { userId: 2, familiaId: 7 } }).channel(Page, "gastosFamilia");
        expect(await a.next({ timeoutMs: 1000 })).toEqual({ soma: 10, itens: ["a"] });
        expect(await b.next({ timeoutMs: 1000 })).toEqual({ soma: 10, itens: ["a"] });

        // The principal's membership moved between the subscription and the emit.
        membership.set(1, "familia:9");
        store[7] = { soma: 30, itens: ["a"] };

        await emit("gastosFamilia", { producerPartition: "familia:7" });

        // A was re-derived to another partition: closed, and no snapshot of the
        // group it no longer belongs to.
        await expect(a.next({ timeoutMs: 1000 })).rejects.toThrow(/closed/);
        expect(a.events).toHaveLength(1);

        // B still belongs: it receives the snapshot.
        expect(await b.next({ timeoutMs: 1000 })).toEqual({ soma: 30, itens: ["a"] });
        expect(b.events).toHaveLength(2);

        await b.close();
        await app.close();
    });

    it("drops and closes a connection whose scope now returns null", async () => {
        const Page = gastosModule({ moduleId: "gastos/Gastos" });
        const app = await membroApp([
            { path: "/gastos", module: Page as RouteModule, middlewares: [requireUser] },
        ]);

        const a = await app.as({ user: { userId: 1, familiaId: 7 } }).channel(Page, "gastosFamilia");
        const b = await app.as({ user: { userId: 2, familiaId: 7 } }).channel(Page, "gastosFamilia");
        await a.next({ timeoutMs: 1000 });
        await b.next({ timeoutMs: 1000 });

        membership.set(1, null);

        await emit("gastosFamilia", { producerPartition: "familia:7" });

        await expect(a.next({ timeoutMs: 1000 })).rejects.toThrow(/closed/);
        expect(a.events).toHaveLength(1);
        expect(await b.next({ timeoutMs: 1000 })).toEqual({ soma: 10, itens: ["a"] });

        await b.close();
        await app.close();
    });

    it("revalidates before a slice too — the dropped connection gets no slice", async () => {
        const calls = { n: 0 };
        const Page = gastosModule({ moduleId: "gastos/Gastos", calls });
        const app = await membroApp([
            { path: "/gastos", module: Page as RouteModule, middlewares: [requireUser] },
        ]);

        const a = await app.as({ user: { userId: 1, familiaId: 7 } }).channel(Page, "gastosFamilia");
        const b = await app.as({ user: { userId: 2, familiaId: 7 } }).channel(Page, "gastosFamilia");
        await a.next({ timeoutMs: 1000 });
        await b.next({ timeoutMs: 1000 });

        membership.set(1, "familia:9");
        await emit(Page, "gastosFamilia", { producerPartition: "familia:7" }, { soma: 77 });

        await expect(a.next({ timeoutMs: 1000 })).rejects.toThrow(/closed/);
        expect(a.events).toHaveLength(1);
        expect(await b.next({ timeoutMs: 1000 })).toEqual({ soma: 77 });

        await b.close();
        await app.close();
    });
});

// ============================================
// Toolkit (CA11)
// ============================================

describe("live loader — toolkit contract (CA11)", () => {
    it("next() keeps returning the raw data (snapshot or slice) as it travels", async () => {
        const Page = gastosModule({ moduleId: "gastos/Gastos" });
        const app = await appWith(routesFor(Page));

        const sub = await app
            .as({ user: { id: 1, familiaId: 7 } })
            .channel(Page, "gastosFamilia");
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ soma: 10, itens: ["a"] });

        await emit(Page, "gastosFamilia", { familiaId: 7 }, { soma: 99 });
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ soma: 99 }); // raw, unmerged

        await sub.close();
        await app.close();
    });

    it("nextEvent() discriminates the mode that delivered the update", async () => {
        const Page = gastosModule({ moduleId: "gastos/Gastos" });
        const app = await appWith(routesFor(Page));

        const sub = await app
            .as({ user: { id: 1, familiaId: 7 } })
            .channel(Page, "gastosFamilia");

        expect(await sub.nextEvent({ timeoutMs: 1000 })).toEqual({
            type: "snapshot",
            data: { soma: 10, itens: ["a"] },
        });

        store[7] = { soma: 25, itens: ["a"] };
        await emit("gastosFamilia", { familiaId: 7 });
        expect(await sub.nextEvent({ timeoutMs: 1000 })).toEqual({
            type: "snapshot",
            data: { soma: 25, itens: ["a"] },
        });

        await emit(Page, "gastosFamilia", { familiaId: 7 }, { itens: ["x", "y"] });
        expect(await sub.nextEvent({ timeoutMs: 1000 })).toEqual({
            type: "slice",
            data: { itens: ["x", "y"] },
        });

        await sub.close();
        await app.close();
    });
});
