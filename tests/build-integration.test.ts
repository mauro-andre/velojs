import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
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

    // Pack into .tgz (exactly what npm publish would upload)
    const pack = spawnSync("npm", ["pack", "--pack-destination", "/tmp"], {
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

    // package.json — references built VeloJS via tarball (same as npm install from registry)
    fs.writeFileSync(
        path.join(TEST_APP_DIR, "package.json"),
        JSON.stringify({
            name: "test-app",
            type: "module",
            dependencies: {
                "@mauroandre/velojs": `file:${tgzPath}`,
            },
        })
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

    // app/client.tsx
    fs.writeFileSync(path.join(TEST_APP_DIR, "app/client.tsx"), "");

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
            { path: "/api/github/webhook", method: "POST", handler: githubWebhook },
        ],
    },
] satisfies AppRoutes;
`
    );

    // app/pages/Deploy.tsx — page with stream_*
    fs.writeFileSync(
        path.join(TEST_APP_DIR, "app/pages/Deploy.tsx"),
        `import { createEventStream } from "@mauroandre/velojs";
import { useEventStream } from "@mauroandre/velojs/hooks";

type DeployState = { step: string; status: "running" | "success" | "error" };

export const stream_progress = createEventStream<DeployState>({
    channel: (c) => c.req.query("channel") ?? "",
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
function runAppBuild(isStatic: boolean) {
    const args = isStatic
        ? ["velojs", "build", "--static"]
        : ["velojs", "build"];

    const result = spawnSync("npx", args, {
        cwd: TEST_APP_DIR,
        stdio: "pipe",
        timeout: 60000,
    });

    if (result.status !== 0) {
        throw new Error(
            `App build failed (status ${result.status}):\n${result.stdout?.toString()}\n${result.stderr?.toString()}`
        );
    }
}

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
            expect(html).toMatch(/client\.[a-zA-Z0-9_]+\.js/);
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
});
