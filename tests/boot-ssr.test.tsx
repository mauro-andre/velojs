// Node environment — asserts the SSR HTML shape and the server branch of
// useBoot, with no browser globals around.
import { describe, it, expect } from "vitest";
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

function extractBootScripts(html: string): string[] {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    return scripts.map((m) => m[1]!).filter((s) => s.includes("__VELO_BOOT__"));
}

describe("Boot — SSR", () => {
    it("renders one inline classic script in the page declaring the keys", async () => {
        const app = await createApp(
            buildRoutes(<Boot localStorage={["theme", "sidebarHidden"]} />)
        );
        const html = await (await app.fetch(new Request("http://localhost/"))).text();

        const boots = extractBootScripts(html);
        expect(boots).toHaveLength(1);
        expect(boots[0]).toContain(`"theme"`);
        expect(boots[0]).toContain(`"sidebarHidden"`);
        expect(boots[0]).toContain("documentElement");
    });

    it("renders one script per Boot declaration (storages declared separately)", async () => {
        const app = await createApp(
            buildRoutes(
                <>
                    <Boot localStorage={["theme"]} />
                    <Boot cookies={["org"]} />
                </>
            )
        );
        const html = await (await app.fetch(new Request("http://localhost/"))).text();

        const boots = extractBootScripts(html);
        expect(boots).toHaveLength(2);
        expect(boots[0]).toContain(`"theme"`);
        expect(boots[1]).toContain(`"org"`);
    });

    it("embeds keys safely — no raw < in the script source", async () => {
        const app = await createApp(
            buildRoutes(<Boot localStorage={["</script><h1>owned</h1>"]} />)
        );
        const html = await (await app.fetch(new Request("http://localhost/"))).text();

        expect(html).not.toContain("</script><h1>owned");
        expect(html).toContain("\\u003c");
    });
});

describe("useBoot — server branch", () => {
    it("returns an empty object during SSR (no window access)", () => {
        expect(useBoot()).toEqual({});
    });
});
