/**
 * Live loader — client runtime (slice 1).
 *
 * After hydration, every rendered module that declares `channels` opens one SSE
 * connection per (module, channel) at `/_channel/{moduleId}/{channel}`. The
 * snapshot the connection receives — the connect snapshot and each emit's —
 * replaces the value of the module's entry in the loader store, so the page
 * stays faithful to server state without a line of code from the developer:
 * `useLoader()`/`Loader()` handles keep the same signal instance and the
 * reading component re-renders on its own.
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
 * loader-store entry with every snapshot it receives. Returns the closer — the
 * channel lives exactly as long as the module that declares it is mounted.
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

    const es = new EventSource(
        `/_channel/${encodeURI(moduleId)}/${encodeURIComponent(channel)}`,
    );

    es.addEventListener("snapshot", (e) => {
        try {
            loaderEntry(moduleId).value = JSON.parse((e as MessageEvent).data);
            record.state = "open";
            record.failed = false;
            recompute();
        } catch {
            // Malformed payload: keep the previous value (a failed push must
            // never blank the screen).
        }
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
    freshness.value = "live";
}
