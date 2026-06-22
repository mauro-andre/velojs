import { describe, it, expect } from "vitest";
import type { ComponentChildren } from "preact";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "../src/server.js";
import type { AppRoutes } from "../src/types.js";

const Root = {
    Component: ({ children }: { children?: ComponentChildren }) => (
        <html>
            <body>{children}</body>
        </html>
    ),
    metadata: { moduleId: "Root" },
};

function page(id: string, fullPath: string, text: string, extra: any = {}) {
    return {
        Component: () => <div>{text}</div>,
        metadata: { moduleId: id, fullPath },
        ...extra,
    };
}

function buildRoutes(): AppRoutes {
    return [
        {
            module: Root,
            isRoot: true,
            children: [
                { path: "/", module: page("Home", "/", "home page") },
                // Explicit status on a normal route.
                {
                    path: "/gone",
                    module: page("Gone", "/gone", "gone page"),
                    statusCode: 410,
                },
                // Conditional status set from a loader (resource missing inside a
                // valid route) — must be honored on HTML and on the _data fetch.
                {
                    path: "/maybe",
                    module: page("Maybe", "/maybe", "maybe page", {
                        loader: async ({ c }: any) => {
                            c.status(404);
                            return { ok: false };
                        },
                    }),
                },
                // Bare catch-all → the 404 page (served via app.notFound).
                {
                    path: "*",
                    statusCode: 404,
                    module: page("NotFound", "/*", "not found page"),
                },
            ],
        },
    ];
}

describe("createApp — statusCode + 404", () => {
    it("serves a normal route with status 200", async () => {
        const app = await createApp(buildRoutes());
        const res = await app.fetch(new Request("http://localhost/"));
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("home page");
    });

    it("honors an explicit statusCode on a route (HTML and _data)", async () => {
        const app = await createApp(buildRoutes());

        const html = await app.fetch(new Request("http://localhost/gone"));
        expect(html.status).toBe(410);
        expect(await html.text()).toContain("gone page");

        const data = await app.fetch(new Request("http://localhost/gone?_data=1"));
        expect(data.status).toBe(410);
    });

    it("renders the catch-all 404 page (with root layout) for an unknown path", async () => {
        const app = await createApp(buildRoutes());
        const res = await app.fetch(new Request("http://localhost/does-not-exist"));
        expect(res.status).toBe(404);
        const body = await res.text();
        expect(body).toContain("not found page");
        // Wrapped in the root layout.
        expect(body).toContain("<html");
    });

    it("returns 404 JSON on the _data fetch of an unknown path", async () => {
        const app = await createApp(buildRoutes());
        const res = await app.fetch(
            new Request("http://localhost/does-not-exist?_data=1")
        );
        expect(res.status).toBe(404);
        expect(res.headers.get("content-type")).toContain("application/json");
    });

    it("honors c.status(404) set in a loader (HTML and _data)", async () => {
        const app = await createApp(buildRoutes());

        const html = await app.fetch(new Request("http://localhost/maybe"));
        expect(html.status).toBe(404);
        expect(await html.text()).toContain("maybe page");

        const data = await app.fetch(new Request("http://localhost/maybe?_data=1"));
        expect(data.status).toBe(404);
    });

    it("falls through serveStatic to the 404 page in production order (SSR platform)", async () => {
        // Mimic startServer's production wiring: serveStatic is mounted on /*
        // AFTER createApp. An unknown path finds no route and no static file, so
        // serveStatic calls next() → Hono runs app.notFound() → our 404 page.
        const app = await createApp(buildRoutes());
        app.use("/*", serveStatic({ root: "/tmp/velojs-nonexistent-client-dir" }));

        const res = await app.fetch(new Request("http://localhost/no-such-page"));
        expect(res.status).toBe(404);
        expect(await res.text()).toContain("not found page");

        // A real page route still renders through the serveStatic middleware.
        const home = await app.fetch(new Request("http://localhost/"));
        expect(home.status).toBe(200);
        expect(await home.text()).toContain("home page");
    });

    it("does not register the catch-all as a normal GET (asset paths fall through)", async () => {
        // With no catch-all there is no app.notFound page; an unknown path gets
        // Hono's default 404 (plain text), proving "*" is wired to notFound and
        // not a greedy GET that would shadow everything.
        const noCatchAll: AppRoutes = [
            {
                module: Root,
                isRoot: true,
                children: [{ path: "/", module: page("Home", "/", "home page") }],
            },
        ];
        const app = await createApp(noCatchAll);
        const res = await app.fetch(new Request("http://localhost/assets/app.js"));
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain("home page");
    });
});
