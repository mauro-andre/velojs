import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import type { ComponentChildren } from "preact";
import { createApp, onServer, startServer } from "../src/server.js";
import type { AppRoutes } from "../src/types.js";

/**
 * Regression for the production report (app on 0.0.57, `velojs build` +
 * `velojs start`): with a top-level dynamic route (`/:mes`) in the tree, the
 * hashed assets answered `302 → /login` without a session (the route auth
 * middleware) and `404` with one (the loader rejecting the hashed name as an
 * invalid param) — Hono composes handlers in registration order and the route
 * table was registered before the `serveStatic` of `dist/client`. The page
 * rendered with no CSS and no hydration.
 *
 * The fixture mirrors the real build layout: `client.<hash>.js` and
 * `client.<hash>.css` at the ROOT of `dist/client` — a single top-level
 * segment, the exact shape that collides with a top-level dynamic route (and,
 * hence, the shape a weaker fixture would miss). The server is the real one:
 * `NODE_ENV=production` through `startServer`, over TCP, against a real
 * `dist/client` on disk.
 */

const FIXTURE_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "velojs-production-assets-")
);
const CLIENT_DIR = path.join(FIXTURE_DIR, "dist", "client");
const JS_ASSET = "client.qx4BGU8J.js";
const CSS_ASSET = "client.9mN2pQ3R.css";
const JS_BODY = Buffer.from(
    'console.log("velojs asset");\n// ção — byte exact\n',
    "utf8"
);
const CSS_BODY = Buffer.from(".velo{color:#0af}\n", "utf8");

const MONTH = /^\d{4}-\d{2}$/;

// The report's route auth middleware: no session → redirect to the login.
// Every run is recorded so the test can prove it never sees an asset path.
const middlewareRuns: string[] = [];
const requireSession = async (c: any, next: any) => {
    middlewareRuns.push(c.req.path);
    if (!(c.req.header("cookie") ?? "").includes("session=")) {
        return c.redirect("/login");
    }
    await next();
};

const page = (
    moduleId: string,
    fullPath: string,
    text: string,
    extra: any = {}
): any => ({
    Component: () => <div>{text}</div>,
    metadata: { moduleId, fullPath },
    ...extra,
});

const Root = {
    Component: ({ children }: { children?: ComponentChildren }) => (
        <html>
            <head></head>
            <body>{children}</body>
        </html>
    ),
    metadata: { moduleId: "Root" },
};

const routes: AppRoutes = [
    {
        module: Root,
        isRoot: true,
        children: [
            { path: "/", module: page("Home", "/", "home page") },
            { path: "/login", module: page("Login", "/login", "login page") },
            {
                path: "/:mes",
                module: page("Month", "/:mes", "month page", {
                    // Same as the report's loader: the param is validated and an
                    // invalid value is the app's own 404 (the catch-all page).
                    loader: async ({ params, c }: any) =>
                        MONTH.test(params.mes ?? "")
                            ? { mes: params.mes }
                            : c.notFound(),
                }),
                middlewares: [requireSession],
            },
            {
                path: "*",
                statusCode: 404,
                module: page("NotFound", "/*", "not found page"),
            },
        ],
    },
];

function freePort(): Promise<number> {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.listen(0, "127.0.0.1", () => {
            const port = (srv.address() as net.AddressInfo).port;
            srv.close(() => resolve(port));
        });
    });
}

const ENV_KEYS = ["NODE_ENV", "STATIC_BASE_URL", "VELO_STATIC", "PORT", "HOST"];
const savedEnv: Record<string, string | undefined> = {};

function restoreEnv(key: string): void {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
}

let captured: import("http").Server | undefined;
let baseUrl = "";
let prevCwd = process.cwd();

beforeAll(async () => {
    fs.mkdirSync(CLIENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(CLIENT_DIR, JS_ASSET), JS_BODY);
    fs.writeFileSync(path.join(CLIENT_DIR, CSS_ASSET), CSS_BODY);

    // `startServer` resolves dist/client from the process cwd — the fixture is
    // the app being served. Restored in afterAll (same pattern as init.test).
    prevCwd = process.cwd();
    process.chdir(FIXTURE_DIR);

    for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
    }
    process.env.NODE_ENV = "production";

    const port = await freePort();
    onServer((server) => {
        captured = server;
    });
    await startServer({ routes, port, hostname: "127.0.0.1" });
    baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
    if (captured) {
        captured.closeIdleConnections?.();
        await new Promise<void>((resolve) => captured!.close(() => resolve()));
    }
    process.chdir(prevCwd);
    for (const key of ENV_KEYS) restoreEnv(key);
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    middlewareRuns.length = 0;
});

const get = (pathname: string, init: RequestInit = {}) =>
    fetch(baseUrl + pathname, init);
const withSession: RequestInit = { headers: { cookie: "session=abc123" } };

describe("production assets — served before the app route table", () => {
    it("without a session: /client.<hash>.js is 200 byte-for-byte, not the auth redirect", async () => {
        const res = await get(`/${JS_ASSET}`);

        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toMatch(/^text\/javascript/);
        expect(Buffer.from(await res.arrayBuffer()).equals(JS_BODY)).toBe(true);
        // The route middleware never saw the request (no 302 → /login).
        expect(middlewareRuns).toEqual([]);
    });

    it("without a session: /client.<hash>.css is 200 byte-for-byte, not the auth redirect", async () => {
        const res = await get(`/${CSS_ASSET}`);

        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toMatch(/^text\/css/);
        expect(Buffer.from(await res.arrayBuffer()).equals(CSS_BODY)).toBe(true);
        expect(middlewareRuns).toEqual([]);
    });

    it("with a session: the dynamic route loader does not swallow the asset", async () => {
        // The other half of the report: with a session the auth middleware
        // passes, and the loader was rejecting `client.<hash>.js` as an
        // invalid `:mes` value (404).
        const res = await get(`/${JS_ASSET}`, withSession);

        expect(res.status).toBe(200);
        expect(Buffer.from(await res.arrayBuffer()).equals(JS_BODY)).toBe(true);
        expect(middlewareRuns).toEqual([]);
    });

    it("a trailing-slash asset URL is normalized before the file lookup", async () => {
        const res = await get(`/${JS_ASSET}/`);

        expect(res.status).toBe(200);
        expect(Buffer.from(await res.arrayBuffer()).equals(JS_BODY)).toBe(true);
        expect(middlewareRuns).toEqual([]);
    });

    it("the app routes stay intact: /2026-10 is 200 with a session, 302 → /login without one", async () => {
        const withCookie = await get("/2026-10", withSession);
        expect(withCookie.status).toBe(200);
        expect(await withCookie.text()).toContain("month page");

        const noCookie = await get("/2026-10", { redirect: "manual" });
        expect(noCookie.status).toBe(302);
        expect(noCookie.headers.get("location")).toBe("/login");
    });

    it("a static miss propagates to the app's catch-all — not the HTTP server's default 404", async () => {
        // `/rota-qualquer` matches the top-level dynamic route; with a session
        // the loader rejects the invalid param and answers the app's 404.
        const rejectedParam = await get("/rota-qualquer", withSession);
        expect(rejectedParam.status).toBe(404);
        expect(await rejectedParam.text()).toContain("not found page");

        // A path with no route at all: the static miss calls next() until the
        // app's notFound handler renders the catch-all page.
        const unmatched = await get("/rota/qualquer/inexistente");
        expect(unmatched.status).toBe(404);
        const body = await unmatched.text();
        expect(body).toContain("not found page");
        expect(body).not.toBe("404 Not Found");
    });

    it("GET / answers the SSR HTML as before — not a 404, not a raw file", async () => {
        const res = await get("/");

        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toMatch(/^text\/html/);
        const body = await res.text();
        expect(body).toContain("<html");
        expect(body).toContain("home page");
    });

    it("gating preserved: CDN prefix, VELO_STATIC and dev never mount the local static", async () => {
        // No local asset answer — the path falls into the app's route table
        // (auth middleware → 302) exactly as before.
        const appAnswersAsRoute = async () => {
            const app = await createApp(routes);
            const res = await app.fetch(
                new Request(`http://localhost/${JS_ASSET}`)
            );
            expect(res.status).toBe(302);
            expect(res.headers.get("location")).toBe("/login");
        };

        process.env.STATIC_BASE_URL = "https://cdn.example.com/assets";
        try {
            await appAnswersAsRoute();
        } finally {
            restoreEnv("STATIC_BASE_URL");
        }

        process.env.VELO_STATIC = "1";
        try {
            await appAnswersAsRoute();
        } finally {
            restoreEnv("VELO_STATIC");
        }

        process.env.NODE_ENV = "development";
        try {
            await appAnswersAsRoute();
        } finally {
            process.env.NODE_ENV = "production";
        }
    });
});