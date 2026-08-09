import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
    buildRouteTree,
    detectExports,
    buildGraph,
} from "../src/graph.js";

// ============================================
// buildRouteTree — route tree structure
// ============================================

describe("buildRouteTree", () => {
    it("parses simple flat routes", () => {
        const code = `
import * as Home from "./pages/Home.js";
import * as About from "./pages/About.js";

export default [
    { path: "/", module: Home },
    { path: "/about", module: About },
];`;
        const tree = buildRouteTree(code);

        expect(tree).toHaveLength(2);
        expect(tree[0]).toMatchObject({
            moduleId: "pages/Home",
            fullPath: "/",
            path: "/",
            children: [],
        });
        expect(tree[1]).toMatchObject({
            moduleId: "pages/About",
            fullPath: "/about",
            path: "/about",
            children: [],
        });
    });

    it("parses nested routes with layouts", () => {
        const code = `
import * as Root from "./client-root.js";
import * as AdminLayout from "./admin/Layout.js";
import * as Dashboard from "./admin/Dashboard.js";
import * as Users from "./admin/Users.js";

export default [
    {
        module: Root,
        children: [
            {
                path: "/admin",
                module: AdminLayout,
                children: [
                    { path: "/", module: Dashboard },
                    { path: "/users", module: Users },
                ],
            },
        ],
    },
];`;
        const tree = buildRouteTree(code);

        expect(tree).toHaveLength(1);
        const root = tree[0]!;
        expect(root.moduleId).toBe("client-root");
        expect(root.children).toHaveLength(1);

        const admin = root.children[0]!;
        expect(admin.moduleId).toBe("admin/Layout");
        expect(admin.fullPath).toBe("/admin");
        expect(admin.children).toHaveLength(2);

        expect(admin.children[0]).toMatchObject({
            moduleId: "admin/Dashboard",
            fullPath: "/admin",
            path: "/",
        });
        expect(admin.children[1]).toMatchObject({
            moduleId: "admin/Users",
            fullPath: "/admin/users",
            path: "/users",
        });
    });

    it("preserves isRoot flag", () => {
        const code = `
import * as Root from "./client-root.js";
import * as Home from "./pages/Home.js";

export default [
    {
        module: Root,
        isRoot: true,
        children: [{ path: "/", module: Home }],
    },
];`;
        const tree = buildRouteTree(code);

        expect(tree[0]!.isRoot).toBe(true);
        expect(tree[0]!.children[0]!.isRoot).toBe(false);
    });

    it("captures middlewares from route nodes", () => {
        const code = `
import * as Admin from "./admin/Layout.js";
import * as Dashboard from "./admin/Dashboard.js";

export default [
    {
        path: "/admin",
        module: Admin,
        middlewares: [authMw, adminMw],
        children: [{ path: "/", module: Dashboard }],
    },
];`;
        const tree = buildRouteTree(code);

        expect(tree[0]!.middlewares).toEqual(["authMw", "adminMw"]);
        expect(tree[0]!.children[0]!.middlewares).toEqual([]);
    });

    it("handles path-less layout (pure wrapper)", () => {
        const code = `
import * as AuthLayout from "./auth/Layout.js";
import * as Login from "./auth/Login.js";

export default [
    {
        module: AuthLayout,
        children: [{ path: "/login", module: Login }],
    },
];`;
        const tree = buildRouteTree(code);

        expect(tree).toHaveLength(1);
        const layout = tree[0]!;
        expect(layout.moduleId).toBe("auth/Layout");
        expect(layout.fullPath).toBe("");
        expect(layout.path).toBe("");
        expect(layout.children[0]!.moduleId).toBe("auth/Login");
    });

    it("handles catch-all route (path: '*')", () => {
        const code = `
import * as NotFound from "./pages/NotFound.js";

export default [
    { path: "*", module: NotFound, statusCode: 404 },
];`;
        const tree = buildRouteTree(code);

        expect(tree).toHaveLength(1);
        expect(tree[0]!.moduleId).toBe("pages/NotFound");
        expect(tree[0]!.fullPath).toBe("/*");
        expect(tree[0]!.path).toBe("*");
    });

    it("handles satisfies AppRoutes syntax", () => {
        const code = `
import type { AppRoutes } from "velojs";
import * as Home from "./pages/Home.js";

export default [
    { path: "/", module: Home },
] satisfies AppRoutes;`;
        const tree = buildRouteTree(code);

        expect(tree).toHaveLength(1);
        expect(tree[0]!.moduleId).toBe("pages/Home");
    });

    it("handles as AppRoutes syntax", () => {
        const code = `
import type { AppRoutes } from "velojs";
import * as Home from "./pages/Home.js";

export default [
    { path: "/", module: Home },
] as AppRoutes;`;
        const tree = buildRouteTree(code);

        expect(tree).toHaveLength(1);
        expect(tree[0]!.moduleId).toBe("pages/Home");
    });

    it("returns empty tree for routes without namespace imports", () => {
        const code = `
import Home from "./pages/Home.js";

export default [
    { path: "/", module: Home },
];`;
        const tree = buildRouteTree(code);

        expect(tree).toHaveLength(1);
        expect(tree[0]!.moduleId).toBeNull();
    });
});

// ============================================
// detectExports — convention exports
// ============================================

describe("detectExports", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velojs-graph-test-"));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeFile(name: string, content: string): string {
        const filePath = path.join(tmpDir, name);
        fs.writeFileSync(filePath, content);
        return filePath;
    }

    it("detects Component + loader in a page module", () => {
        const file = writeFile("page.tsx", `
export const loader = async () => ({ items: [] });
export const Component = () => <div>Hello</div>;
`);
        const result = detectExports(file);

        expect(result.hasComponent).toBe(true);
        expect(result.hasLoader).toBe(true);
        expect(result.actions).toEqual([]);
        expect(result.streams).toEqual([]);
        expect(result.sockets).toEqual([]);
    });

    it("detects action_* exports", () => {
        const file = writeFile("form.tsx", `
export const Component = () => <form />;
export const action_save = async ({ body }) => ({ ok: true });
export const action_delete = async ({ body }) => ({ ok: true });
`);
        const result = detectExports(file);

        expect(result.actions).toEqual(["save", "delete"]);
    });

    it("detects stream_* exports", () => {
        const file = writeFile("deploy.tsx", `
import { createEventStream } from "@mauroandre/velojs/events";
export const Component = () => <div />;
export const stream_progress = createEventStream();
export const stream_logs = createEventStream();
`);
        const result = detectExports(file);

        expect(result.streams).toEqual(["progress", "logs"]);
    });

    it("detects socket_* exports", () => {
        const file = writeFile("terminal.tsx", `
export const Component = () => <div />;
export const socket_terminal = async ({ incoming, send, keepOpen }) => {
    keepOpen();
};
`);
        const result = detectExports(file);

        expect(result.sockets).toEqual(["terminal"]);
    });

    it("does not match export function action_* (only const)", () => {
        const file = writeFile("alt.tsx", `
export async function action_submit(args: any) { return { ok: true }; }
`);
        const result = detectExports(file);

        expect(result.actions).toEqual([]);
    });

    it("returns empty for non-existent files", () => {
        const result = detectExports("/tmp/nonexistent-velojs-test.tsx");

        expect(result.hasComponent).toBe(false);
        expect(result.hasLoader).toBe(false);
        expect(result.actions).toEqual([]);
        expect(result.streams).toEqual([]);
        expect(result.sockets).toEqual([]);
    });
});

// ============================================
// buildGraph — integration
// ============================================

describe("buildGraph", () => {
    let tmpDir: string;
    let appDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velojs-graph-int-"));
        appDir = path.join(tmpDir, "app");
        fs.mkdirSync(appDir, { recursive: true });
        fs.mkdirSync(path.join(appDir, "pages"), { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("builds full graph from a minimal project", () => {
        fs.writeFileSync(
            path.join(appDir, "routes.tsx"),
            `
import type { AppRoutes } from "@mauroandre/velojs";
import * as Root from "./client-root.js";
import * as Home from "./pages/Home.js";
import * as About from "./pages/About.js";

export default [
    {
        module: Root,
        isRoot: true,
        children: [
            { path: "/", module: Home },
            { path: "/about", module: About },
        ],
    },
] satisfies AppRoutes;
`
        );

        fs.writeFileSync(
            path.join(appDir, "client-root.tsx"),
            `
import { Scripts } from "@mauroandre/velojs";

export const Component = ({ children }: any) => (
    <html><body>{children}</body></html>
);
`
        );

        fs.writeFileSync(
            path.join(appDir, "pages", "Home.tsx"),
            `
import { useLoader } from "@mauroandre/velojs/hooks";

export const loader = async () => ({ title: "Home" });
export const Component = () => <div>Home</div>;
`
        );

        fs.writeFileSync(
            path.join(appDir, "pages", "About.tsx"),
            `
export const Component = () => <div>About</div>;
`
        );

        const graph = buildGraph(appDir);

        expect(graph.routes).toHaveLength(1);
        expect(graph.routes[0]!.moduleId).toBe("client-root");
        expect(graph.routes[0]!.isRoot).toBe(true);
        expect(graph.routes[0]!.children).toHaveLength(2);

        const modules = graph.modules;
        expect(modules["client-root"]).toBeDefined();
        expect(modules["client-root"]!.kind).toBe("root");
        expect(modules["client-root"]!.exports.hasComponent).toBe(true);
        expect(modules["client-root"]!.imports).toContain(
            "@mauroandre/velojs"
        );

        expect(modules["pages/Home"]).toBeDefined();
        expect(modules["pages/Home"]!.kind).toBe("page");
        expect(modules["pages/Home"]!.exports.hasLoader).toBe(true);
        expect(modules["pages/Home"]!.imports).toContain(
            "@mauroandre/velojs/hooks"
        );

        expect(modules["pages/About"]).toBeDefined();
        expect(modules["pages/About"]!.kind).toBe("page");
        expect(modules["pages/About"]!.exports.hasLoader).toBe(false);
    });

    it("returns empty graph when routes.tsx is missing", () => {
        const graph = buildGraph(path.join(tmpDir, "nonexistent"));

        expect(graph.routes).toEqual([]);
        expect(graph.modules).toEqual({});
    });

    it("tracks importedBy correctly", () => {
        fs.writeFileSync(
            path.join(appDir, "routes.tsx"),
            `
import * as Home from "./pages/Home.js";

export default [
    { path: "/", module: Home },
];
`
        );

        fs.writeFileSync(
            path.join(appDir, "pages", "Home.tsx"),
            `
import { getData } from "./service.js";
export const Component = () => <div />;
`
        );

        fs.writeFileSync(
            path.join(appDir, "pages", "service.ts"),
            `
export async function getData() { return []; }
`
        );

        const graph = buildGraph(appDir);

        expect(graph.modules["pages/Home"]!.imports).toContain(
            "pages/service"
        );
        expect(graph.modules["pages/service"]!.importedBy).toContain(
            "pages/Home"
        );
    });

    it("handles external imports without crawling them", () => {
        fs.writeFileSync(
            path.join(appDir, "routes.tsx"),
            `
import * as Home from "./pages/Home.js";

export default [{ path: "/", module: Home }];
`
        );

        fs.writeFileSync(
            path.join(appDir, "pages", "Home.tsx"),
            `
import { signal } from "@preact/signals";
import { useLoader } from "@mauroandre/velojs/hooks";
import { useNavigate } from "wouter-preact";

export const Component = () => <div />;
`
        );

        const graph = buildGraph(appDir);

        const home = graph.modules["pages/Home"]!;
        expect(home.imports).toContain("@preact/signals");
        expect(home.imports).toContain("@mauroandre/velojs/hooks");
        expect(home.imports).toContain("wouter-preact");
    });

    it("builds layout kind correctly from route tree", () => {
        fs.writeFileSync(
            path.join(appDir, "routes.tsx"),
            `
import * as Root from "./client-root.js";
import * as AdminLayout from "./admin/Layout.js";
import * as Dashboard from "./admin/Dashboard.js";

export default [
    {
        module: Root,
        isRoot: true,
        children: [
            {
                path: "/admin",
                module: AdminLayout,
                children: [{ path: "/", module: Dashboard }],
            },
        ],
    },
] as any;
`
        );

        fs.mkdirSync(path.join(appDir, "admin"), { recursive: true });
        fs.writeFileSync(
            path.join(appDir, "client-root.tsx"),
            `export const Component = ({ children }: any) => <div>{children}</div>;`
        );
        fs.writeFileSync(
            path.join(appDir, "admin", "Layout.tsx"),
            `export const Component = ({ children }: any) => <div>{children}</div>;`
        );
        fs.writeFileSync(
            path.join(appDir, "admin", "Dashboard.tsx"),
            `export const Component = () => <div>Dash</div>;`
        );

        const graph = buildGraph(appDir);

        expect(graph.modules["client-root"]!.kind).toBe("root");
        expect(graph.modules["admin/Layout"]!.kind).toBe("layout");
        expect(graph.modules["admin/Dashboard"]!.kind).toBe("page");
    });
});
