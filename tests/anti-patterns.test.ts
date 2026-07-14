/**
 * Executable spec for `agent/AGENTS.md` → "Rules that fail silently".
 *
 * Each test pins one row of that table: the anti-pattern goes in, the
 * documented consequence comes out. These assert BROKEN behaviour on purpose —
 * that is the contract the rule warns about.
 *
 * If a test here fails, do not "fix" the test. Either:
 *  - a change regressed something, or
 *  - the framework got better and the anti-pattern now works — in which case
 *    DELETE the matching row from agent/AGENTS.md, because a rule that warns
 *    about a problem that no longer exists is a lie that costs context in every
 *    single conversation.
 *
 * That is the point: the rules cannot rot in silence.
 */
import { describe, it, expect } from "vitest";
import { h } from "preact";
import {
    buildFullPathMap,
    transformActionsForClient,
    removeLoaders,
    veloPlugin,
} from "../src/vite.js";
import { createTestApp } from "../src/testing/index.js";
import { useParams, useQuery, usePathname } from "../src/hooks.js";
import type { AppRoutes, RouteModule } from "../src/types.js";

function makeModule(opts: {
    moduleId: string;
    fullPath?: string;
    Component?: any;
    loader?: (args: any) => any;
    actions?: Record<string, (args: any) => any>;
}): RouteModule {
    const mod: any = {
        Component: opts.Component ?? (() => null),
        metadata: { moduleId: opts.moduleId, fullPath: opts.fullPath, path: opts.fullPath },
    };
    if (opts.loader) mod.loader = opts.loader;
    for (const [name, fn] of Object.entries(opts.actions ?? {})) {
        mod[`action_${name}`] = fn;
    }
    return mod as RouteModule;
}

// ============================================
// routes.tsx shape
// ============================================

describe("anti-pattern: routes.tsx shape", () => {
    it("`export default routes` (an identifier) yields an empty path map", () => {
        const code = `
import * as Home from "./pages/Home.js";
const routes = [{ path: "/", module: Home }];
export default routes;`;
        // Empty map → no fullPath → server logs "has no fullPath" and skips
        // every route. The app boots and 404s everywhere.
        expect(buildFullPathMap(code).size).toBe(0);
    });

    it("a default-imported page module is dropped from the path map", () => {
        const code = `
import * as Root from "./client-root.js";
import Home from "./pages/Home.js";
export default [
    { module: Root, children: [{ path: "/", module: Home }] },
] satisfies AppRoutes;`;
        const result = buildFullPathMap(code);
        expect(result.has("pages/Home")).toBe(false);
        expect(result.has("client-root")).toBe(true); // the namespace one survives
    });

    it("a named-imported page module is dropped from the path map", () => {
        const code = `
import * as Root from "./client-root.js";
import { Component } from "./pages/Home.js";
export default [
    { module: Root, children: [{ path: "/", module: Component }] },
] satisfies AppRoutes;`;
        expect(buildFullPathMap(code).has("pages/Home")).toBe(false);
    });

    it("a `../` import produces a key that cannot match a module id", () => {
        const code = `
import * as Home from "../shared/Home.js";
export default [{ path: "/", module: Home }] satisfies AppRoutes;`;
        const result = buildFullPathMap(code);
        // The transform derives moduleId from path.relative(appDir, id), which
        // never starts with "../" — so this entry matches nothing.
        expect(result.has("../shared/Home")).toBe(true);
        expect(result.has("shared/Home")).toBe(false);
    });

    it("a tsconfig-alias import produces a key that cannot match a module id", () => {
        const code = `
import * as Home from "@/pages/Home.js";
export default [{ path: "/", module: Home }] satisfies AppRoutes;`;
        const result = buildFullPathMap(code);
        expect(result.has("@/pages/Home")).toBe(true);
        expect(result.has("pages/Home")).toBe(false);
    });
});

// ============================================
// action_* / loader export shape
// ============================================

describe("anti-pattern: action/loader export shape", () => {
    it("`export async function action_x` gets no stub — body and imports reach the client", () => {
        const input = `
import { db } from "../db.js";
export async function action_login({ body }) {
    return db.users.find(body.email);
}`;
        const output = transformActionsForClient(input, "pages/Login");
        expect(output).not.toContain("fetch(");
        expect(output).toContain("db.users.find"); // server code, in the browser
        expect(output).toContain(`import { db }`);
    });

    it("a non-destructured action param yields a stub referencing an undeclared `body`", () => {
        const input = `
export const action_login = async (args) => {
    return args.body.email;
};`;
        const output = transformActionsForClient(input, "pages/Login");
        // The param stays `args`, but the generated stub sends `body` —
        // a ReferenceError in the browser the first time it is called.
        expect(output).toContain("JSON.stringify(body)");
        expect(output).toMatch(/async\s*\(\s*args/);
    });

    it("a non-async action arrow gets no stub", () => {
        const input = `export const action_ping = ({ body }) => doSomething(body);`;
        const output = transformActionsForClient(input, "pages/Ping");
        expect(output).not.toContain("fetch(");
        expect(output).toContain("doSomething(body)");
    });

    it("`export async function loader` survives into the client bundle", () => {
        const input = `
import { db } from "../db.js";
export async function loader({ params }) { return db.get(params.id); }
export const Component = () => null;`;
        const output = removeLoaders(input);
        expect(output).toContain("export async function loader");
        expect(output).toContain(`import { db }`);
    });

    it("only the first declarator is read — the second action is ignored", () => {
        const input = `export const action_a = async ({ body }) => { return 1; }, action_b = async ({ body }) => { return 2; };`;
        const output = transformActionsForClient(input, "pages/X");
        expect(output).toContain("fetch("); // action_a became a stub
        expect(output).toContain("return 2"); // action_b untouched
    });
});

// ============================================
// Transform gating
// ============================================

describe("anti-pattern: files the transform never sees", () => {
    const PAGE = `export const Component = () => null;
export const loader = async () => ({ x: 1 });`;

    const transformPlugin = () => {
        const plugin = (veloPlugin() as any[]).find((p) => p?.name === "velo:transform");
        plugin.configResolved({ root: "/proj" }); // → appDir = /proj/app
        return plugin;
    };

    it("transforms a .tsx page inside appDirectory (control)", () => {
        const out = transformPlugin().transform(PAGE, "/proj/app/Home.tsx", {});
        expect(out).not.toBeNull();
        expect(out.code).toContain("moduleId");
    });

    it("skips a .jsx page — no metadata, no stubs, loader ships to the client", () => {
        expect(transformPlugin().transform(PAGE, "/proj/app/Home.jsx", {})).toBeNull();
    });

    it("skips a .js page", () => {
        expect(transformPlugin().transform(PAGE, "/proj/app/Home.js", {})).toBeNull();
    });

    it("skips a page outside appDirectory", () => {
        expect(transformPlugin().transform(PAGE, "/proj/src/Home.tsx", {})).toBeNull();
    });
});

// ============================================
// Request-scoped data
// ============================================

describe("anti-pattern: request-scoped data", () => {
    it("hooks inside a loader read an empty store — LoaderArgs is the only source", async () => {
        let viaHooks: unknown;
        let viaArgs: unknown;
        const loaderFn = async ({ params }: any) => {
            // The AsyncLocalStorage context is opened by renderPage, which runs
            // AFTER every loader. So these read nothing.
            viaHooks = {
                params: useParams(),
                query: useQuery(),
                pathname: usePathname(),
            };
            viaArgs = params;
            return { ok: true };
        };
        const page = makeModule({
            moduleId: "users/Detail",
            fullPath: "/users/:id",
            loader: loaderFn,
        });
        const app = await createTestApp({
            routes: [
                {
                    module: makeModule({ moduleId: "Root" }),
                    isRoot: true,
                    children: [{ path: "/users/:id", module: page }],
                },
            ],
        });

        await app.get("/users/42?tab=billing");

        expect(viaHooks).toEqual({ params: {}, query: {}, pathname: "/" });
        expect(viaArgs).toEqual({ id: "42" }); // the args DO carry it

        await app.close();
    });

    it("c.req.param() inside an action is always empty — actions mount on a static path", async () => {
        let seen: unknown;
        const action_remove = async ({ c, body }: any) => {
            seen = { param: c.req.param("id"), params: c.req.param(), body };
            return { ok: true };
        };
        const page = makeModule({
            moduleId: "items/Detail",
            fullPath: "/items/:id",
            actions: { remove: action_remove },
        });
        const app = await createTestApp({
            routes: [
                {
                    module: makeModule({ moduleId: "Root" }),
                    isRoot: true,
                    children: [{ path: "/items/:id", module: page }],
                },
            ],
        });

        // Resolves to POST /_action/items/Detail/remove — no :id segment exists.
        const res = await app.action(action_remove, { body: { id: "42" } });
        expect(res.status).toBe(200);
        expect(seen).toEqual({ param: undefined, params: {}, body: { id: "42" } });

        await app.close();
    });
});

// ============================================
// The HTML shell
// ============================================

describe("anti-pattern: root layout without a <head>", () => {
    const page = () =>
        makeModule({
            moduleId: "Home",
            fullPath: "/",
            loader: async () => ({ greeting: "hi" }),
        });

    it("injects __PAGE_DATA__ when the root renders a literal <head>", async () => {
        const Root = ({ children }: any) =>
            h("html", null, h("head", null, h("title", null, "t")), h("body", null, children));
        const app = await createTestApp({
            routes: [
                {
                    module: makeModule({ moduleId: "Root", Component: Root }),
                    isRoot: true,
                    children: [{ path: "/", module: page() }],
                },
            ],
        });

        const html = await (await app.get("/")).text();
        expect(html).toContain("__PAGE_DATA__");
        expect(html).toContain("greeting");
        await app.close();
    });

    it("silently skips __PAGE_DATA__ when there is no </head> to replace", async () => {
        // Injection is a string replace of "</head>". No head, no hydration
        // payload — every loader starts at null and refetches over the network.
        const Root = ({ children }: any) => h("div", null, children);
        const app = await createTestApp({
            routes: [
                {
                    module: makeModule({ moduleId: "Root", Component: Root }),
                    isRoot: true,
                    children: [{ path: "/", module: page() }],
                },
            ],
        });

        const res = await app.get("/");
        expect(res.status).toBe(200); // looks perfectly fine
        const html = await res.text();
        expect(html).not.toContain("__PAGE_DATA__");
        await app.close();
    });
});
