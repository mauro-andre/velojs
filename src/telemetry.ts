/**
 * Native telemetry — boundary traces, first-class JSONL (client-safe core).
 *
 * The framework owns a finite set of bottlenecks (page SSR, `?_data=1` refetch,
 * action, declarative endpoint, stream connect, socket setup, channel connect)
 * plus the emit chain that runs outside any request. This module turns each of
 * them into one JSONL event with duration, status, response bytes, child spans
 * and — on long connections — one delivery line per frame delivered and a final
 * close line. The file is the production artifact; `velojs telemetry` ranks it.
 *
 * Activation is by destination, never by a flag: `VELO_TELEMETRY_FILE` and/or
 * `VELO_TELEMETRY_SINK_URL` present and non-empty turn collection on; none of
 * them (absent or empty) leaves the whole module inert — no file, no event, no
 * cost — in any environment, dev included. The values expand `~` and `$VAR`,
 * the effective file carries an instance suffix (pid/hostname) so replicas
 * sharing a volume never corrupt each other, and `VELO_TELEMETRY_MAX_MB`
 * (default 10) is the only pruning mechanism: size-based rotation.
 *
 * This core is import-safe on the client (no Node builtin anywhere): it holds
 * the event model, the trace API and the destination resolution. The writer
 * that touches the filesystem and the network lives in `telemetry-node.ts`,
 * injected at boot — the client bundle never reaches it.
 */

// ============================================
// TYPES
// ============================================

/** Every line of the JSONL carries one of these types. */
export type TelemetryEventType =
    | "boot"
    | "page"
    | "data"
    | "action"
    | "endpoint"
    | "stream-connect"
    | "socket-connect"
    | "channel-connect"
    | "emit"
    | "delivery"
    | "close";

export type TelemetryStatus = "ok" | "error";

/** One child span: name, start relative to the trace, own duration and status. */
export interface TelemetrySpan {
    name: string;
    /** Milliseconds since the trace started. */
    start: number;
    duration: number;
    status: TelemetryStatus;
}

/** The open field set shared by the trace handle and every emitted line. */
export interface TelemetryEventFields {
    status?: TelemetryStatus | undefined;
    duration?: number | undefined;
    bytes?: number | undefined;
    route?: string | undefined;
    module?: string | undefined;
    name?: string | undefined;
    method?: string | undefined;
    channel?: string | undefined;
    partition?: string | null | undefined;
    mode?: "invalidate" | "slice" | undefined;
    connections?: number | undefined;
}

/** One JSONL line. Optional fields exist only when the type has them. */
export interface TelemetryEvent extends TelemetryEventFields {
    trace: string;
    ts: string;
    type: TelemetryEventType;
    /** Cumulative ordinal on `delivery` lines; total on `close` lines. */
    deliveries?: number | undefined;
    spans?: TelemetrySpan[] | undefined;
    // Boot record only.
    version?: string | null | undefined;
    env?: string | null | undefined;
    file?: string | null | undefined;
    sink?: string | null | undefined;
    maxMb?: number | undefined;
}

export interface TelemetrySpanHandle {
    /** Closes the span; first call wins. */
    end(status?: TelemetryStatus): void;
}

/** A span collector detached from any trace — used for coalesced emit rounds. */
export interface TelemetrySpanRecorder {
    readonly spans: TelemetrySpan[];
    span(name: string): TelemetrySpanHandle;
}

/**
 * One open trace. `end()` writes the main line once; `delivery()` and
 * `close()` write the light lines of a long connection, all carrying the same
 * trace id. A disabled trace is a shared no-op.
 */
export interface TelemetryTrace extends TelemetrySpanRecorder {
    readonly id: string;
    readonly enabled: boolean;
    addSpans(spans: readonly TelemetrySpan[]): void;
    setFields(fields: TelemetryEventFields): void;
    end(fields?: TelemetryEventFields): void;
    delivery(bytes?: number): void;
    close(fields?: TelemetryEventFields): void;
}

/** The destination model: env values resolved, defaults applied. */
export interface TelemetrySettings {
    /** `VELO_TELEMETRY_FILE` expanded (instance suffix NOT applied), or null. */
    file: string | null;
    /** `VELO_TELEMETRY_SINK_URL` expanded, or null. */
    sink: string | null;
    /** `VELO_TELEMETRY_MAX_MB`, default 10. */
    maxMb: number;
}

/** Read-only view of the runtime state — the disabled-mode assertion. */
export interface TelemetryState {
    enabled: boolean;
    file: string | null;
    sink: string | null;
    maxMb: number;
    /** Events handed to the destinations since the last reset. */
    events: number;
}

/**
 * Where the events go. The core never touches the filesystem: the Node adapter
 * (`telemetry-node.ts`) implements this and is injected at boot.
 */
export interface TelemetryWriter {
    /** Effective file path the writer appends to (instance suffix applied). */
    readonly file: string | null;
    /** Sink URL the writer POSTs to. */
    readonly sink: string | null;
    write(line: string): Promise<void>;
    close(): Promise<void>;
}

/** What the writer factory needs to build a destination writer. */
export interface TelemetryWriterInput {
    /** Effective file path (instance suffix applied) or null. */
    file: string | null;
    sink: string | null;
    maxBytes: number;
}

export interface TelemetryInitOptions {
    /** Builds the destination writer (the Node adapter, injected). */
    writer: (input: TelemetryWriterInput) => Promise<TelemetryWriter>;
    /** Overrides the pid/hostname suffix (tests only). */
    instanceLabel?: string | undefined;
    /** The app version served — goes into the boot record. */
    version?: string | null | undefined;
    /**
     * The project's `.env` values, the fallback for the destination keys — the
     * Node adapter reads them; the process environment always wins.
     */
    fileEnv?: Record<string, string> | undefined;
}

// ============================================
// ENV RESOLUTION — the destination is the trigger
// ============================================

/** The default rotation limit, in MB. */
export const DEFAULT_MAX_MB = 10;

/**
 * Expands `~` (home) and `$VAR` / `${VAR}` in a destination value, against the
 * merged environment (process env wins over `.env`). An undefined reference is
 * kept literally — a silently wrong path is worse than a visible one, and the
 * boot record shows the effective destination for diagnosis.
 */
export function expandTelemetryValue(
    value: string,
    env: Record<string, string | undefined>,
): string {
    let out = value;
    if (out === "~") out = homeDirFromEnv(env);
    else if (out.startsWith("~/")) out = `${homeDirFromEnv(env)}${out.slice(1)}`;
    return out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, bare) => {
        const key = (braced ?? bare) as string;
        const resolved = env[key];
        return resolved === undefined ? match : resolved;
    });
}

function homeDirFromEnv(env: Record<string, string | undefined>): string {
    return (env.HOME ?? env.USERPROFILE ?? "").replace(/\/+$/, "");
}

/**
 * Parses a `.env` file body. Deliberately a small subset — `KEY=value` (with
 * optional `export`), double/single quotes, `#` comments and inline comments
 * after whitespace — which is all the framework consumes: the telemetry keys
 * of the project, and nothing else.
 */
export function parseDotEnv(content: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) continue;
        const key = match[1]!;
        let value = match[2]!.trim();
        if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
            value = value.slice(1, -1);
        } else {
            const hash = value.indexOf(" #");
            if (hash !== -1) value = value.slice(0, hash).trim();
        }
        out[key] = value;
    }
    return out;
}

/**
 * Resolves the destination model from the environment. `process env` values
 * win over the project's `.env` (the same precedence the release script uses);
 * a key present but empty counts as unset-at-that-level. Returns `null` when
 * neither destination is configured — the whole collection is off.
 */
export function resolveTelemetrySettings(
    env: Record<string, string | undefined>,
    fileEnv: Record<string, string> = {},
): TelemetrySettings | null {
    const pick = (key: string): string => {
        const fromProcess = env[key];
        if (fromProcess !== undefined) return fromProcess.trim();
        return (fileEnv[key] ?? "").trim();
    };

    const rawFile = pick("VELO_TELEMETRY_FILE");
    const rawSink = pick("VELO_TELEMETRY_SINK_URL");
    if (!rawFile && !rawSink) return null;

    const merged: Record<string, string | undefined> = { ...fileEnv, ...env };
    const maxMbRaw = pick("VELO_TELEMETRY_MAX_MB");
    const parsedMax = Number(maxMbRaw);
    const maxMb = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : DEFAULT_MAX_MB;

    return {
        file: rawFile ? expandTelemetryValue(rawFile, merged) : null,
        sink: rawSink ? expandTelemetryValue(rawSink, merged) : null,
        maxMb,
    };
}

/**
 * The effective file of one instance: the instance suffix goes before the
 * extension, so several processes pointing the same destination write
 * different files and an append never interleaves with another process's.
 */
export function effectiveTelemetryFile(baseFile: string, instance: string): string {
    const slash = Math.max(baseFile.lastIndexOf("/"), baseFile.lastIndexOf("\\"));
    const dir = slash === -1 ? "" : baseFile.slice(0, slash + 1);
    const base = slash === -1 ? baseFile : baseFile.slice(slash + 1);
    const dot = base.lastIndexOf(".");
    const suffixed = dot > 0
        ? `${base.slice(0, dot)}.${instance}${base.slice(dot)}`
        : `${base}.${instance}`;
    return `${dir}${suffixed}`;
}

// ============================================
// RUNTIME — the injected writer, the queue
// ============================================

interface TelemetryRuntime {
    settings: TelemetrySettings;
    writer: TelemetryWriter;
    /** Effective path, instance suffix applied. */
    file: string | null;
    sink: string | null;
    version: string | null;
    env: string | null;
    chain: Promise<void>;
    events: number;
}

let runtime: TelemetryRuntime | null = null;
let booted = false;
let initializing: Promise<void> | null = null;
let traceCounter = 0;

function nextTraceId(): string {
    traceCounter += 1;
    return `${Date.now().toString(36)}-${traceCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Copies every defined field of `source` onto `target` (null survives). */
function assignDefined<T extends object>(target: T, source: object): T {
    for (const [key, value] of Object.entries(source)) {
        if (value !== undefined) (target as Record<string, unknown>)[key] = value;
    }
    return target;
}

const roundMs = (value: number): number => Math.round(value * 100) / 100;

const now = (): number =>
    typeof performance !== "undefined" ? performance.now() : Date.now();

const isoNow = (): string => new Date().toISOString();

function processEnv(): Record<string, string | undefined> {
    return typeof process !== "undefined" ? (process.env as Record<string, string | undefined>) : {};
}

/**
 * Starts the collection for this process: resolves the destination from the
 * environment and writes the boot record — the first event of every active
 * destination, the file's first line and the sink's first POST. Without a
 * destination this is a no-op; with one it runs once per process (idempotent).
 *
 * The writer comes from the caller: `initNodeTelemetry()` (the Node adapter)
 * is what the server boot uses.
 */
export async function initTelemetry(options: TelemetryInitOptions): Promise<void> {
    if (booted) return;
    if (initializing) {
        await initializing;
        return;
    }

    initializing = (async () => {
        const env = processEnv();
        const settings = resolveTelemetrySettings(env, options.fileEnv ?? {});
        if (!settings) return;

        const instance =
            options.instanceLabel ?? `pid-${String((globalThis as any).process?.pid ?? "0")}`;
        const file = settings.file ? effectiveTelemetryFile(settings.file, instance) : null;
        const writer = await options.writer({
            file,
            sink: settings.sink,
            maxBytes: settings.maxMb * 1024 * 1024,
        });

        const rt: TelemetryRuntime = {
            settings,
            writer,
            file: writer.file ?? file,
            sink: writer.sink ?? settings.sink,
            version: options.version ?? null,
            env: env.NODE_ENV ?? null,
            chain: Promise.resolve(),
            events: 0,
        };
        runtime = rt;
        booted = true;

        const boot: TelemetryEvent = { trace: nextTraceId(), ts: isoNow(), type: "boot" };
        assignDefined(boot, {
            version: rt.version,
            env: rt.env,
            file: rt.file,
            sink: rt.sink,
            maxMb: rt.settings.maxMb,
        });
        await enqueue(rt, boot);
    })();

    await initializing;
    initializing = null;
}

function enqueue(rt: TelemetryRuntime, event: TelemetryEvent): Promise<void> {
    rt.events += 1;
    rt.chain = rt.chain
        .then(() => rt.writer.write(JSON.stringify(event)))
        .catch(() => {});
    return rt.chain;
}

/** Waits until every queued event reached its destinations. */
export async function flushTelemetry(): Promise<void> {
    await runtime?.chain;
}

/** Whether a destination is active in this process. */
export function isTelemetryEnabled(): boolean {
    return runtime !== null;
}

/** Read-only snapshot of the runtime state. */
export function telemetryState(): TelemetryState {
    return {
        enabled: runtime !== null,
        file: runtime?.file ?? null,
        sink: runtime?.sink ?? null,
        maxMb: runtime?.settings.maxMb ?? DEFAULT_MAX_MB,
        events: runtime?.events ?? 0,
    };
}

/**
 * Test-only. Closes the writer and drops the runtime, so the next
 * `initTelemetry()` re-reads the environment from scratch.
 */
export async function __resetTelemetry(): Promise<void> {
    if (initializing) await initializing;
    const rt = runtime;
    runtime = null;
    booted = false;
    initializing = null;
    if (!rt) return;
    await rt.chain.catch(() => {});
    await rt.writer.close().catch(() => {});
}

// ============================================
// TRACES
// ============================================

const NOOP_SPAN: TelemetrySpanHandle = { end: () => {} };

/** Milliseconds of a string as UTF-8, without pulling Buffer into the client. */
export function byteLength(value: string): number {
    if (typeof Buffer !== "undefined") return Buffer.byteLength(value);
    return new TextEncoder().encode(value).length;
}

/** The JSON byte size of a value, when it serializes at all. */
export function jsonBytes(value: unknown): number | undefined {
    try {
        const text = JSON.stringify(value);
        return text === undefined ? undefined : byteLength(text);
    } catch {
        return undefined;
    }
}

function beginSpan(sink: TelemetrySpan[], traceStart: number, name: string): TelemetrySpanHandle {
    const start = now();
    let done = false;
    return {
        end(status: TelemetryStatus = "ok") {
            if (done) return;
            done = true;
            sink.push({
                name,
                start: roundMs(start - traceStart),
                duration: roundMs(now() - start),
                status,
            });
        },
    };
}

const NOOP_TRACE: TelemetryTrace = {
    id: "",
    enabled: false,
    spans: [],
    span: () => NOOP_SPAN,
    addSpans: () => {},
    setFields: () => {},
    end: () => {},
    delivery: () => {},
    close: () => {},
};

const NOOP_RECORDER: TelemetrySpanRecorder = {
    spans: [],
    span: () => NOOP_SPAN,
};

/** A detached span collector (the coalesced emit round fills it). */
export function spanRecorder(): TelemetrySpanRecorder {
    if (!runtime) return NOOP_RECORDER;
    const spans: TelemetrySpan[] = [];
    return { spans, span: (name) => beginSpan(spans, now(), name) };
}

/**
 * Opens one trace. Every finished line carries the trace id and its own
 * timestamp; the fields given here (route, module, channel, …) travel on the
 * main line and on the delivery/close lines of the same trace.
 */
export function trace(
    type: TelemetryEventType,
    fields: TelemetryEventFields = {},
    startedAt: number = now(),
): TelemetryTrace {
    const rt = runtime;
    if (!rt) return NOOP_TRACE;

    const id = nextTraceId();
    const current: TelemetryEventFields = { ...fields };
    const spans: TelemetrySpan[] = [];
    let ended = false;
    let deliveries = 0;

    const build = (
        lineType: TelemetryEventType,
        extra: TelemetryEventFields & { deliveries?: number | undefined },
    ): TelemetryEvent => {
        const event: TelemetryEvent = { trace: id, ts: isoNow(), type: lineType };
        assignDefined(event, current);
        assignDefined(event, extra);
        return event;
    };

    return {
        id,
        enabled: true,
        spans,
        span: (name) => beginSpan(spans, startedAt, name),
        addSpans(extra) {
            for (const span of extra) spans.push(span);
        },
        setFields(extra) {
            assignDefined(current, extra);
        },
        end(extra = {}) {
            if (ended) return;
            ended = true;
            const event = build(type, extra);
            if (event.status === undefined) event.status = "ok";
            if (event.duration === undefined) event.duration = roundMs(now() - startedAt);
            if (spans.length > 0) event.spans = [...spans];
            void enqueue(rt, event);
        },
        delivery(bytes) {
            deliveries += 1;
            void enqueue(rt, build("delivery", { deliveries, ...(bytes === undefined ? {} : { bytes }) }));
        },
        close(extra = {}) {
            const event = build("close", extra);
            event.deliveries = deliveries;
            if (event.status === undefined) event.status = "ok";
            if (event.duration === undefined) event.duration = roundMs(now() - startedAt);
            void enqueue(rt, event);
        },
    };
}

/**
 * The size of a response body, when it has one that can be measured without
 * disturbing it: declared `content-length` wins; a stream (chunked transfer or
 * an event stream) has no body size — the delivery lines of a long connection
 * account for its frames instead.
 */
export async function responseBytes(response: Response): Promise<number | undefined> {
    if (!response.body) return undefined;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.startsWith("text/event-stream")) return undefined;
    if ((response.headers.get("transfer-encoding") ?? "").includes("chunked")) return undefined;

    const declared = response.headers.get("content-length");
    if (declared !== null) {
        const parsed = Number(declared);
        if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
    try {
        return byteLength(await response.clone().text());
    } catch {
        return undefined;
    }
}