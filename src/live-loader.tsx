/**
 * Live loader — client runtime.
 *
 * After hydration, every rendered module that declares `channels` opens one SSE
 * connection per (module, channel) at `/_channel/{moduleId}/{channel}`. The
 * snapshot the connection receives — the connect snapshot and each emit's —
 * replaces the value of the module's entry in the loader store, so the page
 * stays faithful to server state without a line of code from the developer:
 * `useLoader()`/`Loader()` handles keep the same signal instance and the
 * reading component re-renders on its own.
 *
 * A `slice` event is the other delivery mode: the producer already holds the
 * value, so the payload carries only the changed keys. A slice is merged
 * shallowly by key onto the module's current value — the key sent is replaced
 * by the whole value sent, keys not sent stay intact, and an absent key never
 * means "removed" (removal is re-sending the key with the new whole value).
 * The merge happens on arrival, never at render: slices that land in the same
 * frame are accumulated and applied together before the next render, so none is
 * lost, and for the same key the last one in arrival order wins. A malformed
 * payload keeps the previous value, exactly like a malformed snapshot.
 *
 * A channel declared by a layout AND by a page produces one connection per
 * module (each feeding its own module's signal); a single `emit` by channel
 * name reaches both, because the server groups connections by channel and
 * partition, not by module.
 *
 * `freshness` is aggregated per page: every connection closed → `"stale"`; a
 * failed loader re-execution → `"error"`; otherwise `"live"`. A page with no
 * channels stays `"live"` for its whole life, and a static build never opens a
 * connection at all, so its freshness is constant `"live"` too.
 *
 * The per-channel refinement: `freshnessByChannel` is a signal record keyed by
 * the channel names the module declares, so a page with two channels — one
 * fallen, one following — shows both states at once. The aggregate folds it by
 * the same rule: a silenced or closed channel counts as not-open.
 *
 * The silence detector is the client half of the idle timeout: a connection
 * open but without deliveries for `CHANNEL_SILENCE_MS` (60s — a constant, not
 * a configuration) is marked `"stale"` even though `EventSource` still reads
 * `OPEN` — the tab in the background, the sleeping notebook, the proxy that
 * stopped flushing without closing. Any delivery (or a reconnect's snapshot)
 * brings the channel back to `"live"`. The server's heartbeat comment never
 * generates a client event, so it cannot mask the silence.
 */
import { signal, type Signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { loaderEntry } from "./loader-store.js";

declare const __VELO_STATIC__: boolean;

/** Freshness of the page's live data, as data for CSS to react to. */
export type Freshness = "live" | "stale" | "error";

/**
 * How long an open connection may stay without a delivery (snapshot or slice)
 * before the client calls it stale — the detector of the connection that a
 * proxy silenced without closing. A runtime constant, documented, not a
 * configuration: a channel goes stale on the wire's silence, not on the
 * heartbeat (a comment generates no client event).
 */
export const CHANNEL_SILENCE_MS = 60000;

/** SSE event name of a value that replaces the module's data. */
const SNAPSHOT_EVENT = "snapshot";
/** SSE event name of a slice to be merged into the module's current value. */
const SLICE_EVENT = "slice";

interface ConnectionState {
    /** `"open"` while the connection is usable; `"closed"` after a server close. */
    state: "open" | "reconnecting" | "closed";
    /** True when the last loader re-execution failed (server-reported). */
    failed: boolean;
    /**
     * True when the connection is open but silent past `CHANNEL_SILENCE_MS`:
     * stale on the wire's silence, even with `EventSource` in `OPEN`. Any
     * delivery (or a reconnect's snapshot) clears it.
     */
    silent: boolean;
    /** The module that declared the channel — the per-module freshness key. */
    moduleId: string;
    channel: string;
}

const connections = new Set<ConnectionState>();
const freshness = signal<Freshness>("live");

/**
 * Per-module channel freshness: moduleId → signal of
 * `{ channel → Freshness }`, the record `freshnessByChannel` exposes. The
 * signal is created when a handle asks for it (before any connection) and
 * filled by `recompute` as the module's connections open, deliver and close.
 */
const moduleFreshness = new Map<string, Signal<Record<string, Freshness>>>();

/**
 * The per-channel freshness signal of one module — what
 * `useLoader()`/`Loader()` return as `freshnessByChannel`. Created empty: the
 * keys appear as the module's connections open, the values follow them.
 */
export function moduleChannelFreshness(
    moduleId: string,
): Signal<Record<string, Freshness>> {
    let sig = moduleFreshness.get(moduleId);
    if (!sig) {
        sig = signal<Record<string, Freshness>>({});
        moduleFreshness.set(moduleId, sig);
    }
    return sig;
}

/** The page-level freshness signal shared by every loader handle. */
export function loaderFreshness(): Signal<Freshness> {
    return freshness;
}

/**
 * Slices waiting to be applied, per module — the accumulator of the arrival
 * merge. Slices that land in the same frame are flushed together on a
 * microtask, before the next render, so none is lost between renders.
 */
const pendingSlices = new Map<string, Record<string, unknown>[]>();
let flushScheduled = false;

function queueSlice(moduleId: string, slice: Record<string, unknown>): void {
    let list = pendingSlices.get(moduleId);
    if (!list) {
        list = [];
        pendingSlices.set(moduleId, list);
    }
    list.push(slice);

    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(applyPendingSlices);
}

/**
 * Applies every accumulated slice, in arrival order, onto each module's current
 * value. Merging onto the value read at flush time (not at arrival time) keeps
 * the result the same as a synchronous apply, and the last slice of a key wins.
 */
function applyPendingSlices(): void {
    flushScheduled = false;
    if (pendingSlices.size === 0) return;

    const batches = [...pendingSlices];
    pendingSlices.clear();

    for (const [moduleId, slices] of batches) {
        const entry = loaderEntry<Record<string, unknown>>(moduleId);
        let value: unknown = entry.value;
        for (const slice of slices) {
            const base =
                value !== null && typeof value === "object" && !Array.isArray(value)
                    ? (value as Record<string, unknown>)
                    : {};
            value = { ...base, ...slice };
        }
        entry.value = value as Record<string, unknown>;
    }
}

/** A slice is malformed unless it is a plain object — never a list, never a scalar. */
function parseSlice(data: unknown): Record<string, unknown> | null {
    if (typeof data !== "string" || data.length === 0) return null;
    try {
        const parsed = JSON.parse(data);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
        }
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

function channelFreshness(conns: ConnectionState[]): Freshness {
    if (conns.some((c) => c.failed)) return "error";
    if (conns.some((c) => c.state === "open" && !c.silent)) return "live";
    return "stale";
}

function recompute(): void {
    // The aggregate folds every connection of the page: a failed re-execution
    // errors it; silence counts as not-open (the same rule as a closed or
    // reconnecting connection); anything open and delivering keeps it live.
    let failed = false;
    let open = false;
    for (const conn of connections) {
        if (conn.failed) failed = true;
        if (conn.state === "open" && !conn.silent) open = true;
    }
    if (failed) {
        freshness.value = "error";
    } else if (connections.size > 0 && !open) {
        freshness.value = "stale";
    } else {
        freshness.value = "live";
    }

    // The per-module record: the channels the module's connections hold.
    for (const [moduleId, sig] of moduleFreshness) {
        const byChannel = new Map<string, ConnectionState[]>();
        for (const conn of connections) {
            if (conn.moduleId !== moduleId) continue;
            const list = byChannel.get(conn.channel);
            if (list) list.push(conn);
            else byChannel.set(conn.channel, [conn]);
        }
        const record: Record<string, Freshness> = {};
        for (const [channel, conns] of byChannel) {
            record[channel] = channelFreshness(conns);
        }
        sig.value = record;
    }
}

/**
 * Opens the SSE connection of one (module, channel) pair and feeds the module's
 * loader-store entry with every snapshot and slice it receives. Returns the
 * closer — the channel lives exactly as long as the module that declares it is
 * mounted.
 *
 * Inert (no connection, no freshness change) in a static build: there is no
 * server to speak SSE.
 */
export function connectChannel(moduleId: string, channel: string): () => void {
    if (typeof __VELO_STATIC__ !== "undefined" && __VELO_STATIC__) return () => {};
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
        return () => {};
    }

    const record: ConnectionState = {
        state: "open",
        failed: false,
        silent: false,
        moduleId,
        channel,
    };
    connections.add(record);
    recompute();

    // The silence clock: armed on connect (the connect snapshot is the first
    // delivery) and restarted by every delivery that follows. A heartbeat
    // comment never fires a client event, so it can neither restart it nor
    // mask the silence.
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    const armSilence = (): void => {
        if (silenceTimer !== null) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
            silenceTimer = null;
            record.silent = true;
            recompute();
        }, CHANNEL_SILENCE_MS);
    };
    armSilence();

    // Slices are accumulated per module and flushed together, so a second
    // slice that lands while an earlier one is pending joins the same flush,
    // in arrival order.
    const es = new EventSource(
        `/_channel/${encodeURI(moduleId)}/${encodeURIComponent(channel)}`,
    );

    es.addEventListener(SNAPSHOT_EVENT, (e) => {
        try {
            // A snapshot stands for the whole value: anything still pending for
            // this module would be clobbered by it, so it is applied first.
            applyPendingSlices();
            loaderEntry(moduleId).value = JSON.parse((e as MessageEvent).data);
            record.state = "open";
            record.failed = false;
            record.silent = false;
            armSilence();
            recompute();
        } catch {
            // Malformed payload: keep the previous value (a failed push must
            // never blank the screen).
        }
    });

    es.addEventListener(SLICE_EVENT, (e) => {
        const slice = parseSlice((e as MessageEvent).data);
        if (!slice) return; // malformed: keep the previous value
        record.state = "open";
        record.failed = false;
        record.silent = false;
        armSilence();
        recompute();
        queueSlice(moduleId, slice);
    });

    es.addEventListener("error", (e) => {
        const data = (e as MessageEvent).data;
        if (typeof data === "string" && data.length > 0) {
            // Server-reported loader failure (an `error` SSE event). A native
            // connection error carries no data and only marks the connection
            // as reconnecting — stale, not errored.
            record.failed = true;
        } else {
            record.state =
                es.readyState === EventSource.CLOSED ? "closed" : "reconnecting";
        }
        recompute();
    });

    es.addEventListener("close", () => {
        record.state = "closed";
        recompute();
    });

    return () => {
        connections.delete(record);
        if (silenceTimer !== null) clearTimeout(silenceTimer);
        try {
            es.close();
        } catch {
            // already closed
        }
        recompute();
    };
}

/**
 * Mounts the live channels of one route module. It renders its children
 * unchanged (no DOM node, so SSR output and hydration are untouched) and only
 * exists to tie the connection lifecycle to the module's own mount/unmount —
 * SPA navigation and page close close the connections.
 */
export function ChannelBoundary({
    moduleId,
    channels,
    children,
}: {
    moduleId?: string | undefined;
    channels?: readonly string[] | undefined;
    children?: ComponentChildren;
}): ComponentChildren {
    // Arrays are recreated on every render; the joined names are the real
    // dependency of the effect.
    const key = channels && channels.length > 0 ? channels.join(",") : "";

    useEffect(() => {
        if (!moduleId || key === "") return;
        const closers = key.split(",").map((channel) => connectChannel(moduleId, channel));
        return () => {
            for (const close of closers) close();
        };
    }, [moduleId, key]);

    return children;
}

/** Test-only. Drops every connection and resets every freshness signal. */
export function __resetLiveLoader(): void {
    connections.clear();
    pendingSlices.clear();
    flushScheduled = false;
    freshness.value = "live";
    for (const sig of moduleFreshness.values()) sig.value = {};
}
