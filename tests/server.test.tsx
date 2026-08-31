import { describe, it, expect } from "vitest";
import type { ComponentChildren } from "preact";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "../src/server.js";
import type { AppRoutes } from "../src/types.js";

const Root = {
    Component: ({ children }: { children?: ComponentChildren }) => (
        <html>
            <head></head>
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

describe("createApp — loader short-circuit Response", () => {
    const routesWithRedirect = (): AppRoutes => [
        {
            module: Root,
            isRoot: true,
            children: [
                {
                    path: "/login",
                    module: page("Login", "/login", "login page", {
                        loader: async ({ c }: any) => c.redirect("/"),
                    }),
                },
                { path: "/", module: page("Home", "/", "home page") },
            ],
        },
    ];

    it("a Response returned by a loader short-circuits rendering (redirect on direct load)", async () => {
        // Report: in 0.0.46 the Response ended up stringified into
        // __PAGE_DATA__ and the page rendered 200. A loader must be able to
        // redirect — auth checks live in loaders, not only in middlewares.
        const app = await createApp(routesWithRedirect());
        const res = await app.fetch(new Request("http://localhost/login"));
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/");
    });

    it("_data=1 gets a JSON __redirect instead of the raw Response (SPA navigation)", async () => {
        // fetch() would follow a 302 into HTML and fail on r.json() — the data
        // endpoint hands the client the target and lets it navigate.
        const app = await createApp(routesWithRedirect());
        const res = await app.fetch(new Request("http://localhost/login?_data=1"));
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.__redirect).toBe("/");
    });
});

describe("createApp — __PAGE_DATA__ script injection", () => {
    const extractPayload = (html: string): any => {
        const match = html.match(/window\.__PAGE_DATA__=(.*?)<\/script>/);
        if (!match) throw new Error("payload script not found (or closed early)");
        return JSON.parse(match[1]!);
    };

    const routesWithPayload = (payload: unknown): AppRoutes => [
        {
            module: Root,
            isRoot: true,
            children: [
                {
                    path: "/",
                    module: page("Home", "/", "home page", {
                        loader: async () => payload,
                    }),
                },
            ],
        },
    ];

    it("escapes </script> inside loader data — the tag never closes early", async () => {
        const app = await createApp(
            routesWithPayload({ evil: "</script><h1>owned</h1>" })
        );
        const html = await (await app.fetch(new Request("http://localhost/"))).text();

        expect(html).toContain("\\u003c/script");
        expect(html).not.toContain("</script><h1>owned");
        expect(extractPayload(html).Home.evil).toBe("</script><h1>owned</h1>");
    });

    it("escapes <!-- (script data escaped state)", async () => {
        const app = await createApp(routesWithPayload({ note: "<!-- comment -->" }));
        const html = await (await app.fetch(new Request("http://localhost/"))).text();

        expect(html).not.toContain("<!--");
        expect(extractPayload(html).Home.note).toBe("<!-- comment -->");
    });

    it("round-trips unicode, quotes, backslashes, literal \\u003c text and nested structures", async () => {
        const original = {
            unicode: "olá — 你好 \u2028 separador",
            quotes: 'aspas "duplas" e \'simples\'',
            backslash: "c:\\temp\\x",
            literalEscape: "o texto literal \\u003c não pode sofrer duplo-escape",
            nested: { arr: [1, "</script>", { deep: true }], nil: null },
        };
        const app = await createApp(routesWithPayload(original));
        const html = await (await app.fetch(new Request("http://localhost/"))).text();

        expect(extractPayload(html).Home).toEqual(original);
    });
    it("does not interpret $-patterns in the payload during </head> injection", async () => {
        // 0.0.48 residue: `html.replace("</head>", script + "</head>")` runs
        // AFTER jsonForScript — and a string replacement interprets $& $' $`
        // $1 $$ inside the payload. $' dumps the REST OF THE DOCUMENT into the
        // JSON, reintroducing raw </script> and breaking hydration by a second
        // path. The replacement must be a function (functions skip $-handling).
        const original = { r: "price $& and $' and $` and $1 and $$end" };
        const app = await createApp(routesWithPayload(original));
        const html = await (await app.fetch(new Request("http://localhost/"))).text();

        expect(html.match(/<\/head>/g)).toHaveLength(1);
        expect(extractPayload(html).Home).toEqual(original);
    });

    it("does not interpret repeated $-patterns ($&$&$&$&)", async () => {
        const original = { r: "$&$&$&$&" };
        const app = await createApp(routesWithPayload(original));
        const html = await (await app.fetch(new Request("http://localhost/"))).text();

        expect(extractPayload(html).Home).toEqual(original);
    });
});

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
