import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const TEST_APP_DIR = path.resolve("/tmp/velojs-build-test");
const VELOJS_ROOT = path.resolve(__dirname, "..");

/**
 * Builds the VeloJS package and creates a tarball (npm pack).
 * Returns the path to the .tgz file.
 * This simulates exactly what gets published to npm.
 */
function buildAndPackVeloJS(): string {
    // Build
    const build = spawnSync("npm", ["run", "build"], {
        cwd: VELOJS_ROOT,
        stdio: "pipe",
        timeout: 30000,
    });
    if (build.status !== 0) {
        throw new Error(
            `VeloJS build failed:\n${build.stderr?.toString()}\n${build.stdout?.toString()}`
        );
    }

    // Pack into .tgz (exactly what npm publish would upload).
    // --silent is load-bearing: we parse stdout for the filename, and without it
    // npm prints the `prepack` lifecycle banners there too, poisoning the path.
    const pack = spawnSync("npm", ["pack", "--silent", "--pack-destination", "/tmp"], {
        cwd: VELOJS_ROOT,
        stdio: "pipe",
        timeout: 30000,
    });
    if (pack.status !== 0) {
        throw new Error(
            `npm pack failed:\n${pack.stderr?.toString()}`
        );
    }

    const tgzName = pack.stdout.toString().trim();
    return path.join("/tmp", tgzName);
}

/**
 * Creates a minimal VeloJS app that uses the packed tarball.
 * Simulates a real dev installing @mauroandre/velojs from npm.
 */
function createTestApp(tgzPath: string) {
    if (fs.existsSync(TEST_APP_DIR)) {
        fs.rmSync(TEST_APP_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_APP_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_APP_DIR, "app/pages"), { recursive: true });
    fs.mkdirSync(path.join(TEST_APP_DIR, "app/webhooks"), { recursive: true });
    fs.mkdirSync(path.join(TEST_APP_DIR, "public/logos"), { recursive: true });

    // package.json — references built VeloJS via tarball (same as npm install from registry).
    // VELO_FIXTURE_VITE ("7" | "8") forces the vite major via npm overrides so the
    // build can be exercised under both Rollup (vite 7) and Rolldown (vite 8). When
    // unset, npm resolves velojs's declared range (highest match → vite 8).
    const fixtureVite = process.env.VELO_FIXTURE_VITE;
    const pkg: Record<string, unknown> = {
        name: "test-app",
        type: "module",
        dependencies: {
            "@mauroandre/velojs": `file:${tgzPath}`,
        },
    };
    if (fixtureVite) {
        pkg.overrides = { vite: `^${fixtureVite}.0.0` };
    }
    fs.writeFileSync(
        path.join(TEST_APP_DIR, "package.json"),
        JSON.stringify(pkg)
    );

    // vite.config.ts
    fs.writeFileSync(
        path.join(TEST_APP_DIR, "vite.config.ts"),
        `import { defineConfig } from "vite";
import { veloPlugin } from "@mauroandre/velojs/vite";
export default defineConfig({ plugins: [veloPlugin()] });
`
    );

    // tsconfig.json
    fs.writeFileSync(
        path.join(TEST_APP_DIR, "tsconfig.json"),
        JSON.stringify({
            compilerOptions: {
                target: "ES2022",
                module: "ESNext",
                moduleResolution: "bundler",
                jsx: "react-jsx",
                jsxImportSource: "preact",
                strict: true,
                esModuleInterop: true,
                skipLibCheck: true,
            },
            include: ["app/**/*"],
        })
    );

    // app/client-root.tsx
    fs.writeFileSync(
        path.join(TEST_APP_DIR, "app/client-root.tsx"),
        `import type { ComponentChildren } from "preact";
import { Scripts } from "@mauroandre/velojs";

export const Component = ({ children }: { children?: ComponentChildren }) => (
    <html lang="en">
        <head>
            <Scripts />
        </head>
        <body>{children}</body>
    </html>
);
`
    );

    // app/client.tsx — clientInit: imports the BASE stylesheet (sync entry).
    // The THEME deliberately does NOT live here: it mirrors the consumer —
    // the css of identity (tokens in :root) is reachable ONLY through modules
    // that fall into async chunks, loaded by interaction, never at boot.
    fs.writeFileSync(
        path.join(TEST_APP_DIR, "app/client.tsx"),
        `import "./base.css";
`
    );

    // app/base.css — the sync-entry stylesheet
    fs.writeFileSync(
        path.join(TEST_APP_DIR, "app/base.css"),
        "body { font-family: sans-serif; }\n"
    );

    // app/theme.css + app/lazy.css — stylesheets reachable ONLY through a
    // dynamic import (async chunk): they travel as strings inside the chunk
    // JS and the theme must still reach the FIRST PAINT of every page.
    fs.writeFileSync(
        path.join(TEST_APP_DIR, "app/theme.css"),
        ":root { --color-bg: #101014; }\n.themed { background: var(--color-bg); }\n"
    );
    fs.writeFileSync(
        path.join(TEST_APP_DIR, "app/lazy.css"),
        ".lazy-pane { padding: 1rem; }\n"
    );
    fs.writeFileSync(
        path.join(TEST_APP_DIR, "app/lazy-pane.ts"),
        `import "./theme.css";
import "./lazy.css";
export const LAZY_PANE_MARKER = "lazy-pane-ok";
`
    );

    // app/server.tsx
    fs.writeFileSync(path.join(TEST_APP_DIR, "app/server.tsx"), "");

    // app/webhooks/github.handler.ts — server-only: imports node:crypto
    fs.writeFileSync(
        path.join(TEST_APP_DIR, "app/webhooks/github.handler.ts"),
        `import type { EndpointHandler } from "@mauroandre/velojs";
import { createHmac } from "node:crypto";

const SECRET_SENTINEL_MARKER = "GITHUB_WEBHOOK_SECRET_XYZ_12345";

export const githubWebhook: EndpointHandler = async ({ c }) => {
    const raw = await c.req.text();
    const sig = c.req.header("x-hub-signature-256") ?? "";
    const expected = "sha256=" + createHmac("sha256", SECRET_SENTINEL_MARKER).update(raw).digest("hex");
    if (sig !== expected) return c.json({ error: "bad sig" }, 401);
    return c.json({ ok: true });
};
`
    );

    // app/routes.tsx
    fs.writeFileSync(
        path.join(TEST_APP_DIR, "app/routes.tsx"),
        `import type { AppRoutes } from "@mauroandre/velojs";
import * as Root from "./client-root.js";
import * as Home from "./pages/Home.js";
import * as About from "./pages/About.js";
import * as Deploy from "./pages/Deploy.js";
import * as Terminal from "./pages/Terminal.js";
import * as Lazy from "./pages/Lazy.js";
import { githubWebhook } from "./webhooks/github.handler.js";

export default [
    {
        module: Root,
        isRoot: true,
        children: [
            { path: "/", module: Home },
            { path: "/about", module: About },
            { path: "/deploy/:id", module: Deploy },
            { path: "/terminal", module: Terminal },
            { path: "/lazy", module: Lazy },
            { path: "/api/github/webhook", method: "POST", handler: githubWebhook },
        ],
    },
] satisfies AppRoutes;
`
    );

    // app/pages/Lazy.tsx — page whose only css arrives via a dynamic import
    // (async chunk): the runtime loads it, so its path must be absolute.
    fs.writeFileSync(
        path.join(TEST_APP_DIR, "app/pages/Lazy.tsx"),
        `export const Component = () => (
    <button onClick={async () => { const m = await import("../lazy-pane.js"); document.title = m.LAZY_PANE_MARKER; }}>lazy</button>
);
`
    );

    // app/channel.server.ts — server-only channel resolver, imported TOP-LEVEL by a
    // page and used only inside createEventStream({ channel }). After the stream is
    // stubbed on the client, this import is orphaned. Rollup tree-shook it for free;
    // Rolldown (vite 8) keeps it, leaking the whole module into the browser bundle.
    // The client transform's import-prune must drop it. (This is the podcubo bug.)
    fs.writeFileSync(
        path.join(TEST_APP_DIR, "app/channel.server.ts"),
        `import { randomBytes } from "node:crypto";

const CHANNEL_RESOLVER_SECRET = "STREAM_CHANNEL_RESOLVER_SECRET_QWE456";

export const ownChannel = (c: any): string => {
    randomBytes(1);
    return c.req.query("channel") ?? CHANNEL_RESOLVER_SECRET;
};
`
    );

    // app/pages/Deploy.tsx — page with stream_* whose channel is an imported helper
    fs.writeFileSync(
        path.join(TEST_APP_DIR, "app/pages/Deploy.tsx"),
        `import { createEventStream } from "@mauroandre/velojs";
import { useEventStream } from "@mauroandre/velojs/hooks";
import { ownChannel } from "../channel.server.js";

type DeployState = { step: string; status: "running" | "success" | "error" };

export const stream_progress = createEventStream<DeployState>({
    channel: ownChannel,
    closeOn: (s) => s.status === "success" || s.status === "error",
});

export const staticPaths = async () => [{ id: "demo" }];

export const Component = () => {
    const { data } = useEventStream(stream_progress);
    return <div>{data.value?.step ?? "waiting"}</div>;
};
`
    );

    // app/pages/Home.tsx — page with loader
    fs.writeFileSync(
        path.join(TEST_APP_DIR, "app/pages/Home.tsx"),
        `import type { LoaderArgs } from "@mauroandre/velojs";
import { useLoader } from "@mauroandre/velojs/hooks";

export const loader = async ({ c }: LoaderArgs) => {
    return { message: "Hello" };
};

export const Component = () => {
    const { data } = useLoader<{ message: string }>();
    return <h1>{data.value?.message}</h1>;
};
`
    );

    // app/pages/About.tsx — simple page without loader
    fs.writeFileSync(
        path.join(TEST_APP_DIR, "app/pages/About.tsx"),
        `export const Component = () => <h1>About</h1>;
`
    );

    // app/pages/Terminal.tsx — page with socket_* importing node-only code
    fs.writeFileSync(
        path.join(TEST_APP_DIR, "app/pages/Terminal.tsx"),
        `import type { SocketHandler } from "@mauroandre/velojs";
import { randomBytes } from "node:crypto";

const TERMINAL_SECRET_SENTINEL = "SOCKET_TERMINAL_SECRET_ABC987";

export const socket_terminal: SocketHandler = async ({ send, keepOpen, abortSignal }) => {
    const sessionId = randomBytes(8).toString("hex") + ":" + TERMINAL_SECRET_SENTINEL;
    send({ type: "hello", sessionId });
    keepOpen();
    abortSignal.addEventListener("abort", () => {});
};

export const Component = () => <div>terminal</div>;
`
    );

    // public/logos/logo.svg — static asset
    fs.writeFileSync(
        path.join(TEST_APP_DIR, "public/logos/logo.svg"),
        "<svg>test</svg>"
    );

    // npm install — installs the built VeloJS package
    const install = spawnSync("npm", ["install"], {
        cwd: TEST_APP_DIR,
        stdio: "pipe",
        timeout: 60000,
    });

    if (install.status !== 0) {
        throw new Error(
            `npm install failed:\n${install.stderr?.toString()}`
        );
    }
}

/**
 * Runs velojs build in the test app.
 */
function runAppBuild(isStatic: boolean, extraEnv: Record<string, string> = {}) {
    const args = isStatic
        ? ["velojs", "build", "--static"]
        : ["velojs", "build"];

    const result = spawnSync("npx", args, {
        cwd: TEST_APP_DIR,
        stdio: "pipe",
        timeout: 60000,
        env: { ...process.env, ...extraEnv },
    });

    if (result.status !== 0) {
        throw new Error(
            `App build failed (status ${result.status}):\n${result.stdout?.toString()}\n${result.stderr?.toString()}`
        );
    }
}

/**
 * Serves the real production build (`node dist/server.js`) on a free TCP
 * port — the exact surface `velojs start` puts in front of a consumer.
 */
async function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address() as net.AddressInfo;
            srv.close(() => resolve(addr.port));
        });
    });
}

interface ServedBuild {
    fetch: (path: string) => Promise<Response>;
    stop: () => Promise<void>;
}

async function serveBuild(extraEnv: Record<string, string> = {}): Promise<ServedBuild> {
    const port = await getFreePort();
    const child = spawn("node", ["dist/server.js"], {
        cwd: TEST_APP_DIR,
        stdio: "pipe",
        env: { ...process.env, NODE_ENV: "production", PORT: String(port), ...extraEnv },
    });
    const base = `http://127.0.0.1:${port}`;

    // Wait for the server to actually listen (boot + module load).
    for (let attempt = 0; attempt < 50; attempt++) {
        try {
            const probe = await fetch(`${base}/`);
            probe.body?.cancel();
            if (probe.status > 0) break;
        } catch {
            await new Promise((r) => setTimeout(r, 200));
        }
    }

    return {
        fetch: (p) => fetch(`${base}${p}`),
        stop: () =>
            new Promise<void>((resolve) => {
                child.on("exit", () => resolve());
                child.kill("SIGTERM");
                setTimeout(() => {
                    child.kill("SIGKILL");
                    resolve();
                }, 3000).unref();
            }),
    };
}

const stylesheetHrefs = (html: string): string[] =>
    Array.from(html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/g), (m) => m[1]!);

const readAllClientJs = (): string => {
    const clientDir = path.join(TEST_APP_DIR, "dist/client");
    let out = "";
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".js")) out += fs.readFileSync(full, "utf-8");
        }
    };
    walk(clientDir);
    return out;
};

describe("Build Integration", () => {
    let tgzPath: string;

    beforeAll(() => {
        // Step 1: Build and pack VeloJS (simulates npm publish)
        tgzPath = buildAndPackVeloJS();
        // Step 2: Create test app using the packed tarball
        createTestApp(tgzPath);
    }, 120000);

    afterAll(() => {
        if (fs.existsSync(TEST_APP_DIR)) {
            fs.rmSync(TEST_APP_DIR, { recursive: true });
        }
        if (tgzPath && fs.existsSync(tgzPath)) {
            fs.unlinkSync(tgzPath);
        }
    });

    describe("SSR build", () => {
        beforeAll(() => {
            const distDir = path.join(TEST_APP_DIR, "dist");
            if (fs.existsSync(distDir)) {
                fs.rmSync(distDir, { recursive: true });
            }
            runAppBuild(false);
        }, 60000);

        it("generates client JS with content hash in filename", () => {
            const clientDir = path.join(TEST_APP_DIR, "dist/client");
            const files = fs.readdirSync(clientDir);

            const jsFiles = files.filter(
                (f) => f.startsWith("client.") && f.endsWith(".js")
            );

            expect(jsFiles.length).toBe(1);
            expect(jsFiles[0]).not.toBe("client.js");
            expect(jsFiles[0]).toMatch(/^client\..+\.js$/);
        });

        it("generates vite manifest with hashed entry", () => {
            const manifestPath = path.join(
                TEST_APP_DIR,
                "dist/client/.vite/manifest.json"
            );
            expect(fs.existsSync(manifestPath)).toBe(true);

            const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
            const entry = manifest["virtual:velo/client-entry"];
            expect(entry).toBeDefined();
            expect(entry.file).toMatch(/^client\..+\.js$/);
        });

        it("server.js sets globalThis.__veloBuildHash with build hash", () => {
            const serverJs = fs.readFileSync(
                path.join(TEST_APP_DIR, "dist/server.js"),
                "utf-8"
            );
            expect(serverJs).toContain("__veloBuildHash");

            // Extract the hash value
            const match = serverJs.match(/__veloBuildHash\s*=\s*"([^"]+)"/);
            expect(match).not.toBeNull();
            expect(match![1]!.length).toBeGreaterThan(0);
        });

        it("server.js passes a resolved port to startServer (no leftover token)", () => {
            const serverJs = fs.readFileSync(
                path.join(TEST_APP_DIR, "dist/server.js"),
                "utf-8"
            );
            // The __VELO_CONFIG_PORT__ define must be substituted, otherwise
            // startServer({ port: __VELO_CONFIG_PORT__ }) throws at runtime.
            expect(serverJs).not.toContain("__VELO_CONFIG_PORT__");
            // Fixture sets no `port` in config → baked as null (PORT env / 3000 win).
            expect(serverJs).toMatch(/startServer\(\s*\{[^}]*port\s*:\s*(null|\d+)/);
        });

        it("server.js references hashed CSS and JS from manifest", () => {
            const serverJs = fs.readFileSync(
                path.join(TEST_APP_DIR, "dist/server.js"),
                "utf-8"
            );

            const manifest = JSON.parse(
                fs.readFileSync(
                    path.join(TEST_APP_DIR, "dist/client/.vite/manifest.json"),
                    "utf-8"
                )
            );
            const entry = manifest["virtual:velo/client-entry"];

            expect(serverJs).toContain(entry.file);
            if (entry.css?.[0]) {
                expect(serverJs).toContain(entry.css[0]);
            }
        });

        it("client and server have the same build hash", () => {
            const serverJs = fs.readFileSync(
                path.join(TEST_APP_DIR, "dist/server.js"),
                "utf-8"
            );
            const serverHashMatch = serverJs.match(
                /__veloBuildHash\s*=\s*"([^"]+)"/
            );
            expect(serverHashMatch).not.toBeNull();
            const buildHash = serverHashMatch![1];

            // Client JS must contain the exact same hash
            const clientDir = path.join(TEST_APP_DIR, "dist/client");
            const clientJsFile = fs
                .readdirSync(clientDir)
                .find((f) => f.startsWith("client.") && f.endsWith(".js"))!;
            const clientJs = fs.readFileSync(
                path.join(clientDir, clientJsFile),
                "utf-8"
            );
            expect(clientJs).toContain(buildHash);
        });

        it("client JS uses fetch with cache: no-cache, not ?v= param", () => {
            const clientDir = path.join(TEST_APP_DIR, "dist/client");
            const clientJsFile = fs
                .readdirSync(clientDir)
                .find((f) => f.startsWith("client.") && f.endsWith(".js"))!;
            const clientJs = fs.readFileSync(
                path.join(clientDir, clientJsFile),
                "utf-8"
            );

            // Must use cache: "no-cache"
            expect(clientJs).toContain("no-cache");
            // Must NOT have old ?v= cache busting pattern
            expect(clientJs).not.toContain("cacheBust");
            expect(clientJs).not.toContain("separator");
        });

        it("__buildHash and Cache-Control logic exists in velojs/server package", () => {
            // In SSR, renderPage lives in @mauroandre/velojs/server (external import).
            // Verify the installed package contains the logic.
            const veloServerJs = fs.readFileSync(
                path.join(TEST_APP_DIR, "node_modules/@mauroandre/velojs/dist/server.js"),
                "utf-8"
            );
            expect(veloServerJs).toContain("__buildHash");
            expect(veloServerJs).toContain("__veloBuildHash");
            expect(veloServerJs).toContain("Cache-Control");
            expect(veloServerJs).toContain("no-cache");
        });

        it("stream_* exports are stubbed in client.js (no createEventStream call leaked)", () => {
            const clientDir = path.join(TEST_APP_DIR, "dist/client");
            const clientJsFile = fs
                .readdirSync(clientDir)
                .find((f) => f.startsWith("client.") && f.endsWith(".js"))!;
            const clientJs = fs.readFileSync(
                path.join(clientDir, clientJsFile),
                "utf-8"
            );

            // The stub object marker must be present on client
            expect(clientJs).toContain("__isVeloEventStream");
            // The path generated by the convention must be there
            expect(clientJs).toContain("/_event/pages/Deploy/progress");
            // The actual createEventStream call must NOT be in the client bundle
            // (the body is stripped — only the stub object remains)
            expect(clientJs).not.toContain("createEventStream");
        });

        it("server.js calls createEventStream from velojs (or imports it)", () => {
            const serverJs = fs.readFileSync(
                path.join(TEST_APP_DIR, "dist/server.js"),
                "utf-8"
            );
            // Server side keeps the real createEventStream
            expect(serverJs).toContain("createEventStream");
        });

        it("velojs package exports createEventStream and useEventStream", () => {
            const indexJs = fs.readFileSync(
                path.join(TEST_APP_DIR, "node_modules/@mauroandre/velojs/dist/index.js"),
                "utf-8"
            );
            expect(indexJs).toContain("createEventStream");

            const hooksJs = fs.readFileSync(
                path.join(TEST_APP_DIR, "node_modules/@mauroandre/velojs/dist/hooks.js"),
                "utf-8"
            );
            expect(hooksJs).toContain("useEventStream");
        });

        it("endpoint handler is registered on the server bundle", () => {
            const serverJs = fs.readFileSync(
                path.join(TEST_APP_DIR, "dist/server.js"),
                "utf-8"
            );
            // The webhook secret sentinel and path should both be in the server bundle
            expect(serverJs).toContain("/api/github/webhook");
            expect(serverJs).toContain("GITHUB_WEBHOOK_SECRET_XYZ_12345");
        });

        it("endpoint handler does NOT leak into the client bundle", () => {
            const clientDir = path.join(TEST_APP_DIR, "dist/client");
            const clientJsFile = fs
                .readdirSync(clientDir)
                .find((f) => f.startsWith("client.") && f.endsWith(".js"))!;
            const clientJs = fs.readFileSync(
                path.join(clientDir, clientJsFile),
                "utf-8"
            );

            // The endpoint path must not appear in the client bundle
            expect(clientJs).not.toContain("/api/github/webhook");
            // The secret sentinel (inside the handler module) must not appear
            expect(clientJs).not.toContain("GITHUB_WEBHOOK_SECRET_XYZ_12345");
            // node:crypto usage from the handler must not leak
            expect(clientJs).not.toContain("createHmac");
        });

        it("socket_* exports become stubs on the client bundle", () => {
            const clientDir = path.join(TEST_APP_DIR, "dist/client");
            const clientJsFile = fs
                .readdirSync(clientDir)
                .find((f) => f.startsWith("client.") && f.endsWith(".js"))!;
            const clientJs = fs.readFileSync(
                path.join(clientDir, clientJsFile),
                "utf-8"
            );

            // Stub marker present and path derived by convention
            expect(clientJs).toContain("__isVeloSocket");
            expect(clientJs).toContain("/_socket/pages/Terminal/terminal");
        });

        it("socket_* handler body does NOT leak into the client bundle", () => {
            const clientDir = path.join(TEST_APP_DIR, "dist/client");
            const clientJsFile = fs
                .readdirSync(clientDir)
                .find((f) => f.startsWith("client.") && f.endsWith(".js"))!;
            const clientJs = fs.readFileSync(
                path.join(clientDir, clientJsFile),
                "utf-8"
            );

            // The handler's secret sentinel (inside the async function body) must not appear
            expect(clientJs).not.toContain("SOCKET_TERMINAL_SECRET_ABC987");
            // node:crypto usage from the handler must not leak
            expect(clientJs).not.toContain("randomBytes");
        });

        it("socket_* handler is present on the server bundle", () => {
            const serverJs = fs.readFileSync(
                path.join(TEST_APP_DIR, "dist/server.js"),
                "utf-8"
            );
            // Secret sentinel from the handler body must be present on server
            expect(serverJs).toContain("SOCKET_TERMINAL_SECRET_ABC987");
            // randomBytes is the node:crypto import the handler uses
            expect(serverJs).toContain("randomBytes");
        });

        it("server-only stream channel resolver does NOT leak into the client (orphan import pruned)", () => {
            // Scan EVERY js file under dist/client — a leaked module can land in a
            // separate chunk, not just client.*.js (this is how it manifested in
            // the wild: a `*.service-*.js` chunk dragged in under Rolldown).
            const clientDir = path.join(TEST_APP_DIR, "dist/client");
            const readAllJs = (dir: string): string => {
                let out = "";
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) out += readAllJs(full);
                    else if (entry.name.endsWith(".js")) out += fs.readFileSync(full, "utf-8");
                }
                return out;
            };
            const clientJs = readAllJs(clientDir);

            // The resolver module (and its node:crypto dep) must be fully absent.
            expect(clientJs).not.toContain("STREAM_CHANNEL_RESOLVER_SECRET_QWE456");
            expect(clientJs).not.toContain("channel.server");
            // The stream itself is still stubbed on the client.
            expect(clientJs).toContain("/_event/pages/Deploy/progress");
        });

        it("server-only stream channel resolver IS present on the server bundle", () => {
            const serverJs = fs.readFileSync(
                path.join(TEST_APP_DIR, "dist/server.js"),
                "utf-8"
            );
            // The resolver runs on the server — its body must survive there.
            expect(serverJs).toContain("STREAM_CHANNEL_RESOLVER_SECRET_QWE456");
        });
    });

    describe("Static build (SSG)", () => {
        beforeAll(() => {
            const distDir = path.join(TEST_APP_DIR, "dist");
            if (fs.existsSync(distDir)) {
                fs.rmSync(distDir, { recursive: true });
            }
            runAppBuild(true);
        }, 60000);

        it("generates static HTML for each route", () => {
            expect(
                fs.existsSync(path.join(TEST_APP_DIR, "dist/index.html"))
            ).toBe(true);
            expect(
                fs.existsSync(path.join(TEST_APP_DIR, "dist/about/index.html"))
            ).toBe(true);
        });

        it("generates static JSON for each route", () => {
            expect(
                fs.existsSync(path.join(TEST_APP_DIR, "dist/index.json"))
            ).toBe(true);
            expect(
                fs.existsSync(path.join(TEST_APP_DIR, "dist/about/index.json"))
            ).toBe(true);
        });

        it("JSON files contain __buildHash", () => {
            const indexJson = JSON.parse(
                fs.readFileSync(
                    path.join(TEST_APP_DIR, "dist/index.json"),
                    "utf-8"
                )
            );
            const aboutJson = JSON.parse(
                fs.readFileSync(
                    path.join(TEST_APP_DIR, "dist/about/index.json"),
                    "utf-8"
                )
            );

            expect(indexJson.__buildHash).toBeDefined();
            expect(typeof indexJson.__buildHash).toBe("string");
            expect(indexJson.__buildHash.length).toBeGreaterThan(0);

            expect(aboutJson.__buildHash).toBeDefined();
            expect(aboutJson.__buildHash).toBe(indexJson.__buildHash);
        });

        it("JSON __buildHash matches client JS build hash", () => {
            const indexJson = JSON.parse(
                fs.readFileSync(
                    path.join(TEST_APP_DIR, "dist/index.json"),
                    "utf-8"
                )
            );

            const clientDir = path.join(TEST_APP_DIR, "dist/client");
            const clientJsFile = fs
                .readdirSync(clientDir)
                .find((f) => f.startsWith("client.") && f.endsWith(".js"))!;
            const clientJs = fs.readFileSync(
                path.join(clientDir, clientJsFile),
                "utf-8"
            );

            expect(clientJs).toContain(indexJson.__buildHash);
        });

        it("copies public/ folder to dist/ root", () => {
            expect(
                fs.existsSync(path.join(TEST_APP_DIR, "dist/logos/logo.svg"))
            ).toBe(true);
            expect(
                fs.readFileSync(
                    path.join(TEST_APP_DIR, "dist/logos/logo.svg"),
                    "utf-8"
                )
            ).toBe("<svg>test</svg>");
        });

        it("HTML references hashed JS filename, not fixed name", () => {
            const html = fs.readFileSync(
                path.join(TEST_APP_DIR, "dist/index.html"),
                "utf-8"
            );

            // JS must NOT have fixed name
            expect(html).not.toMatch(/["']\/client\/client\.js["']/);
            // JS must have hashed name
            expect(html).toMatch(/client\.[a-zA-Z0-9_-]+\.js/);
        });

        it("client JS uses fetch with cache: no-cache", () => {
            const clientDir = path.join(TEST_APP_DIR, "dist/client");
            const clientJsFile = fs
                .readdirSync(clientDir)
                .find((f) => f.startsWith("client.") && f.endsWith(".js"))!;
            const clientJs = fs.readFileSync(
                path.join(clientDir, clientJsFile),
                "utf-8"
            );

            expect(clientJs).toContain("no-cache");
        });
    });

    describe("Production served HTML (css of the entry)", () => {
        // Own production build, served by the real server.js on a real TCP
        // port — the exact surface `velojs start` puts in front of a consumer.
        let served: ServedBuild;

        beforeAll(async () => {
            const distDir = path.join(TEST_APP_DIR, "dist");
            if (fs.existsSync(distDir)) {
                fs.rmSync(distDir, { recursive: true });
            }
            runAppBuild(false);
            served = await serveBuild();
        }, 90000);

        afterAll(async () => {
            await served.stop();
        });

        it("served HTML links EVERY css of the client graph — entry AND async chunks (the theme reaches the first paint)", async () => {
            const manifest = JSON.parse(
                fs.readFileSync(
                    path.join(TEST_APP_DIR, "dist/client/.vite/manifest.json"),
                    "utf-8"
                )
            );
            const entryCss: string[] = manifest["virtual:velo/client-entry"].css ?? [];
            // The consumer mirror: the THEME (tokens in :root) lives ONLY in
            // async chunks — the module that imports it loads by interaction,
            // so nothing but a <link> in the served HTML can carry it to the
            // first paint. On 0.0.62 this is the red: the async css is never
            // linked and never injected.
            const asyncCss: string[] = Object.values(manifest)
                .flatMap((node: any) => (node && Array.isArray(node.css) ? node.css : []))
                .filter((css: string) => !entryCss.includes(css));
            expect(asyncCss.length).toBeGreaterThanOrEqual(1);
            expect(entryCss.length).toBeGreaterThanOrEqual(1);
            const allCss = [...entryCss, ...asyncCss];

            const res = await served.fetch("/");
            expect(res.status).toBe(200);
            const hrefs = stylesheetHrefs(await res.text());

            expect(hrefs.length).toBe(allCss.length);
            for (const css of allCss) {
                expect(hrefs).toContain(`/${css}`);
            }

            // The served css carries the theme tokens — identity on the first
            // paint, even though the chunk that imports them never loaded.
            const cssBodies = await Promise.all(
                hrefs.map(async (href) => (await served.fetch(href)).text())
            );
            const allCssBodies = cssBodies.join("\n");
            expect(allCssBodies).toContain("--color-bg");
            expect(allCssBodies).toContain("font-family");
        });

        it("every linked stylesheet answers 200 — the theme is actually served", async () => {
            const res = await served.fetch("/");
            const hrefs = stylesheetHrefs(await res.text());
            expect(hrefs.length).toBeGreaterThan(0);

            for (const href of hrefs) {
                const cssRes = await served.fetch(href);
                expect(cssRes.status).toBe(200);
            }
        });

        it("nested route (/deploy/demo): no css href resolves against the page path", async () => {
            const res = await served.fetch("/deploy/demo");
            expect(res.status).toBe(200);
            const hrefs = stylesheetHrefs(await res.text());
            expect(hrefs.length).toBeGreaterThan(0);

            // Absolute paths only: a page-relative "client.x.css" at /deploy/demo
            // would resolve to /deploy/client.x.css → 404, the reported defect.
            for (const href of hrefs) {
                expect(href.startsWith("/")).toBe(true);
            }
        });

        it("css strings inside client chunks are ABSOLUTE — async-route css never rides page-relative", () => {
            const clientJs = readAllClientJs();
            // The async lazy-pane chunk references its css (client.<hash>.css) as
            // a quoted string. Every such string must be an ABSOLUTE path
            // (leading "/" or full base): a page-relative one resolves against
            // the current route on nested paths → 404, the reported defect.
            const refs = Array.from(
                clientJs.matchAll(/"([^"']*client\.[a-zA-Z0-9_-]+\.css)"/g)
            ).map((m) => m[1]!);
            expect(refs.length).toBeGreaterThan(0);
            const offenders = refs.filter((ref) => !ref.startsWith("/"));
            expect(offenders).toEqual([]);
        });
    });

    describe("cssCodeSplit: false (single css asset)", () => {
        // The consumer app tried `build: { cssCodeSplit: false }` as a
        // workaround: the HTML asked for the UNHASHED "client.css" while the
        // emit wrote a hashed file — 404 on the whole stylesheet, patched today
        // by a manual copy step that dies on every upgrade.
        const viteConfigPath = path.join(TEST_APP_DIR, "vite.config.ts");
        let originalViteConfig = "";
        let served: ServedBuild;

        beforeAll(async () => {
            originalViteConfig = fs.readFileSync(viteConfigPath, "utf-8");
            fs.writeFileSync(
                viteConfigPath,
                `import { defineConfig } from "vite";
import { veloPlugin } from "@mauroandre/velojs/vite";
export default defineConfig({ plugins: [veloPlugin()], build: { cssCodeSplit: false } });
`
            );
            const distDir = path.join(TEST_APP_DIR, "dist");
            if (fs.existsSync(distDir)) {
                fs.rmSync(distDir, { recursive: true });
            }
            runAppBuild(false);
            served = await serveBuild();
        }, 90000);

        afterAll(async () => {
            await served.stop();
            fs.writeFileSync(viteConfigPath, originalViteConfig);
        });

        it("HTML references the css EXACTLY as emitted (hashed) and it answers 200 — no copy step", async () => {
            const clientDir = path.join(TEST_APP_DIR, "dist/client");
            const emittedCss = fs.readdirSync(clientDir).filter((f) => f.endsWith(".css"));
            // One single css asset exists in the emit (the whole graph in one file).
            expect(emittedCss.length).toBe(1);
            expect(emittedCss[0]).toMatch(/^client\.[a-zA-Z0-9_-]+\.css$/);

            const res = await served.fetch("/");
            expect(res.status).toBe(200);
            const hrefs = stylesheetHrefs(await res.text());

            expect(hrefs).toEqual([`/${emittedCss[0]}`]);
            const cssRes = await served.fetch(hrefs[0]!);
            expect(cssRes.status).toBe(200);
        });
    });

    describe("STATIC_BASE_URL prefix (cdn)", () => {
        let served: ServedBuild;

        beforeAll(async () => {
            const distDir = path.join(TEST_APP_DIR, "dist");
            if (fs.existsSync(distDir)) {
                fs.rmSync(distDir, { recursive: true });
            }
            runAppBuild(false, { STATIC_BASE_URL: "http://cdn.example.com/assets" });
            served = await serveBuild({ STATIC_BASE_URL: "http://cdn.example.com/assets" });
        }, 90000);

        afterAll(async () => {
            await served.stop();
        });

        it("nested route: every css href carries the configured base, absolute", async () => {
            const res = await served.fetch("/deploy/demo");
            expect(res.status).toBe(200);
            const hrefs = stylesheetHrefs(await res.text());
            expect(hrefs.length).toBeGreaterThan(0);

            for (const href of hrefs) {
                expect(href.startsWith("http://cdn.example.com/assets/")).toBe(true);
            }
        });
    });

    describe("Determinism (VELO_BUILD_HASH fixed)", () => {
        const buildAssetNames = (): { js: string[]; css: string[] } => {
            const clientDir = path.join(TEST_APP_DIR, "dist/client");
            const names = fs.readdirSync(clientDir);
            return {
                js: names.filter((f) => f.startsWith("client.") && f.endsWith(".js")).sort(),
                css: names.filter((f) => f.endsWith(".css")).sort(),
            };
        };

        let first: { js: string[]; css: string[] };
        let second: { js: string[]; css: string[] };

        beforeAll(() => {
            const distDir = path.join(TEST_APP_DIR, "dist");
            if (fs.existsSync(distDir)) {
                fs.rmSync(distDir, { recursive: true });
            }
            runAppBuild(false, { VELO_BUILD_HASH: "det-hash-fixed" });
            first = buildAssetNames();

            if (fs.existsSync(distDir)) {
                fs.rmSync(distDir, { recursive: true });
            }
            runAppBuild(false, { VELO_BUILD_HASH: "det-hash-fixed" });
            second = buildAssetNames();
        }, 180000);

        it("two consecutive builds with the same source and the same VELO_BUILD_HASH emit the SAME asset names", () => {
            expect(first.js.length).toBeGreaterThan(0);
            expect(first.css.length).toBeGreaterThan(0);
            // Identical source + identical VELO_BUILD_HASH ⇒ identical hashes
            // for js AND css (the Date.now() default stays as the versioning
            // valve between deploys — determinism is for the FIXED input).
            expect(second.js).toEqual(first.js);
            expect(second.css).toEqual(first.css);
        });
    });
});
