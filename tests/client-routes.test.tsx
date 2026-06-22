// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/preact";
import { Link } from "wouter-preact";
import type { ComponentChildren } from "preact";
import { ClientRoutes } from "../src/client.js";
import type { AppRoutes } from "../src/types.js";

// Helpers — minimal page/layout modules that print an identifiable marker.
const layout = (text: string) => ({
    Component: ({ children }: { children?: ComponentChildren }) => (
        <div>
            {text}
            {children}
        </div>
    ),
});
const page = (text: string) => ({ Component: () => <div>{text}</div> });

// Mirrors the reported repro: a path-less GROUP layout (DocsLayout) wrapping
// localized doc routes, plus a bare catch-all NotFound as the last child.
function buildRoutes(): AppRoutes {
    return [
        {
            module: layout("root-layout"),
            isRoot: true,
            children: [
                { path: "/", module: page("home-page") },
                { path: "/termos", module: page("terms-page") },
                {
                    // Path-less group layout grouping localized doc routes.
                    module: layout("docs-layout"),
                    children: [
                        { path: "/docs/:slug", module: page("doc-page") },
                        { path: "/en/docs/:slug", module: page("doc-page-en") },
                    ],
                },
                // Bare catch-all — must win only when nothing else matches.
                { path: "*", module: page("not-found"), statusCode: 404 },
            ],
        },
    ];
}

function navigate(path: string) {
    window.history.pushState({}, "", path);
}

describe("client router — catch-all with a path-less group layout", () => {
    beforeEach(() => navigate("/"));
    afterEach(() => {
        cleanup();
        navigate("/");
    });

    it("renders the catch-all NotFound for an unmatched path (not the group layout)", () => {
        navigate("/does-not-exist");
        const { container } = render(<ClientRoutes routes={buildRoutes()} />);

        // Correct behavior: the bare catch-all wins.
        expect(container.textContent).toContain("not-found");
        // Bug: the path-less docs-layout enters the root <Switch> as an element
        // with no `path` prop, which wouter treats as "*", so it greedily
        // matches the unmatched URL and shadows the real catch-all.
        expect(container.textContent).not.toContain("docs-layout");
    });

    it("still renders a grouped page (inside its layout) when its route matches", () => {
        navigate("/docs/intro");
        const { container } = render(<ClientRoutes routes={buildRoutes()} />);

        expect(container.textContent).toContain("docs-layout");
        expect(container.textContent).toContain("doc-page");
        expect(container.textContent).not.toContain("not-found");
    });

    it("renders top-level pages normally", () => {
        navigate("/termos");
        const { container } = render(<ClientRoutes routes={buildRoutes()} />);

        expect(container.textContent).toContain("terms-page");
        expect(container.textContent).not.toContain("not-found");
    });
});

describe("client router — catch-all with a path-ful nested layout", () => {
    // A layout WITH a path (nest) coexisting with the catch-all.
    function routes(): AppRoutes {
        return [
            {
                module: layout("root-layout"),
                isRoot: true,
                children: [
                    { path: "/", module: page("home-page") },
                    {
                        path: "/dashboard",
                        module: layout("dash-layout"),
                        children: [
                            { path: "/", module: page("overview-page") },
                            { path: "/settings", module: page("settings-page") },
                        ],
                    },
                    { path: "*", module: page("not-found"), statusCode: 404 },
                ],
            },
        ];
    }

    beforeEach(() => navigate("/"));
    afterEach(() => {
        cleanup();
        navigate("/");
    });

    it("renders a nested page inside its path-ful layout", () => {
        navigate("/dashboard/settings");
        const { container } = render(<ClientRoutes routes={routes()} />);

        expect(container.textContent).toContain("dash-layout");
        expect(container.textContent).toContain("settings-page");
        expect(container.textContent).not.toContain("not-found");
    });

    it("still reaches the catch-all for an unmatched path", () => {
        navigate("/nope");
        const { container } = render(<ClientRoutes routes={routes()} />);

        expect(container.textContent).toContain("not-found");
        expect(container.textContent).not.toContain("dash-layout");
    });
});

describe("client router — path-less parent layout wrapping a path-ful nested area", () => {
    // Repro structure: a path-less AdminLayout (with a sidebar <Link>) wrapping
    // a path-ful MasterLayout (nested area), plus a root-level catch-all.
    const adminLayout = {
        Component: ({ children }: { children?: ComponentChildren }) => (
            <div>
                admin-layout
                <Link to="/master/workers">go-workers</Link>
                {children}
            </div>
        ),
    };
    const masterLayout = layout("master-layout");

    function routes(): AppRoutes {
        return [
            {
                module: layout("root-layout"),
                isRoot: true,
                children: [
                    {
                        // PATH-LESS parent layout — gets distributed.
                        module: adminLayout,
                        children: [
                            { path: "/", module: page("dashboard-page") },
                            {
                                // PATH-FUL nested area.
                                path: "/master",
                                module: masterLayout,
                                children: [
                                    { path: "/workers", module: page("workers-page") },
                                    { path: "/servers", module: page("servers-page") },
                                ],
                            },
                        ],
                    },
                    { path: "*", module: page("not-found"), statusCode: 404 },
                ],
            },
        ];
    }

    beforeEach(() => navigate("/"));
    afterEach(() => {
        cleanup();
        navigate("/");
    });

    it("renders the nested area pages (control)", () => {
        navigate("/master/servers");
        const { container } = render(<ClientRoutes routes={routes()} />);

        expect(container.textContent).toContain("admin-layout");
        expect(container.textContent).toContain("master-layout");
        expect(container.textContent).toContain("servers-page");
    });

    // Bug 1: an unmatched sub-route of the nested area must bubble up to the
    // root catch-all and render standalone (matching SSR) — not the empty
    // nested layout.
    it("bubbles an unmatched nested sub-route to the root catch-all (standalone)", () => {
        navigate("/master/does-not-exist");
        const { container } = render(<ClientRoutes routes={routes()} />);

        expect(container.textContent).toContain("not-found");
        // Should NOT render the nested area chrome at all.
        expect(container.textContent).not.toContain("master-layout");
        expect(container.textContent).not.toContain("admin-layout");
    });

    // Bug 2: a <Link> in the path-less PARENT layout must resolve against the
    // root base, not the nested area's base — no prefix doubling.
    it("resolves parent-layout links against the root base (no doubled prefix)", () => {
        navigate("/master/servers");
        const { getByText } = render(<ClientRoutes routes={routes()} />);

        const link = getByText("go-workers") as HTMLAnchorElement;
        expect(link.getAttribute("href")).toBe("/master/workers");
    });
});
