import { describe, it, expect } from "vitest";
import { buildFullPathMap } from "../src/vite.js";

describe("buildFullPathMap", () => {
    it("parses simple flat routes", () => {
        const code = `
import * as Home from "./pages/Home.js";
import * as About from "./pages/About.js";

export default [
    { path: "/", module: Home },
    { path: "/about", module: About },
];`;
        const result = buildFullPathMap(code);
        expect(result.get("pages/Home")).toEqual({ fullPath: "/", path: "/" });
        expect(result.get("pages/About")).toEqual({ fullPath: "/about", path: "/about" });
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
        const result = buildFullPathMap(code);
        expect(result.get("admin/Layout")).toEqual({ fullPath: "/admin", path: "/admin" });
        // Index route: path "/" on leaf resolves to parent's fullPath
        expect(result.get("admin/Dashboard")).toEqual({ fullPath: "/admin", path: "/" });
        expect(result.get("admin/Users")).toEqual({ fullPath: "/admin/users", path: "/users" });
    });

    it("handles routes with parameters", () => {
        const code = `
import * as UserDetail from "./users/Detail.js";

export default [
    { path: "/users/:id", module: UserDetail },
];`;
        const result = buildFullPathMap(code);
        expect(result.get("users/Detail")).toEqual({ fullPath: "/users/:id", path: "/users/:id" });
    });

    it("handles deeply nested routes", () => {
        const code = `
import * as Root from "./client-root.js";
import * as Admin from "./admin/Layout.js";
import * as Settings from "./admin/settings/Layout.js";
import * as Profile from "./admin/settings/Profile.js";

export default [
    {
        module: Root,
        children: [
            {
                path: "/admin",
                module: Admin,
                children: [
                    {
                        path: "/settings",
                        module: Settings,
                        children: [
                            { path: "/profile", module: Profile },
                        ],
                    },
                ],
            },
        ],
    },
];`;
        const result = buildFullPathMap(code);
        expect(result.get("admin/settings/Profile")).toEqual({
            fullPath: "/admin/settings/profile",
            path: "/profile",
        });
    });

    it("handles layout without path (pure wrapper)", () => {
        const code = `
import * as AuthLayout from "./auth/Layout.js";
import * as Login from "./auth/Login.js";

export default [
    {
        module: AuthLayout,
        children: [
            { path: "/login", module: Login },
        ],
    },
];`;
        const result = buildFullPathMap(code);
        // AuthLayout has no path, so it's a pure wrapper
        expect(result.get("auth/Layout")).toEqual({ fullPath: "", path: "" });
        expect(result.get("auth/Login")).toEqual({ fullPath: "/login", path: "/login" });
    });

    it("handles satisfies AppRoutes syntax", () => {
        const code = `
import type { AppRoutes } from "velojs";
import * as Home from "./pages/Home.js";

export default [
    { path: "/", module: Home },
] satisfies AppRoutes;`;
        const result = buildFullPathMap(code);
        expect(result.get("pages/Home")).toEqual({ fullPath: "/", path: "/" });
    });

    it("handles as AppRoutes syntax", () => {
        // `as` must behave exactly like `satisfies`. Without a TSAsExpression
        // branch the map comes back empty, no module gets a fullPath, and every
        // route 404s at boot with only a console.warn — a silent failure.
        const code = `
import type { AppRoutes } from "velojs";
import * as Home from "./pages/Home.js";

export default [
    { path: "/", module: Home },
] as AppRoutes;`;
        const result = buildFullPathMap(code);
        expect(result.get("pages/Home")).toEqual({ fullPath: "/", path: "/" });
    });

    it("returns empty map for routes without namespace imports", () => {
        const code = `
import Home from "./pages/Home.js";

export default [
    { path: "/", module: Home },
];`;
        const result = buildFullPathMap(code);
        // Default import (not namespace) won't be matched
        expect(result.size).toBe(0);
    });
});
