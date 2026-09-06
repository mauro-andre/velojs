import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import http from "node:http";
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

beforeAll(async () => {
    writeFixture();
    vite = await createServer({
        root: FIXTURE,
        configFile: false,
        plugins: veloPlugin(),
        server: { middlewareMode: true, hmr: false },
        optimizeDeps: { noDiscovery: true },
        resolve: {
            alias: {
                "@mauroandre/velojs/server": path.join(VELOJS_ROOT, "src/server.tsx"),
                "@mauroandre/velojs/client": path.join(VELOJS_ROOT, "src/client.tsx"),
                "@mauroandre/velojs/hooks": path.join(VELOJS_ROOT, "src/hooks.tsx"),
                "@mauroandre/velojs": path.join(VELOJS_ROOT, "src/index.ts"),
            },
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
