/**
 * Live loader — route params (slice 4), exercised through `createTestApp`.
 *
 * The client **declares** the address it is already seeing — the params its own
 * URL carries, the same information `?_data=1` sends on every SPA navigation.
 * The server **decides**: it validates the shape against the module's declared
 * path and the scope validates the policy (ownership/permission), deriving the
 * partition. The client never chooses a scope; a declaration is not an input of
 * authorization.
 *
 * Deterministic by construction: the channel subscription registers on the
 * server before its connect snapshot is written, so awaiting the first `next()`
 * is the clock — no sleep, no retry, no timing assertion.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import { createTestApp } from "../src/testing/index.js";
import {
    declaredRouteParams,
    emit,
    inspectChannels,
    parseRouteParamsQuery,
} from "../src/channels.js";
import type { AppRoutes, LoaderArgs, RouteModule } from "../src/types.js";

// ============================================
// Fixture — /projeto/:id, a resource-partitioned channel
// ============================================

type ProjectUser = { id: number; projects: string[] };

/** Files per project — mutable, so an emit changes the state. */
let store: Record<string, string[]> = {};

/** Every scope call, recorded: the ctx shape is part of the contract. */
let scopeCalls: Array<{ user: unknown; params: unknown }> = [];

const CHANNELS = {
    projetoArquivos: {
        // On subscribe the ctx is `{ user, params }`: the resource is validated
        // against the principal (ownership) and the key derived from it. On
        // emit the producer builds the same shape with the fields the scope
        // consumes — `{ params }` is the whole address of a resource channel —
        // and the ownership check applies wherever a principal exists.
        scope: ({ user, params }: any) => {
            scopeCalls.push({ user, params });
            const id = params?.id;
            if (id == null) return null;
            if (user && !user.projects.includes(String(id))) return null;
            return `projeto:${id}`;
        },
    },
    principal: { scope: ({ user }: any) => `user:${user.id}` },
};

const getSessionCookie = async ({ user }: { user: ProjectUser }) => ({
    user: JSON.stringify(user),
});

/** Materializes the principal under the house key ("user"). */
const requireUser: MiddlewareHandler = async (c, next) => {
    const raw = getCookie(c, "user");
    if (!raw) return c.json({ error: "unauthorized" }, 401);
    (c.set as unknown as (k: string, v: unknown) => void)("user", JSON.parse(raw));
    await next();
};

/** A loader that reads the connection's params and query — and returns both. */
const projectFiles = async ({ params, query }: LoaderArgs) => ({
    id: params.id ?? null,
    files: store[params.id ?? ""] ?? [],
    query,
});

function makeModule(opts: {
    moduleId: string;
    fullPath?: string;
    loader?: (args: LoaderArgs) => unknown;
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

function projectRoutes(): AppRoutes {
    const Projeto = makeModule({
        moduleId: "projeto/Projeto",
        fullPath: "/projeto/:id",
        loader: projectFiles,
        channels: ["projetoArquivos"],
    });
    return [{ path: "/projeto/:id", module: Projeto, middlewares: [requireUser] }];
}

async function appWith(routes: AppRoutes) {
    return await createTestApp({ routes, channels: CHANNELS, getSessionCookie });
}

const user = { id: 1, projects: ["7", "9"] };

beforeEach(() => {
    store = { "7": ["a.txt", "b.txt"], "9": ["z.txt"] };
    scopeCalls = [];
});

// ============================================
// The loader re-executes with the connection's params (CA2)
// ============================================

describe("live loader — the loader runs with the connection's params", () => {
    it("the connect snapshot carries the data of the declared resource (CA2)", async () => {
        const routes = projectRoutes();
        const app = await appWith(routes);
        const Projeto = routes[0]!.module!;
        const session = app.as({ user });

        const seven = await session.channel(Projeto, "projetoArquivos", {
            params: { id: "7" },
        });
        const nine = await session.channel(Projeto, "projetoArquivos", {
            params: { id: "9" },
        });

        expect(seven.status).toBe(200);
        expect(nine.status).toBe(200);
        expect(await seven.next({ timeoutMs: 1000 })).toEqual({
            id: "7",
            files: ["a.txt", "b.txt"],
            query: {},
        });
        expect(await nine.next({ timeoutMs: 1000 })).toEqual({
            id: "9",
            files: ["z.txt"],
            query: {},
        });

        await seven.close();
        await nine.close();
        await app.close();
    });

    it("an emit re-executes the loader with the params of each connection (CA3)", async () => {
        const routes = projectRoutes();
        const app = await appWith(routes);
        const Projeto = routes[0]!.module!;
        const session = app.as({ user });

        const seven = await session.channel(Projeto, "projetoArquivos", {
            params: { id: "7" },
        });
        const nine = await session.channel(Projeto, "projetoArquivos", {
            params: { id: "9" },
        });
        await seven.next({ timeoutMs: 1000 });
        await nine.next({ timeoutMs: 1000 });

        store["7"] = ["c.txt"];
        await emit("projetoArquivos", { params: { id: 7 } });

        expect(await seven.next({ timeoutMs: 1000 })).toEqual({
            id: "7",
            files: ["c.txt"],
            query: {},
        });
        // The other resource did not move: nothing travels to its group.
        expect(nine.events).toHaveLength(1);

        await seven.close();
        await nine.close();
        await app.close();
    });

    it("the query delivered to the loader excludes the internal `_route` key (CA4)", async () => {
        const routes = projectRoutes();
        const app = await appWith(routes);
        const Projeto = routes[0]!.module!;

        const sub = await app.as({ user }).channel(Projeto, "projetoArquivos", {
            params: { id: "7" },
            query: { tab: "files" },
        });

        // `_route` is protocol transport, not page data.
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({
            id: "7",
            files: ["a.txt", "b.txt"],
            query: { tab: "files" },
        });

        await sub.close();
        await app.close();
    });
});

// ============================================
// Partition relevance (CA3)
// ============================================

describe("live loader — partition relevance by resource", () => {
    it("two connections of the same principal in different resources land in different partitions (CA3)", async () => {
        const routes = projectRoutes();
        const app = await appWith(routes);
        const Projeto = routes[0]!.module!;
        const session = app.as({ user });

        const seven = await session.channel(Projeto, "projetoArquivos", {
            params: { id: "7" },
        });
        const nine = await session.channel(Projeto, "projetoArquivos", {
            params: { id: "9" },
        });
        await seven.next({ timeoutMs: 1000 });
        await nine.next({ timeoutMs: 1000 });

        const groups = inspectChannels().channels[0]!.groups.map((g) => g.partition).sort();
        expect(groups).toEqual(["projeto:7", "projeto:9"]);

        store["7"] = ["only-seven.txt"];
        await emit("projetoArquivos", { params: { id: 7 } });

        expect(await seven.next({ timeoutMs: 1000 })).toEqual({
            id: "7",
            files: ["only-seven.txt"],
            query: {},
        });
        expect(nine.events).toHaveLength(1);

        await seven.close();
        await nine.close();
        await app.close();
    });
});

// ============================================
// The scope ctx: { user, params } (CA4)
// ============================================

describe("live loader — the scope ctx", () => {
    it("receives { user, params } on subscribe — the principal and the validated params (CA4)", async () => {
        const routes = projectRoutes();
        const app = await appWith(routes);
        const Projeto = routes[0]!.module!;

        const sub = await app.as({ user }).channel(Projeto, "projetoArquivos", {
            params: { id: "7" },
        });
        await sub.next({ timeoutMs: 1000 });

        expect(scopeCalls[0]).toEqual({
            user: { id: 1, projects: ["7", "9"] },
            params: { id: "7" },
        });

        await sub.close();
        await app.close();
    });

    it("the emit applies the same scope to the object the producer built, verbatim (CA4)", async () => {
        const routes = projectRoutes();
        const app = await appWith(routes);
        const Projeto = routes[0]!.module!;

        const sub = await app.as({ user }).channel(Projeto, "projetoArquivos", {
            params: { id: "7" },
        });
        await sub.next({ timeoutMs: 1000 });
        scopeCalls = [];

        await emit("projetoArquivos", { params: { id: 7 } });

        // First the emitter's object, verbatim; then the revalidation of the
        // connection, with the ctx stored at subscribe.
        expect(scopeCalls).toEqual([
            { user: undefined, params: { id: 7 } },
            { user: { id: 1, projects: ["7", "9"] }, params: { id: "7" } },
        ]);

        await sub.close();
        await app.close();
    });

    it("a scope that returns null denies with 403 — with params (CA4)", async () => {
        const routes = projectRoutes();
        const app = await appWith(routes);
        const Projeto = routes[0]!.module!;

        // The principal does not own project 9: the resource is denied.
        const denied = await app
            .as({ user: { id: 1, projects: ["7"] } })
            .channel(Projeto, "projetoArquivos", { params: { id: "9" } });
        expect(denied.status).toBe(403);
        expect(denied.closed).toBe(true);

        await app.close();
    });

    it("a scope that throws denies with 403 and logs loudly, naming the channel (CA4)", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const Projeto = makeModule({
                moduleId: "projeto/Projeto",
                fullPath: "/projeto/:id",
                loader: projectFiles,
                channels: ["projetoArquivos"],
            });
            const app = await createTestApp({
                routes: [{ path: "/projeto/:id", module: Projeto, middlewares: [requireUser] }],
                channels: {
                    projetoArquivos: {
                        scope: () => {
                            throw new Error("membership service down");
                        },
                    },
                },
                getSessionCookie,
            });

            const denied = await app
                .as({ user })
                .channel(Projeto, "projetoArquivos", { params: { id: "7" } });
            expect(denied.status).toBe(403);

            const logged = error.mock.calls.map((c) => String(c[0])).join("\n");
            expect(logged).toContain('channel "projetoArquivos"');
            expect(logged).toContain("scope threw");

            await app.close();
        } finally {
            error.mockRestore();
        }
    });

    it("without :params the connection declares none and the scope receives empty params (CA9)", async () => {
        const Mod = makeModule({
            moduleId: "docs/Doc",
            fullPath: "/docs/*",
            loader: async ({ params, query }: LoaderArgs) => ({ params, query }),
            channels: ["principal"],
        });
        const app = await createTestApp({
            routes: [{ path: "/docs/*", module: Mod, middlewares: [requireUser] }],
            channels: CHANNELS,
            getSessionCookie,
        });

        const sub = await app.as({ user }).channel(Mod, "principal");
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({
            params: {},
            query: {},
        });

        // The partition came from the principal only — the catch-all declares no key.
        expect(inspectChannels().channels[0]!.groups[0]!.partition).toBe("user:1");

        await sub.close();
        await app.close();
    });
});

// ============================================
// Shape validation — declared keys only (CA5)
// ============================================

describe("live loader — route params validation", () => {
    it("rejects a key the module's path does not declare (CA5)", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const routes = projectRoutes();
            const app = await appWith(routes);
            const Projeto = routes[0]!.module!;

            const forged = await app.as({ user }).channel(Projeto, "projetoArquivos", {
                params: { id: "7", outro: "9" },
            });
            expect(forged.status).toBe(400);
            expect(forged.closed).toBe(true);

            const logged = error.mock.calls.map((c) => String(c[0])).join("\n");
            expect(logged).toContain('channel "projetoArquivos"');
            expect(logged).toContain("outro");

            await app.close();
        } finally {
            error.mockRestore();
        }
    });

    it("rejects any key on a module whose path declares none (CA5)", async () => {
        const Mod = makeModule({
            moduleId: "docs/Doc",
            fullPath: "/docs/*",
            loader: async ({ params }: LoaderArgs) => ({ params }),
            channels: ["principal"],
        });
        const app = await createTestApp({
            routes: [{ path: "/docs/*", module: Mod, middlewares: [requireUser] }],
            channels: CHANNELS,
            getSessionCookie,
        });

        const res = await app.as({ user }).get("/_channel/docs/Doc/principal", {
            query: { _route: JSON.stringify({ id: "7" }) },
        });
        expect(res.status).toBe(400);

        await app.close();
    });

    it("rejects a malformed payload — invalid JSON, a list, a non-string value (CA5)", async () => {
        const routes = projectRoutes();
        const app = await appWith(routes);

        const tooManyKeys = await app.as({ user }).get(
            "/_channel/projeto/Projeto/projetoArquivos",
            { query: { _route: "{nope" } },
        );
        expect(tooManyKeys.status).toBe(400);

        const list = await app.as({ user }).get(
            "/_channel/projeto/Projeto/projetoArquivos",
            { query: { _route: "[]" } },
        );
        expect(list.status).toBe(400);

        const number = await app.as({ user }).get(
            "/_channel/projeto/Projeto/projetoArquivos",
            { query: { _route: JSON.stringify({ id: 7 }) } },
        );
        expect(number.status).toBe(400);

        await app.close();
    });

    it("the parser is a pure function of the payload and the declared names (CA5)", () => {
        expect(declaredRouteParams("/projeto/:id")).toEqual(["id"]);
        expect(declaredRouteParams("/a/:x/b/:y")).toEqual(["x", "y"]);
        expect(declaredRouteParams("/docs/*")).toEqual([]);
        expect(declaredRouteParams(undefined)).toEqual([]);

        expect(parseRouteParamsQuery(undefined, ["id"])).toEqual({
            params: {},
            error: null,
        });
        expect(parseRouteParamsQuery(JSON.stringify({ id: "7" }), ["id"])).toEqual({
            params: { id: "7" },
            error: null,
        });
        expect(parseRouteParamsQuery(JSON.stringify({ id: "7", x: "1" }), ["id"]).error)
            .toMatch(/not declared/);
        expect(parseRouteParamsQuery(JSON.stringify({ id: 7 }), ["id"]).error)
            .toMatch(/must be a URL string/);
    });
});

// ============================================
// Revalidation re-derives with the stored params (CA6)
// ============================================

describe("live loader — revalidation with route params", () => {
    /** The current id → partition mapping — it can move between subscribe and emit. */
    let partitions: Map<string, string>;

    const movingChannels = {
        projetoArquivos: {
            // The producer names the affected partition; a connection resolves
            // its own from the resource it declared.
            scope: ({ params }: any) => params?.partition ?? partitions.get(String(params?.id)) ?? null,
        },
    };

    async function movingApp() {
        const routes = projectRoutes();
        const app = await createTestApp({
            routes,
            channels: movingChannels,
            getSessionCookie,
        });
        return { app, Projeto: routes[0]!.module! };
    }

    beforeEach(() => {
        partitions = new Map([
            ["7", "projeto:7"],
            ["9", "projeto:9"],
        ]);
    });

    it("keeps a connection whose re-derivation still holds — the stored params are used", async () => {
        const { app, Projeto } = await movingApp();

        const sub = await app.as({ user }).channel(Projeto, "projetoArquivos", {
            params: { id: "7" },
        });
        await sub.next({ timeoutMs: 1000 });

        store["7"] = ["after.txt"];
        await emit("projetoArquivos", { params: { partition: "projeto:7" } });

        // Re-derived with the connection's own params (empty params would have
        // returned null): the snapshot arrives.
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({
            id: "7",
            files: ["after.txt"],
            query: {},
        });

        await sub.close();
        await app.close();
    });

    it("drops and closes a connection whose re-derived partition moved (CA6)", async () => {
        const { app, Projeto } = await movingApp();

        const sub = await app.as({ user }).channel(Projeto, "projetoArquivos", {
            params: { id: "7" },
        });
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({
            id: "7",
            files: ["a.txt", "b.txt"],
            query: {},
        });

        // The resource now belongs to another partition.
        partitions.set("7", "projeto:9");

        store["7"] = ["should-not-arrive.txt"];
        await emit("projetoArquivos", { params: { partition: "projeto:7" } });

        await expect(sub.next({ timeoutMs: 1000 })).rejects.toThrow(/closed/);
        expect(sub.events).toHaveLength(1);

        await app.close();
    });

    it("drops and closes a connection whose re-derived scope returns null (CA6)", async () => {
        const { app, Projeto } = await movingApp();

        const sub = await app.as({ user }).channel(Projeto, "projetoArquivos", {
            params: { id: "7" },
        });
        await sub.next({ timeoutMs: 1000 });

        partitions.delete("7");
        await emit("projetoArquivos", { params: { partition: "projeto:7" } });

        await expect(sub.next({ timeoutMs: 1000 })).rejects.toThrow(/closed/);
        expect(sub.events).toHaveLength(1);

        await app.close();
    });
});