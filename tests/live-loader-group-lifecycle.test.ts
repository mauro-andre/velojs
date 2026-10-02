/**
 * Live loader — group lifecycle (slice 4), exercised through `createTestApp`.
 *
 * A channel's group is a (channel, partition) pair: `onGroupOpen` fires when the
 * first connection enters it and `onGroupClose` when the last one leaves — by
 * any cause (disconnect, idle, revalidation) — which is where a source with a
 * cost of life (a filesystem watcher, a process) arms and disarms instead of
 * running forever for an empty group. Both hooks are awaited: the group is only
 * marked open after `onGroupOpen` resolves and only discarded after
 * `onGroupClose` resolves; a hook that throws is logged loudly and the group
 * continues.
 *
 * Deterministic by construction: the connect snapshot is the clock and the
 * gates are promises the test releases by hand.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { getCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import { createTestApp } from "../src/testing/index.js";
import { emit, inspectChannels } from "../src/channels.js";
import type {
    ChannelDefinition,
    ChannelGroupCloseContext,
    ChannelGroupOpenContext,
} from "../src/channels.js";
import type { AppRoutes, RouteModule } from "../src/types.js";

// ============================================
// Fixture — a resource channel with hooks
// ============================================

const getSessionCookie = async ({ user }: { user: { id: number } }) => ({
    user: JSON.stringify(user),
});

const requireUser: MiddlewareHandler = async (c, next) => {
    const raw = getCookie(c, "user");
    if (!raw) return c.json({ error: "unauthorized" }, 401);
    (c.set as unknown as (k: string, v: unknown) => void)("user", JSON.parse(raw));
    await next();
};

function projectModule(): RouteModule {
    return {
        Component: () => null,
        metadata: { moduleId: "projeto/Projeto", fullPath: "/projeto/:id" },
        loader: async ({ params }: any) => ({ id: params.id ?? null }),
        channels: ["projetoArquivos"],
    } as RouteModule;
}

function projectRoutes(): AppRoutes {
    return [{ path: "/projeto/:id", module: projectModule(), middlewares: [requireUser] }];
}

async function appWith(channels: Record<string, ChannelDefinition>, extra = {}) {
    const routes = projectRoutes();
    const app = await createTestApp({
        routes,
        channels,
        getSessionCookie,
        ...extra,
    });
    return { app, Projeto: routes[0]!.module! };
}

const opens: ChannelGroupOpenContext[] = [];
const closes: ChannelGroupCloseContext[] = [];

function resourceChannel(extra: Partial<ChannelDefinition> = {}): ChannelDefinition {
    return {
        scope: ({ params }: any) => `projeto:${params.id}`,
        ...extra,
    };
}

afterEach(() => {
    vi.useRealTimers();
});

// ============================================
// onGroupOpen — first connection only, with { partition, params } (CA8)
// ============================================

describe("live loader — onGroupOpen", () => {
    it("fires once, on the first connection, with the partition and the params (CA8)", async () => {
        opens.length = 0;
        const { app, Projeto } = await appWith({
            projetoArquivos: resourceChannel({
                onGroupOpen: (ctx) => {
                    opens.push(ctx);
                },
            }),
        });

        const sub = await app
            .as({ user: { id: 1 } })
            .channel(Projeto, "projetoArquivos", { params: { id: "7" } });
        await sub.next({ timeoutMs: 1000 });

        expect(opens).toEqual([{ partition: "projeto:7", params: { id: "7" } }]);

        await sub.close();
        await app.close();
    });

    it("a second connection of the same group does not fire it again — another resource does (CA8)", async () => {
        opens.length = 0;
        const { app, Projeto } = await appWith({
            projetoArquivos: resourceChannel({
                onGroupOpen: (ctx) => {
                    opens.push(ctx);
                },
            }),
        });
        const session = app.as({ user: { id: 1 } });

        const a = await session.channel(Projeto, "projetoArquivos", { params: { id: "7" } });
        const b = await session.channel(Projeto, "projetoArquivos", { params: { id: "7" } });
        await a.next({ timeoutMs: 1000 });
        await b.next({ timeoutMs: 1000 });
        expect(opens).toHaveLength(1);

        // Another resource is another group — its own open.
        const c = await session.channel(Projeto, "projetoArquivos", { params: { id: "9" } });
        await c.next({ timeoutMs: 1000 });
        expect(opens.map((o) => o.partition)).toEqual(["projeto:7", "projeto:9"]);

        await a.close();
        await b.close();
        await c.close();
        await app.close();
    });

    it("awaits an async hook: the connect snapshot only lands after it resolves (CA8)", async () => {
        const order: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const { app, Projeto } = await appWith({
            projetoArquivos: resourceChannel({
                onGroupOpen: async ({ partition }) => {
                    await gate;
                    order.push(`open:${partition}`);
                },
            }),
        });

        const sub = await app
            .as({ user: { id: 1 } })
            .channel(Projeto, "projetoArquivos", { params: { id: "7" } });

        // Registered, but the group is not open yet — the snapshot waits.
        expect(inspectChannels().totalConnections).toBe(1);
        expect(order).toEqual([]);

        release();
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ id: "7" });
        expect(order).toEqual(["open:projeto:7"]);

        await sub.close();
        await app.close();
    });

    it("a hook that throws is logged loudly and the group continues (CA8)", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const { app, Projeto } = await appWith({
                projetoArquivos: resourceChannel({
                    onGroupOpen: async () => {
                        throw new Error("watcher exploded");
                    },
                }),
            });
            const session = app.as({ user: { id: 1 } });

            const sub = await session.channel(Projeto, "projetoArquivos", {
                params: { id: "7" },
            });
            // The cold-source snapshot still arrives — only the live data waits
            // for the hook to be fixed, and the log says so.
            expect(await sub.next({ timeoutMs: 1000 })).toEqual({ id: "7" });

            const logged = error.mock.calls.map((c) => String(c[0])).join("\n");
            expect(logged).toContain('channel "projetoArquivos"');
            expect(logged).toContain("onGroupOpen failed");
            expect(logged).toContain('"projeto:7"');

            // The group continues: a second connection opens no new hook and
            // still gets its snapshot.
            const second = await session.channel(Projeto, "projetoArquivos", {
                params: { id: "7" },
            });
            expect(await second.next({ timeoutMs: 1000 })).toEqual({ id: "7" });
            expect(inspectChannels().totalConnections).toBe(2);

            await sub.close();
            await second.close();
            await app.close();
        } finally {
            error.mockRestore();
        }
    });
});

// ============================================
// onGroupClose — last connection out, by any cause (CA8)
// ============================================

describe("live loader — onGroupClose", () => {
    it("fires when the last connection disconnects — not on the first of two (CA8)", async () => {
        closes.length = 0;
        const { app, Projeto } = await appWith({
            projetoArquivos: resourceChannel({
                onGroupClose: (ctx) => {
                    closes.push(ctx);
                },
            }),
        });
        const session = app.as({ user: { id: 1 } });

        const a = await session.channel(Projeto, "projetoArquivos", { params: { id: "7" } });
        const b = await session.channel(Projeto, "projetoArquivos", { params: { id: "7" } });
        await a.next({ timeoutMs: 1000 });
        await b.next({ timeoutMs: 1000 });

        await a.close();
        expect(closes).toEqual([]); // b still holds the group

        await b.close();
        expect(closes).toEqual([{ partition: "projeto:7" }]);
        expect(inspectChannels().totalConnections).toBe(0);

        await app.close();
    });

    it("fires on the idle timeout — the same gesture as any server-side close (CA8)", async () => {
        vi.useFakeTimers();
        closes.length = 0;
        const { app, Projeto } = await appWith(
            {
                projetoArquivos: resourceChannel({
                    onGroupClose: (ctx) => {
                        closes.push(ctx);
                    },
                }),
            },
            { channelOptions: { idleMs: 50 } },
        );

        const sub = await app
            .as({ user: { id: 1 } })
            .channel(Projeto, "projetoArquivos", { params: { id: "7" } });
        await sub.next({ timeoutMs: 1000 });

        await vi.advanceTimersByTimeAsync(50);

        expect(closes).toEqual([{ partition: "projeto:7" }]);
        expect(inspectChannels().totalConnections).toBe(0);

        await sub.close();
        await app.close();
    });

    it("fires on the revalidation drop — the group empties before the discard (CA8)", async () => {
        closes.length = 0;
        const flip = { moved: false };
        const { app, Projeto } = await appWith({
            projetoArquivos: {
                scope: ({ params }: any) =>
                    params?.partition ?? (flip.moved ? "projeto:9" : "projeto:7"),
                onGroupClose: (ctx) => {
                    closes.push(ctx);
                },
            },
        });

        const sub = await app
            .as({ user: { id: 1 } })
            .channel(Projeto, "projetoArquivos", { params: { id: "7" } });
        await sub.next({ timeoutMs: 1000 });

        // The connection now belongs to another partition: the next emit of its
        // group drops it — and the group closes.
        flip.moved = true;
        await emit("projetoArquivos", { params: { partition: "projeto:7" } });

        await expect(sub.next({ timeoutMs: 1000 })).rejects.toThrow(/closed/);
        expect(closes).toEqual([{ partition: "projeto:7" }]);
        expect(inspectChannels().totalConnections).toBe(0);

        await app.close();
    });

    it("awaits an async hook before the group is discarded (CA8)", async () => {
        vi.useFakeTimers();
        const order: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const { app, Projeto } = await appWith(
            {
                projetoArquivos: resourceChannel({
                    onGroupClose: async ({ partition }) => {
                        await gate;
                        order.push(`close:${partition}`);
                    },
                }),
            },
            { channelOptions: { idleMs: 50 } },
        );

        const sub = await app
            .as({ user: { id: 1 } })
            .channel(Projeto, "projetoArquivos", { params: { id: "7" } });
        await sub.next({ timeoutMs: 1000 });

        await vi.advanceTimersByTimeAsync(50);
        expect(order).toEqual([]);
        // The watcher is still being disarmed: the group is not gone yet.
        expect(inspectChannels().totalConnections).toBe(1);

        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(order).toEqual(["close:projeto:7"]);
        expect(inspectChannels().totalConnections).toBe(0);

        await sub.close();
        await app.close();
    });

    it("re-arms the surviving group when a connection enters while the close hook runs (CA8)", async () => {
        const order: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const { app, Projeto } = await appWith({
            projetoArquivos: resourceChannel({
                onGroupOpen: ({ params }: any) => {
                    order.push(`open:${params.id}`);
                },
                onGroupClose: async () => {
                    await gate;
                    order.push("close");
                },
            }),
        });
        const session = app.as({ user: { id: 1 } });

        const a = await session.channel(Projeto, "projetoArquivos", { params: { id: "7" } });
        await a.next({ timeoutMs: 1000 });
        expect(order).toEqual(["open:7"]);

        // The last connection leaves: the watcher starts disarming and parks on
        // the gate, still holding the group.
        await a.close();
        expect(order).toEqual(["open:7"]);

        // A new connection of the same group arrives while the disarm runs: it
        // finds the group occupied, so it does not arm it itself.
        const b = await session.channel(Projeto, "projetoArquivos", { params: { id: "7" } });
        expect(await b.next({ timeoutMs: 1000 })).toEqual({ id: "7" });
        expect(order).toEqual(["open:7"]);

        // The disarm finishes: the group survived, so it is re-armed for b —
        // a live group never stays without its source.
        release();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(order).toEqual(["open:7", "close", "open:7"]);
        expect(inspectChannels().totalConnections).toBe(1);

        await b.close();
        await app.close();
    });

    it("a close hook that throws is logged loudly and the teardown completes (CA8)", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const { app, Projeto } = await appWith({
                projetoArquivos: resourceChannel({
                    onGroupClose: async () => {
                        throw new Error("watcher refused to die");
                    },
                }),
            });

            const sub = await app
                .as({ user: { id: 1 } })
                .channel(Projeto, "projetoArquivos", { params: { id: "7" } });
            await sub.next({ timeoutMs: 1000 });
            await sub.close();

            const logged = error.mock.calls.map((c) => String(c[0])).join("\n");
            expect(logged).toContain('channel "projetoArquivos"');
            expect(logged).toContain("onGroupClose failed");
            expect(inspectChannels().totalConnections).toBe(0);

            await app.close();
        } finally {
            error.mockRestore();
        }
    });
});