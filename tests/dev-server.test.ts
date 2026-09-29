import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { veloPlugin, devServerExcludeFor } from "../src/vite.js";
import { defaultOptions as devServerDefaults } from "@hono/vite-dev-server";

const VELOJS_ROOT = path.resolve(__dirname, "..");
const FIXTURE = "/tmp/velojs-dev-mjs-fixture";

/**
 * A VeloJS app whose page imports a project `.mjs` module — the Panda CSS
 * shape, without Panda: build-time generators emit ESM artifacts (.mjs)
 * inside the project (styled-system/, .vanilla-extract, etc.).
 */
function writeFixture() {
    fs.rmSync(FIXTURE, { recursive: true, force: true });
    fs.mkdirSync(path.join(FIXTURE, "app/pages"), { recursive: true });
    fs.mkdirSync(path.join(FIXTURE, "styled-system/css"), { recursive: true });

    fs.writeFileSync(
        path.join(FIXTURE, "package.json"),
        JSON.stringify({ name: "mjs-fixture", type: "module" })
    );
    fs.writeFileSync(
        path.join(FIXTURE, "app/routes.tsx"),
        `import type { AppRoutes } from "@mauroandre/velojs";
import * as Root from "./client-root.js";
import * as Home from "./pages/Home.js";
export default [
    { module: Root, isRoot: true, children: [{ path: "/", module: Home }] },
] satisfies AppRoutes;`
    );
    fs.writeFileSync(
        path.join(FIXTURE, "app/client-root.tsx"),
        `export const Component = ({ children }: any) => (
    <html><head></head><body>{children}</body></html>
);`
    );
    fs.writeFileSync(
        path.join(FIXTURE, "app/pages/Home.tsx"),
        `import { css } from "../../styled-system/css/index.mjs";
export const Component = () => <div class={css({ color: "red" })}>home</div>;`
    );
    fs.writeFileSync(
        path.join(FIXTURE, "styled-system/css/index.mjs"),
        `export const css = () => "x";\n`
    );
    fs.writeFileSync(
        path.join(FIXTURE, "app/server.tsx"),
        `// Server initialization\n`
    );
    fs.writeFileSync(
        path.join(FIXTURE, "app/client.tsx"),
        `// Client initialization\n`
    );
    // The fixture has no dependencies of its own: link the repo's
    // node_modules so preact/wouter/hono resolve, and alias the framework's
    // subpaths to the source in this repo — the dev server runs against the
    // real plugin, not a packed tarball.
    fs.symlinkSync(
        path.join(VELOJS_ROOT, "node_modules"),
        path.join(FIXTURE, "node_modules"),
        "dir"
    );
}

let vite: ViteDevServer;
let httpServer: http.Server;
let port: number;

// Framework subpaths resolve to this repo's source, so the fixture runs
// against the real plugin rather than a packed tarball.
const SOURCE_ALIAS = {
    "@mauroandre/velojs/server": path.join(VELOJS_ROOT, "src/server.tsx"),
    "@mauroandre/velojs/client": path.join(VELOJS_ROOT, "src/client.tsx"),
    "@mauroandre/velojs/hooks": path.join(VELOJS_ROOT, "src/hooks.tsx"),
    "@mauroandre/velojs": path.join(VELOJS_ROOT, "src/index.ts"),
};

/**
 * Starts the fixture dev server with a given veloPlugin config, at a random
 * loopback port. Returns the pieces the caller must close.
 */
async function startFixtureServer(
    veloConfig: Record<string, unknown> = {},
    server: Record<string, unknown> = {},
) {
    const serverImpl = await createServer({
        root: FIXTURE,
        configFile: false,
        plugins: veloPlugin(veloConfig),
        server: { middlewareMode: true, hmr: false, ws: false, ...server },
        optimizeDeps: { noDiscovery: true },
        resolve: { alias: SOURCE_ALIAS },
    });
    const listener = http.createServer(serverImpl.middlewares);
    await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
    return { vite: serverImpl, httpServer: listener, port: (listener.address() as any).port };
}

/** A free loopback TCP port (Vite ignores `server.port: 0`). */
function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const p = (probe.address() as any).port;
            probe.close(() => resolve(p));
        });
    });
}

/**
 * Starts the real fixture dev server — Vite owns the listener, no
 * `middlewareMode` — with `HOST` set in the environment (`undefined` clears
 * it), and returns the address the OS actually bound. This locks the last
 * link of the criteria chain: HOST → server.host → the listening socket.
 */
async function startBoundServer(hostEnv: string | undefined) {
    const saved = process.env.HOST;
    if (hostEnv === undefined) delete process.env.HOST;
    else process.env.HOST = hostEnv;
    try {
        const server = await createServer({
            root: FIXTURE,
            configFile: false,
            plugins: veloPlugin(),
            server: {
                port: await freePort(),
                strictPort: true,
                hmr: false,
                ws: false,
            },
            optimizeDeps: { noDiscovery: true },
            resolve: { alias: SOURCE_ALIAS },
        });
        await server.listen();
        return { server, address: server.httpServer!.address() as any };
    } finally {
        if (saved === undefined) delete process.env.HOST;
        else process.env.HOST = saved;
    }
}

beforeAll(async () => {
    writeFixture();
    vite = await createServer({
        root: FIXTURE,
        configFile: false,
        plugins: veloPlugin(),
        server: { middlewareMode: true, hmr: false },
        optimizeDeps: { noDiscovery: true },
        resolve: {
            alias: SOURCE_ALIAS,
        },
    });
    httpServer = http.createServer(vite.middlewares);
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
    port = (httpServer.address() as any).port;
}, 60000);

afterAll(async () => {
    httpServer?.close();
    await vite?.close();
});

describe("devServerExcludeFor — composition", () => {
    it("keeps the upstream defaults and adds .mjs", () => {
        const exclude = devServerExcludeFor({});
        expect(exclude.some((p) => p instanceof RegExp && p.test("/app/pages/Home.tsx"))).toBe(true);
        expect(exclude.some((p) => p instanceof RegExp && p.test("/node_modules/x/y.js"))).toBe(true);
        expect(exclude.some((p) => p instanceof RegExp && p.test("/styled-system/css/index.mjs"))).toBe(true);
    });

    it("tracks the upstream defaults instead of a local copy", () => {
        // The composition imports the defaults — if upstream adds a pattern,
        // it flows through here with no drift.
        const exclude = devServerExcludeFor({});
        const upstreamCount = devServerDefaults.exclude.length;
        expect(exclude.slice(0, upstreamCount)).toEqual(devServerDefaults.exclude);
        expect(exclude[upstreamCount]).toEqual(/.*\.mjs$/);
    });

    it("appends the project's own patterns without replacing the defaults", () => {
        const exclude = devServerExcludeFor({ devServerExclude: ["/generated/**"] });
        expect(exclude).toContain("/generated/**");
        // defaults still there
        expect(exclude.some((p) => p instanceof RegExp && p.test("/app/pages/Home.tsx"))).toBe(true);
        // user patterns come last so they cannot shadow the defaults
        expect(exclude[exclude.length - 1]).toBe("/generated/**");
    });
});

describe("dev server — project .mjs modules", () => {
    it("serves a project .mjs module as JS instead of intercepting it as a page", async () => {
        // Report: /styled-system/css/index.mjs fell through to the SSR app and
        // came back as fallback HTML/404 — the browser ESM import died with
        // "Failed to load module", app without render.
        const res = await fetch(`http://127.0.0.1:${port}/styled-system/css/index.mjs`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("javascript");
        const body = await res.text();
        expect(body).toContain("css");
        expect(body).not.toMatch(/<html|<!doctype/i);
    });

    it("still serves the page itself (the exclusion did not break routing)", async () => {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain("home");
    });
});

/**
 * HTTP GET with a forged Host header — Node's fetch treats Host as a
 * forbidden header, so we go through net/http directly.
 */
function requestWithHost(
    port: number,
    host: string,
): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: "127.0.0.1", port, path: "/", headers: { Host: host } },
            (res) => {
                let body = "";
                res.on("data", (chunk) => (body += chunk));
                res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
            },
        );
        req.on("error", reject);
        req.end();
    });
}

describe("dev server — Host header policy", () => {
    it("a broad bind accepts a request carrying an arbitrary domain in Host", async () => {
        // `HOST=0.0.0.0`/`--host` (no value) declares the dev server sits
        // behind a proxy: the DNS-rebinding guard is dropped, so the domain
        // the proxy forwards is served instead of 403'd.
        const s = await startFixtureServer({ hostname: "0.0.0.0" });
        try {
            const res = await requestWithHost(s.port, "app.exemplo.com");
            expect(res.status).toBe(200);
            expect(res.body).toContain("home");
        } finally {
            s.httpServer.close();
            await s.vite.close();
        }
    }, 60000);

    it("keeps Vite's block on an arbitrary Host outside a broad bind", async () => {
        const s = await startFixtureServer();
        try {
            const res = await requestWithHost(s.port, "app.exemplo.com");
            expect(res.status).toBe(403);
            expect(res.body).toContain("Blocked request");
        } finally {
            s.httpServer.close();
            await s.vite.close();
        }
    }, 60000);

    it("respects a project-declared server.allowedHosts even on a broad bind", async () => {
        // Same broad bind, but the project pinned the list: it wins.
        const s = await startFixtureServer(
            { hostname: "0.0.0.0" },
            { allowedHosts: ["permitido.exemplo.com"] },
        );
        try {
            const blocked = await requestWithHost(s.port, "outro.exemplo.com");
            expect(blocked.status).toBe(403);

            const allowed = await requestWithHost(s.port, "permitido.exemplo.com");
            expect(allowed.status).toBe(200);
        } finally {
            s.httpServer.close();
            await s.vite.close();
        }
    }, 60000);
});

describe("dev server — listener bind (HOST in dev)", () => {
    it("binds every interface when HOST=0.0.0.0", async () => {
        const { server, address } = await startBoundServer("0.0.0.0");
        try {
            expect(address.address).toBe("0.0.0.0");
        } finally {
            await server.close();
        }
    }, 60000);

    it("binds loopback when HOST=127.0.0.1", async () => {
        const { server, address } = await startBoundServer("127.0.0.1");
        try {
            expect(address.address).toBe("127.0.0.1");
        } finally {
            await server.close();
        }
    }, 60000);

    it("binds loopback when nothing is declared", async () => {
        const { server, address } = await startBoundServer(undefined);
        try {
            // Vite resolves the loopback default to 127.0.0.1 or ::1 depending
            // on the machine; both are loopback.
            expect(["127.0.0.1", "::1"]).toContain(address.address);
        } finally {
            await server.close();
        }
    }, 60000);
});
