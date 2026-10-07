/**
 * `velojs telemetry` — the analysis surface.
 *
 * Ranks the JSONL the runtime writes: by route/action/channel, with count,
 * errors, p50/p95 and volume in bytes, plus the timeline. The window is the
 * whole file by default and `--last <duration>` recuts it; without a path the
 * destination comes from `VELO_TELEMETRY_FILE` (environment or project `.env`),
 * including the instance/rotation files derived from it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    parseDuration,
    runTelemetryCli,
    type TelemetryCliIo,
} from "../src/telemetry-cli.js";
import type { TelemetryEvent } from "../src/telemetry.js";

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "velo-telemetry-cli-"));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

function line(event: Partial<TelemetryEvent> & { type: string; ts: string }): string {
    return JSON.stringify({ trace: "t-1", ...event });
}

async function run(args: string[], io: TelemetryCliIo = {}): Promise<string> {
    const out: string[] = [];
    await runTelemetryCli(args, { cwd: dir, env: {}, write: (l) => out.push(l), ...io });
    return out.join("\n");
}

/** The ranking row of `key` inside a section (from `header` on). */
function row(text: string, header: string, key: string): string {
    const lines = text.split("\n");
    const start = lines.findIndex((l) => l.trim() === header);
    const end = lines.findIndex((l, i) => i > start && l.trim().startsWith("By ")) ;
    const section = lines.slice(start, end === -1 ? undefined : end);
    const found = section.find((l) => l.trim().startsWith(key + " "));
    if (!found) throw new Error(`no row "${key}" in "${header}" of:\n${text}`);
    return found;
}

// ============================================
// Fixture — one file with the whole vocabulary
// ============================================

const NOW = Date.now();

function fixtureFile(): string {
    const file = path.join(dir, "telemetry.prod.jsonl");
    const recent = (offsetMs: number) => new Date(NOW - offsetMs).toISOString();
    const lines = [
        line({ type: "boot", ts: recent(10 * 60_000), version: "1.2.3", env: "production", maxMb: 10 }),
        // Routes: three pages + one error + one data refetch on /:mes, one page on /about.
        line({ type: "page", ts: recent(9 * 60_000), route: "/:mes", module: "Mes", status: "ok", duration: 10, bytes: 1000 }),
        line({ type: "page", ts: recent(8 * 60_000), route: "/:mes", module: "Mes", status: "ok", duration: 20, bytes: 1000 }),
        line({ type: "page", ts: recent(7 * 60_000), route: "/:mes", module: "Mes", status: "ok", duration: 30, bytes: 1000 }),
        line({ type: "page", ts: recent(6 * 60_000), route: "/:mes", module: "Mes", status: "error", duration: 40, bytes: 1000 }),
        line({ type: "data", ts: recent(5 * 60_000), route: "/:mes", module: "Mes", status: "ok", duration: 5, bytes: 500 }),
        line({ type: "page", ts: recent(4 * 60_000), route: "/about", module: "About", status: "ok", duration: 2, bytes: 100 }),
        // Endpoints rank in the same section, identified by method + route.
        line({ type: "endpoint", ts: recent(4 * 60_000), method: "GET", route: "/api/health", status: "ok", duration: 1, bytes: 12 }),
        // Actions: two on the same pair.
        line({ type: "action", ts: recent(3 * 60_000), route: "/jobs", module: "Jobs", name: "notify", status: "ok", duration: 8, bytes: 20 }),
        line({ type: "action", ts: recent(2 * 60_000), route: "/jobs", module: "Jobs", name: "notify", status: "error", duration: 12, bytes: 0 }),
        // Channels: connect + two deliveries + close + an emit.
        line({ type: "channel-connect", ts: recent(2 * 60_000), route: "/_channel/Expenses/teamExpenses", module: "Expenses", channel: "teamExpenses", status: "ok", duration: 6 }),
        line({ type: "delivery", ts: recent(2 * 60_000), channel: "teamExpenses", deliveries: 1, bytes: 30 }),
        line({ type: "delivery", ts: recent(2 * 60_000), channel: "teamExpenses", deliveries: 2, bytes: 31 }),
        line({ type: "emit", ts: recent(2 * 60_000), channel: "teamExpenses", partition: "team:7", mode: "invalidate", connections: 1, status: "ok", duration: 9 }),
        line({ type: "close", ts: recent(60_000), channel: "teamExpenses", deliveries: 2, status: "ok", duration: 120_000 }),
    ];
    fs.writeFileSync(file, lines.join("\n") + "\n");
    return file;
}

// ============================================
// Ranking and timeline
// ============================================

describe("velojs telemetry — ranking", () => {
    it("ranks by route with count, errors, p50/p95 and bytes, and prints the timeline (CA14)", async () => {
        const file = fixtureFile();
        const text = await run([file]);

        // Header contract of a ranking table.
        expect(text).toContain("By route");
        expect(text).toContain("By action");
        expect(text).toContain("By channel");
        expect(text).toContain("Timeline");
        const header = text.split("\n").find((l) => l.includes("count"))!;
        for (const column of ["count", "errors", "p50", "p95", "bytes"]) {
            expect(header).toContain(column);
        }

        // Routes: 4 traces on /:mes (3 ok + 1 error + the data refetch), one error,
        // p50 = 20ms, p95 = 38ms, bytes = 4500 → 4.4KB.
        const mes = row(text, "By route", "/:mes");
        expect(mes).toContain("4");
        expect(mes).toContain("20.0ms");
        expect(mes).toContain("38.0ms");
        expect(mes).toContain("4.4KB");
        expect(row(text, "By route", "/about")).toContain("1");
        // Endpoints are identified by method + route in the same ranking.
        expect(row(text, "By route", "GET /api/health")).toContain("1");

        // Actions: identified by module and name.
        const notify = row(text, "By action", "Jobs/notify");
        expect(notify).toContain("2");
        expect(notify).toContain("1"); // one error

        // Channels: connect + deliveries + emit + close.
        const channel = row(text, "By channel", "teamExpenses");
        expect(channel).toContain("5");
        expect(channel).toContain("61"); // bytes of the two frames

        // Timeline: one line per event, in order.
        const timeline = text.slice(text.indexOf("Timeline"));
        expect(timeline).toContain("/:mes");
        expect(timeline).toContain("teamExpenses #1");
        expect(timeline).toContain("boot");
    });

    it("`--last <duration>` recuts the window to the recent events only (CA14)", async () => {
        const file = path.join(dir, "telemetry.prod.jsonl");
        fs.writeFileSync(
            file,
            [
                line({ type: "page", ts: new Date(NOW - 2 * 3_600_000).toISOString(), route: "/old", status: "ok", duration: 1 }),
                line({ type: "page", ts: new Date(NOW - 60_000).toISOString(), route: "/recent", status: "ok", duration: 2 }),
            ].join("\n") + "\n",
        );

        const whole = await run([file]);
        expect(whole).toContain("/old");
        expect(whole).toContain("/recent");

        const windowed = await run([file, "--last", "60m"]);
        expect(windowed).toContain("last 60m");
        expect(windowed).toContain("/recent");
        expect(windowed).not.toContain("/old");
        expect(windowed).toContain("events: 1");
    });

    it("parses durations with the documented units", () => {
        expect(parseDuration("500ms")).toBe(500);
        expect(parseDuration("30s")).toBe(30_000);
        expect(parseDuration("60m")).toBe(3_600_000);
        expect(parseDuration("2h")).toBe(7_200_000);
        expect(parseDuration("7d")).toBe(604_800_000);
        expect(parseDuration("15")).toBe(15_000);
        expect(() => parseDuration("nope")).toThrow(/invalid duration/);
    });
});

// ============================================
// Destination resolution
// ============================================

describe("velojs telemetry — destination resolution", () => {
    it("without a path resolves VELO_TELEMETRY_FILE and the instance/rotation files derived from it (CA14)", async () => {
        const base = path.join(dir, "telemetry.jsonl");
        fs.writeFileSync(
            path.join(dir, "telemetry.123-host.jsonl"),
            line({ type: "page", ts: new Date(NOW).toISOString(), route: "/from-instance", status: "ok", duration: 1 }) + "\n",
        );
        fs.writeFileSync(
            path.join(dir, "telemetry.123-host.jsonl.1"),
            line({ type: "page", ts: new Date(NOW).toISOString(), route: "/from-rotation", status: "ok", duration: 1 }) + "\n",
        );

        const text = await run([], { env: { VELO_TELEMETRY_FILE: base } });
        expect(text).toContain("files:  2");
        expect(text).toContain("/from-instance");
        expect(text).toContain("/from-rotation");
    });

    it("falls back to the project's .env when the environment has no destination (CA14)", async () => {
        fs.writeFileSync(path.join(dir, ".env"), "OTHER=1\nVELO_TELEMETRY_FILE=$TELEMETRY_DIR/telemetry.jsonl\n");
        fs.writeFileSync(
            path.join(dir, "telemetry.9-x.jsonl"),
            line({ type: "page", ts: new Date(NOW).toISOString(), route: "/from-dotenv", status: "ok", duration: 1 }) + "\n",
        );

        const text = await run([], { env: { TELEMETRY_DIR: dir } });
        expect(text).toContain("/from-dotenv");
    });

    it("an explicit path reads the JSONL copied from production (CA14)", async () => {
        const file = path.join(dir, "copied.jsonl");
        fs.writeFileSync(file, line({ type: "page", ts: new Date(NOW).toISOString(), route: "/copied", status: "ok", duration: 1 }) + "\n");
        const text = await run([file]);
        expect(text).toContain("files:  1");
        expect(text).toContain("/copied");
    });

    it("skips malformed lines instead of dying on them", async () => {
        const file = path.join(dir, "torn.jsonl");
        fs.writeFileSync(
            file,
            [
                "{ not json",
                line({ type: "page", ts: new Date(NOW).toISOString(), route: "/intact", status: "ok", duration: 1 }),
                "",
            ].join("\n"),
        );
        const text = await run([file]);
        expect(text).toContain("/intact");
        expect(text).toContain("events: 1");
    });

    it("with no destination at all, fails legibly naming the env", async () => {
        await expect(run([])).rejects.toThrow(/VELO_TELEMETRY_FILE/);
    });

    it("a missing explicit path and an unknown flag are legible errors", async () => {
        await expect(run([path.join(dir, "nope.jsonl")])).rejects.toThrow(/file not found/);
        await expect(run(["--bogus"])).rejects.toThrow(/unknown flag/);
    });
});