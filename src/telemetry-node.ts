/**
 * Native telemetry — the Node adapter.
 *
 * The client-safe core (`telemetry.ts`) holds the event model, the trace API
 * and the destination resolution; this module owns everything that touches the
 * filesystem, the host and the network: the append-only JSONL writer with
 * size-based rotation and the instance suffix, the optional HTTP sink, the
 * reading of the project's `.env` and of the app version for the boot record.
 *
 * Only server-side entry points import it (`server.tsx`, `telemetry-cli.ts`),
 * which is what keeps the Node builtins out of the client bundle.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    initTelemetry,
    parseDotEnv,
    byteLength,
    type TelemetryWriter,
    type TelemetryWriterInput,
} from "./telemetry.js";

// ============================================
// ENVIRONMENT
// ============================================

/**
 * Reads the project's `.env` — the runtime fallback for the destination envs,
 * and the source the CLI resolves a missing `VELO_TELEMETRY_FILE` from.
 * Missing or unreadable file → empty map; the process environment always wins.
 */
export function readProjectEnv(cwd: string = process.cwd()): Record<string, string> {
    try {
        return parseDotEnv(fs.readFileSync(path.join(cwd, ".env"), "utf-8"));
    } catch {
        return {};
    }
}

/** `pid.hostname`, sanitized for a filename — one file per process replica. */
export function nodeInstanceLabel(): string {
    const clean = os
        .hostname()
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return clean ? `${process.pid}-${clean}` : String(process.pid);
}

/** The version of the app served — the project's `package.json`. */
export function readAppVersion(cwd: string = process.cwd()): string | null {
    try {
        const raw = fs.readFileSync(path.join(cwd, "package.json"), "utf-8");
        const pkg = JSON.parse(raw) as { version?: unknown };
        return typeof pkg.version === "string" ? pkg.version : null;
    } catch {
        return null;
    }
}

// ============================================
// THE WRITER — file (with rotation) and sink
// ============================================

function statSizeSync(file: string): number {
    try {
        return fs.statSync(file).size;
    } catch {
        return 0;
    }
}

/**
 * Builds the destination writer: append-only JSONL with size-based rotation,
 * plus an optional HTTP POST per event. Failures are logged and never
 * propagate — a telemetry destination down must not affect the request that
 * produced the event.
 */
export async function nodeTelemetryWriter(input: TelemetryWriterInput): Promise<TelemetryWriter> {
    const file = input.file;
    const sink = input.sink;

    let handle: fs.promises.FileHandle | null = null;
    let size = 0;
    let rotations = 0;

    const openFile = async (): Promise<void> => {
        if (handle || !file) return;
        // The destination is the operator's declaration: a fresh volume with
        // the declared directory missing gets it created (never a silent,
        // destination-less failure).
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        size = statSizeSync(file);
        handle = await fs.promises.open(file, "a");
    };

    /**
     * Size-based rotation — the only pruning mechanism there is (no daily
     * retention). The live file is renamed to `<effective>.<n>` (n chosen so an
     * earlier run's rotated file is never overwritten) and a fresh file takes
     * its place, so the effective path always holds the newest lines.
     */
    const rotate = async (): Promise<void> => {
        if (!file) return;
        if (handle) {
            await handle.close().catch(() => {});
            handle = null;
        }
        let n = rotations + 1;
        while (fs.existsSync(`${file}.${n}`)) n += 1;
        await fs.promises.rename(file, `${file}.${n}`);
        rotations = n;
        size = 0;
        handle = await fs.promises.open(file, "a");
    };

    const writeToFile = async (line: string): Promise<void> => {
        if (!file) return;
        try {
            await openFile();
            const bytes = byteLength(line) + 1;
            if (size > 0 && size + bytes > input.maxBytes) await rotate();
            await handle!.write(`${line}\n`);
            size += bytes;
        } catch (err) {
            console.error(`[velojs] telemetry file destination failed (${file}):`, err);
        }
    };

    const postToSink = async (line: string): Promise<void> => {
        if (!sink) return;
        try {
            const response = await fetch(sink, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: line,
            });
            await response.text().catch(() => "");
            if (!response.ok) {
                console.error(`[velojs] telemetry sink responded ${response.status} (${sink})`);
            }
        } catch (err) {
            console.error(`[velojs] telemetry sink destination failed (${sink}):`, err);
        }
    };

    return {
        file,
        sink,
        async write(line: string): Promise<void> {
            const jobs: Array<Promise<void>> = [];
            if (file) jobs.push(writeToFile(line));
            if (sink) jobs.push(postToSink(line));
            await Promise.allSettled(jobs);
        },
        async close(): Promise<void> {
            if (handle) {
                await handle.close().catch(() => {});
                handle = null;
            }
        },
    };
}

// ============================================
// BOOT
// ============================================

/**
 * Starts the collection with the Node adapter: process env plus the project's
 * `.env`, the pid/hostname suffix, the app version for the boot record. This
 * is what `createApp` calls; without a destination it is a no-op.
 */
export async function initNodeTelemetry(opts?: { instanceLabel?: string }): Promise<void> {
    await initTelemetry({
        writer: nodeTelemetryWriter,
        instanceLabel: opts?.instanceLabel ?? nodeInstanceLabel(),
        version: readAppVersion(),
        fileEnv: readProjectEnv(process.cwd()),
    });
}