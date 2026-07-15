/**
 * Executable spec for `agent/AGENTS.md` → "Rules that fail silently".
 *
 * Each rule in that table is pinned here: the anti-pattern goes in, the
 * documented consequence comes out. These assert BROKEN behaviour on purpose —
 * that is the contract the rule warns about.
 *
 * The table and this file are checked against each other by the parity test at
 * the bottom, so they cannot drift:
 *  - add a row without pinning it here                 → red
 *  - fix the bug and delete the test, but keep the row → red
 *  - reword a row without revisiting its test          → red
 *
 * So when a test here fails, do not "fix" the test. Either a change regressed
 * something, or the framework got better and the anti-pattern now works — in
 * which case DELETE the row from agent/AGENTS.md and delete the test. A rule
 * warning about a problem that no longer exists is a lie that costs context in
 * every single conversation.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { h } from "preact";
import {
    buildFullPathMap,
    transformActionsForClient,
    removeLoaders,
    veloPlugin,
} from "../src/vite.js";
import { createTestApp } from "../src/testing/index.js";
import { useParams, useQuery, usePathname } from "../src/hooks.js";
import type { RouteModule } from "../src/types.js";

// ============================================
// The AGENTS.md ↔ tests coupling
// ============================================

const AGENTS_MD = fileURLToPath(new URL("../agent/AGENTS.md", import.meta.url));
const SECTION = "Rules that fail silently";

/** The "Never write" cell of every row in the AGENTS.md silent-failure table. */
function declaredRules(): string[] {
    const md = fs.readFileSync(AGENTS_MD, "utf-8");
    const section = md.split(/^## /m).find((s) => s.startsWith(SECTION));
    if (!section) throw new Error(`agent/AGENTS.md: "## ${SECTION}" section not found`);

    const rows = section.split("\n").filter((l) => l.startsWith("|"));
    if (rows.length < 3) throw new Error(`agent/AGENTS.md: "${SECTION}" has no table rows`);

    // `| a | b | c |`.split("|") → ["", " a ", " b ", " c ", ""]
    return rows.slice(2).map((line) => {
        const cells = line.split("|");
        if (cells.length < 4) throw new Error(`agent/AGENTS.md: malformed table row: ${line}`);
        return cells[1]!.trim();
    });
}

/**
 * Verbatim copies of each row's first cell. This object IS the claim "these are
 * the rules this file pins"; the parity test proves the claim against the real
 * table, so a typo here is caught rather than silently un-pinning a rule.
 */
const RULE = {
    routesIdentifier: "`export default routes` (a variable)",
    pageImportStyle:
        '`import Home from "./pages/Home.js"`<br>`import { Component } from "./pages/Home.js"`',
    pageImportPath:
        '`import * as Home from "../shared/Home.js"`<br>or a tsconfig alias, in `routes.tsx`',
    actionFunctionDecl: "`export async function action_x(...)`",
    actionParamNotDestructured: "`export const action_x = async (args) => {}`",
    actionNotAsync: "`export const action_x = ({ body }) => {}` (not `async`)",
    loaderFunctionDecl: "`export async function loader(...)`",
    twoDeclarators: "`export const action_a = ..., action_b = ...`",
    hooksInLoader: "`useParams()` / `useQuery()` / `usePathname()` inside a `loader`",
    paramsInConventionRoute:
        "`c.req.param(...)` or `params.x` inside `action_*`, `stream_*`, `socket_*`",
    untransformedFile: "a page in `.jsx` / `.js`, or any page outside `appDirectory`",
    rootWithoutHead: "a root layout that doesn't render a literal `<head>`",
} as const;

const pinned = new Set<string>();

/**
 * Declares a test AND records which rule it pins. Registration happens at
 * collection time — when the `describe` body runs — not when the test runs, so
 * a `-t` filter can never make the parity check lie about coverage.
 */
function ruleTest(rule: string, name: string, fn: () => void | Promise<void>): void {
    pinned.add(rule);
    it(name, fn);
}

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
    ruleTest(
        RULE.routesIdentifier,
        "`export default routes` (an identifier) yields an empty path map",
        () => {
            const code = `
import * as Home from "./pages/Home.js";
const routes = [{ path: "/", module: Home }];
export default routes;`;
            // Empty map → no fullPath → server logs "has no fullPath" and skips
            // every route. The app boots and 404s everywhere.
            expect(buildFullPathMap(code).size).toBe(0);
        },
    );

    ruleTest(
        RULE.pageImportStyle,
        "a default-imported page module is dropped from the path map",
        () => {
            const code = `
import * as Root from "./client-root.js";
import Home from "./pages/Home.js";
export default [
    { module: Root, children: [{ path: "/", module: Home }] },
] satisfies AppRoutes;`;
            const result = buildFullPathMap(code);
            expect(result.has("pages/Home")).toBe(false);
            expect(result.has("client-root")).toBe(true); // the namespace one survives
        },
    );

    ruleTest(
        RULE.pageImportStyle,
        "a named-imported page module is dropped from the path map",
        () => {
            const code = `
import * as Root from "./client-root.js";
import { Component } from "./pages/Home.js";
export default [
    { module: Root, children: [{ path: "/", module: Component }] },
] satisfies AppRoutes;`;
            expect(buildFullPathMap(code).has("pages/Home")).toBe(false);
        },
    );

    ruleTest(
        RULE.pageImportPath,
        "a `../` import produces a key that cannot match a module id",
        () => {
            const code = `
import * as Home from "../shared/Home.js";
export default [{ path: "/", module: Home }] satisfies AppRoutes;`;
            const result = buildFullPathMap(code);
            // The transform derives moduleId from path.relative(appDir, id), which
            // never starts with "../" — so this entry matches nothing.
            expect(result.has("../shared/Home")).toBe(true);
            expect(result.has("shared/Home")).toBe(false);
        },
    );

    ruleTest(
        RULE.pageImportPath,
        "a tsconfig-alias import produces a key that cannot match a module id",
        () => {
            const code = `
import * as Home from "@/pages/Home.js";
export default [{ path: "/", module: Home }] satisfies AppRoutes;`;
            const result = buildFullPathMap(code);
            expect(result.has("@/pages/Home")).toBe(true);
            expect(result.has("pages/Home")).toBe(false);
        },
    );
});

// ============================================
// action_* / loader export shape
// ============================================

describe("anti-pattern: action/loader export shape", () => {
    ruleTest(
        RULE.actionFunctionDecl,
        "`export async function action_x` gets no stub — body and imports reach the client",
        () => {
            const input = `
import { db } from "../db.js";
export async function action_login({ body }) {
    return db.users.find(body.email);
}`;
            const output = transformActionsForClient(input, "pages/Login");
            expect(output).not.toContain("fetch(");
            expect(output).toContain("db.users.find"); // server code, in the browser
            expect(output).toContain(`import { db }`);
        },
    );

    ruleTest(
        RULE.actionParamNotDestructured,
        "a non-destructured action param yields a stub referencing an undeclared `body`",
        () => {
            const input = `
export const action_login = async (args) => {
    return args.body.email;
};`;
            const output = transformActionsForClient(input, "pages/Login");
            // The param stays `args`, but the generated stub sends `body` —
            // a ReferenceError in the browser the first time it is called.
            expect(output).toContain("JSON.stringify(body)");
            expect(output).toMatch(/async\s*\(\s*args/);
        },
    );

    ruleTest(RULE.actionNotAsync, "a non-async action arrow gets no stub", () => {
        const input = `export const action_ping = ({ body }) => doSomething(body);`;
        const output = transformActionsForClient(input, "pages/Ping");
        expect(output).not.toContain("fetch(");
        expect(output).toContain("doSomething(body)");
    });

    ruleTest(
        RULE.loaderFunctionDecl,
        "`export async function loader` survives into the client bundle",
        () => {
            const input = `
import { db } from "../db.js";
export async function loader({ params }) { return db.get(params.id); }
export const Component = () => null;`;
            const output = removeLoaders(input);
            expect(output).toContain("export async function loader");
            expect(output).toContain(`import { db }`);
        },
    );

    ruleTest(
        RULE.twoDeclarators,
        "only the first declarator is read — the second action is ignored",
        () => {
            const input = `export const action_a = async ({ body }) => { return 1; }, action_b = async ({ body }) => { return 2; };`;
            const output = transformActionsForClient(input, "pages/X");
            expect(output).toContain("fetch("); // action_a became a stub
            expect(output).toContain("return 2"); // action_b untouched
        },
    );
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

    ruleTest(
        RULE.untransformedFile,
        "skips a .jsx page — no metadata, no stubs, loader ships to the client",
        () => {
            expect(transformPlugin().transform(PAGE, "/proj/app/Home.jsx", {})).toBeNull();
        },
    );

    ruleTest(RULE.untransformedFile, "skips a .js page", () => {
        expect(transformPlugin().transform(PAGE, "/proj/app/Home.js", {})).toBeNull();
    });

    ruleTest(RULE.untransformedFile, "skips a page outside appDirectory", () => {
        expect(transformPlugin().transform(PAGE, "/proj/src/Home.tsx", {})).toBeNull();
    });
});

// ============================================
// Request-scoped data
// ============================================

describe("anti-pattern: request-scoped data", () => {
    ruleTest(
        RULE.hooksInLoader,
        "hooks inside a loader read an empty store — LoaderArgs is the only source",
        async () => {
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
        },
    );

    ruleTest(
        RULE.paramsInConventionRoute,
        "c.req.param() inside an action is always empty — actions mount on a static path",
        async () => {
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
        },
    );
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

    it("injects __PAGE_DATA__ when the root renders a literal <head> (control)", async () => {
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

    ruleTest(
        RULE.rootWithoutHead,
        "silently skips __PAGE_DATA__ when there is no </head> to replace",
        async () => {
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
        },
    );
});

// ============================================
// The coupling itself
// ============================================

describe("agent/AGENTS.md ↔ this file", () => {
    it("pins exactly the rules the silent-failure table declares — no more, no less", () => {
        const declared = declaredRules();

        // A rule in AGENTS.md that nothing here pins: unverified prose, which is
        // how the docs rotted in the first place. Pin it or delete the row.
        const unpinned = declared.filter((rule) => !pinned.has(rule));

        // A rule pinned here that AGENTS.md no longer declares: either the row
        // was reworded (update RULE) or the rule was dropped (delete the test).
        const orphaned = [...pinned].filter((rule) => !declared.includes(rule));

        expect({ unpinned, orphaned }).toEqual({ unpinned: [], orphaned: [] });
    });

    it("every declared rule is unique, so a row cannot be pinned by accident", () => {
        const declared = declaredRules();
        expect(declared).toEqual([...new Set(declared)]);
    });
});
