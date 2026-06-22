// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, cleanup, act } from "@testing-library/preact";
import { useEffect } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { ClientRoutes } from "../src/client.js";
import type { AppRoutes } from "../src/types.js";

let mounts: Record<string, number>;
const layout = (name: string) => ({
    Component: ({ children }: { children?: ComponentChildren }) => {
        useEffect(() => {
            mounts[name] = (mounts[name] ?? 0) + 1;
        }, []);
        return <div>{name}{children}</div>;
    },
});
const page = (t: string) => ({ Component: () => <div>{t}</div> });

function routes(): AppRoutes {
    return [
        {
            module: { Component: ({ children }: any) => <div>{children}</div> },
            isRoot: true,
            children: [
                {
                    module: layout("admin"),
                    children: [
                        { path: "/", module: page("dash") },
                        {
                            path: "/master",
                            module: layout("master"),
                            children: [
                                { path: "/workers", module: page("workers") },
                                { path: "/servers", module: page("servers") },
                            ],
                        },
                    ],
                },
                { path: "*", module: page("not-found") },
            ],
        },
    ];
}

function navigate(path: string) {
    act(() => {
        window.history.pushState({}, "", path);
        window.dispatchEvent(new PopStateEvent("popstate"));
    });
}

beforeEach(() => {
    mounts = {};
    window.history.pushState({}, "", "/master/workers");
});
afterEach(() => {
    cleanup();
    window.history.pushState({}, "", "/");
});

describe("layout persistence across sibling navigations", () => {
    it("path-ful layout (master) persists across sibling routes", () => {
        const { container } = render(<ClientRoutes routes={routes()} />);
        expect(container.textContent).toContain("workers");
        expect(mounts.master).toBe(1);

        navigate("/master/servers");
        expect(container.textContent).toContain("servers"); // nav happened
        expect(mounts.master).toBe(1); // NOT remounted
    });

    it("parent layout (admin) persists within a section", () => {
        const { container } = render(<ClientRoutes routes={routes()} />);
        expect(mounts.admin).toBe(1);
        navigate("/master/servers");
        expect(container.textContent).toContain("servers");
        expect(mounts.admin).toBe(1);
    });
});
