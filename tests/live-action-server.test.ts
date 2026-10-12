/**
 * Live actions — server side (slice 1), exercised through `createTestApp`.
 *
 * A tab is not a route: it is a subscription to an action with its own args
 * (`app.liveAction(Module, "abrirFicha", { args })`). Everything here is
 * deterministic: the subscription registers on the server before its connect
 * snapshot is written, so awaiting the next arrival is the clock — no sleep, no
 * retry, no timing assertion. The transport clocks default to 0 in the toolkit;
 * the tests that exercise them pass them explicitly and drive fake timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import { createTestApp } from "../src/testing/index.js";
import { emit, inspectChannels } from "../src/channels.js";
import type { ActionArgs, AppRoutes, LoaderArgs, RouteModule } from "../src/types.js";

// ============================================
// Fixture — the canonical finance app, a project sheet per tab
// ============================================

interface Ficha {
    nome: string;
    fase: string;
}

/** Per-project state the action reads — mutable, so an emit changes the value. */
let fichas: Record<number, Ficha>;

/** The args each live action execution received — how the suite proves isolation. */
let abrirCalls: { id: number }[] = [];

/** Principals banned at the policy layer — the scope denies them on entry. */
let banned: Set<number>;

const CHANNELS = {
    fichaProjeto: {
        // The canonical resource scope: the partition derives from the address
        // the subscription itself declared (`args`), with the ownership check
        // on the principal — the same ruler the live-loader doc carves for a
        // resource channel (`if (user && !podeVer(user, id)) return null`).
        scope: ({ user, args }: any) => {
            if (args?.id == null) return null;
            if (user && banned.has(user.id)) return null;
            return `projeto:${args.id}`;
        },
    },
    expenseSheet: {
        // The canonical shared-pont scope: declared by a loader (partitioned by
        // the route's `params`) AND by a live action (partitioned by its
        // `args`) — one scope, one partition.
        scope: ({ params, args }: any) =>
            "expense:" + String(args?.id ?? params?.id ?? ""),
    },
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
 * The page module of the tab UI: the Component renders the shell (the tab
 * bar), the live action carries the content of one tab, addressed by args.
 */
function projetoModule(opts: {
    moduleId?: string;
    calls?: { id: number }[];
    channels?: readonly string[];
    liveActions?: Record<string, readonly string[]>;
} = {}): RouteModule {
    const calls = opts.calls ?? abrirCalls;
    const mod: any = {
        Component: () => null,
        metadata: { moduleId: opts.moduleId ?? "projeto/Projeto", fullPath: "/projeto" },
        action_abrirFicha: async ({ body }: ActionArgs<{ id: number }>) => {
            calls.push({ id: body.id });
            return { ...fichas[body.id]! };
        },
    };
    if (opts.liveActions) mod.liveActions = opts.liveActions;
    else mod.liveActions = { abrirFicha: opts.channels ?? ["fichaProjeto"] };
    return mod as RouteModule;
}

function projetoRoutes(module: RouteModule): AppRoutes {
    return [{ path: "/projeto", module, middlewares: [requireUser] }];
}

async function projetoApp(module: RouteModule = projetoModule()) {
    return await createTestApp({
        routes: projetoRoutes(module),
        channels: CHANNELS,
        getSessionCookie,
    });
}

beforeEach(() => {
    fichas = {
        7: { nome: "Site", fase: "build" },
        9: { nome: "App", fase: "review" },
    };
    abrirCalls = [];
    banned = new Set();
});

afterEach(() => {
    vi.useRealTimers();
});

// ============================================
// The subscription — snapshot on connect, emit delivers (CA1)
// ============================================

describe("live action — subscription", () => {
    it("the connect snapshot is the action executed once with the declared args (CA1, CA5)", async () => {
        const app = await projetoApp();

        const sub = await app
            .as({ user: { id: 1 } })
            .liveAction("projeto/Projeto", "abrirFicha", { args: { id: 7 } });

        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ nome: "Site", fase: "build" });
        expect(abrirCalls).toEqual([{ id: 7 }]); // one execution, the loading gesture

        await sub.close();
        await app.close();
    });

    it("an emit in the action's channel re-executes it with the same args and delivers the value (CA1)", async () => {
        const app = await projetoApp();

        const sub = await app
            .as({ user: { id: 1 } })
            .liveAction("projeto/Projeto", "abrirFicha", { args: { id: 7 } });
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ nome: "Site", fase: "build" });

        fichas[7] = { nome: "Site", fase: "review" };
        await emit("fichaProjeto", { args: { id: 7 } });

        // The whole value, replaced — no merge.
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ nome: "Site", fase: "review" });
        expect(abrirCalls).toEqual([{ id: 7 }, { id: 7 }]);

        await sub.close();
        await app.close();
    });

    it("the re-executed action receives the same ActionArgs ruler — body carries the declared args", async () => {
        let seen: ActionArgs<any> | null = null;
        const mod: any = {
            Component: () => null,
            metadata: { moduleId: "projeto/Projeto", fullPath: "/projeto" },
            liveActions: { abrirFicha: ["fichaProjeto"] },
            action_abrirFicha: async (args: ActionArgs<any>) => {
                seen = args;
                return { ok: true };
            },
        };
        const app = await createTestApp({
            routes: [{ path: "/projeto", module: mod as RouteModule, middlewares: [requireUser] }],
            channels: CHANNELS,
            getSessionCookie,
        });

        const sub = await app
            .as({ user: { id: 1 } })
            .liveAction(mod, "abrirFicha", { args: { id: 7 } });
        await sub.next({ timeoutMs: 1000 });

        expect(seen!.body).toEqual({ id: 7 });
        expect(seen!.c).toBeDefined(); // the connection's context
        expect(seen!.params).toEqual({}); // the route is static, like /_action

        await sub.close();
        await app.close();
    });

    it("the args are the subscription's identity — another id is another subscription", async () => {
        const app = await projetoApp();
        const user = app.as({ user: { id: 1 } });

        const a = await user.liveAction("projeto/Projeto", "abrirFicha", { args: { id: 7 } });
        const b = await user.liveAction("projeto/Projeto", "abrirFicha", { args: { id: 9 } });
        expect(await a.next({ timeoutMs: 1000 })).toEqual({ nome: "Site", fase: "build" });
        expect(await b.next({ timeoutMs: 1000 })).toEqual({ nome: "App", fase: "review" });

        // The partition derives from the args: id 7 wakes a, not b (CA2, CA8).
        fichas[7] = { nome: "Site", fase: "done" };
        await emit("fichaProjeto", { args: { id: 7 } });

        expect(await a.next({ timeoutMs: 1000 })).toEqual({ nome: "Site", fase: "done" });
        expect(b.events).toHaveLength(1); // nothing arrived: no re-execution either
        expect(abrirCalls.filter((call) => call.id === 9)).toHaveLength(1); // connect only

        await a.close();
        await b.close();
        await app.close();
    });
});

// ============================================
// Isolation — other subjects get nothing (CA2)
// ============================================

describe("live action — isolation", () => {
    it("an emit for another partition neither re-executes the action nor touches the connection (CA2)", async () => {
        const calls: { id: number }[] = [];
        const app = await projetoApp(projetoModule({ calls }));

        const sub = await app
            .as({ user: { id: 1 } })
            .liveAction("projeto/Projeto", "abrirFicha", { args: { id: 7 } });
        await sub.next({ timeoutMs: 1000 });
        calls.length = 0;

        await emit("fichaProjeto", { args: { id: 9 } });

        expect(calls).toHaveLength(0); // the action of another subject did not run
        expect(sub.events).toHaveLength(1); // and no traffic arrived

        await sub.close();
        await app.close();
    });

    it("a loader-addressed slice does not reach a live subscription — the shapes differ", async () => {
        // The slice mode is typed to the LOADER's return; a live subscription's
        // value has the ACTION's shape (slices for live actions are a later
        // slice). The wire proves it: nothing arrives, nothing runs.
        const calls: { id: number }[] = [];
        const Mod = projetoModule({ calls });
        (Mod as any).loader = async () => ({ sheet: "page-data" });
        (Mod as any).channels = ["fichaProjeto"];
        const app = await createTestApp({
            routes: projetoRoutes(Mod),
            channels: CHANNELS,
            getSessionCookie,
        });

        const tab = await app
            .as({ user: { id: 1 } })
            .liveAction(Mod, "abrirFicha", { args: { id: 7 } });
        expect(await tab.next({ timeoutMs: 1000 })).toEqual({ nome: "Site", fase: "build" });
        calls.length = 0;

        await emit(Mod, "fichaProjeto", { args: { id: 7 } }, { sheet: "sliced" });

        expect(tab.events).toHaveLength(1); // no slice on the live wire
        expect(calls).toHaveLength(0);      // and no re-execution either

        await tab.close();
        await app.close();
    });

    it("a module without liveActions has no /_live route — actions behave exactly as before (CA5)", async () => {
        const mod: any = {
            Component: () => null,
            metadata: { moduleId: "plain/Page", fullPath: "/plain" },
            action_save: async ({ body }: ActionArgs<{ x: number }>) => ({ saved: body.x }),
        };
        const app = await createTestApp({
            routes: [{ path: "/plain", module: mod as RouteModule }],
            channels: CHANNELS,
        });

        const res = await app.hono.request("/_live/plain/Page/save");
        expect(res.status).toBe(404);
        await res.body?.cancel().catch(() => {});

        // The common action call keeps its shape and cost.
        const call = await app.action(mod.action_save, { body: { x: 1 } });
        expect(call.status).toBe(200);
        expect(await call.json()).toEqual({ saved: 1 });

        await app.close();
    });
});

// ============================================
// Lifecycle — close cuts, remount reborn, group hooks (CA3, CA4, CA16)
// ============================================

describe("live action — lifecycle", () => {
    it("closing the subscription cuts the receiving — the inspector sees it gone, the group closes (CA3)", async () => {
        const closes: string[] = [];
        const channels = {
            fichaProjeto: {
                scope: CHANNELS.fichaProjeto.scope,
                onGroupClose: ({ partition }: any) => {
                    closes.push(partition);
                },
            },
        };
        const app = await createTestApp({
            routes: projetoRoutes(projetoModule()),
            channels,
            getSessionCookie,
        });

        const sub = await app
            .as({ user: { id: 1 } })
            .liveAction("projeto/Projeto", "abrirFicha", { args: { id: 7 } });
        await sub.next({ timeoutMs: 1000 });

        expect(inspectChannels().liveActions).toHaveLength(1);
        expect(inspectChannels().totalConnections).toBe(1);

        await sub.close();

        // The inspector no longer holds the subscription.
        expect(inspectChannels().liveActions).toHaveLength(0);
        expect(inspectChannels().totalConnections).toBe(0);

        // Nothing arrives after the closing — the server holds nothing for the gone.
        fichas[7] = { nome: "Site", fase: "done" };
        await emit("fichaProjeto", { args: { id: 7 } });
        expect(sub.events).toHaveLength(1);

        // Being the last of the group, the disarm hook ran.
        expect(await vi.waitFor(() => closes)).toEqual(["projeto:7"]);

        await app.close();
    });

    it("remounting with the same args is a new subscription with a snapshot of the current state (CA4)", async () => {
        const app = await projetoApp();

        const first = await app
            .as({ user: { id: 1 } })
            .liveAction("projeto/Projeto", "abrirFicha", { args: { id: 7 } });
        expect(await first.next({ timeoutMs: 1000 })).toEqual({ nome: "Site", fase: "build" });
        await first.close();

        // The server moves while nobody watches.
        fichas[7] = { nome: "Site", fase: "review" };

        // The tab reopens (the refresh restored it): reborn, current, live.
        const second = await app
            .as({ user: { id: 1 } })
            .liveAction("projeto/Projeto", "abrirFicha", { args: { id: 7 } });
        expect(await second.next({ timeoutMs: 1000 })).toEqual({ nome: "Site", fase: "review" });

        fichas[7] = { nome: "Site", fase: "done" };
        await emit("fichaProjeto", { args: { id: 7 } });
        expect(await second.next({ timeoutMs: 1000 })).toEqual({ nome: "Site", fase: "done" });

        await second.close();
        await app.close();
    });

    it("onGroupOpen receives the args of the subscription that opened the group (CA16)", async () => {
        const opens: any[] = [];
        const closes: string[] = [];
        const channels = {
            fichaProjeto: {
                scope: CHANNELS.fichaProjeto.scope,
                onGroupOpen: (ctx: any) => {
                    opens.push(ctx);
                },
                onGroupClose: (ctx: any) => {
                    closes.push(ctx.partition);
                },
            },
        };
        const app = await createTestApp({
            routes: projetoRoutes(projetoModule()),
            channels,
            getSessionCookie,
        });

        const sub = await app
            .as({ user: { id: 1 } })
            .liveAction("projeto/Projeto", "abrirFicha", { args: { id: 7 } });
        await sub.next({ timeoutMs: 1000 });
        await sub.close();

        expect(opens).toEqual([{ partition: "projeto:7", params: {}, args: { id: 7 } }]);
        expect(await vi.waitFor(() => closes)).toEqual(["projeto:7"]);

        await app.close();
    });

    it("a second subscription of the same group arms nothing; the last one out disarms once (CA16)", async () => {
        const opens: any[] = [];
        const closes: string[] = [];
        const channels = {
            fichaProjeto: {
                scope: CHANNELS.fichaProjeto.scope,
                onGroupOpen: (ctx: any) => {
                    opens.push(ctx);
                },
                onGroupClose: (ctx: any) => {
                    closes.push(ctx.partition);
                },
            },
        };
        const app = await createTestApp({
            routes: projetoRoutes(projetoModule()),
            channels,
            getSessionCookie,
        });
        const user = app.as({ user: { id: 1 } });

        const a = await user.liveAction("projeto/Projeto", "abrirFicha", { args: { id: 7 } });
        const b = await user.liveAction("projeto/Projeto", "abrirFicha", { args: { id: 7 } });
        await a.next({ timeoutMs: 1000 });
        await b.next({ timeoutMs: 1000 });

        await a.close();
        expect(closes).toHaveLength(0); // not the last one

        await b.close();
        expect(await vi.waitFor(() => closes)).toEqual(["projeto:7"]); // the last disarmed
        expect(opens).toHaveLength(1);

        await app.close();
    });
});

// ============================================
// Guards — middlewares for real, scope denial, args size (CA8, CA11)
// ============================================

describe("live action — guards", () => {
    it("the route node's middlewares run for real: no session, no subscription (CA8)", async () => {
        const app = await projetoApp();

        const res = await app.hono.request(
            "/_live/projeto/Projeto/abrirFicha?_args=" + encodeURIComponent('{"id":7}'),
        );
        expect(res.status).toBe(401); // requireUser denied — exactly as it denies the page
        await res.body?.cancel().catch(() => {});

        await app.close();
    });

    it("a scope that resolves to nothing denies the subscription with 403 (CA8)", async () => {
        const app = await projetoApp();

        // No declared address: the scope has nothing to partition.
        const denied = await app
            .as({ user: { id: 1 } })
            .liveAction("projeto/Projeto", "abrirFicha", { args: {} });
        expect(denied.status).toBe(403);

        await app.close();
    });

    it("a scope that throws denies with 403, loudly (CA8)", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const channels = {
                fichaProjeto: {
                    scope: () => {
                        throw new Error("boom");
                    },
                },
            };
            const app = await createTestApp({
                routes: projetoRoutes(projetoModule()),
                channels,
                getSessionCookie,
            });

            const denied = await app
                .as({ user: { id: 1 } })
                .liveAction("projeto/Projeto", "abrirFicha", { args: { id: 7 } });
            expect(denied.status).toBe(403);
            expect(error).toHaveBeenCalled();

            await app.close();
        } finally {
            error.mockRestore();
        }
    });

    it("serialized args above 4096 bytes reject the subscription with 400, naming action and limit (CA11)", async () => {
        const app = await projetoApp();
        const cookie = `user=${encodeURIComponent(JSON.stringify({ id: 1 }))}`;

        const res = await app.hono.request(
            "/_live/projeto/Projeto/abrirFicha?_args=" +
                encodeURIComponent(JSON.stringify({ id: 7, blob: "x".repeat(5000) })),
            { headers: { cookie } },
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe("args-too-large");
        expect(body.message).toContain("projeto/Projeto/abrirFicha");
        expect(body.message).toContain("4096");

        await app.close();
    });

    it("a malformed ?_args= payload rejects with 400", async () => {
        const app = await projetoApp();
        const cookie = `user=${encodeURIComponent(JSON.stringify({ id: 1 }))}`;

        const res = await app.hono.request(
            "/_live/projeto/Projeto/abrirFicha?_args=" + encodeURIComponent("{not json"),
            { headers: { cookie } },
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.message).toContain("_args");
        await app.close();
    });

    it("registering a liveActions entry without the action is a loud server error", async () => {
        const mod: any = {
            Component: () => null,
            metadata: { moduleId: "broken/Broken", fullPath: "/broken" },
            liveActions: { naoExiste: ["fichaProjeto"] },
        };
        await expect(
            createTestApp({
                routes: [{ path: "/broken", module: mod as RouteModule }],
                channels: CHANNELS,
            }),
        ).rejects.toThrow(/broken\/Broken.*naoExiste.*action_naoExiste/);
    });

    it("registering a channel with no entry in app/channels.ts is a loud server error", async () => {
        const mod: any = {
            Component: () => null,
            metadata: { moduleId: "broken/Broken", fullPath: "/broken" },
            liveActions: { abrirFicha: ["canalDesconhecido"] },
            action_abrirFicha: async () => ({}),
        };
        await expect(
            createTestApp({
                routes: [{ path: "/broken", module: mod as RouteModule }],
                channels: CHANNELS,
            }),
        ).rejects.toThrow(/broken\/Broken.*canalDesconhecido/);
    });
});

// ============================================
// One channel, two surfaces — loader and live action (CA9)
// ============================================

describe("live action — a channel shared with a loader", () => {
    function sheetModule(): RouteModule {
        const mod: any = {
            Component: () => null,
            metadata: { moduleId: "expenses/Sheet", fullPath: "/expenses/:id" },
            loader: async ({ params }: LoaderArgs) => ({
                total: sheetTotals[Number(params.id)] ?? 0,
            }),
            channels: ["expenseSheet"],
            action_abrirExpense: async ({ body }: ActionArgs<{ id: number }>) => ({
                total: sheetTotals[body.id] ?? 0,
                linhas: sheetRows[body.id] ?? [],
            }),
            liveActions: { abrirExpense: ["expenseSheet"] },
        };
        return mod as RouteModule;
    }

    let sheetTotals: Record<number, number>;
    let sheetRows: Record<number, string[]>;

    beforeEach(() => {
        sheetTotals = { 7: 10 };
        sheetRows = { 7: ["mercado"] };
    });

    it("one emit by name updates the page and the tab, each with its own data (CA9)", async () => {
        const Mod = sheetModule();
        const app = await createTestApp({
            routes: [{ path: "/expenses/:id", module: Mod }],
            channels: CHANNELS,
        });

        // The page (loader, address declared by the route it is seeing).
        const page = await app.channel(Mod, "expenseSheet", { params: { id: "7" } });
        expect(await page.next({ timeoutMs: 1000 })).toEqual({ total: 10 });

        // The tab (live action, address declared by its own args).
        const tab = await app.liveAction(Mod, "abrirExpense", { args: { id: 7 } });
        expect(await tab.next({ timeoutMs: 1000 })).toEqual({ total: 10, linhas: ["mercado"] });

        // One gesture, by name: both surfaces wake, each re-executing its own source.
        sheetTotals[7] = 12;
        sheetRows[7] = ["mercado", "luz"];
        await emit("expenseSheet", { args: { id: 7 } });

        expect(await page.next({ timeoutMs: 1000 })).toEqual({ total: 12 });
        expect(await tab.next({ timeoutMs: 1000 })).toEqual({ total: 12, linhas: ["mercado", "luz"] });

        await page.close();
        await tab.close();
        await app.close();
    });
});

// ============================================
// Error keeps the last value — the wire carries it as an event (CA10)
// ============================================

describe("live action — errors", () => {
    function flakyModule(fail: { now: boolean }): RouteModule {
        const mod: any = {
            Component: () => null,
            metadata: { moduleId: "projeto/Projeto", fullPath: "/projeto" },
            action_abrirFicha: async ({ body }: ActionArgs<{ id: number }>) => {
                if (fail.now) throw new Error("ficha unavailable");
                return { ...fichas[body.id]! };
            },
            liveActions: { abrirFicha: ["fichaProjeto"] },
        };
        return mod as RouteModule;
    }

    it("an error in a re-execution arrives as a typed event — the payload stream keeps its last value (CA10)", async () => {
        const fail = { now: false };
        const app = await createTestApp({
            routes: projetoRoutes(flakyModule(fail)),
            channels: CHANNELS,
            getSessionCookie,
        });

        const sub = await app
            .as({ user: { id: 1 } })
            .liveAction("projeto/Projeto", "abrirFicha", { args: { id: 7 } });
        expect((await sub.nextEvent({ timeoutMs: 1000 })).type).toBe("snapshot");

        fail.now = true;
        await emit("fichaProjeto", { args: { id: 7 } });

        const event = await sub.nextEvent({ timeoutMs: 1000 });
        expect(event.type).toBe("error");
        expect((event.data as any).message).toContain("ficha unavailable");
        expect(sub.events).toHaveLength(1); // the snapshot — an error is not a payload

        await sub.close();
        await app.close();
    });

    it("an error in the connect snapshot is reported the same way (CA10)", async () => {
        const app = await createTestApp({
            routes: projetoRoutes(flakyModule({ now: true })),
            channels: CHANNELS,
            getSessionCookie,
        });

        const sub = await app
            .as({ user: { id: 1 } })
            .liveAction("projeto/Projeto", "abrirFicha", { args: { id: 7 } });
        const event = await sub.nextEvent({ timeoutMs: 1000 });
        expect(event.type).toBe("error");
        expect(sub.events).toHaveLength(0);

        await sub.close();
        await app.close();
    });
});

// ============================================
// Transport — the same ruler as the channel (CA6)
// ============================================

describe("live action — transport", () => {
    it("the SSE answer carries Cache-Control: no-store (CA6)", async () => {
        const app = await projetoApp();

        const res = await app.hono.request(
            "/_live/projeto/Projeto/abrirFicha?_args=" + encodeURIComponent('{"id":7}'),
            { headers: { cookie: `user=${encodeURIComponent(JSON.stringify({ id: 1 }))}` } },
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");

        await res.body!.cancel();
        await app.close();
    });

    it("no polling exists — data moves only on emit; the heartbeat comment is not an event (CA6)", async () => {
        vi.useFakeTimers();
        const app = await createTestApp({
            routes: projetoRoutes(projetoModule()),
            channels: CHANNELS,
            getSessionCookie,
            channelOptions: { heartbeatMs: 20 },
        });
        const cookie = `user=${encodeURIComponent(JSON.stringify({ id: 1 }))}`;
        const path = "/_live/projeto/Projeto/abrirFicha?_args=" + encodeURIComponent('{"id":7}');

        // A raw tap on the wire: transport artifacts (the `: ping` comment)
        // carry no event and no data — only the snapshot and the emit do.
        let buffer = "";
        const res = await app.hono.request(path, { headers: { cookie } });
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        const pump = (async () => {
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) return;
                    buffer += decoder.decode(value, { stream: true });
                }
            } catch {
                // canceled by the teardown
            }
        })();

        // The connect snapshot is on the wire...
        await vi.waitFor(() => expect(buffer).toContain("event: snapshot"));
        const snapshotsAfterConnect = buffer.split("event: snapshot").length - 1;

        // ...two heartbeat windows pass with no emit: only comments on the wire.
        await vi.advanceTimersByTimeAsync(45);
        expect(buffer).toContain(": ping");
        expect(buffer.split("event: snapshot").length - 1).toBe(snapshotsAfterConnect);
        expect(buffer).not.toContain("event: error");

        // The data moves when the emit happens — and only then.
        fichas[7] = { nome: "Site", fase: "review" };
        await emit("fichaProjeto", { args: { id: 7 } });
        await vi.waitFor(() =>
            expect(buffer.split("event: snapshot").length - 1).toBe(snapshotsAfterConnect + 1),
        );
        expect(buffer).toContain('"fase":"review"');

        await reader.cancel().catch(() => {});
        await pump.catch(() => {});
        await app.close();
        vi.useRealTimers();
    });

    it("idle timeout closes a silent subscription — the toolkit default is 0 (determinism)", async () => {
        vi.useFakeTimers();
        const app = await createTestApp({
            routes: projetoRoutes(projetoModule()),
            channels: CHANNELS,
            getSessionCookie,
            channelOptions: { idleMs: 100 },
        });

        const sub = await app
            .as({ user: { id: 1 } })
            .liveAction("projeto/Projeto", "abrirFicha", { args: { id: 7 } });
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ nome: "Site", fase: "build" });

        await vi.advanceTimersByTimeAsync(100);
        expect(sub.closed).toBe(true);
        expect(inspectChannels().liveActions).toHaveLength(0);

        await app.close();
        vi.useRealTimers();
    });
});

// ============================================
// Inspector (CA14)
// ============================================

describe("live action — inspector", () => {
    it("lists the live subscriptions with module, action, args and groups, next to the loader groups (CA14)", async () => {
        const app = await projetoApp();
        const user = app.as({ user: { id: 1 } });

        const sub = await user.liveAction("projeto/Projeto", "abrirFicha", { args: { id: 7 } });
        await sub.next({ timeoutMs: 1000 });

        const report = inspectChannels();
        expect(report.liveActions).toHaveLength(1);
        expect(report.liveActions[0]).toMatchObject({
            moduleId: "projeto/Projeto",
            action: "abrirFicha",
            args: { id: 7 },
        });
        expect(report.liveActions[0]!.channels).toEqual([
            { channel: "fichaProjeto", partition: "projeto:7" },
        ]);
        // One subscription is one connection — however many groups it entered.
        expect(report.totalConnections).toBe(1);

        await sub.close();
        await app.close();
    });

    it("a subscription declaring two channels enters both groups — and counts once (CA14)", async () => {
        const channels = {
            ...CHANNELS,
            fichaAuditoria: { scope: ({ args }: any) => `aud:${args?.id}` },
        };
        const mod = projetoModule({
            liveActions: { abrirFicha: ["fichaProjeto", "fichaAuditoria"] },
        });
        const app = await createTestApp({
            routes: projetoRoutes(mod),
            channels,
            getSessionCookie,
        });

        const sub = await app
            .as({ user: { id: 1 } })
            .liveAction("projeto/Projeto", "abrirFicha", { args: { id: 7 } });
        await sub.next({ timeoutMs: 1000 });

        const report = inspectChannels();
        expect(report.liveActions[0]!.channels).toEqual([
            { channel: "fichaProjeto", partition: "projeto:7" },
            { channel: "fichaAuditoria", partition: "aud:7" },
        ]);
        expect(report.totalConnections).toBe(1);

        // An emit in ANY of the declared channels delivers.
        fichas[7] = { nome: "Site", fase: "review" };
        await emit("fichaAuditoria", { args: { id: 7 } });
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ nome: "Site", fase: "review" });

        await sub.close();
        await app.close();
    });
});

// ============================================
// Partition revalidation — the live twin (the ruler of CA8)
// ============================================

describe("live action — partition revalidation", () => {
    it("an emit drops a subscription whose scope now denies it (fail-closed)", async () => {
        const app = await createTestApp({
            routes: projetoRoutes(projetoModule()),
            channels: CHANNELS,
            getSessionCookie,
        });

        const a = await app
            .as({ user: { id: 1 } })
            .liveAction("projeto/Projeto", "abrirFicha", { args: { id: 7 } });
        const b = await app
            .as({ user: { id: 2 } })
            .liveAction("projeto/Projeto", "abrirFicha", { args: { id: 7 } });
        await a.next({ timeoutMs: 1000 });
        await b.next({ timeoutMs: 1000 });

        banned.add(1); // the first principal lost access between subscribe and emit
        fichas[7] = { nome: "Site", fase: "review" };
        await emit("fichaProjeto", { args: { id: 7 } });

        // A was re-derived to nothing: closed, and no value of a group it left.
        await expect(a.next({ timeoutMs: 1000 })).rejects.toThrow(/closed/);
        expect(a.events).toHaveLength(1);

        // B still belongs: it receives the value.
        expect(await b.next({ timeoutMs: 1000 })).toEqual({ nome: "Site", fase: "review" });

        await b.close();
        await app.close();
    });
});
