/**
 * `velojs telemetry` — the inaugural consumption surface over the collection.
 *
 * Reads the JSONL the runtime writes (one line per trace) and prints the
 * ranking by route/action/channel — count, errors, p50/p95 and volume in bytes
 * — plus the timeline. The window is the whole file by default, recut with
 * `--last <duration>` (`--last 60m`). Without a path, the destination comes
 * from `VELO_TELEMETRY_FILE` in the environment or in the project's `.env`,
 * including the instance and rotation files that derive from it; an explicit
 * path reads a JSONL copied from production.
 *
 * No UI, no server route: the operator's terminal is the whole surface.
 */

import fs from "node:fs";
import path from "node:path";
import { expandTelemetryValue, type TelemetryEvent } from "./telemetry.js";
import { readProjectEnv } from "./telemetry-node.js";

// ============================================
// TYPES
// ============================================

export interface TelemetryCliIo {
    cwd?: string | undefined;
    env?: Record<string, string | undefined> | undefined;
    write?: ((line: string) => void) | undefined;
    writeError?: ((line: string) => void) | undefined;
}

export interface RankRow {
    key: string;
    count: number;
    errors: number;
    p50: number | null;
    p95: number | null;
    bytes: number;
}

export interface TimelineEntry {
    ts: string;
    type: string;
    label: string;
    duration: number | null;
    status: string | null;
    bytes: number | null;
    deliveries: number | null;
}

export interface TelemetryReport {
    files: string[];
    events: TelemetryEvent[];
    routes: RankRow[];
    actions: RankRow[];
    channels: RankRow[];
    timeline: TimelineEntry[];
}

// ============================================
// DURATIONS
// ============================================

/** `--last` accepts `ms`, `s`, `m`, `h`, `d`; a bare number counts seconds. */
export function parseDuration(raw: string): number {
    const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
    if (!match) {
        throw new Error(
            `[velojs] invalid duration "${raw}" — use a unit: 500ms, 30s, 60m, 2h, 7d.`,
        );
    }
    const value = Number(match[1]);
    const unit = match[2] ?? "s";
    const factor =
        unit === "ms" ? 1
        : unit === "s" ? 1000
        : unit === "m" ? 60_000
        : unit === "h" ? 3_600_000
        : 86_400_000;
    return value * factor;
}

// ============================================
// FILES — the env destination and its derived files
// ============================================

function statOrNull(target: string): fs.Stats | null {
    try {
        return fs.statSync(target);
    } catch {
        return null;
    }
}

/**
 * The files a destination resolves to. The effective file of each instance
 * carries a pid/hostname suffix (`telemetry.123-host.jsonl`) and rotation adds
 * a numeric tail (`…jsonl.1`), so a base path collects its whole family. A
 * directory collects every JSONL inside it.
 */
export function collectTelemetryFiles(target: string, basePath: boolean): string[] {
    const stat = statOrNull(target);
    if (stat?.isDirectory()) {
        return fs
            .readdirSync(target)
            .filter((name) => name.includes(".jsonl"))
            .sort()
            .map((name) => path.join(target, name));
    }
    if (stat?.isFile()) return [target];
    if (!basePath) {
        throw new Error(`[velojs] velojs telemetry: file not found — ${target}`);
    }

    const dir = path.dirname(target);
    const base = path.basename(target);
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";

    if (!statOrNull(dir)) {
        throw new Error(
            `[velojs] velojs telemetry: no telemetry files at ${target} — the directory does not exist.`,
        );
    }
    const found = fs
        .readdirSync(dir)
        .filter((name) => {
            if (name === base) return true;
            if (!name.startsWith(`${stem}.`)) return false;
            return ext === "" || name.includes(ext);
        })
        .sort()
        .map((name) => path.join(dir, name));

    if (found.length === 0) {
        throw new Error(
            `[velojs] velojs telemetry: no telemetry files found for ${target} — ` +
            `set VELO_TELEMETRY_FILE (see .env.example) or pass the JSONL path explicitly.`,
        );
    }
    return found;
}

function resolveFiles(
    pathArg: string | null,
    env: Record<string, string | undefined>,
    fileEnv: Record<string, string>,
    cwd: string,
): string[] {
    if (pathArg) {
        const expanded = expandTelemetryValue(pathArg, { ...fileEnv, ...env });
        const abs = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
        return collectTelemetryFiles(abs, false);
    }

    const raw = env.VELO_TELEMETRY_FILE ?? fileEnv.VELO_TELEMETRY_FILE ?? "";
    if (!raw.trim()) {
        throw new Error(
            "[velojs] velojs telemetry: no destination — set VELO_TELEMETRY_FILE " +
            "in the environment or in the project's .env (see .env.example), " +
            "or pass the JSONL path as an argument.",
        );
    }
    const expanded = expandTelemetryValue(raw.trim(), { ...fileEnv, ...env });
    const abs = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
    return collectTelemetryFiles(abs, true);
}

// ============================================
// READING
// ============================================

/** Reads every JSONL file, skipping malformed lines, in chronological order. */
export function readTelemetryEvents(files: string[]): TelemetryEvent[] {
    const events: TelemetryEvent[] = [];
    for (const file of files) {
        let raw: string;
        try {
            raw = fs.readFileSync(file, "utf-8");
        } catch (err) {
            throw new Error(
                `[velojs] velojs telemetry: cannot read ${file} — ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
        }
        for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const parsed = JSON.parse(trimmed) as TelemetryEvent;
                if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
                    events.push(parsed);
                }
            } catch {
                // A torn/tampered line is skipped, never fatal: the analysis is
                // over the file a production process may be appending to.
            }
        }
    }
    events.sort((a, b) => {
        const at = Date.parse(a.ts ?? "");
        const bt = Date.parse(b.ts ?? "");
        return (Number.isFinite(at) ? at : 0) - (Number.isFinite(bt) ? bt : 0);
    });
    return events;
}

/** Keeps the events inside the `--last` window (everything without `lastMs`). */
export function windowEvents(events: TelemetryEvent[], lastMs: number | null, nowMs: number): TelemetryEvent[] {
    if (lastMs === null) return events;
    const cutoff = nowMs - lastMs;
    return events.filter((event) => {
        const ts = Date.parse(event.ts ?? "");
        return Number.isFinite(ts) && ts >= cutoff;
    });
}

// ============================================
// AGGREGATION
// ============================================

function percentile(values: number[], p: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 1) return sorted[0]!;
    const index = (sorted.length - 1) * p;
    const low = Math.floor(index);
    const high = Math.ceil(index);
    if (low === high) return sorted[low]!;
    return sorted[low]! + (sorted[high]! - sorted[low]!) * (index - low);
}

function rankRows(
    events: TelemetryEvent[],
    match: (event: TelemetryEvent) => boolean,
    keyOf: (event: TelemetryEvent) => string,
): RankRow[] {
    const buckets = new Map<string, { durations: number[]; count: number; errors: number; bytes: number }>();
    for (const event of events) {
        if (!match(event)) continue;
        const key = keyOf(event);
        let bucket = buckets.get(key);
        if (!bucket) {
            bucket = { durations: [], count: 0, errors: 0, bytes: 0 };
            buckets.set(key, bucket);
        }
        bucket.count += 1;
        if (event.status === "error") bucket.errors += 1;
        if (typeof event.duration === "number" && Number.isFinite(event.duration)) {
            bucket.durations.push(event.duration);
        }
        if (typeof event.bytes === "number" && Number.isFinite(event.bytes)) {
            bucket.bytes += event.bytes;
        }
    }

    return [...buckets.entries()]
        .map(([key, bucket]) => ({
            key,
            count: bucket.count,
            errors: bucket.errors,
            p50: percentile(bucket.durations, 0.5),
            p95: percentile(bucket.durations, 0.95),
            bytes: bucket.bytes,
        }))
        .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const isRouteTrace = (event: TelemetryEvent): boolean =>
    event.type === "page" || event.type === "data" || event.type === "endpoint";

const routeKey = (event: TelemetryEvent): string => {
    const route = event.route ?? "(no route)";
    return event.type === "endpoint" && event.method ? `${event.method} ${route}` : route;
};

const actionKey = (event: TelemetryEvent): string =>
    `${event.module ?? "(no module)"}/${event.name ?? "(no name)"}`;

const isChannelTrace = (event: TelemetryEvent): boolean => typeof event.channel === "string";

function labelOf(event: TelemetryEvent): string {
    switch (event.type) {
        case "page":
        case "data":
        case "endpoint":
            return `${event.method ? `${event.method} ` : ""}${event.route ?? "(no route)"}`;
        case "action":
            return actionKey(event);
        case "emit":
            return `${event.channel ?? "?"} (${event.mode ?? "?"}${event.connections !== undefined ? `, ${event.connections} conn` : ""})`;
        case "delivery":
            return `${event.channel ?? "?"} #${event.deliveries ?? "?"}`;
        case "close":
            return `${event.channel ?? "?"} ${event.deliveries ?? 0} deliveries`;
        case "stream-connect":
            return `${event.route ?? "?"}${event.channel ? ` [${event.channel}]` : ""}`;
        case "socket-connect":
            return event.route ?? "?";
        case "channel-connect":
            return `${event.channel ?? "?"} [${event.module ?? "?"}]`;
        case "boot":
            return `version ${event.version ?? "?"} env ${event.env ?? "?"}`;
        default:
            return event.route ?? event.channel ?? "?";
    }
}

/** The whole analysis, as data: rankings + timeline. */
export function buildTelemetryReport(files: string[], events: TelemetryEvent[]): TelemetryReport {
    return {
        files,
        events,
        routes: rankRows(events, isRouteTrace, routeKey),
        actions: rankRows(events, (event) => event.type === "action", actionKey),
        channels: rankRows(events, isChannelTrace, (event) => event.channel!),
        timeline: events.map((event) => ({
            ts: event.ts ?? "",
            type: event.type,
            label: labelOf(event),
            duration: typeof event.duration === "number" ? event.duration : null,
            status: event.status ?? null,
            bytes: typeof event.bytes === "number" ? event.bytes : null,
            deliveries: typeof event.deliveries === "number" ? event.deliveries : null,
        })),
    };
}

// ============================================
// RENDERING
// ============================================

const DASH = "—";

function formatMs(value: number | null): string {
    if (value === null) return DASH;
    if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
    return `${value.toFixed(1)}ms`;
}

function formatBytes(value: number): string {
    if (value <= 0) return "0";
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)}MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)}KB`;
    return `${value}B`;
}

function renderRank(title: string, rows: RankRow[]): string[] {
    const lines: string[] = [title];
    if (rows.length === 0) {
        lines.push("  (nothing)");
        return lines;
    }
    const widths = {
        key: Math.max(3, ...rows.map((row) => row.key.length)),
        count: Math.max(5, ...rows.map((row) => String(row.count).length)),
        errors: Math.max(6, ...rows.map((row) => String(row.errors).length)),
        p50: Math.max(4, ...rows.map((row) => formatMs(row.p50).length)),
        p95: Math.max(4, ...rows.map((row) => formatMs(row.p95).length)),
        bytes: Math.max(5, ...rows.map((row) => formatBytes(row.bytes).length)),
    };
    const pad = (value: string, width: number) => value.padEnd(width);
    const padStart = (value: string, width: number) => value.padStart(width);
    lines.push(
        `  ${pad("key", widths.key)}  ${padStart("count", widths.count)}  ` +
        `${padStart("errors", widths.errors)}  ${padStart("p50", widths.p50)}  ` +
        `${padStart("p95", widths.p95)}  ${padStart("bytes", widths.bytes)}`,
    );
    for (const row of rows) {
        lines.push(
            `  ${pad(row.key, widths.key)}  ${padStart(String(row.count), widths.count)}  ` +
            `${padStart(String(row.errors), widths.errors)}  ${padStart(formatMs(row.p50), widths.p50)}  ` +
            `${padStart(formatMs(row.p95), widths.p95)}  ${padStart(formatBytes(row.bytes), widths.bytes)}`,
        );
    }
    return lines;
}

function renderTimeline(entries: TimelineEntry[]): string[] {
    const lines: string[] = ["Timeline"];
    if (entries.length === 0) {
        lines.push("  (nothing)");
        return lines;
    }
    for (const entry of entries) {
        const stamp = entry.ts.replace("T", " ").replace("Z", "");
        const duration = entry.duration === null ? "" : `  ${formatMs(entry.duration)}`;
        const status = entry.status ? `  ${entry.status}` : "";
        const bytes = entry.bytes === null ? "" : `  ${formatBytes(entry.bytes)}`;
        lines.push(`  ${stamp}  ${entry.type.padEnd(15)}  ${entry.label}${duration}${status}${bytes}`);
    }
    return lines;
}

/** Renders the human report — the CLI's whole stdout. */
export function formatTelemetryReport(
    report: TelemetryReport,
    lastMs: number | null,
    nowMs: number,
    lastLabel?: string,
): string {
    const lines: string[] = ["VeloJS telemetry"];
    lines.push(`files:  ${report.files.length}`);
    for (const file of report.files) lines.push(`  ${file}`);
    const window = lastMs === null
        ? "the whole file"
        : `last ${lastLabel ?? formatDurationLabel(lastMs)} — since ${new Date(nowMs - lastMs).toISOString()}`;
    lines.push(`window: ${window}`);
    lines.push(`events: ${report.events.length}`);
    lines.push("");
    lines.push(...renderRank("By route", report.routes));
    lines.push("");
    lines.push(...renderRank("By action", report.actions));
    lines.push("");
    lines.push(...renderRank("By channel", report.channels));
    lines.push("");
    lines.push(...renderTimeline(report.timeline));
    return lines.join("\n");
}

function formatDurationLabel(ms: number): string {
    if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
    if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
    if (ms % 60_000 === 0) return `${ms / 60_000}m`;
    if (ms % 1000 === 0) return `${ms / 1000}s`;
    return `${ms}ms`;
}

// ============================================
// ENTRY POINT
// ============================================

const USAGE = `Usage: velojs telemetry [path] [--last <duration>]

Ranks the JSONL written by the native telemetry (count, errors, p50/p95,
bytes) by route, action and channel, and prints the timeline.

  path            JSONL file copied from production (or a directory of them).
                  Without it, VELO_TELEMETRY_FILE from the environment or the
                  project's .env is used, including the instance/rotation
                  files derived from it.
  --last <dur>    Window: 500ms, 30s, 60m, 2h, 7d (default: the whole file).

Examples:
  velojs telemetry
  velojs telemetry --last 60m
  velojs telemetry ./telemetry.prod.jsonl`;

/**
 * Runs the `telemetry` command. Throws (legibly) on a missing destination;
 * the CLI turns that into exit code 1.
 */
export async function runTelemetryCli(args: string[], io: TelemetryCliIo = {}): Promise<void> {
    const cwd = io.cwd ?? process.cwd();
    const env = io.env ?? process.env;
    const write = io.write ?? ((line: string) => console.log(line));

    let pathArg: string | null = null;
    let lastMs: number | null = null;
    let lastLabel: string | undefined;

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i]!;
        if (arg === "--help" || arg === "-h") {
            write(USAGE);
            return;
        }
        if (arg === "--last") {
            const value = args[i + 1];
            if (value === undefined) {
                throw new Error("[velojs] velojs telemetry: --last requires a duration (e.g. --last 60m).");
            }
            lastMs = parseDuration(value);
            lastLabel = value;
            i += 1;
            continue;
        }
        if (arg.startsWith("--last=")) {
            lastLabel = arg.slice("--last=".length);
            lastMs = parseDuration(lastLabel);
            continue;
        }
        if (arg.startsWith("-")) {
            throw new Error(`[velojs] velojs telemetry: unknown flag "${arg}".\n\n${USAGE}`);
        }
        if (pathArg !== null) {
            throw new Error(`[velojs] velojs telemetry: unexpected argument "${arg}".\n\n${USAGE}`);
        }
        pathArg = arg;
    }

    const fileEnv = readProjectEnv(cwd);
    const files = resolveFiles(pathArg, env, fileEnv, cwd);
    const events = windowEvents(readTelemetryEvents(files), lastMs, Date.now());
    const report = buildTelemetryReport(files, events);
    write(formatTelemetryReport(report, lastMs, Date.now(), lastLabel));
}