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
 * `freshness` is aggregated per page (the refinements — idle timeout and
 * per-channel granularity — belong to a later slice): every connection closed
 * → `"stale"`; a failed loader re-execution → `"error"`; otherwise `"live"`.
 * A page with no channels stays `"live"` for its whole life, and a static
 * build never opens a connection at all, so its freshness is constant `"live"`
 * too.
 */
import { signal, type Signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { loaderEntry } from "./loader-store.js";

declare const __VELO_STATIC__: boolean;

/** Freshness of the page's live data, as data for CSS to react to. */
export type Freshness = "live" | "stale" | "error";

/** SSE event name of a value that replaces the module's data. */
const SNAPSHOT_EVENT = "snapshot";
/** SSE event name of a slice to be merged into the module's current value. */
const SLICE_EVENT = "slice";

interface ConnectionState {
    /** `"open"` while the connection is usable; `"closed"` after a server close. */
    state: "open" | "reconnecting" | "closed";
    /** True when the last loader re-execution failed (server-reported). */
    failed: boolean;
}

const connections = new Set<ConnectionState>();
const freshness = signal<Freshness>("live");

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

function recompute(): void {
    let failed = false;
    let open = false;
    for (const conn of connections) {
        if (conn.failed) failed = true;
        if (conn.state === "open") open = true;
    }
    if (failed) {
        freshness.value = "error";
    } else if (connections.size > 0 && !open) {
        freshness.value = "stale";
    } else {
        freshness.value = "live";
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

    const record: ConnectionState = { state: "open", failed: false };
    connections.add(record);
    recompute();

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

/** Test-only. Drops every connection and resets the aggregate freshness. */
export function __resetLiveLoader(): void {
    connections.clear();
    pendingSlices.clear();
    flushScheduled = false;
    freshness.value = "live";
}
