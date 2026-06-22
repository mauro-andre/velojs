// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/preact";
import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { ClientRoutes } from "../src/client.js";
import type { AppRoutes } from "../src/types.js";

// Counts mounts (useEffect with [] runs once per mount) per layout name.
let mounts: Record<string, number>;

const layout = (name: string) => ({
    Component: ({ children }: { children?: ComponentChildren }) => {
        const [count, setCount] = useState(0);
        useEffect(() => {
            mounts[name] = (mounts[name] ?? 0) + 1;
        }, []);
        return (
            <div data-layout={name}>
                {name}
                <button data-inc={name} onClick={() => setCount((c) => c + 1)}>
                    count:{count}
                </button>
                {children}
            </div>
        );
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
    it("path-ful layout (master) is NOT re-mounted across sibling routes", () => {
        const { container } = render(<ClientRoutes routes={routes()} />);
        expect(container.textContent).toContain("workers");
        expect(mounts.master).toBe(1);

        navigate("/master/servers");
        expect(container.textContent).toContain("servers"); // nav happened
        expect(mounts.master).toBe(1); // mount effect did NOT run again
    });

    it("parent layout (admin) is NOT re-mounted within a section", () => {
        const { container } = render(<ClientRoutes routes={routes()} />);
        expect(mounts.admin).toBe(1);

        navigate("/master/servers");
        expect(container.textContent).toContain("servers");
        expect(mounts.admin).toBe(1);
    });

    it("keeps the SAME layout DOM node across sibling navigations (no flicker)", () => {
        const { container } = render(<ClientRoutes routes={routes()} />);
        const before = container.querySelector('[data-layout="master"]');
        expect(before).not.toBeNull();

        navigate("/master/servers");
        const after = container.querySelector('[data-layout="master"]');
        // Same DOM node reference — the layout was reconciled in place, not
        // unmounted and replaced (which is what causes the flicker).
        expect(after).toBe(before);
    });

    it("preserves layout component state across sibling navigations (no reload)", () => {
        const { container } = render(<ClientRoutes routes={routes()} />);
        const btn = container.querySelector('[data-inc="master"]')!;
        act(() => {
            fireEvent.click(btn);
            fireEvent.click(btn);
        });
        expect(
            container.querySelector('[data-inc="master"]')!.textContent
        ).toContain("count:2");

        navigate("/master/servers");
        expect(container.textContent).toContain("servers");
        // State survived the navigation → the layout instance was reused, not
        // reloaded from scratch.
        expect(
            container.querySelector('[data-inc="master"]')!.textContent
        ).toContain("count:2");
    });

    it("path-less shell persists across disjoint top-level children (the PodCubo case)", () => {
        // A pure app-shell (path-less, with a loader) wrapping unrelated
        // top-level routes. Navigating between them must NOT remount the shell.
        const shellRoutes: AppRoutes = [
            {
                module: { Component: ({ children }: any) => <div>{children}</div> },
                isRoot: true,
                children: [
                    {
                        module: layout("shell"),
                        children: [
                            { path: "/stacks", module: page("stacks") },
                            { path: "/billing", module: page("billing") },
                            { path: "/backups", module: page("backups") },
                        ],
                    },
                    { path: "*", module: page("not-found") },
                ],
            },
        ];

        window.history.pushState({}, "", "/stacks");
        const { container } = render(<ClientRoutes routes={shellRoutes} />);
        expect(container.textContent).toContain("stacks");
        expect(mounts.shell).toBe(1);

        navigate("/billing");
        expect(container.textContent).toContain("billing");
        navigate("/backups");
        expect(container.textContent).toContain("backups");
        // Shell rendered once and stayed mounted across all three. No flicker.
        expect(mounts.shell).toBe(1);
    });

    it("path-less parent persists across ALL its children; inner section re-mounts on re-entry", () => {
        render(<ClientRoutes routes={routes()} />);
        expect(mounts.master).toBe(1);
        expect(mounts.admin).toBe(1);

        navigate("/"); // dashboard — a different child of admin
        navigate("/master/workers"); // back into the master section

        // The path-less shell (admin) covers all of its children, so it stays
        // mounted the whole time — even crossing between dashboard and /master.
        expect(mounts.admin).toBe(1);
        // The inner path-ful layout (master) is left and re-entered, so it
        // re-mounts (it isn't part of the dashboard route).
        expect(mounts.master).toBe(2);
    });
});
