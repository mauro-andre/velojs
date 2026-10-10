/**
 * Server->client leak diagnostic — unit tests over real fixture trees.
 *
 * These exercise the analysis itself (what qualifies as a server module, what
 * the chain reports, where the entry point lands) against small app trees
 * written to /tmp, with no Vite process involved: the analysis applies the same
 * client transform the build applies, so the semantics under test are the ones
 * the bundle sees. Build/dev integration lives in
 * `leak-diagnostic-integration.test.ts`.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { analyzeClientLeaks, formatLeakReport, type LeakReport } from "../src/leak-diagnostic.js";
import { clientEntryModulePaths } from "../src/vite.js";

const ROOT = "/tmp/velojs-leak-unit";

interface Fixture {
    report: LeakReport;
    text: string;
    rootDir: string;
    appDir: string;
}

function writeFixture(name: string, files: Record<string, string>) {
    const rootDir = path.join(ROOT, name);
    fs.rmSync(rootDir, { recursive: true, force: true });
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(rootDir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    }
    return { rootDir, appDir: path.join(rootDir, "app") };
}

function analyze(
    name: string,
    files: Record<string, string>,
    serverOnly?: string[]
): Fixture {
    const { rootDir, appDir } = writeFixture(name, files);
    const entry = clientEntryModulePaths(appDir, {});
    const report = analyzeClientLeaks({
        rootDir,
        appDir,
        entrySpecs: [entry.clientInit, entry.routes, entry.framework],
        serverOnly,
    });
    return { report, text: formatLeakReport(report), rootDir, appDir };
}

// ============================================
// SHARED FIXTURE PIECES
// ============================================

const CLIENT_INIT = `// client init\n`;

const ROUTES = `import type { AppRoutes } from "@mauroandre/velojs";
import * as Root from "./client-root.js";
import * as Home from "./pages/Home.js";

export default [
    { module: Root, isRoot: true, children: [{ path: "/", module: Home }] },
] satisfies AppRoutes;
`;

const ROOT_LAYOUT = `export const Component = ({ children }: any) => (
    <html><head></head><body>{children}</body></html>
);
`;

const SERVER_SIDE = `import fs from "node:fs";

export const readConfig = () => fs.readFileSync("/etc/hostname", "utf-8");
`;

afterAll(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
});

// ============================================
// C1/C2/C3 — chain, lines and entry point
// ============================================

describe("leak chain (builtin pulled by await import)", () => {
    // A (Home, travels) imports B (mid) statically; B pulls S (server-side)
    // via `await import()`; S touches `node:fs`. One chain, four links.
    const files = {
        "app/client.tsx": CLIENT_INIT,
        "app/routes.tsx": ROUTES,
        "app/client-root.tsx": ROOT_LAYOUT,
        "app/pages/Home.tsx": `import { helper } from "../mid.js";

export const Component = () => <h1>{helper()}</h1>;
`,
        "app/mid.ts": `export const helper = async () => {
    const mod = await import("./server-side.js");
    return mod.readConfig();
};
`,
        "app/server-side.ts": SERVER_SIDE,
    };

    const fixture = analyze("chain", files);
    const leak = fixture.report.leaks[0]!;

    it("finds exactly one leak — the module that touches the builtin", () => {
        expect(fixture.report.leaks.length).toBe(1);
        expect(leak.target).toBe("app/server-side.ts");
    });

    it("qualifies the leaked module with the builtin it touches", () => {
        expect(leak.qualifiers).toEqual(['imports Node builtin "node:fs"']);
    });

    it("lists every link of the chain with file and line", () => {
        expect(leak.chain).toEqual([
            { from: "virtual:velo/client-entry", line: null, to: "app/routes.tsx" },
            { from: "app/routes.tsx", line: 3, to: "app/pages/Home.tsx" },
            { from: "app/pages/Home.tsx", line: 1, to: "app/mid.ts" },
            { from: "app/mid.ts", line: 2, to: "app/server-side.ts" },
        ]);
    });

    it("highlights the entry point at the real import the developer edits (C2)", () => {
        const entryLink = leak.chain[leak.entryIndex]!;
        expect(entryLink).toEqual({ from: "app/mid.ts", line: 2, to: "app/server-side.ts" });
        // Opening the file at the reported line shows the import that pulls the
        // first server module — the exact cut point.
        const source = fs.readFileSync(path.join(fixture.rootDir, "app/mid.ts"), "utf-8");
        const line = source.split("\n")[entryLink.line! - 1]!;
        expect(line).toContain("await import");
        expect(line).toContain("./server-side.js");
    });

    it("prints the chain and the cut in the report", () => {
        expect(fixture.text).toContain("app/mid.ts:2 -> app/server-side.ts  <- entry point (cut here)");
        expect(fixture.text).toContain("server because: imports Node builtin \"node:fs\"");
    });

    it("is read-only: no fixture file changes under analysis", () => {
        const snapshot = (rel: string) =>
            fs.readFileSync(path.join(fixture.rootDir, rel), "utf-8");
        const before = Object.keys(files).map((rel) => [rel, snapshot(rel)]);
        // A second analysis over the SAME tree (no rewrite): the walk reads and
        // transforms in memory only.
        const entry = clientEntryModulePaths(fixture.appDir, {});
        analyzeClientLeaks({
            rootDir: fixture.rootDir,
            appDir: fixture.appDir,
            entrySpecs: [entry.clientInit, entry.routes, entry.framework],
        });
        const after = Object.keys(files).map((rel) => [rel, snapshot(rel)]);
        expect(after).toEqual(before);
    });

    it("is stable: two runs print the same list in the same order (C8)", () => {
        const second = analyze("chain", files);
        expect(second.text).toBe(fixture.text);
        expect(second.report.signature).toBe(fixture.report.signature);
    });
});

// ============================================
// C4 — domain code appears only when declared
// ============================================

describe("serverOnly declaration", () => {
    const files = {
        "app/client.tsx": CLIENT_INIT,
        "app/routes.tsx": `import type { AppRoutes } from "@mauroandre/velojs";
import * as Root from "./client-root.js";
import * as About from "./pages/About.js";

export default [
    { module: Root, isRoot: true, children: [{ path: "/about", module: About }] },
] satisfies AppRoutes;
`,
        "app/client-root.tsx": ROOT_LAYOUT,
        "app/pages/About.tsx": `export const loadDomain = () => import("../../lib/domain.js");

export const Component = () => <h1>About</h1>;
`,
        "lib/domain.ts": `export const label = "domain";\n`,
    };

    it("no item without the declaration — builtin-free code is invisible", () => {
        const fixture = analyze("domain-off", files);
        expect(fixture.report.leaks).toEqual([]);
        expect(fixture.text).toContain("0 leaks");
    });

    it("one item with the declaration, same format, qualifier names the pattern", () => {
        const fixture = analyze("domain-on", files, ["lib/**"]);
        expect(fixture.report.leaks.length).toBe(1);
        const leak = fixture.report.leaks[0]!;
        expect(leak.target).toBe("lib/domain.ts");
        expect(leak.qualifiers).toEqual(['matches serverOnly pattern "lib/**"']);
        expect(leak.chain[leak.entryIndex]).toEqual({
            from: "app/pages/About.tsx",
            line: 1,
            to: "lib/domain.ts",
        });
        expect(fixture.text).toContain('server because: matches serverOnly pattern "lib/**"');
    });

    it("the glob honors *, ** and ? against the root-relative path", () => {
        const star = analyze("domain-star", files, ["lib/doma?n.ts"]);
        expect(star.report.leaks.map((l) => l.target)).toEqual(["lib/domain.ts"]);
        const noMatch = analyze("domain-nomatch", files, ["src/**"]);
        expect(noMatch.report.leaks).toEqual([]);
    });
});

// ============================================
// C5 — no false positives on the normal app shape
// ============================================

describe("normal app shape (framework-removed points)", () => {
    const files = {
        "app/client.tsx": CLIENT_INIT,
        "app/routes.tsx": `import type { AppRoutes } from "@mauroandre/velojs";
import * as Root from "./client-root.js";
import * as Home from "./pages/Home.js";
import * as Save from "./pages/Save.js";
import * as Deploy from "./pages/Deploy.js";
import * as Terminal from "./pages/Terminal.js";
import { authMiddleware } from "./mw.js";
import { webhook } from "./webhooks/hook.js";

export default [
    {
        module: Root,
        isRoot: true,
        middlewares: [authMiddleware],
        children: [
            { path: "/", module: Home },
            { path: "/save", module: Save },
            { path: "/deploy", module: Deploy },
            { path: "/terminal", module: Terminal },
            { path: "/api/hook", method: "POST", handler: webhook },
        ],
    },
] satisfies AppRoutes;
`,
        "app/client-root.tsx": ROOT_LAYOUT,
        // Layout middleware — stripped with its import on the client.
        "app/mw.ts": `import { timingSafeEqual } from "node:crypto";

export const authMiddleware = async (_c: any, next: () => Promise<void>) => {
    timingSafeEqual(Buffer.from("a"), Buffer.from("a"));
    await next();
};
`,
        // Endpoint handler — stripped with its import on the client.
        "app/webhooks/hook.ts": `import { createHmac } from "node:crypto";

export const webhook = ({ c }: any) => {
    createHmac("sha256", "k");
    return c.json({ ok: true });
};
`,
        // Page with a loader importing server code — the loader is stripped.
        "app/pages/Home.tsx": `import type { Config } from "../server-config.js";
import { query } from "../db.js";

export const loader = async (_args: any) => {
    return { rows: await query("select 1"), config: null as Config | null };
};

export const Component = () => <h1>home</h1>;
`,
        // Page with action_* importing server code — stubbed on the client.
        "app/pages/Save.tsx": `import { writeFile } from "node:fs/promises";

export const action_save = async ({ body }: any) => {
    await writeFile("/tmp/x", String(body));
    return { ok: true };
};

export const Component = () => <form>save</form>;
`,
        // Page with stream_* whose channel resolver imports server code —
        // stubbed, and the import is pruned as orphaned.
        "app/pages/Deploy.tsx": `import { createEventStream } from "@mauroandre/velojs";
import { ownChannel } from "../channel.server.js";

export const stream_progress = createEventStream({
    channel: ownChannel,
    closeOn: () => false,
});

export const Component = () => <div>deploy</div>;
`,
        // Page with socket_* importing a Node builtin top-level — stubbed and pruned.
        "app/pages/Terminal.tsx": `import { randomBytes } from "node:crypto";

export const socket_terminal = async ({ send }: any) => {
    send({ id: randomBytes(4).toString("hex") });
};

export const Component = () => <div>terminal</div>;
`,
        "app/db.ts": `import { readFile } from "node:fs/promises";

export const query = async (sql: string) => {
    await readFile("/etc/hostname");
    return [sql];
};
`,
        "app/channel.server.ts": `import { randomUUID } from "node:crypto";

export const ownChannel = (_c: any) => randomUUID();
`,
        "app/server-config.ts": `import fs from "node:fs";

export type Config = { raw: typeof fs };
`,
    };

    it("reports zero leaks and says so — absence is distinguishable from not running", () => {
        const fixture = analyze("normal", files);
        expect(fixture.report.leaks).toEqual([]);
        expect(fixture.text).toBe(
            "[velojs] server->client leak analysis: 0 leaks — what ships to the client is clean."
        );
    });

    it("still walks what ships (the analysis ran over real modules)", () => {
        const fixture = analyze("normal", files);
        expect(fixture.report.moduleCount).toBeGreaterThan(3);
    });
});

// ============================================
// C9 — two paths to the same module, two items
// ============================================

describe("two paths to the same leaked module", () => {
    const files = {
        "app/client.tsx": CLIENT_INIT,
        "app/routes.tsx": `import type { AppRoutes } from "@mauroandre/velojs";
import * as Root from "./client-root.js";
import * as Home from "./pages/Home.js";
import * as About from "./pages/About.js";

export default [
    { module: Root, isRoot: true, children: [{ path: "/", module: Home }, { path: "/about", module: About }] },
] satisfies AppRoutes;
`,
        "app/client-root.tsx": ROOT_LAYOUT,
        "app/pages/Home.tsx": `export const fromHome = () => import("../server-side.js");

export const Component = () => <h1>home</h1>;
`,
        "app/pages/About.tsx": `export const fromAbout = () => import("../server-side.js");

export const Component = () => <h1>about</h1>;
`,
        "app/server-side.ts": SERVER_SIDE,
    };

    it("generates two items, each with its own entry point", () => {
        const fixture = analyze("two-paths", files);
        expect(fixture.report.leaks.length).toBe(2);
        expect(fixture.report.leaks.map((l) => l.target)).toEqual([
            "app/server-side.ts",
            "app/server-side.ts",
        ]);

        const cuts = fixture.report.leaks.map((leak) => leak.chain[leak.entryIndex]);
        expect(cuts).toEqual([
            { from: "app/pages/Home.tsx", line: 1, to: "app/server-side.ts" },
            { from: "app/pages/About.tsx", line: 1, to: "app/server-side.ts" },
        ]);
    });
});
