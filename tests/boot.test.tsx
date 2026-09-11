// @vitest-environment jsdom
// Executes the generated boot script against real jsdom storage/cookies —
// the round-trip that decides whether the first paint is correct.
import { describe, it, expect, beforeEach } from "vitest";
import type { ComponentChildren } from "preact";
import { createApp } from "../src/server.js";
import { useBoot } from "../src/hooks.js";
import { Boot } from "../src/components.js";
import type { AppRoutes } from "../src/types.js";

const buildRoutes = (head: ComponentChildren): AppRoutes => [
    {
        module: {
            Component: ({ children }: any) => (
                <html>
                    <head>{head}</head>
                    <body>{children}</body>
                </html>
            ),
            metadata: { moduleId: "Root" },
        },
        isRoot: true,
        children: [
            {
                path: "/",
                module: {
                    Component: () => <div>home</div>,
                    metadata: { moduleId: "Home", fullPath: "/" },
                },
            },
        ],
    },
];

async function ssrBootScripts(head: ComponentChildren): Promise<string[]> {
    const app = await createApp(buildRoutes(head));
    const html = await (await app.fetch(new Request("http://localhost/"))).text();
    return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .map((m) => m[1]!)
        .filter((s) => s.includes("__VELO_BOOT__"));
}

/** First boot script, asserted to exist. */
async function firstBootScript(head: ComponentChildren): Promise<string> {
    const scripts = await ssrBootScripts(head);
    expect(scripts.length).toBeGreaterThan(0);
    return scripts[0]!;
}

beforeEach(() => {
    delete (window as any).__VELO_BOOT__;
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-sidebarHidden");
    document.documentElement.removeAttribute("data-bc-terminal-colapsado");
    document.documentElement.removeAttribute("data-org");
});

describe("Boot — script execution", () => {
    it("loads localStorage keys into __VELO_BOOT__ and mirrors them as data-attributes", async () => {
        localStorage.setItem("theme", "dark");
        localStorage.setItem("sidebarHidden", "true");

        const script = await firstBootScript(
            <Boot localStorage={["theme", "sidebarHidden"]} />
        );
        // The pre-paint execution: this is exactly what the browser does
        // between parsing <head> and painting <body>.
        (0, eval)(script);

        expect((window as any).__VELO_BOOT__).toEqual({
            theme: "dark",
            sidebarHidden: "true",
        });
        expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
        expect(document.documentElement.getAttribute("data-sidebarHidden")).toBe("true");
    });

    it("sanitizes attribute names — 'bc:terminal-colapsado' becomes data-bc-terminal-colapsado", async () => {
        localStorage.setItem("bc:terminal-colapsado", "true");

        const script = await firstBootScript(
            <Boot localStorage={["bc:terminal-colapsado"]} />
        );
        (0, eval)(script);

        expect(document.documentElement.getAttribute("data-bc-terminal-colapsado")).toBe("true");
    });

    it("leaves absent keys out — undefined on destructure, no attribute", async () => {
        const script = await firstBootScript(
            <Boot localStorage={["theme", "missing"]} />
        );
        (0, eval)(script);

        // Nothing found → no boot object at all (the script stays no-op);
        // useBoot() normalizes to {}.
        expect((window as any).__VELO_BOOT__).toBeUndefined();
        expect(useBoot().missing).toBeUndefined();
        expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    });

    it("loads cookies and merges multiple Boot declarations into one object", async () => {
        localStorage.setItem("theme", "dark");
        document.cookie = "org=acme";

        const scripts = await ssrBootScripts(
            <>
                <Boot localStorage={["theme"]} />
                <Boot cookies={["org"]} />
            </>
        );
        expect(scripts).toHaveLength(2);
        for (const s of scripts) (0, eval)(s);

        expect((window as any).__VELO_BOOT__).toEqual({ theme: "dark", org: "acme" });
        expect(document.documentElement.getAttribute("data-org")).toBe("acme");
    });

    it("survives a poisoned storage (private-mode access throws)", async () => {
        const original = window.localStorage;
        Object.defineProperty(window, "localStorage", {
            get() {
                throw new Error("SecurityError");
            },
            configurable: true,
        });
        try {
            const script = await firstBootScript(<Boot localStorage={["theme"]} />);
            (0, eval)(script); // must not throw
            expect((window as any).__VELO_BOOT__).toBeUndefined();
        } finally {
            Object.defineProperty(window, "localStorage", {
                value: original,
                configurable: true,
            });
        }
    });
});

describe("useBoot — client branch", () => {
    it("returns the boot values loaded before paint", async () => {
        localStorage.setItem("theme", "dark");
        const script = await firstBootScript(<Boot localStorage={["theme"]} />);
        (0, eval)(script);

        const { theme } = useBoot();
        expect(theme).toBe("dark");
    });

    it("returns an empty object when nothing was declared/loaded", () => {
        expect(useBoot()).toEqual({});
    });
});
