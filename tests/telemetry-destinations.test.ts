/**
 * Native telemetry — destinations and activation.
 *
 * The destination env is the trigger: `VELO_TELEMETRY_FILE` and/or
 * `VELO_TELEMETRY_SINK_URL` present and non-empty turns collection on; none of
 * them leaves the whole module inert (no file, no event) in any environment.
 * The values expand `~`/`$VAR`, the effective file carries the pid/hostname
 * suffix, `VELO_TELEMETRY_MAX_MB` rotates the file, and the boot record opens
 * every active destination with version, environment, effective destination
 * and the rotation limit in force.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createTestApp } from "../src/testing/index.js";
import {
    __resetTelemetry,
    effectiveTelemetryFile,
    expandTelemetryValue,
    flushTelemetry,
    resolveTelemetrySettings,
    telemetryState,
    type TelemetryEvent,
} from "../src/telemetry.js";
import { initNodeTelemetry } from "../src/telemetry-node.js";
import type { AppRoutes, RouteModule } from "../src/types.js";

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf-8")) as {
    version: string;
};

// ============================================
// Fixtures
// ============================================

function pageModule(moduleId: string, fullPath: string): RouteModule {
    return {
        Component: () => null,
        metadata: { moduleId, fullPath, path: fullPath },
        loader: async () => ({ ok: true }),
    } as any;
}

const routes: AppRoutes = [{ path: "/home", module: pageModule("Home", "/home") }];

let dir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "velo-telemetry-dest-"));
    savedEnv = { ...process.env };
    for (const key of [
        "VELO_TELEMETRY_FILE",
        "VELO_TELEMETRY_SINK_URL",
        "VELO_TELEMETRY_MAX_MB",
    ]) {
        delete process.env[key];
    }
    await __resetTelemetry();
});

afterEach(async () => {
    await __resetTelemetry();
    for (const key of [
        "VELO_TELEMETRY_FILE",
        "VELO_TELEMETRY_SINK_URL",
        "VELO_TELEMETRY_MAX_MB",
        "NODE_ENV",
    ]) {
        const value = savedEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
});

function filesMatching(prefix: string, suffix = ""): string[] {
    return fs
        .readdirSync(dir)
        .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
        .sort();
}

async function readJsonl(file: string): Promise<TelemetryEvent[]> {
    await flushTelemetry();
    return fs
        .readFileSync(file, "utf-8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as TelemetryEvent);
}

/** A tiny sink that records every POST body, in order. */
async function startSink(): Promise<{ url: string; received: string[]; close: () => Promise<void> }> {
    const received: string[] = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            received.push(body);
            res.writeHead(200, { "content-type": "application/json" });
            res.end("{}");
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    return {
        url: `http://127.0.0.1:${address.port}/ingest`,
        received,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

// ============================================
// Activation by destination
// ============================================

describe("telemetry — activation by destination", () => {
    it("no destination (absent) leaves the collection off in any environment: no file, no event (CA1)", async () => {
        for (const env of ["development", "test", "production"]) {
            process.env.NODE_ENV = env;
            await __resetTelemetry();
            const app = await createTestApp({ routes });
            const res = await app.get("/home");
            expect(res.status).toBe(200);

            expect(telemetryState().enabled).toBe(false);
            expect(telemetryState().events).toBe(0);
            // No telemetry file was born anywhere we could point at: the
            // framework has no default path.
            expect(filesMatching("telemetry")).toEqual([]);
            await app.close();
        }
    });

    it("empty destination envs count as absent: collection stays off (CA1)", async () => {
        process.env.VELO_TELEMETRY_FILE = "";
        process.env.VELO_TELEMETRY_SINK_URL = "   ";
        const app = await createTestApp({ routes });
        await app.get("/home");

        expect(telemetryState().enabled).toBe(false);
        expect(telemetryState().events).toBe(0);
        expect(filesMatching("telemetry")).toEqual([]);
        await app.close();
    });

    it("VELO_TELEMETRY_FILE present activates collection at that path (CA2)", async () => {
        process.env.VELO_TELEMETRY_FILE = path.join(dir, "telemetry.jsonl");
        const app = await createTestApp({ routes });
        await app.get("/home");

        const [effective] = filesMatching("telemetry", ".jsonl");
        expect(effective).toBeTruthy();
        const events = await readJsonl(path.join(dir, effective!));
        expect(events.map((event) => event.type)).toContain("page");
        await app.close();
    });

    it("a path derived from another variable is expanded — the file is born there (CA2)", async () => {
        const target = path.join(dir, "derived");
        process.env.TELEMETRY_ROOT = target;
        process.env.VELO_TELEMETRY_FILE = "$TELEMETRY_ROOT/logs/telemetry.jsonl";
        try {
            const app = await createTestApp({ routes });
            await app.get("/home");
            await app.close();

            const born = fs.readdirSync(path.join(target, "logs"));
            expect(born.some((name) => name.startsWith("telemetry."))).toBe(true);
        } finally {
            delete process.env.TELEMETRY_ROOT;
        }
    });

    it("expands `~` against HOME when the destination is activated (CA2)", async () => {
        const savedHome = process.env.HOME;
        process.env.HOME = dir;
        process.env.VELO_TELEMETRY_FILE = "~/logs/telemetry.jsonl";
        try {
            const app = await createTestApp({ routes });
            await app.get("/home");
            await app.close();
            const born = fs.readdirSync(path.join(dir, "logs"));
            expect(born.some((name) => name.startsWith("telemetry."))).toBe(true);
        } finally {
            if (savedHome === undefined) delete process.env.HOME;
            else process.env.HOME = savedHome;
        }
    });

    it("expands `~` through the resolver", () => {
        expect(expandTelemetryValue("~/telemetry/log.jsonl", { HOME: "/tmp/homedir" })).toBe(
            "/tmp/homedir/telemetry/log.jsonl",
        );
        // An undefined reference is kept literally — never a silent wrong path.
        expect(expandTelemetryValue("$UNSET_DIR/log.jsonl", {})).toBe("$UNSET_DIR/log.jsonl");
    });

    it("VELO_TELEMETRY_SINK_URL present activates collection through POST, even without FILE (CA3)", async () => {
        const sink = await startSink();
        process.env.VELO_TELEMETRY_SINK_URL = sink.url;
        try {
            const app = await createTestApp({ routes });
            await app.get("/home");
            await app.close();
            await flushTelemetry();

            const types = sink.received.map((line) => (JSON.parse(line) as TelemetryEvent).type);
            expect(types[0]).toBe("boot");
            expect(types).toContain("page");
            // Sink-only: nothing was written to disk.
            expect(filesMatching("telemetry")).toEqual([]);
        } finally {
            await sink.close();
        }
    });

    it("both destinations present feed both (CA3)", async () => {
        const sink = await startSink();
        process.env.VELO_TELEMETRY_FILE = path.join(dir, "telemetry.jsonl");
        process.env.VELO_TELEMETRY_SINK_URL = sink.url;
        try {
            const app = await createTestApp({ routes });
            await app.get("/home");
            await app.close();
            await flushTelemetry();

            const [effective] = filesMatching("telemetry", ".jsonl");
            const events = await readJsonl(path.join(dir, effective!));
            expect(events.map((event) => event.type)).toContain("page");
            const types = sink.received.map((line) => (JSON.parse(line) as TelemetryEvent).type);
            expect(types).toContain("boot");
            expect(types).toContain("page");
        } finally {
            await sink.close();
        }
    });

    it("a failing sink is logged and never breaks the request (CA13)", async () => {
        // A port nothing listens on: the connection is refused.
        const dead = await startSink();
        const url = dead.url;
        await dead.close();

        process.env.VELO_TELEMETRY_SINK_URL = url;
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const app = await createTestApp({ routes });
            const res = await app.get("/home");
            expect(res.status).toBe(200);
            await flushTelemetry();
            expect(errors).toHaveBeenCalled();
            await app.close();
        } finally {
            errors.mockRestore();
        }
    });
});

// ============================================
// Boot record
// ============================================

describe("telemetry — boot record", () => {
    it("carries version, environment, effective destination and rotation limit, and opens the file (CA10)", async () => {
        process.env.VELO_TELEMETRY_FILE = path.join(dir, "telemetry.jsonl");
        process.env.VELO_TELEMETRY_MAX_MB = "4";

        await initNodeTelemetry();
        const events = await readJsonl(filesMatching("telemetry", ".jsonl").map((name) => path.join(dir, name))[0]!);

        const boot = events[0]!;
        expect(boot.type).toBe("boot");
        expect(boot.version).toBe(pkg.version);
        expect(boot.env).toBe(process.env.NODE_ENV ?? null);
        expect(boot.maxMb).toBe(4);
        expect(boot.sink).toBeNull();
        // The effective destination: the file with its instance suffix.
        expect(typeof boot.file).toBe("string");
        expect(boot.file).toContain(`.${process.pid}-`);
        expect(path.basename(boot.file!)).toBe(path.basename(filesMatching("telemetry", ".jsonl")[0]!));
    });

    it("is the first POST that leaves in sink-only mode (CA10)", async () => {
        const sink = await startSink();
        process.env.VELO_TELEMETRY_SINK_URL = sink.url;
        try {
            await initNodeTelemetry();
            await flushTelemetry();
            const first = JSON.parse(sink.received[0]!) as TelemetryEvent;
            expect(first.type).toBe("boot");
            expect(first.file).toBeNull();
            expect(first.sink).toBe(sink.url);
            expect(first.maxMb).toBe(10);
        } finally {
            await sink.close();
        }
    });

    it("the default rotation limit is 10 MB (CA10)", async () => {
        process.env.VELO_TELEMETRY_FILE = path.join(dir, "telemetry.jsonl");
        await initNodeTelemetry();
        expect(telemetryState().maxMb).toBe(10);
        const [effective] = filesMatching("telemetry", ".jsonl");
        const events = await readJsonl(path.join(dir, effective!));
        expect(events[0]!.maxMb).toBe(10);
    });
});

// ============================================
// Instance suffix and rotation
// ============================================

describe("telemetry — instance suffix", () => {
    it("the effective file carries pid and hostname (CA11)", async () => {
        process.env.VELO_TELEMETRY_FILE = path.join(dir, "telemetry.jsonl");
        await initNodeTelemetry();
        const [effective] = filesMatching("telemetry", ".jsonl");
        expect(effective).toContain(`.${process.pid}-${os.hostname().replace(/[^A-Za-z0-9._-]+/g, "-")}.jsonl`);
        expect(telemetryState().file).toBe(path.join(dir, effective!));
    });

    it("two instances of the same app pointing the same destination write distinct files (CA11)", async () => {
        process.env.VELO_TELEMETRY_FILE = path.join(dir, "telemetry.jsonl");

        await initNodeTelemetry({ instanceLabel: "111-one" });
        await flushTelemetry();
        const first = await readJsonl(path.join(dir, "telemetry.111-one.jsonl"));

        await __resetTelemetry();
        await initNodeTelemetry({ instanceLabel: "222-two" });
        await flushTelemetry();
        const second = await readJsonl(path.join(dir, "telemetry.222-two.jsonl"));

        // Both files are valid JSONL, each with its own boot — no shared append.
        expect(first[0]!.type).toBe("boot");
        expect(second[0]!.type).toBe("boot");
        expect(first[0]!.file).toContain("telemetry.111-one.jsonl");
        expect(second[0]!.file).toContain("telemetry.222-two.jsonl");
    });

    it("a base without extension keeps the suffix at the end", () => {
        expect(effectiveTelemetryFile("/var/log/telemetry", "9-host")).toBe("/var/log/telemetry.9-host");
        expect(effectiveTelemetryFile("/var/log/telemetry.jsonl", "9-host")).toBe(
            "/var/log/telemetry.9-host.jsonl",
        );
    });
});

describe("telemetry — rotation", () => {
    it("rotates the file when VELO_TELEMETRY_MAX_MB is exceeded, keeping the live file (CA12)", async () => {
        process.env.VELO_TELEMETRY_FILE = path.join(dir, "telemetry.jsonl");
        // ~1 KiB: a handful of traces overflows it.
        process.env.VELO_TELEMETRY_MAX_MB = "0.001";
        expect(telemetryState().maxMb).toBe(10); // before init: the default

        const app = await createTestApp({ routes });
        for (let i = 0; i < 12; i += 1) await app.get("/home");
        await app.close();
        await flushTelemetry();

        const live = filesMatching("telemetry", ".jsonl");
        const rotated = filesMatching("telemetry", ".jsonl.1");
        expect(live.length).toBe(1);
        expect(rotated.length).toBeGreaterThanOrEqual(1);

        // The live file holds valid JSONL and only post-rotation lines; the
        // rotated file was renamed intact.
        const liveEvents = await readJsonl(path.join(dir, live[0]!));
        const rotatedEvents = await readJsonl(path.join(dir, rotated[0]!));
        expect(rotatedEvents[0]!.type).toBe("boot");
        expect(liveEvents.length).toBeGreaterThan(0);
        expect(fs.statSync(path.join(dir, live[0]!)).size).toBeLessThanOrEqual(1024 * 1.01);
    });

    it("the settings carry the override and the default", () => {
        expect(resolveTelemetrySettings({ VELO_TELEMETRY_FILE: "/x/t.jsonl" }, {})!.maxMb).toBe(10);
        expect(
            resolveTelemetrySettings({ VELO_TELEMETRY_FILE: "/x/t.jsonl", VELO_TELEMETRY_MAX_MB: "2" }, {})!.maxMb,
        ).toBe(2);
        // A present-but-empty destination never activates.
        expect(resolveTelemetrySettings({ VELO_TELEMETRY_FILE: "" }, {})).toBeNull();
        // The project's .env is the fallback when the environment lacks the key
        // (the runtime plugs its reader in; the environment always wins).
        expect(resolveTelemetrySettings({}, { VELO_TELEMETRY_FILE: "/x/from-dotenv.jsonl" })!.file).toBe(
            "/x/from-dotenv.jsonl",
        );
        expect(
            resolveTelemetrySettings({ VELO_TELEMETRY_FILE: "/x/from-env.jsonl" }, {
                VELO_TELEMETRY_FILE: "/x/from-dotenv.jsonl",
            })!.file,
        ).toBe("/x/from-env.jsonl");
    });
});