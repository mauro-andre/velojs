// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/preact";
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
