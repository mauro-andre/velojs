// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/preact";
import { Router } from "wouter-preact";
import { Link } from "../src/components.js";
import type { RouteModule } from "../src/types.js";

afterEach(() => cleanup());

function hrefOf(node: preact.VNode): string | null {
    const { container } = render(<Router>{node}</Router>);
    return container.querySelector("a")!.getAttribute("href");
}

// Minimal module with injected metadata (as the Vite plugin would produce).
function mod(fullPath: string): RouteModule {
    return {
        Component: () => null,
        metadata: { moduleId: "m", fullPath, path: fullPath },
    };
}

describe("Link — resolution after the no-nest router change", () => {
    it("string path resolves root-absolute", () => {
        expect(hrefOf(<Link to="/stacks">x</Link>)).toBe("/stacks");
    });

    // Critical for consumers with many "~/" links: the "~" is stripped by
    // wouter and the path resolves to root-absolute — it never becomes literal.
    it('"~/x" resolves to "/x" (tilde stripped, not literal)', () => {
        expect(hrefOf(<Link to="~/stacks">x</Link>)).toBe("/stacks");
        expect(hrefOf(<Link to="~/master/workers">x</Link>)).toBe(
            "/master/workers"
        );
    });

    it("module ref navigates to its fullPath (default mode)", () => {
        expect(hrefOf(<Link to={mod("/master/workers")}>x</Link>)).toBe(
            "/master/workers"
        );
    });

    it("module ref with absolute (no-op) still uses fullPath", () => {
        expect(hrefOf(<Link to={mod("/master/workers")} absolute>x</Link>)).toBe(
            "/master/workers"
        );
    });

    it("substitutes params into a module fullPath", () => {
        expect(
            hrefOf(<Link to={mod("/users/:id")} params={{ id: "5" }}>x</Link>)
        ).toBe("/users/5");
    });

    it("appends search params", () => {
        expect(hrefOf(<Link to="/stacks" search={{ tab: "a" }}>x</Link>)).toBe(
            "/stacks?tab=a"
        );
    });
});
