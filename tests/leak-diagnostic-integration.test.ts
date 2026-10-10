/**
 * Server->client leak diagnostic — integration over real builds and dev.
 *
 * Covers the criteria that need the real pipeline: `velojs build` and
 * `velojs build --static` printing the report and finishing with success;
 * read-only proven against a baseline tree WITHOUT the feature (byte-identical
 * client artifacts with a fixed `VELO_BUILD_HASH`); `velojs dev` printing at
 * startup and re-emitting on file changes, in both directions. The same suite
 * runs under Vite 7 and Vite 8 via `VELO_FIXTURE_VITE`, like
 * `build-integration.test.ts`.
 *
 * The baseline is `git archive HEAD` — the committed tree, collected before the
 * diagnostic exists. If a future commit ships the feature in HEAD, the
 * extraction is neutralized with an inert stub so the comparison keeps proving
 * the diagnostic's hooks touch nothing.
 *
 * Two hygiene rules make the byte comparison apples-to-apples:
 * - `NODE_ENV=production` on both sides. The test runner exports
 *   `NODE_ENV=test`, which makes Vite compile with JSX dev source metadata —
 *   absolute source paths baked into the bundle — and then artifacts would
 *   depend on the build layout, never on the code.
 * - Both sides build at the SAME paths, sequentially: the bundle under test is
 *   literally "the same build, in the tree without the feature".
 *
 * Everything is built in /tmp copies: nothing here touches the repo's dist/,
 * so this file can run in parallel with the rest of the suite.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";

const VELOJS_ROOT = path.resolve(__dirname, "..");
const WORK = "/tmp/velojs-leak-integration";

// Shared by both sides of the byte comparison — the same layout every time.
const SRC = path.join(WORK, "src");
const APP = path.join(WORK, "app");
const PACKS = path.join(WORK, "packs");

const run = (cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => {
    const result = spawnSync(cmd, args, {
        cwd,
        stdio: "pipe",
        timeout: 420000,
        env: { ...process.env, NODE_ENV: "production", ...env },
    });
    return {
        status: result.status,
        stdout: result.stdout?.toString() ?? "",
        stderr: result.stderr?.toString() ?? "",
    };
};

/** Copies the repo source (minus generated/installed trees) into the scratch dir. */
function copyFeatureSource(to: string) {
    fs.cpSync(VELOJS_ROOT, to, {
        recursive: true,
        filter: (src) => {
            const rel = path.relative(VELOJS_ROOT, src);
            const top = rel.split(path.sep)[0] ?? "";
            if (["node_modules", ".git", ".worktrees", "dist", ".velojs", "tests", "docs"].includes(top)) {
                return false;
            }
            const base = path.basename(src);
            return base !== "node_modules" && !base.endsWith(".tgz");
        },
    });
}

/** Extracts `git archive HEAD` — the tree without the feature — into the scratch dir. */
function extractBaselineSource(to: string) {
    const archive = path.join(WORK, "baseline.tar");
    const archived = run("git", ["archive", "--format=tar", "-o", archive, "HEAD"], VELOJS_ROOT);
    if (archived.status !== 0) {
        throw new Error(`git archive HEAD failed:\n${archived.stdout}\n${archived.stderr}`);
    }
    fs.mkdirSync(to, { recursive: true });
    const extracted = run("tar", ["-xf", archive, "-C", to], WORK);
    if (extracted.status !== 0) {
        throw new Error(`tar extract failed:\n${extracted.stdout}\n${extracted.stderr}`);
    }

    const baselineFeature = path.join(to, "src", "leak-diagnostic.ts");
    if (fs.existsSync(baselineFeature)) {
        // Future state: HEAD already ships the feature. Neutralize it so the
        // comparison keeps proving the diagnostic's hooks touch nothing.
        fs.writeFileSync(
            baselineFeature,
            `export interface LeakReport { leaks: never[]; truncated: boolean; signature: string; moduleCount: number; }
export interface CachedModule { mtimeMs: number; info: unknown; }
export function analyzeClientLeaks(_options?: unknown): LeakReport {
    return { leaks: [], truncated: false, signature: "inert-baseline", moduleCount: 0 };
}
export function formatLeakReport(_report?: unknown): string {
    return "[velojs] server->client leak analysis (inert baseline)";
}
`
        );
    }
}

/** Builds the framework at the scratch path and packs it; returns the tarball. */
function buildAndPack(tag: string): string {
    fs.symlinkSync(path.join(VELOJS_ROOT, "node_modules"), path.join(SRC, "node_modules"), "dir");
    const packsDir = path.join(PACKS, tag);
    fs.mkdirSync(packsDir, { recursive: true });

    const build = run("npm", ["run", "build"], SRC);
    if (build.status !== 0) {
        throw new Error(`npm run build failed (${tag}):\n${build.stdout}\n${build.stderr}`);
    }
    const pack = run("npm", ["pack", "--silent", "--pack-destination", packsDir], SRC);
    if (pack.status !== 0) {
        throw new Error(`npm pack failed (${tag}):\n${pack.stdout}\n${pack.stderr}`);
    }
    return path.join(packsDir, pack.stdout.trim());
}

const APP_FILES: Record<string, string> = {
    "vite.config.ts": `import { defineConfig } from "vite";
import { veloPlugin } from "@mauroandre/velojs/vite";
export default defineConfig({ plugins: [veloPlugin()] });
`,
    "tsconfig.json": JSON.stringify({
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
    }),
    "app/client.tsx": `// client init\n`,
    "app/server.tsx": `// server init\n`,
    "app/client-root.tsx": `import type { ComponentChildren } from "preact";
import { Scripts } from "@mauroandre/velojs";

export const Component = ({ children }: { children?: ComponentChildren }) => (
    <html lang="en">
        <head>
            <Scripts />
        </head>
        <body>{children}</body>
    </html>
);
`,
    "app/routes.tsx": `import type { AppRoutes } from "@mauroandre/velojs";
import * as Root from "./client-root.js";
import * as Home from "./pages/Home.js";
import * as About from "./pages/About.js";

export default [
    {
        module: Root,
        isRoot: true,
        children: [
            { path: "/", module: Home },
            { path: "/about", module: About },
        ],
    },
] satisfies AppRoutes;
`,
    // The leak: what travels to the client pulls a Node-builtin module through
    // `await import()`.
    "app/pages/Home.tsx": `import type { LoaderArgs } from "@mauroandre/velojs";
import { useLoader } from "@mauroandre/velojs/hooks";

export const loader = async (_args: LoaderArgs) => ({ message: "hello" });

export const loadServerSide = () => import("../server-side.js");

export const Component = () => {
    const { data } = useLoader<{ message: string }>();
    return <h1>{data.value?.message}</h1>;
};
`,
    "app/pages/About.tsx": `export const Component = () => <h1>about</h1>;
`,
    "app/server-side.ts": `import fs from "node:fs";

export const readEtc = () => fs.readFileSync("/etc/hostname", "utf-8");
`,
    "app/extra-server.ts": `import path from "node:path";

export const sep = () => path.sep;
`,
};

function createApp(tarball: string) {
    fs.rmSync(APP, { recursive: true, force: true });
    fs.mkdirSync(path.join(APP, "app/pages"), { recursive: true });
    for (const [rel, content] of Object.entries(APP_FILES)) {
        fs.writeFileSync(path.join(APP, rel), content);
    }

    // VELO_FIXTURE_VITE ("7" | "8") forces the vite major via npm overrides so
    // both supported majors can be exercised — same mechanism as
    // build-integration.test.ts.
    const fixtureVite = process.env.VELO_FIXTURE_VITE;
    const pkg: Record<string, unknown> = {
        name: "leak-app",
        type: "module",
        dependencies: { "@mauroandre/velojs": `file:${tarball}` },
    };
    if (fixtureVite) pkg.overrides = { vite: `^${fixtureVite}.0.0` };
    fs.writeFileSync(path.join(APP, "package.json"), JSON.stringify(pkg));

    const install = run("npm", ["install", "--no-audit", "--no-fund"], APP);
    if (install.status !== 0) {
        throw new Error(`npm install failed:\n${install.stdout}\n${install.stderr}`);
    }
}

function sha256(file: string): string {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Every generated client artifact (bundle + manifest), hashed, keyed by rel path. */
function clientArtifacts(): Map<string, string> {
    const base = path.join(APP, "dist", "client");
    const out = new Map<string, string>();
    const walk = (current: string) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const abs = path.join(current, entry.name);
            if (entry.isDirectory()) walk(abs);
            else out.set(path.relative(base, abs).split(path.sep).join("/"), sha256(abs));
        }
    };
    walk(base);
    return out;
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const port = (server.address() as net.AddressInfo).port;
            server.close(() => resolve(port));
        });
    });
}

let featureTgz = "";
let dev: ChildProcessWithoutNullStreams | null = null;

beforeAll(() => {
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });

    // The feature side first — C1/C7 run against it.
    fs.rmSync(SRC, { recursive: true, force: true });
    copyFeatureSource(SRC);
    featureTgz = buildAndPack("feature");
    createApp(featureTgz);
}, 600000);

afterAll(() => {
    if (dev && !dev.killed) dev.kill("SIGKILL");
    fs.rmSync(WORK, { recursive: true, force: true });
});

describe("velojs build prints the leak report and succeeds (C1)", () => {
    let buildOut = "";

    beforeAll(() => {
        fs.rmSync(path.join(APP, "dist"), { recursive: true, force: true });
        const result = run("npx", ["velojs", "build"], APP);
        buildOut = result.stdout + result.stderr;
        if (result.status !== 0) {
            throw new Error(`velojs build failed (status ${result.status}):\n${buildOut}`);
        }
    }, 420000);

    it("finishes with success and names the leaked module", () => {
        expect(buildOut).toMatch(/server->client leak analysis: 1 leak\(s\)/);
        expect(buildOut).toContain("1) app/server-side.ts");
    });

    it("qualifies the leaked module with the builtin it touches", () => {
        expect(buildOut).toContain('server because: imports Node builtin "node:fs"');
    });

    it("lists the chain from the client entry, file and line per link", () => {
        expect(buildOut).toContain("virtual:velo/client-entry (generated) -> app/routes.tsx");
        expect(buildOut).toMatch(/app\/routes\.tsx:\d+ -> app\/pages\/Home\.tsx/);
        expect(buildOut).toMatch(/app\/pages\/Home\.tsx:\d+ -> app\/server-side\.ts/);
    });

    it("highlights the entry point — the real import the developer edits (C2)", () => {
        const match = buildOut.match(
            /(app\/pages\/Home\.tsx:(\d+) -> app\/server-side\.ts)  <- entry point \(cut here\)/
        );
        expect(match).not.toBeNull();
        const line = fs
            .readFileSync(path.join(APP, "app/pages/Home.tsx"), "utf-8")
            .split("\n")[Number(match![2]) - 1]!;
        expect(line).toContain("import(");
        expect(line).toContain("../server-side.js");
    });

    it("prints exactly one report — the server build adds none", () => {
        const headers = buildOut.match(/server->client leak analysis/g) ?? [];
        expect(headers.length).toBe(1);
    });
});

describe("velojs build --static prints the same report and succeeds (C1)", () => {
    let buildOut = "";

    beforeAll(() => {
        fs.rmSync(path.join(APP, "dist"), { recursive: true, force: true });
        const result = run("npx", ["velojs", "build", "--static"], APP);
        buildOut = result.stdout + result.stderr;
        if (result.status !== 0) {
            throw new Error(`velojs build --static failed (status ${result.status}):\n${buildOut}`);
        }
    }, 420000);

    it("succeeds and carries the same leak report", () => {
        expect(buildOut).toMatch(/server->client leak analysis: 1 leak\(s\)/);
        expect(buildOut).toContain("1) app/server-side.ts");
        expect(buildOut).toContain('server because: imports Node builtin "node:fs"');
        expect(buildOut).toMatch(/app\/pages\/Home\.tsx:\d+ -> app\/server-side\.ts/);
    });
});

describe("read-only against the baseline tree without the feature (C6)", () => {
    const HASH = "leakbaselinehash";

    function buildSide(tarball: string): { artifacts: Map<string, string>; out: string } {
        createApp(tarball);
        fs.rmSync(path.join(APP, "dist"), { recursive: true, force: true });
        // The client build runs directly with the build hash fixed in the env —
        // `velojs build` would overwrite it on every execution.
        const built = run("npx", ["vite", "build"], APP, { VELO_BUILD_HASH: HASH });
        if (built.status !== 0) {
            throw new Error(`vite build failed:\n${built.stdout}\n${built.stderr}`);
        }
        return { artifacts: clientArtifacts(), out: built.stdout + built.stderr };
    }

    it("client artifacts are byte-identical (hash) to the pre-feature build", () => {
        // Baseline: the tree without the feature, same layout, same hash.
        fs.rmSync(SRC, { recursive: true, force: true });
        extractBaselineSource(SRC);
        const baseline = buildSide(buildAndPack("baseline"));

        // Feature: the same build in the tree with the diagnostic.
        fs.rmSync(SRC, { recursive: true, force: true });
        copyFeatureSource(SRC);
        const feature = buildSide(buildAndPack("c6-feature"));

        // The analysis ran on the feature side — the light is on while the
        // artifacts stay untouched.
        expect(feature.out).toContain("server->client leak analysis");

        expect(feature.artifacts.size).toBeGreaterThan(0);
        expect([...feature.artifacts.keys()].sort()).toEqual([...baseline.artifacts.keys()].sort());
        for (const [rel, hash] of feature.artifacts) {
            expect(hash, `artifact drifted: ${rel}`).toBe(baseline.artifacts.get(rel));
        }
    }, 600000);

    it("the manifest and the fixed build hash are what got embedded", () => {
        const manifest = JSON.parse(
            fs.readFileSync(path.join(APP, "dist", "client", ".vite", "manifest.json"), "utf-8")
        );
        const entry = manifest["virtual:velo/client-entry"];
        expect(entry).toBeDefined();
        expect(clientArtifacts().has(entry.file)).toBe(true);
    });

    it("runs under the requested Vite major (C10)", () => {
        const requested = process.env.VELO_FIXTURE_VITE;
        const vitePkg = JSON.parse(
            fs.readFileSync(path.join(APP, "node_modules", "vite", "package.json"), "utf-8")
        ) as { version: string };
        if (requested) {
            expect(vitePkg.version.startsWith(`${requested}.`)).toBe(true);
        } else {
            expect(vitePkg.version).toMatch(/^\d+\./);
        }
    });
});

describe("velojs dev re-emits the report without navigation (C7)", () => {
    let out = "";
    let mark = 0;

    const waitFor = async (label: string, check: (slice: string) => boolean, timeoutMs = 120000) => {
        const start = Date.now();
        for (;;) {
            const slice = out.slice(mark);
            if (check(slice)) return slice;
            if (Date.now() - start > timeoutMs) {
                throw new Error(`timeout waiting for ${label}; output so far:\n${slice}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    };

    beforeAll(async () => {
        const port = await freePort();
        dev = spawn("npx", ["velojs", "dev", "--port", String(port)], {
            cwd: APP,
            env: { ...process.env, NODE_ENV: "development" },
        });
        dev.stdout.on("data", (chunk) => (out += chunk.toString()));
        dev.stderr.on("data", (chunk) => (out += chunk.toString()));
        (dev as unknown as { __port: number }).__port = port;
    });

    afterAll(async () => {
        if (dev && !dev.killed) {
            dev.kill("SIGTERM");
            await new Promise((resolve) => setTimeout(resolve, 500));
            if (!dev.killed) dev.kill("SIGKILL");
        }
    });

    it("prints the full report at startup, before any navigation", async () => {
        const slice = await waitFor("startup report", (s) =>
            s.includes("server->client leak analysis")
        );
        expect(slice).toMatch(/server->client leak analysis: 1 leak\(s\)/);
        expect(slice).toContain("1) app/server-side.ts");
        expect(slice).toContain('server because: imports Node builtin "node:fs"');
        expect(slice).toContain("virtual:velo/client-entry (generated) -> app/routes.tsx");
        expect(slice).toMatch(/app\/pages\/Home\.tsx:\d+ -> app\/server-side\.ts/);
    }, 180000);

    it("the dev server keeps responding", async () => {
        const port = (dev as unknown as { __port: number }).__port;
        // The dev server binds to whatever `localhost` resolves to — which may
        // be ::1 or 127.0.0.1 depending on the machine. Any of them answering
        // is the dev continuing to respond.
        const urls = [
            `http://localhost:${port}/`,
            `http://127.0.0.1:${port}/`,
            `http://[::1]:${port}/`,
        ];
        const start = Date.now();
        for (;;) {
            for (const url of urls) {
                try {
                    const response = await fetch(url);
                    expect(response.status).toBe(200);
                    return;
                } catch {
                    // try the next address
                }
            }
            if (Date.now() - start > 120000) {
                throw new Error(`dev server did not respond on ${urls.join(", ")}\n--- output ---\n${out}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }, 180000);

    it("removing the import re-emits with the zero-leak line (direction 2)", async () => {
        mark = out.length;
        const home = path.join(APP, "app/pages/Home.tsx");
        const original = fs.readFileSync(home, "utf-8");
        const edited = original
            .split("\n")
            .filter((line) => !line.includes('import("../server-side.js")'))
            .join("\n");
        expect(edited).not.toBe(original);
        fs.writeFileSync(home, edited);

        const slice = await waitFor("zero-leak re-emit", (s) =>
            s.includes("0 leaks — what ships to the client is clean.")
        );
        expect(slice).not.toContain("app/server-side.ts");
    }, 180000);

    it("a new import stitching a server path appears in the next report (direction 1)", async () => {
        mark = out.length;
        const home = path.join(APP, "app/pages/Home.tsx");
        fs.appendFileSync(home, `\nexport const loadExtra = () => import("../extra-server.js");\n`);

        const slice = await waitFor("new leak re-emit", (s) => s.includes("app/extra-server.ts"));
        expect(slice).toMatch(/server->client leak analysis: 1 leak\(s\)/);
        expect(slice).toContain("1) app/extra-server.ts");
        expect(slice).toContain('server because: imports Node builtin "node:path"');
        expect(slice).toMatch(/app\/pages\/Home\.tsx:\d+ -> app\/extra-server\.ts/);
    }, 180000);
});
