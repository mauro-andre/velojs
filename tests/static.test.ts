import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { generateStatic } from "../src/static.js";
import { Hono } from "hono";
import type { AppRoutes } from "../src/types.js";

// Mock a simple Hono app that returns HTML and JSON
function createMockApp(pages: Record<string, { html: string; data: any }>) {
    const app = new Hono();

    for (const [routePath, { html, data }] of Object.entries(pages)) {
        app.get(routePath, (c) => {
            if (c.req.query("_data") === "1") {
                return c.json(data);
            }
            return c.html(html);
        });
    }

    return app;
}

const TEST_DIR = path.resolve("/tmp/velojs-static-test");

describe("generateStatic", () => {
    beforeEach(() => {
        if (fs.existsSync(TEST_DIR)) {
            fs.rmSync(TEST_DIR, { recursive: true });
        }
        fs.mkdirSync(TEST_DIR, { recursive: true });
        fs.mkdirSync(path.join(TEST_DIR, "dist"), { recursive: true });
    });

    afterEach(() => {
        if (fs.existsSync(TEST_DIR)) {
            fs.rmSync(TEST_DIR, { recursive: true });
        }
    });

    it("generates index.html and index.json for a simple route", async () => {
        const app = createMockApp({
            "/": {
                html: "<html><body>Home</body></html>",
                data: { "pages/Home": { title: "Home" } },
            },
        });

        const routes: AppRoutes = [
            {
                module: {
                    Component: () => null,
                    metadata: { moduleId: "pages/Home", fullPath: "/" },
                },
            },
        ];

        const originalCwd = process.cwd;
        process.cwd = () => TEST_DIR;
        try {
            await generateStatic(app, routes);
        } finally {
            process.cwd = originalCwd;
        }

        const htmlPath = path.join(TEST_DIR, "dist/index.html");
        const jsonPath = path.join(TEST_DIR, "dist/index.json");

        expect(fs.existsSync(htmlPath)).toBe(true);
        expect(fs.existsSync(jsonPath)).toBe(true);
        expect(fs.readFileSync(htmlPath, "utf-8")).toContain("Home");
        expect(JSON.parse(fs.readFileSync(jsonPath, "utf-8"))).toHaveProperty("pages/Home");
    });

    it("generates nested route paths", async () => {
        const app = createMockApp({
            "/about": {
                html: "<html><body>About</body></html>",
                data: { "pages/About": { text: "About us" } },
            },
        });

        const routes: AppRoutes = [
            {
                module: {
                    Component: () => null,
                    metadata: { moduleId: "pages/About", fullPath: "/about" },
                },
            },
        ];

        const originalCwd = process.cwd;
        process.cwd = () => TEST_DIR;
        try {
            await generateStatic(app, routes);
        } finally {
            process.cwd = originalCwd;
        }

        expect(fs.existsSync(path.join(TEST_DIR, "dist/about/index.html"))).toBe(true);
        expect(fs.existsSync(path.join(TEST_DIR, "dist/about/index.json"))).toBe(true);
    });

    it("skips dynamic routes without staticPaths", async () => {
        const app = createMockApp({});

        const routes: AppRoutes = [
            {
                module: {
                    Component: () => null,
                    metadata: { moduleId: "pages/User", fullPath: "/users/:id" },
                },
            },
        ];

        const originalCwd = process.cwd;
        process.cwd = () => TEST_DIR;
        try {
            await generateStatic(app, routes);
        } finally {
            process.cwd = originalCwd;
        }

        // Should not create any files for dynamic routes without staticPaths
        expect(fs.existsSync(path.join(TEST_DIR, "dist/users"))).toBe(false);
    });

    it("generates pages for dynamic routes with staticPaths", async () => {
        const app = createMockApp({
            "/users/1": {
                html: "<html><body>User 1</body></html>",
                data: { "pages/User": { name: "Alice" } },
            },
            "/users/2": {
                html: "<html><body>User 2</body></html>",
                data: { "pages/User": { name: "Bob" } },
            },
        });

        const routes: AppRoutes = [
            {
                module: {
                    Component: () => null,
                    metadata: { moduleId: "pages/User", fullPath: "/users/:id" },
                    staticPaths: async () => [{ id: "1" }, { id: "2" }],
                },
            },
        ];

        const originalCwd = process.cwd;
        process.cwd = () => TEST_DIR;
        try {
            await generateStatic(app, routes);
        } finally {
            process.cwd = originalCwd;
        }

        expect(fs.existsSync(path.join(TEST_DIR, "dist/users/1/index.html"))).toBe(true);
        expect(fs.existsSync(path.join(TEST_DIR, "dist/users/1/index.json"))).toBe(true);
        expect(fs.existsSync(path.join(TEST_DIR, "dist/users/2/index.html"))).toBe(true);
        expect(fs.existsSync(path.join(TEST_DIR, "dist/users/2/index.json"))).toBe(true);
        expect(fs.readFileSync(path.join(TEST_DIR, "dist/users/1/index.html"), "utf-8")).toContain("User 1");
    });

    it("handles routes with children (layout + pages)", async () => {
        const app = createMockApp({
            "/": {
                html: "<html><body>Dashboard</body></html>",
                data: { "admin/Dashboard": { stats: 42 } },
            },
            "/settings": {
                html: "<html><body>Settings</body></html>",
                data: { "admin/Settings": { theme: "dark" } },
            },
        });

        const routes: AppRoutes = [
            {
                module: {
                    Component: () => null,
                    metadata: { moduleId: "admin/Layout" },
                },
                children: [
                    {
                        module: {
                            Component: () => null,
                            metadata: { moduleId: "admin/Dashboard", fullPath: "/" },
                        },
                    },
                    {
                        module: {
                            Component: () => null,
                            metadata: { moduleId: "admin/Settings", fullPath: "/settings" },
                        },
                    },
                ],
            },
        ];

        const originalCwd = process.cwd;
        process.cwd = () => TEST_DIR;
        try {
            await generateStatic(app, routes);
        } finally {
            process.cwd = originalCwd;
        }

        expect(fs.existsSync(path.join(TEST_DIR, "dist/index.html"))).toBe(true);
        expect(fs.existsSync(path.join(TEST_DIR, "dist/settings/index.html"))).toBe(true);
    });

    it("copies public/ folder contents to dist/ root", async () => {
        const app = createMockApp({
            "/": {
                html: '<html><body><img src="/logos/logo.svg"/></body></html>',
                data: { "pages/Home": { title: "Home" } },
            },
        });

        const routes: AppRoutes = [
            {
                module: {
                    Component: () => null,
                    metadata: { moduleId: "pages/Home", fullPath: "/" },
                },
            },
        ];

        // Create public/ with nested files
        const publicDir = path.join(TEST_DIR, "public");
        fs.mkdirSync(path.join(publicDir, "logos"), { recursive: true });
        fs.writeFileSync(path.join(publicDir, "logos", "logo.svg"), "<svg>logo</svg>");
        fs.writeFileSync(path.join(publicDir, "favicon.ico"), "icon");

        const originalCwd = process.cwd;
        process.cwd = () => TEST_DIR;
        try {
            await generateStatic(app, routes);
        } finally {
            process.cwd = originalCwd;
        }

        // Public assets should be at dist/ root (not dist/client/)
        expect(fs.existsSync(path.join(TEST_DIR, "dist/logos/logo.svg"))).toBe(true);
        expect(fs.readFileSync(path.join(TEST_DIR, "dist/logos/logo.svg"), "utf-8")).toBe("<svg>logo</svg>");
        expect(fs.existsSync(path.join(TEST_DIR, "dist/favicon.ico"))).toBe(true);
    });

    it("emits dist/404.html for a catch-all route (and does not generate it as a normal page)", async () => {
        const app = createMockApp({
            "/": {
                html: "<html><body>Home</body></html>",
                data: { "pages/Home": { title: "Home" } },
            },
        });
        // The catch-all is served via Hono's notFound hook — generateStatic
        // fetches an unknown path to capture it.
        app.notFound((c) => c.html("<html><body>Not Found</body></html>", 404));

        const routes: AppRoutes = [
            {
                module: {
                    Component: () => null,
                    metadata: { moduleId: "Root" },
                },
                isRoot: true,
                children: [
                    {
                        path: "/",
                        module: {
                            Component: () => null,
                            metadata: { moduleId: "pages/Home", fullPath: "/" },
                        },
                    },
                    {
                        path: "*",
                        statusCode: 404,
                        module: {
                            Component: () => null,
                            metadata: { moduleId: "pages/NotFound", fullPath: "/*" },
                        },
                    },
                ],
            },
        ];

        const originalCwd = process.cwd;
        process.cwd = () => TEST_DIR;
        try {
            await generateStatic(app, routes);
        } finally {
            process.cwd = originalCwd;
        }

        // 404.html lives at the outDir root (convention /404.html), next to index.html.
        const notFoundPath = path.join(TEST_DIR, "dist/404.html");
        expect(fs.existsSync(notFoundPath)).toBe(true);
        expect(fs.readFileSync(notFoundPath, "utf-8")).toContain("Not Found");

        // The catch-all must NOT be generated as a normal page (no "*" dir).
        expect(fs.existsSync(path.join(TEST_DIR, "dist/*"))).toBe(false);
        expect(fs.existsSync(path.join(TEST_DIR, "dist/index.html"))).toBe(true);
    });

    it("does not emit 404.html when there is no catch-all", async () => {
        const app = createMockApp({
            "/": {
                html: "<html><body>Home</body></html>",
                data: { "pages/Home": { title: "Home" } },
            },
        });

        const routes: AppRoutes = [
            {
                module: {
                    Component: () => null,
                    metadata: { moduleId: "pages/Home", fullPath: "/" },
                },
            },
        ];

        const originalCwd = process.cwd;
        process.cwd = () => TEST_DIR;
        try {
            await generateStatic(app, routes);
        } finally {
            process.cwd = originalCwd;
        }

        expect(fs.existsSync(path.join(TEST_DIR, "dist/404.html"))).toBe(false);
    });

    it("works without a public/ folder", async () => {
        const app = createMockApp({
            "/": {
                html: "<html><body>Home</body></html>",
                data: { "pages/Home": { title: "Home" } },
            },
        });

        const routes: AppRoutes = [
            {
                module: {
                    Component: () => null,
                    metadata: { moduleId: "pages/Home", fullPath: "/" },
                },
            },
        ];

        const originalCwd = process.cwd;
        process.cwd = () => TEST_DIR;
        try {
            await generateStatic(app, routes);
        } finally {
            process.cwd = originalCwd;
        }

        // Should still generate HTML normally
        expect(fs.existsSync(path.join(TEST_DIR, "dist/index.html"))).toBe(true);
    });
});
