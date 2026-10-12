/**
 * Live loader — server-side runtime (slice 1).
 *
 * A route module opts into state synchronization with a sibling `channels`
 * export (an array of channel names). The framework derives one internal SSE
 * route per declared channel — `GET /_channel/{moduleId}/{channel}`, the same
 * family as `/_action` and `/_event` — which inherits the middlewares of the
 * module's route node and serves the module's loader as a stream of snapshots.
 *
 * The tab-facing twin is the live action: a module declares
 * `liveActions = { actionName: [channel, …] }` and the framework derives
 * `GET /_live/{moduleId}/{actionName}` — a subscription whose args travel in
 * `?_args=` and whose source is the action itself (a parameterized read,
 * re-executed with those args). The subscription enters the SAME groups by
 * (channel, partition): one `emit` by name wakes the loader connections and
 * the live subscriptions of the partition, each re-executing its own source.
 *
 * The app owns the partition policy in `app/channels.ts`, a name → resolver map:
 *
 * ```ts
 * export const channels = {
 *     teamExpenses: { scope: ({ user }) => `team:${user?.teamId}` },
 * };
 * ```
 *
 * On subscribe the resolver receives `{ user, params }` (a loader connection)
 * or `{ user, args }` (a live action subscription): `user` is the
 * materialized principal (`c.get("user")`, the house key — `undefined` when the
 * app does not materialize one, so a public channel ignores it and an
 * authenticated one returns `null`, which denies the subscription with 403) and
 * `params` are the route params the client declared and the runtime validated
 * against the module's path (empty for a route without `:params`). The
 * partition NEVER derives from the query string or from any other client input;
 * `params` are not input — they are the address the client is already seeing,
 * validated by shape and then by the scope (ownership/permission).
 *
 * `emit(channel, ctx)` resolves the same partition key on the producer side —
 * the producer builds the same `{ user, params }` shape with the fields its
 * scope consumes — finds the group of connections in that partition and
 * re-executes the loader for each connection, with that connection's own
 * principal and route params, pushing a fresh snapshot down the wire. Emitting
 * to a channel with no subscribers is a no-op; emitting to a channel with no
 * entry in the app map throws immediately.
 *
 * `emit(module, channel, ctx, slice)` is the second mode, addressed to the
 * (module, channel) pair: the producer already holds the value, so it travels
 * as a slice — the connections of that pair in the emitting partition merge it
 * shallowly by key, and no loader runs. The slice is typed as a `Partial` of
 * the module's loader return, which is why the module is part of the address:
 * one channel can be declared by modules with different `Data` (a layout and a
 * page), and a slice is the shape of exactly one of them.
 *
 * A channel's group (channel + partition) has a lifecycle: the first connection
 * arms it (`onGroupOpen({ partition, params })`) and the last one disarms it
 * (`onGroupClose({ partition })`), both awaited — that is where a watcher with a
 * cost of life is armed and disarmed, instead of running forever for an empty
 * group.
 *
 * Every emit logs one line (channel, partition, kind, connections at the
 * moment of the gesture, timestamp) unless `logEmits: false` is registered,
 * and invalidations are folded by a coalescing window per (channel, partition)
 * (`coalesceMs`, default 50, `0` disables). Before delivering anything the
 * runtime re-derives each connection's partition with the ctx captured on
 * subscribe: a connection that moved (or whose scope now returns null) is
 * dropped and closed instead of receiving data of a group it left.
 */

import type { Context, Hono, MiddlewareHandler } from "hono";
import { DEFAULT_HEARTBEAT_MS } from "./events.js";
import type { ActionArgs, LoaderArgs, RouteModule } from "./types.js";
import {
    byteLength,
    spanRecorder,
    trace,
    type TelemetrySpanRecorder,
    type TelemetryStatus,
    type TelemetryTrace,
} from "./telemetry.js";

// ============================================
// TYPES
// ============================================

/** Result of a partition resolver. `null`/`undefined` denies the subscription. */
export type ChannelScopeResult = string | null | undefined;

/**
 * The ctx of a partition resolver — the same shape on both sides.
 *
 * On **subscribe** the runtime builds it: `user` is the materialized principal
 * (`c.get("user")`, the house key — `undefined` when the app does not
 * materialize one) and `params` are the route params the client declared and
 * the runtime validated against the module's path (URL strings; empty for a
 * route without `:params`).
 *
 * On **emit** the producer builds the same object with the fields its scope
 * consumes — `{ params: { id: 7 } }` for a resource channel, `{ user: … }`
 * for a principal one — and the same `scope` runs against it.
 */
export interface ChannelScopeContext {
    user?: any;
    params?: Record<string, any>;
    /**
     * The declared arguments of a **live action** subscription (`kind: "live"`).
     * The tab-facing twin of `params`: the address the subscription itself
     * declared, not something the route declares.
     */
    args?: Record<string, any> | undefined;
}

/**
 * What `onGroupOpen` receives: the partition key of the group that just got its
 * first connection, and the validated route params of **that** connection.
 *
 * The params are identical across the group only when the partition derives
 * from them (a watcher per resource — the case the hook exists for). A channel
 * partitioned by principal, declared in a module with `:params`, mixes
 * resources in the same group and the hook's params are the first connection's
 * — arbitrary for the rest; such a channel must not consume them here.
 *
 * `args` is the live-action half of the same address: when the connection that
 * opened the group is a live action subscription, they are the args that
 * subscription declared (with the same arbitrariness caveat when the partition
 * does not derive from them).
 */
export interface ChannelGroupOpenContext {
    partition: string;
    params: Record<string, string>;
    /** The declared args of the connection that opened the group (live actions). */
    args?: Record<string, unknown> | undefined;
}

/**
 * What `onGroupClose` receives: the partition key of the group being torn
 * down and, when the group was opened by a live action subscription, the args
 * of that connection — the same fields `onGroupOpen` saw.
 */
export interface ChannelGroupCloseContext {
    partition: string;
    /** The declared args of the connection that opened the group (live actions). */
    args?: Record<string, unknown> | undefined;
}

/**
 * One entry of the app's channel map (`app/channels.ts`).
 *
 * `scope` receives `{ user, params }` on subscribe and the emitter's object on
 * emit; returning `null` denies with 403. Omitted → the channel is public
 * (`() => "all"`).
 *
 * `onGroupOpen`/`onGroupClose` are the group lifecycle — armed by the first
 * connection of a (channel, partition) group, disarmed by the last one — and
 * may be async: the runtime awaits them (the group is only marked open after
 * `onGroupOpen` resolves; only discarded after `onGroupClose` resolves). A hook
 * that throws or rejects is logged loudly and the group continues.
 */
export interface ChannelDefinition {
    scope?: (ctx: ChannelScopeContext) => ChannelScopeResult | Promise<ChannelScopeResult>;
    onGroupOpen?: (ctx: ChannelGroupOpenContext) => void | Promise<void>;
    onGroupClose?: (ctx: ChannelGroupCloseContext) => void | Promise<void>;
}

/** The `app/channels.ts` map: channel name → partition resolver. */
export type ChannelMap = Record<string, ChannelDefinition>;

/** SSE event carrying the loader's current value — it replaces the module's data. */
export const SNAPSHOT_EVENT = "snapshot";
/** SSE event carrying a slice — the client merges it into the module's current value. */
export const SLICE_EVENT = "slice";
/** SSE event signaling that the loader re-execution failed on the server. */
export const CHANNEL_ERROR_EVENT = "error";
/** SSE event signaling a deliberate server-side close. */
export const CHANNEL_CLOSE_EVENT = "close";

/** Default coalescing window, in milliseconds. */
export const DEFAULT_COALESCE_MS = 50;

/**
 * Default idle timeout of a channel connection, in milliseconds: a connection
 * with no deliveries (snapshot or slice) for this long is closed by the
 * server. The heartbeat does NOT reset it — idle is about data delivery,
 * heartbeat is transport. The close makes a live page cycle
 * (close → EventSource reconnect → snapshot on connect), which repairs the
 * state, and frees an abandoned page's resources for good.
 */
export const DEFAULT_IDLE_MS = 300000;

/** The two modes of `emit`, as they appear in the emit log. */
export type ChannelEmitKind = "invalidate" | "slice";

/**
 * `registerChannels` options.
 *
 * `coalesceMs` is the coalescing window of the invalidation mode, per
 * (channel, partition): every emit inside an open window becomes one
 * re-execution round, fired when the window closes. `0` disables it (immediate
 * — the slice-1 behavior). The default is `DEFAULT_COALESCE_MS` in any
 * registration without options; `createTestApp` registers with `0` for
 * determinism.
 *
 * `logEmits` writes one line per emit gesture (never per consolidated
 * delivery). Default: on.
 *
 * `idleMs` closes a connection that had no deliveries (snapshot or slice) for
 * that long — a silent connection is closed even though its heartbeat keeps
 * flowing; heartbeats never reset the idle clock. Default: `DEFAULT_IDLE_MS`
 * (5 min) in any registration without options; `0` disables it.
 * `createTestApp` registers with `0` for determinism.
 *
 * `heartbeatMs` writes an SSE comment (`: ping`) through the write chain every
 * interval, keeping proxies and the browser from buffering or closing an idle
 * stream. A comment generates no client event and never counts as a delivery
 * (no effect on freshness or idle). Default: `DEFAULT_HEARTBEAT_MS` (20s) in
 * any registration without options; `0` disables it.
 */
export interface ChannelRegistryOptions {
    coalesceMs?: number;
    logEmits?: boolean;
    idleMs?: number;
    heartbeatMs?: number;
}

/**
 * What `emit(module, channel, ctx, slice)` accepts: the imported route module
 * (the same object the route tree uses — the Vite plugin has injected its
 * `metadata`, and its `loader` types the slice).
 */
export interface ChannelEmitModule {
    metadata?: { moduleId?: string } | undefined;
    channels?: readonly string[] | undefined;
    loader?: ((args: LoaderArgs) => unknown) | undefined;
}

/**
 * The slice type of a module: a `Partial` of whatever its loader returns.
 * `Partial` (plus `exactOptionalPropertyTypes` on the app's tsconfig) is what
 * makes a wrong key or a wrong value type a compile error instead of a silent
 * no-op at runtime.
 */
export type ChannelSlice<M> = M extends { loader?: (...args: any[]) => infer R }
    ? Partial<Awaited<R>>
    : never;

// ============================================
// REGISTRY
// ============================================

/**
 * The app's channel map. Process-wide (like the event stream registry): the
 * framework reads it from free functions (`emit`) and from route handlers, not
 * from a per-app binding. The production entry registers `app/channels.ts`;
 * `createTestApp({ channels })` registers the test's map.
 */
let channelMap: ChannelMap = {};

/** Coalescing window in force (`0` = immediate). */
let coalesceMs = DEFAULT_COALESCE_MS;

/** Idle timeout in force (`0` = disabled). */
let idleMs = DEFAULT_IDLE_MS;

/** Heartbeat interval in force (`0` = disabled). */
let heartbeatMs = DEFAULT_HEARTBEAT_MS;

/** Whether every emit writes its log line. */
let logEmits = true;

/**
 * Registers (replaces) the app's channel map and its options. Idempotent.
 *
 * Called without options, the coalescing window is `DEFAULT_COALESCE_MS` — the
 * window matters wherever emits burst (a job writing N rows), not only in
 * production.
 */
export function registerChannels(
    map: ChannelMap | undefined,
    options?: ChannelRegistryOptions,
): void {
    channelMap = map ? { ...map } : {};
    coalesceMs = options?.coalesceMs ?? DEFAULT_COALESCE_MS;
    idleMs = options?.idleMs ?? DEFAULT_IDLE_MS;
    heartbeatMs = options?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    logEmits = options?.logEmits ?? true;
    // A re-registration invalidates the windows still open and the group opens
    // still in flight (they belong to the map being replaced).
    cancelPendingWindows();
    groupOpens.clear();
    groupOpenAddress.clear();
}

/** The currently registered channel map (read-only use). */
export function getChannelMap(): ChannelMap {
    return channelMap;
}

/** Channel names declared in the app map, in declaration order. */
export function channelNames(): string[] {
    return Object.keys(channelMap);
}

// ============================================
// CONNECTIONS — groups by channel and partition
// ============================================

/** One live channel connection (an SSE subscription). */
export interface ChannelConnection {
    channel: string;
    /** Partition key resolved at subscribe time — never from client input. */
    partition: string;
    moduleId: string;
    /**
     * Which surface the connection feeds: `"loader"` (the page's live-loader
     * connection — the default) or `"live"` (a live action subscription, the
     * tab-facing twin).
     */
    kind?: "loader" | "live";
    /**
     * The principal materialized at subscribe (`c.get("user")`), captured for
     * the partition revalidation of every emit — the scope re-runs against it.
     */
    principal: unknown;
    /** The module's loader — the data source of a `"loader"` connection. */
    loader?: (args: LoaderArgs) => Promise<unknown>;
    /** The live action — the data source of a `"live"` connection. */
    action?: (args: ActionArgs<any>) => Promise<unknown>;
    /** The action name without the `action_` prefix (`"live"` connections). */
    actionName?: string | undefined;
    /** The subscription's declared args (`"live"` connections) — the tab's address. */
    args?: Record<string, unknown> | undefined;
    /**
     * Identifies one live action subscription across the N group entries it
     * holds (one per declared channel) — the inspector's key.
     */
    liveId?: string | undefined;
    /** The subscribing request's context — the loader/action re-runs against it. */
    c: Context;
    params: Record<string, string>;
    query: Record<string, string>;
    /** Writes one SSE event on this connection. Resolves when it hits the wire. */
    send: (event: string, data: string) => Promise<void>;
    /**
     * Ends this connection: a `close` event on the wire, then the group entry
     * and the stream. Used when the connection's partition no longer holds —
     * or when its idle timeout elapsed.
     */
    terminate: (reason?: string) => Promise<void>;
    /**
     * Epoch ms of this connection's last delivery (snapshot or slice) — the
     * clock the idle timeout runs on and what the inspector reports. Heartbeat
     * comments never touch it.
     */
    lastDeliveryAt?: number | undefined;
    /**
     * The connection's telemetry trace: `channel-connect` with the snapshot
     * span, then one `delivery` line per snapshot/slice and the final `close`
     * line. Absent (no-op) when collection is off.
     */
    telemetry?: TelemetryTrace | undefined;
}

/** channel → partition key → live connections. Empty groups do not exist. */
const groups = new Map<string, Map<string, Set<ChannelConnection>>>();

/**
 * In-flight `onGroupOpen` promises, per (channel, partition). Kept so a
 * `onGroupClose` that lands while the open hook is still running waits for it —
 * the pair is always ordered open → close — and so the group is only marked
 * open once the hook resolves.
 */
const groupOpens = new Map<string, Promise<void>>();

/** One open coalescing window: `(channel, partition)` → its timer. */
interface CoalesceWindow {
    timer: ReturnType<typeof setTimeout>;
    channel: string;
    partition: string;
    /**
     * The gestures that opened or joined the window: each one gets its own
     * `emit` trace at round completion, carrying the round's re-execution spans.
     */
    gestures: TelemetryTrace[];
}

const windows = new Map<string, CoalesceWindow>();

/**
 * Closes the open window of a (channel, partition): one re-execution round is
 * the effect of every emit that fell inside it — no invalidation is lost.
 */
function openWindow(channel: string, partition: string, gesture: TelemetryTrace | null): void {
    const key = groupKey(channel, partition);
    // The first emit opens the window; the later ones join it without moving
    // the deadline (a sliding window would postpone the round indefinitely on
    // a hot producer).
    const existing = windows.get(key);
    if (existing) {
        if (gesture) existing.gestures.push(gesture);
        return;
    }

    const window: CoalesceWindow = {
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
        channel,
        partition,
        gestures: gesture ? [gesture] : [],
    };
    const timer = setTimeout(() => {
        windows.delete(key);
        void runCoalescedRound(window);
    }, coalesceMs);

    // A pending window must never hold the process open.
    const unref = (timer as { unref?: () => void }).unref;
    if (typeof unref === "function") unref.call(timer);

    window.timer = timer;
    windows.set(key, window);
}

/**
 * Runs the round an expired window accumulated and closes every gesture's
 * trace with the round's spans and reach.
 */
async function runCoalescedRound(window: CoalesceWindow): Promise<void> {
    const recorder = spanRecorder();
    const reached = await runInvalidationRound(window.channel, window.partition, recorder);
    for (const gesture of window.gestures) {
        gesture.addSpans(recorder.spans);
        gesture.end({ status: "ok", connections: reached });
    }
}

function cancelPendingWindows(): void {
    for (const window of windows.values()) clearTimeout(window.timer);
    windows.clear();
}

// ============================================
// INSPECTOR — the live state, for the incident
// ============================================

/** One live group of a channel: the connections of one module in one partition. */
export interface ChannelInspectGroup {
    /** The route module holding these connections (`metadata.moduleId`). */
    moduleId: string;
    /** The partition key resolved at subscribe time. */
    partition: string;
    /** Live connections in this (module, partition) pair. */
    connections: number;
    /** ISO timestamp of the last delivery; `null` when none was delivered yet. */
    lastDeliveryAt: string | null;
}

/** One live channel: its groups and its total. */
export interface ChannelInspectChannel {
    channel: string;
    /** Groups identified by (moduleId, partition) — which page holds what. */
    groups: ChannelInspectGroup[];
    connections: number;
}

/** One open coalescing window: the invalidations not yet delivered. */
export interface ChannelInspectWindow {
    channel: string;
    partition: string;
}

/** One live action subscription, as the inspector reports it. */
export interface ChannelInspectLiveAction {
    /** The route module holding the action (`metadata.moduleId`). */
    moduleId: string;
    /** The action name, without the `action_` prefix. */
    action: string;
    /** Every (channel, partition) group the subscription entered. */
    channels: { channel: string; partition: string }[];
    /** The args the subscription declared — its address. */
    args: Record<string, unknown> | null;
    /** ISO timestamp of the subscription's last delivery; `null` when none yet. */
    lastDeliveryAt: string | null;
}

/** The full live state of the channel registry, as `inspectChannels()` sees it. */
export interface ChannelInspectReport {
    channels: ChannelInspectChannel[];
    /** Open coalescing windows, per (channel, partition). */
    openCoalesceWindows: ChannelInspectWindow[];
    /** The live action subscriptions, per (moduleId, action, args). */
    liveActions: ChannelInspectLiveAction[];
    totalConnections: number;
}

/**
 * Server-side snapshot of the live channels: per channel, the groups
 * identified by (moduleId, partition key), each with its connection count and
 * the timestamp of its last delivery; the coalescing windows still open; the
 * live action subscriptions (module, action, args and the groups they hold);
 * and the grand totals — where each live subscription counts once, however
 * many channel groups it entered. Always available — the app decides how (and
 * with what guard) to expose it; the dev server exposes it as
 * `GET /_channel-inspect`.
 */
export function inspectChannels(): ChannelInspectReport {
    const channels: ChannelInspectChannel[] = [];
    let totalConnections = 0;
    const liveSeen = new Map<string, ChannelInspectLiveAction>();

    for (const [channel, byPartition] of groups) {
        const reportGroups: ChannelInspectGroup[] = [];
        // Connections of a (channel, partition) group can belong to several
        // modules (a layout and a page sharing the channel name): the group
        // report is per (moduleId, partition) pair — the "per page" dimension.
        for (const [partition, set] of byPartition) {
            const byModule = new Map<string, { count: number; last: number | undefined }>();
            for (const conn of set) {
                const entry = byModule.get(conn.moduleId) ?? { count: 0, last: undefined };
                entry.count += 1;
                if (conn.lastDeliveryAt !== undefined &&
                    (entry.last === undefined || conn.lastDeliveryAt > entry.last)) {
                    entry.last = conn.lastDeliveryAt;
                }
                byModule.set(conn.moduleId, entry);

                // The live-action half of the report: one entry per
                // subscription (its N group entries fold under its liveId).
                if (conn.kind === "live" && conn.liveId) {
                    let live = liveSeen.get(conn.liveId);
                    if (!live) {
                        live = {
                            moduleId: conn.moduleId,
                            action: conn.actionName ?? "(anonymous)",
                            channels: [],
                            args: conn.args ? { ...conn.args } : null,
                            lastDeliveryAt: null,
                        };
                        liveSeen.set(conn.liveId, live);
                    }
                    live.channels.push({ channel, partition });
                    if (conn.lastDeliveryAt !== undefined) {
                        const iso = new Date(conn.lastDeliveryAt).toISOString();
                        if (live.lastDeliveryAt === null || iso > live.lastDeliveryAt) {
                            live.lastDeliveryAt = iso;
                        }
                    }
                } else if (conn.kind !== "live") {
                    totalConnections += 1;
                }
            }
            for (const [moduleId, entry] of byModule) {
                reportGroups.push({
                    moduleId,
                    partition,
                    connections: entry.count,
                    lastDeliveryAt: entry.last === undefined ? null : new Date(entry.last).toISOString(),
                });
            }
        }
        channels.push({
            channel,
            groups: reportGroups,
            connections: byPartitionSize(byPartition),
        });
    }

    // Each live subscription is one connection (one SSE stream), however many
    // groups its declared channels put it in.
    totalConnections += liveSeen.size;

    const openCoalesceWindows: ChannelInspectWindow[] = [];
    for (const window of windows.values()) {
        openCoalesceWindows.push({ channel: window.channel, partition: window.partition });
    }

    return {
        channels,
        openCoalesceWindows,
        liveActions: [...liveSeen.values()],
        totalConnections,
    };
}

function byPartitionSize(byPartition: Map<string, Set<ChannelConnection>>): number {
    let size = 0;
    for (const set of byPartition.values()) size += set.size;
    return size;
}

/** The key of a (channel, partition) pair — the connection group and its coalescing window. */
function groupKey(channel: string, partition: string): string {
    return `${channel}\u0000${partition}`;
}

/**
 * Registers the connection in its group. Returns `true` when it is the first
 * one — the transition that opens the group (and fires `onGroupOpen`).
 */
function addConnection(conn: ChannelConnection): boolean {
    let byPartition = groups.get(conn.channel);
    if (!byPartition) {
        byPartition = new Map();
        groups.set(conn.channel, byPartition);
    }
    let set = byPartition.get(conn.partition);
    if (!set) {
        set = new Set();
        byPartition.set(conn.partition, set);
    }
    const wasEmpty = set.size === 0;
    set.add(conn);
    return wasEmpty;
}

/**
 * Removes the connection from its group. Returns `true` when it was the last
 * one — the transition that empties the group (and fires `onGroupClose`).
 */
function removeConnection(conn: ChannelConnection): boolean {
    const byPartition = groups.get(conn.channel);
    const set = byPartition?.get(conn.partition);
    if (!byPartition || !set) return false;
    set.delete(conn);
    const emptied = set.size === 0;
    if (emptied) byPartition.delete(conn.partition);
    if (byPartition.size === 0) groups.delete(conn.channel);
    return emptied;
}

// ============================================
// GROUP LIFECYCLE
// ============================================

/**
 * The address of the connection that opened a group — what `onGroupOpen`
 * receives (and what `onGroupClose` sees again when the group empties).
 */
interface GroupOpenAddress {
    params: Record<string, string>;
    args?: Record<string, unknown> | undefined;
}

/** groupKey → the address of the connection that opened that group. */
const groupOpenAddress = new Map<string, GroupOpenAddress>();

/**
 * Fires `onGroupOpen` for a group that just received its first connection, and
 * keeps the promise until it resolves: that is what "marked open" means — a
 * second connection entering meanwhile joins the open group and never fires
 * the hook again.
 *
 * A hook that throws (or rejects) is logged loudly, naming channel and
 * partition, and the group continues: the connect snapshot still delivers data
 * from the cold source, the live data simply does not arrive until the hook is
 * fixed — and the log is what says so.
 */
function openGroup(
    channel: string,
    partition: string,
    address: GroupOpenAddress,
): Promise<void> {
    const key = groupKey(channel, partition);
    const hook = channelMap[channel]?.onGroupOpen;

    groupOpenAddress.set(key, address);

    const pending = (async () => {
        if (typeof hook !== "function") return;
        try {
            await hook({ partition, params: address.params, args: address.args });
        } catch (err) {
            console.error(
                `[velojs] channel "${channel}" onGroupOpen failed for partition "${partition}":`,
                err,
            );
        }
    })();

    groupOpens.set(key, pending);
    void pending.then(() => {
        if (groupOpens.get(key) === pending) groupOpens.delete(key);
    });
    return pending;
}

/**
 * Takes the connection out of its group, awaiting the group's `onGroupClose`
 * before the last one is actually discarded (the watcher disarms before the
 * group stops existing). An in-flight `onGroupOpen` is awaited first, so the
 * pair is always ordered; if another connection entered while we waited, this
 * one is not the last anymore and no close fires.
 *
 * The close hook is async, so a connection may enter the group while it runs:
 * that one finds the group occupied (the leaving connection is still in it) and
 * never opens it itself, so the surviving group is **re-armed here**, after the
 * discard — the source must not stay disarmed over a live group.
 */
async function leaveGroup(conn: ChannelConnection): Promise<void> {
    const key = groupKey(conn.channel, conn.partition);
    const opening = groupOpens.get(key);
    if (opening) await opening;

    const set = groups.get(conn.channel)?.get(conn.partition);
    if (!set || !set.has(conn) || set.size > 1) {
        // Not the last one (or already gone): just leave the group.
        removeConnection(conn);
        return;
    }

    const hook = channelMap[conn.channel]?.onGroupClose;
    // The address of the connection that opened the group — `onGroupClose`
    // sees the same fields `onGroupOpen` saw (the args of a live action group
    // included). Dropped once the group is really gone.
    const address = groupOpenAddress.get(key) ?? { params: conn.params };
    if (typeof hook === "function") {
        try {
            await hook({ partition: conn.partition, args: address.args });
        } catch (err) {
            console.error(
                `[velojs] channel "${conn.channel}" onGroupClose failed for partition ` +
                `"${conn.partition}":`,
                err,
            );
        }
    }

    removeConnection(conn);

    // The group may have gained connections while the close hook was running
    // (they joined a group that was still occupied). They are the group now:
    // the source is armed for them, with the address of the first one.
    const survivors = groups.get(conn.channel)?.get(conn.partition);
    const first = survivors ? [...survivors][0] : undefined;
    if (first) {
        await openGroup(conn.channel, conn.partition, {
            params: first.params,
            args: first.args,
        });
    } else {
        groupOpenAddress.delete(key);
    }
}

/** Test-only. Drops every live connection, group and open window. */
export function __resetChannels(): void {
    groups.clear();
    groupOpens.clear();
    groupOpenAddress.clear();
    cancelPendingWindows();
}

// ============================================
// PARTITION
// ============================================

async function resolvePartition(
    def: ChannelDefinition,
    ctx: ChannelScopeContext,
): Promise<ChannelScopeResult> {
    const scope = def.scope;
    // A channel with no resolver is public by construction.
    if (typeof scope !== "function") return "all";
    return await scope(ctx);
}

/** Reads a Hono context variable by name (`c.get` is keyed by the Env type). */
function contextVariable(c: Context, key: string): unknown {
    return (c.get as unknown as (k: string) => unknown)(key);
}

/**
 * Re-derives the partition of every connection in a group, running the scope
 * with the ctx captured at subscribe (`{ user, params }` — the principal and
 * the validated route params of the connection). A connection whose partition
 * moved — or whose scope now returns `null` — is closed and removed from the
 * group before any delivery: it must not receive data of a grouping it left.
 *
 * Returns the connections still in the group (`null` when none is left).
 */
async function revalidateGroup(
    channel: string,
    partition: string,
): Promise<ChannelConnection[] | null> {
    const set = groups.get(channel)?.get(partition);
    if (!set || set.size === 0) return null;

    const def = channelMap[channel]!;
    const kept: ChannelConnection[] = [];

    for (const conn of [...set]) {
        let next: ChannelScopeResult;
        try {
            next = await resolvePartition(def, connectionScopeCtx(conn));
        } catch (err) {
            // A scope that throws on re-derivation cannot vouch for the
            // partition: the connection is dropped, never silently kept.
            console.error(`[velojs] channel "${channel}" scope threw on emit:`, err);
            next = null;
        }
        if (next == null || next !== partition) {
            await conn.terminate();
            continue;
        }
        kept.push(conn);
    }

    return kept.length > 0 ? kept : null;
}

/**
 * The scope ctx a connection re-derives its partition with: `{ user, params }`
 * for a loader connection, `{ user, args }` for a live action subscription —
 * the fields captured at subscribe, the same address the scope first saw.
 */
function connectionScopeCtx(conn: ChannelConnection): ChannelScopeContext {
    if (conn.kind === "live") {
        return { user: conn.principal, args: conn.args };
    }
    return { user: conn.principal, params: conn.params };
}

/**
 * Delivers one invalidation round: the loader re-executed once per connection
 * still in the group, each with its own principal — each re-execution is a
 * child span of the trace that caused the round.
 *
 * Returns the number of connections reached (the ones whose loader ran).
 */
async function runInvalidationRound(
    channel: string,
    partition: string,
    recorder: TelemetrySpanRecorder,
): Promise<number> {
    const kept = await revalidateGroup(channel, partition);
    if (!kept) return 0;
    await Promise.all(
        kept.map(async (conn) => {
            const span = recorder.span(connectionSpanName(conn));
            const status = await pushSnapshot(conn);
            span.end(status);
        }),
    );
    return kept.length;
}

/**
 * The re-execution span of a connection: `loader:{moduleId}` for a page
 * connection, `action:{moduleId}/{name}` for a live action subscription — the
 * ranking tells one surface from the other.
 */
function connectionSpanName(conn: ChannelConnection): string {
    if (conn.kind === "live") {
        return `action:${conn.moduleId}/${conn.actionName ?? "anonymous"}`;
    }
    return `loader:${conn.moduleId}`;
}

// ============================================
// SNAPSHOT
// ============================================

/**
 * Runs the connection's data source with the connection's own captured
 * address: the loader with `{ params, query, c }` (a page connection), the
 * action with `{ body: args, params, query, c }` (a live subscription — the
 * same `ActionArgs` ruler as the common call, with `body` carrying the args
 * declared in the subscription).
 */
async function runConnection(conn: ChannelConnection): Promise<unknown> {
    if (conn.kind === "live") {
        if (typeof conn.action !== "function") {
            throw new Error("[velojs] live action connection has no action");
        }
        return conn.action({
            body: conn.args ?? {},
            params: conn.params,
            query: conn.query,
            c: conn.c,
        });
    }
    if (typeof conn.loader !== "function") {
        throw new Error("[velojs] channel connection has no loader");
    }
    return conn.loader({ params: conn.params, query: conn.query, c: conn.c });
}

/**
 * Executes the connection's data source (the loader of a page connection, the
 * action of a live subscription) with the connection's own principal and
 * pushes the result as a snapshot. Per-connection execution (rather than one
 * execution per partition) is deliberate: every subscriber always receives the
 * snapshot computed with its own scope, which makes the homogeneous-partition
 * rule unnecessary as a security invariant. What a burst of invalidations
 * amortizes is the number of *rounds*, not the executions inside one — a single
 * computation serving the whole partition is a later slice.
 *
 * A source that throws reports the failure on the connection (`error` event)
 * instead of dying silently; a source that returns a `Response` (a redirect
 * short-circuit) has no state to send.
 */
export async function pushSnapshot(conn: ChannelConnection): Promise<TelemetryStatus> {
    let value: unknown;
    try {
        value = await runConnection(conn);
    } catch (err) {
        await conn.send(
            CHANNEL_ERROR_EVENT,
            JSON.stringify({
                message: err instanceof Error ? err.message : String(err),
            }),
        );
        return "error";
    }
    if (value instanceof Response) return "ok";
    await conn.send(SNAPSHOT_EVENT, JSON.stringify(value ?? null));
    return "ok";
}

// ============================================
// EMIT
// ============================================

/**
 * Signals that a channel's partition changed: every connection in that
 * partition receives a fresh snapshot (its loader re-executed with the
 * connection's own principal and route params). Connections in other
 * partitions receive nothing; a channel with no subscribers is a no-op; a
 * channel with no entry in the app map throws immediately, naming the channel.
 *
 * The ctx is the object the same `scope` receives: the producer builds it with
 * the fields its scope consumes (`{ params: { id: 7 } }` for a resource
 * channel, `{ user: … }` for a principal one).
 *
 * ```ts
 * import { emit } from "@mauroandre/velojs/server";
 * await emit("teamExpenses", { user: { teamId: 7 } });
 * ```
 */
export function emit(channel: string, ctx?: ChannelScopeContext): Promise<void>;
/**
 * Slice mode: pushes the value the producer already holds to the connections
 * of the (module, channel) pair in the emitting partition — **without**
 * re-executing the loader. The slice is typed as a `Partial` of what the
 * module's loader returns, and the merge on arrival is shallow by key.
 *
 * ```ts
 * import * as Expenses from "../app/expenses/Expenses.js";
 * await emit(Expenses, "teamExpenses", { user: { teamId: 7 } }, { teamTotal: 880 });
 * ```
 */
export function emit<M extends ChannelEmitModule>(
    module: M,
    channel: string,
    ctx: ChannelScopeContext,
    slice: ChannelSlice<M>,
): Promise<void>;
export function emit(
    channelOrModule: string | ChannelEmitModule,
    channelOrCtx?: unknown,
    ctx?: unknown,
    slice?: unknown,
): Promise<void> {
    return typeof channelOrModule === "string"
        ? emitInvalidation(channelOrModule, (channelOrCtx ?? {}) as ChannelScopeContext)
        : emitSlice(channelOrModule, channelOrCtx as string, ctx as ChannelScopeContext, slice);
}

/**
 * The invalidation mode: the channel's partition changed, so every connection
 * in it gets a fresh snapshot. Connections in other partitions receive
 * nothing; a channel with no subscribers is a no-op (but still logged); a
 * channel with no entry in the app map throws immediately, naming the channel.
 */
async function emitInvalidation(channel: string, ctx: ChannelScopeContext): Promise<void> {
    const def = channelMap[channel];
    if (!def) {
        throw new Error(
            `[velojs] emit("${channel}"): this channel has no entry in app/channels.ts. ` +
            `Add one — a typo or a renamed channel would otherwise be a silent no-op.`,
        );
    }

    const partition = await resolvePartition(def, ctx);

    // The log is the gesture, not the delivery: the group size is read before
    // the coalescing window and before the partition revalidation, and a
    // consolidated round never writes a second line. A scope that resolves to
    // `null` is logged too — an emit that reaches nobody is exactly what the
    // log exists to show.
    const size = partition == null ? 0 : groups.get(channel)?.get(partition)?.size ?? 0;
    logEmit(channel, partition, "invalidate", size);

    // Every gesture is a trace of its own, with no request parent at all: this
    // is the part of the framework that works outside the request cycle. The
    // gestures that end up sharing a coalesced round all carry that round's
    // re-execution spans.
    const t = trace("emit", {
        channel,
        partition: partition ?? null,
        mode: "invalidate",
        connections: size,
    });

    if (partition == null) {
        t.end({ status: "ok", connections: 0 });
        return;
    }
    if (size === 0) {
        // no subscribers: no-op, no error
        t.end({ status: "ok", connections: 0 });
        return;
    }

    if (coalesceMs <= 0) {
        const recorder = spanRecorder();
        const reached = await runInvalidationRound(channel, partition, recorder);
        t.addSpans(recorder.spans);
        t.end({ status: "ok", connections: reached });
        return;
    }
    openWindow(channel, partition, t);
}

/**
 * The slice mode: the producer holds the value; it travels as-is to the
 * connections of the (module, channel) pair in the emitting partition. Guarded
 * loudly — a module that does not declare the channel, or that has no loader,
 * or a slice that is not an object, is an immediate error naming the parts.
 */
async function emitSlice(
    module: ChannelEmitModule,
    channel: string,
    ctx: ChannelScopeContext,
    slice: unknown,
): Promise<void> {
    const moduleId = module?.metadata?.moduleId;
    if (!moduleId) {
        throw new Error(
            `[velojs] emit(module, "${channel}", …): the module has no ` +
            `metadata.moduleId — pass the imported route module (the Vite plugin ` +
            `injects its metadata), the same object the route tree uses.`,
        );
    }

    const declared = module.channels;
    if (!Array.isArray(declared) || !declared.includes(channel)) {
        throw new Error(
            `[velojs] emit(module, "${channel}", …): module "${moduleId}" does not ` +
            `declare channel "${channel}" — add it to the module's \`channels\` export, ` +
            `or use emit("${channel}", ctx) for the invalidation mode.`,
        );
    }

    if (typeof module.loader !== "function") {
        throw new Error(
            `[velojs] emit(module, "${channel}", …): module "${moduleId}" has no ` +
            `\`loader\` — there is no data shape to slice.`,
        );
    }

    const def = channelMap[channel];
    if (!def) {
        throw new Error(
            `[velojs] emit(module, "${channel}", …): this channel has no entry in ` +
            `app/channels.ts. Add one — a typo or a renamed channel would otherwise ` +
            `be a silent no-op.`,
        );
    }

    if (slice === null || typeof slice !== "object" || Array.isArray(slice)) {
        throw new Error(
            `[velojs] emit(module, "${channel}", …): the slice must be the object of ` +
            `changed keys — got ${slice === null ? "null" : Array.isArray(slice) ? "an array" : typeof slice}.`,
        );
    }

    const partition = await resolvePartition(def, ctx);
    const group = partition == null ? undefined : groups.get(channel)?.get(partition);
    const size = group?.size ?? 0;
    logEmit(channel, partition, "slice", size);

    const t = trace("emit", {
        channel,
        partition: partition ?? null,
        mode: "slice",
        connections: size,
    });
    if (partition == null) {
        t.end({ status: "ok", connections: 0 });
        return;
    }
    if (!group || size === 0) {
        t.end({ status: "ok", connections: 0 });
        return;
    }

    const kept = await revalidateGroup(channel, partition);
    if (!kept) {
        t.end({ status: "ok", connections: 0 });
        return;
    }

    // The slice belongs to one module's data shape: only the connections of
    // that module merge it. A layout and a page may share the channel name and
    // hold different shapes — and a live action subscription of the same
    // module has the ACTION's shape, not the loader's, so it is not a slice
    // target (a slice addressed to a live action is a later slice).
    const targets = kept.filter(
        (conn) => conn.moduleId === moduleId && conn.kind !== "live",
    );
    if (targets.length === 0) {
        t.end({ status: "ok", connections: 0 });
        return;
    }

    const payload = JSON.stringify(slice);
    await Promise.all(targets.map((conn) => conn.send(SLICE_EVENT, payload)));
    t.end({ status: "ok", connections: targets.length });
}

/**
 * One line per emit gesture. Off with `registerChannels(map, { logEmits: false })`.
 *
 * `partition` is quoted when it resolved to a key and bare `null` when the
 * scope resolved to nothing; `connections` is the size of the group at that
 * instant — before the coalescing window and before the revalidation.
 */
function logEmit(
    channel: string,
    partition: ChannelScopeResult,
    kind: ChannelEmitKind,
    connections: number,
): void {
    if (!logEmits) return;
    const rendered = typeof partition === "string" ? `"${partition}"` : "null";
    console.log(
        `[velojs] emit kind=${kind} channel="${channel}" partition=${rendered} ` +
        `connections=${connections} at=${new Date().toISOString()}`,
    );
}

// ============================================
// ROUTE REGISTRATION
// ============================================

/**
 * Serializes the SSE writes of one connection and never lets a failed write
 * break the chain.
 *
 * A write can fail because the client went away mid-event (tab closed, proxy
 * cut). The connection is cleaned up by the abort handler either way, but the
 * failure is logged instead of swallowed: a snapshot lost in a dead write must
 * not be indistinguishable from an emit that never happened.
 */
export function createChannelWriteChain(
    channel: string,
    write: (payload: ChannelWritePayload) => Promise<unknown>,
): (payload: ChannelWritePayload) => Promise<void> {
    let chain: Promise<void> = Promise.resolve();
    return (payload) => {
        chain = chain
            .then(() => write(payload))
            .then(() => undefined)
            .catch((err) => {
                console.warn(
                    `[velojs] channel "${channel}": SSE write failed — ` +
                    `the snapshot did not reach the client:`,
                    err,
                );
            });
        return chain;
    };
}

/**
 * What the write chain carries: an SSE event (`{ event, data }`) or a raw
 * chunk — the heartbeat is a comment (`": ping\n\n"`), which is no event at
 * all: no client event fires for it and no delivery clock moves.
 */
export type ChannelWritePayload = { event: string; data: string } | string;

// ============================================
// ROUTE PARAMS — declared by the client, validated by the server
// ============================================

/** Query key carrying the route params the connection declares. */
export const ROUTE_PARAMS_QUERY = "_route";

/**
 * The `:param` names a route path declares, in declaration order. A path with
 * a catch-all (`/docs/*`) declares none: the pattern has no key to extract, so
 * the connection travels by principal only.
 */
export function declaredRouteParams(fullPath: string | null | undefined): string[] {
    if (!fullPath) return [];
    return fullPath
        .split("/")
        .filter((segment) => segment.startsWith(":"))
        .map((segment) => segment.slice(1));
}

/**
 * Parses and validates the `?_route=` payload of a channel connection against
 * the names the module's route path declares.
 *
 * The client declares the params of the URL it is already seeing; it is not
 * free input: a key the module's path does not declare rejects the
 * subscription with an explicit error, and every value is a URL string. An
 * absent payload is the empty object — a route without `:params` sends none.
 */
export function parseRouteParamsQuery(
    raw: string | undefined | null,
    declared: readonly string[],
): { params: Record<string, string>; error: string | null } {
    if (raw === undefined || raw === null || raw === "") {
        return { params: {}, error: null };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { params: {}, error: `the ?${ROUTE_PARAMS_QUERY}= payload is not valid JSON` };
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
            params: {},
            error: `the ?${ROUTE_PARAMS_QUERY}= payload must be an object of route params`,
        };
    }

    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!declared.includes(key)) {
            const declaredList = declared.length > 0 ? declared.join(", ") : "none";
            return {
                params: {},
                error:
                    `route param "${key}" is not declared by the module's path ` +
                    `(declared: ${declaredList})`,
            };
        }
        if (typeof value !== "string") {
            return { params: {}, error: `route param "${key}" must be a URL string` };
        }
        params[key] = value;
    }

    return { params, error: null };
}

/**
 * Registers the internal SSE route of one declared channel:
 * `GET /_channel/{moduleId}/{channel}`, inheriting the route node's
 * middlewares (auth policy is declared once per node).
 *
 * Guards are loud: a module that declares `channels` without a `loader`, or a
 * channel with no entry in `app/channels.ts`, is an explicit error — never a
 * silent inert route.
 *
 * The connection carries the client-declared route params (validated here
 * against the module's path), the principal captured for the partition
 * revalidation of every emit, and `terminate` lets an emit close a connection
 * whose partition no longer holds.
 */
export function registerChannelRoute(
    app: Hono,
    path: string,
    channel: string,
    module: RouteModule,
    moduleId: string,
    middlewares: MiddlewareHandler[],
): void {
    if (typeof module.loader !== "function") {
        throw new Error(
            `[velojs] module "${moduleId}" declares \`channels\` without a \`loader\` — ` +
            `there is nothing to synchronize. Add a loader or remove the export.`,
        );
    }
    if (!channelMap[channel]) {
        throw new Error(
            `[velojs] module "${moduleId}" declares channel "${channel}" with no entry ` +
            `in app/channels.ts — add the partition resolver for "${channel}".`,
        );
    }

    const loader = module.loader;
    const declaredParams = declaredRouteParams(module.metadata?.fullPath);

    const handler = async (c: Context) => {
        const def = channelMap[channel]!;

        // One trace per connection: `channel-connect` carries the connect phase
        // — scope resolution plus the connect snapshot, as a child span of its
        // own — and the same trace records the deliveries and the close line.
        const t = trace("channel-connect", { route: path, module: moduleId, channel });

        // The connection declares the params of the URL the client is already
        // seeing; the server validates the shape against the module's path —
        // a key the path does not declare is an explicit rejection, never a
        // silently ignored input.
        const parsed = parseRouteParamsQuery(
            c.req.query(ROUTE_PARAMS_QUERY),
            declaredParams,
        );
        if (parsed.error) {
            console.error(`[velojs] channel "${channel}": rejecting subscription — ${parsed.error}`);
            t.end({ status: "error" });
            return c.json({ error: "invalid-route-params", message: parsed.error }, 400);
        }
        const params = parsed.params;

        // The ctx contract is fixed: `{ user, params }`. The principal comes
        // from the house key "user" (no principal → undefined; the scope may
        // ignore it or return null, which denies with 403). A scope that
        // throws cannot vouch for the partition: denied loudly, never silently.
        const principal = contextVariable(c, "user");

        let partition: string | null | undefined;
        try {
            partition = await resolvePartition(def, { user: principal, params });
        } catch (err) {
            console.error(`[velojs] channel "${channel}" scope threw:`, err);
            t.end({ status: "error" });
            return c.json({ error: "forbidden" }, 403);
        }
        if (partition == null) {
            t.end({ status: "error" });
            return c.json({ error: "forbidden" }, 403);
        }

        const { streamSSE } = await import("hono/streaming");

        // The query delivered to the re-executed loader is the connection's
        // own minus the internal `_route` key — it is protocol transport, not
        // page data.
        const query: Record<string, string> = {};
        for (const [key, value] of Object.entries(c.req.query())) {
            if (key === ROUTE_PARAMS_QUERY) continue;
            query[key] = value;
        }

        const response = await streamSSE(c, async (sse) => {
            let disposed = false;
            let resolveDone: () => void = () => {};
            const done = new Promise<void>((resolve) => {
                resolveDone = resolve;
            });

            // Serialize writes: a burst of emits must not interleave mid-event,
            // and a dead connection is logged, never silenced. A raw string is
            // the heartbeat comment — no event on the wire, no delivery clock.
            const enqueue = createChannelWriteChain(channel, (payload) =>
                typeof payload === "string"
                    ? sse.write(payload)
                    : sse.writeSSE(payload),
            );

            const conn: ChannelConnection = {
                channel,
                partition,
                moduleId,
                principal,
                loader,
                c,
                params,
                query,
                telemetry: t,
                send: (event, data) => {
                    if (disposed) return Promise.resolve();
                    const isDelivery =
                        event === SNAPSHOT_EVENT || event === SLICE_EVENT;
                    if (!isDelivery) return enqueue({ event, data });
                    // The delivery line is stamped at enqueue: the close line
                    // must total every delivery the connection made, even the
                    // one that loses the race against a disconnect.
                    if (conn.telemetry?.enabled) conn.telemetry.delivery(byteLength(data));
                    // A delivery is what the idle clock runs on: it is stamped
                    // when it hits the wire and the idle countdown restarts.
                    // A heartbeat comment never comes through here.
                    return enqueue({ event, data }).then(() => {
                        if (disposed) return;
                        conn.lastDeliveryAt = Date.now();
                        armIdle();
                    });
                },
                terminate: (reason) => terminateConnection(reason),
            };

            const cleanup = (): void => {
                if (disposed) return;
                disposed = true;
                if (idleTimer !== null) clearTimeout(idleTimer);
                if (heartbeat !== null) clearInterval(heartbeat);
                resolveDone();
                // The connection is over: the close line carries the total of
                // deliveries and the lifetime of the connection.
                conn.telemetry?.close();
                // Out of the group — and, when this was the last connection,
                // through the group's `onGroupClose` before the group is
                // discarded. Any cause (disconnect, idle, revalidation) ends
                // up here.
                void leaveGroup(conn);
            };

            /**
             * Ends the connection from the server side: the client sees the
             * `close` event (and the stream end) and follows the normal flow —
             * no retry, no silent resubscription on a partition it left. The
             * idle timeout closes with the same gesture: a live page cycles
             * (close → EventSource reconnect → snapshot on connect), an
             * abandoned page's resources are freed for good.
             */
            const terminateConnection = async (
                reason: string = "partition",
            ): Promise<void> => {
                if (disposed) return;
                await conn.send(CHANNEL_CLOSE_EVENT, JSON.stringify({ reason }));
                cleanup();
            };

            // ---------- Idle timeout (no delivery ⇒ close) ----------
            let idleTimer: ReturnType<typeof setTimeout> | null = null;
            const armIdle = (): void => {
                if (idleMs <= 0 || disposed) return;
                if (idleTimer !== null) clearTimeout(idleTimer);
                idleTimer = setTimeout(() => {
                    idleTimer = null;
                    void terminateConnection("idle");
                }, idleMs);
                // A pending idle must never hold the process open.
                const unref = (idleTimer as { unref?: () => void }).unref;
                if (typeof unref === "function") unref.call(idleTimer);
            };

            // ---------- Heartbeat (transport, never a delivery) ----------
            let heartbeat: ReturnType<typeof setInterval> | null = null;
            if (heartbeatMs > 0) {
                heartbeat = setInterval(() => {
                    if (disposed) return;
                    void enqueue(": ping\n\n");
                }, heartbeatMs);
            }

            // Registered before the connect snapshot so an emit that lands in
            // between still reaches this connection. The first connection of
            // the group fires `onGroupOpen`, awaited before the snapshot: the
            // source is armed before the first data arrives, and a rejected
            // hook is logged and the group continues.
            const opened = addConnection(conn);
            sse.onAbort(cleanup);
            armIdle();
            if (heartbeat !== null) {
                const unref = (heartbeat as unknown as { unref?: () => void }).unref;
                if (typeof unref === "function") unref.call(heartbeat);
            }
            if (opened) await openGroup(channel, partition, { params });

            // Snapshot on connect: the pane never shows the SSR value while the
            // server has already moved on. A reconnect is a new connection and
            // therefore a new snapshot — no extra refetch. The snapshot is a
            // delivery: it stamps `lastDeliveryAt` and restarts the idle clock.
            const snapshotSpan = t.span("snapshot");
            const snapshotStatus = await pushSnapshot(conn);
            snapshotSpan.end(snapshotStatus);
            t.end({ status: snapshotStatus });

            await done;
        });

        // Proxies and the browser must never serve a cached channel snapshot:
        // a stale snapshot is exactly the illusion the live loader exists to
        // kill. `streamSSE` writes `no-cache`; the channel answer demands the
        // stronger `no-store`. (The heartbeat comment keeps the proxy from
        // buffering or closing the idle stream — documented operation note.)
        const headers = new Headers(response.headers);
        headers.set("Cache-Control", "no-store");
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
        });
    };

    if (middlewares.length > 0) {
        app.on(["GET"], [path], ...middlewares, handler);
    } else {
        app.on(["GET"], [path], handler);
    }
}

// ============================================
// LIVE ACTIONS — the tab-facing twin of the channel route
// ============================================

/** Query key carrying the subscription's declared args. */
export const LIVE_ARGS_QUERY = "_args";

/**
 * The serialized-args ceiling of a live action subscription, in bytes. Args
 * travel on the URL — the ceiling keeps the address an address, not a payload;
 * a bigger read wants an action call plus channels on the page.
 */
export const LIVE_ARGS_MAX_BYTES = 4096;

/**
 * Parses and validates the `?_args=` payload of a live action subscription.
 *
 * The client declares the args of the tab it opened; they are the subscription's
 * identity (a change reconnects) and the `body` of every re-execution. An
 * absent payload is the empty object — a live action may take no arguments.
 */
export function parseLiveArgsQuery(
    raw: string | undefined | null,
): { args: Record<string, unknown>; error: string | null } {
    if (raw === undefined || raw === null || raw === "") {
        return { args: {}, error: null };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { args: {}, error: `the ?${LIVE_ARGS_QUERY}= payload is not valid JSON` };
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
            args: {},
            error: `the ?${LIVE_ARGS_QUERY}= payload must be an object of the action's arguments`,
        };
    }

    return { args: parsed as Record<string, unknown>, error: null };
}

/** Counter of live subscriptions opened by this process (their inspector id). */
let liveSubscriptionSeq = 0;

/**
 * Registers the internal SSE route of one declared live action:
 * `GET /_live/{moduleId}/{actionName}`, inheriting the route node's
 * middlewares — the subscription is guarded exactly like the action call and
 * the page are.
 *
 * The action runs once on subscribe (the snapshot of connection is the whole
 * loading gesture — no initial POST exists) and once per emit in any of the
 * declared channels, always with the args declared in the subscription as
 * `body`. The subscription enters the groups of every declared channel: an
 * emit in any one delivers.
 *
 * Guards are loud: an action that does not exist in the module, or a channel
 * with no entry in `app/channels.ts`, is an explicit error — never a silent
 * inert route. Args above `LIVE_ARGS_MAX_BYTES` reject the subscription with
 * 400, naming the action and the limit; a scope that resolves to nothing (or
 * throws) denies it with 403.
 */
export function registerLiveActionRoute(
    app: Hono,
    path: string,
    actionName: string,
    channels: readonly string[],
    module: RouteModule,
    moduleId: string,
    middlewares: MiddlewareHandler[],
): void {
    const action = (module as unknown as Record<string, unknown>)[`action_${actionName}`];
    if (typeof action !== "function") {
        throw new Error(
            `[velojs] module "${moduleId}" declares liveActions.${actionName} but has no ` +
            `\`export const action_${actionName}\` — there is nothing to synchronize. ` +
            `Add the action or remove the entry.`,
        );
    }
    for (const channel of channels) {
        if (!channelMap[channel]) {
            throw new Error(
                `[velojs] module "${moduleId}" liveActions.${actionName} declares channel ` +
                `"${channel}" with no entry in app/channels.ts — add the partition ` +
                `resolver for "${channel}".`,
            );
        }
    }

    const handler = async (c: Context) => {
        // One trace per subscription: `live-action-connect` carries the connect
        // phase — the scopes, the group opens and the connect snapshot — and
        // the same trace records every delivery and the close line. Its fields
        // (module, name — never a channel) are what keeps it apart from a
        // loader's `channel-connect` in the report.
        const t = trace("live-action-connect", { route: path, module: moduleId, name: actionName });

        // The declared args are the subscription's address: parsed as an
        // object, guarded by size. A malformed or oversized payload rejects the
        // subscription with 400, naming the action — never a silent no-op.
        const parsed = parseLiveArgsQuery(c.req.query(LIVE_ARGS_QUERY));
        if (parsed.error) {
            console.error(
                `[velojs] live action "${moduleId}/${actionName}": rejecting subscription — ` +
                parsed.error,
            );
            t.end({ status: "error" });
            return c.json({ error: "invalid-args", message: parsed.error }, 400);
        }
        const args = parsed.args;
        const serializedArgs = JSON.stringify(args);
        if (byteLength(serializedArgs) > LIVE_ARGS_MAX_BYTES) {
            const message =
                `[velojs] live action "${moduleId}/${actionName}": the serialized args are ` +
                `${byteLength(serializedArgs)} bytes — the limit is ${LIVE_ARGS_MAX_BYTES}. ` +
                `Pass less data (an id, not the document) — the args are the tab's address.`;
            console.error(message);
            t.end({ status: "error" });
            return c.json(
                { error: "args-too-large", message, limit: LIVE_ARGS_MAX_BYTES },
                400,
            );
        }

        // Every declared channel must resolve a partition for this principal
        // with these args: the subscription enters all their groups, and any
        // scope denying (or throwing) denies the whole subscription.
        const principal = contextVariable(c, "user");
        const targets: { channel: string; partition: string }[] = [];
        for (const channel of channels) {
            const def = channelMap[channel]!;
            let partition: string | null | undefined;
            try {
                partition = await resolvePartition(def, { user: principal, args });
            } catch (err) {
                console.error(`[velojs] channel "${channel}" scope threw:`, err);
                t.end({ status: "error" });
                return c.json({ error: "forbidden" }, 403);
            }
            if (partition == null) {
                t.end({ status: "error" });
                return c.json({ error: "forbidden" }, 403);
            }
            targets.push({ channel, partition });
        }

        const { streamSSE } = await import("hono/streaming");

        // The query delivered to the re-executed action is the connection's
        // own minus the internal `_args` key — it is protocol transport, not
        // action data.
        const query: Record<string, string> = {};
        for (const [key, value] of Object.entries(c.req.query())) {
            if (key === LIVE_ARGS_QUERY) continue;
            query[key] = value;
        }

        const response = await streamSSE(c, async (sse) => {
            let disposed = false;
            let resolveDone: () => void = () => {};
            const done = new Promise<void>((resolve) => {
                resolveDone = resolve;
            });

            // Serialize writes: a burst of emits must not interleave mid-event,
            // and a dead subscription is logged, never silenced. A raw string is
            // the heartbeat comment — no event on the wire, no delivery clock.
            const enqueue = createChannelWriteChain(
                `${moduleId}/${actionName}`,
                (payload) =>
                    typeof payload === "string"
                        ? sse.write(payload)
                        : sse.writeSSE(payload),
            );

            liveSubscriptionSeq += 1;
            const liveId = `live-${liveSubscriptionSeq}`;

            /**
             * The subscription is ONE stream with N group entries (one per
             * declared channel). Every entry shares the send/terminate below:
             * a delivery writes once, and any cause of death (disconnect, idle,
             * partition revalidation in ANY of the channels) ends the whole
             * subscription — a tab cannot be half alive.
             */
            const entries: ChannelConnection[] = targets.map(({ channel, partition }) => ({
                channel,
                partition,
                moduleId,
                kind: "live" as const,
                principal,
                action: action as (args: ActionArgs<any>) => Promise<unknown>,
                actionName,
                args,
                liveId,
                c,
                params: {},
                query,
                telemetry: t,
                send: (event, data) => send(event, data),
                terminate: (reason) => terminateSubscription(reason),
            }));

            const send = (event: string, data: string): Promise<void> => {
                if (disposed) return Promise.resolve();
                const isDelivery = event === SNAPSHOT_EVENT;
                if (!isDelivery) return enqueue({ event, data });
                // Stamped at enqueue, like the loader connection: the close
                // line totals every delivery, even one racing a disconnect.
                if (t.enabled) t.delivery(byteLength(data));
                return enqueue({ event, data }).then(() => {
                    if (disposed) return;
                    const now = Date.now();
                    for (const entry of entries) entry.lastDeliveryAt = now;
                    armIdle();
                });
            };

            const cleanup = (): void => {
                if (disposed) return;
                disposed = true;
                if (idleTimer !== null) clearTimeout(idleTimer);
                if (heartbeat !== null) clearInterval(heartbeat);
                resolveDone();
                // The subscription is over: the close line carries the total of
                // deliveries and its lifetime.
                t.close();
                // Out of every group it entered — and, for each one it empties,
                // through the group's `onGroupClose` before it is discarded.
                for (const entry of entries) void leaveGroup(entry);
            };

            /**
             * Ends the subscription from the server side: the client sees the
             * `close` event (and the stream end) and follows the normal flow —
             * no retry, no silent resubscription on a partition it left.
             */
            const terminateSubscription = async (
                reason: string = "partition",
            ): Promise<void> => {
                if (disposed) return;
                await send(CHANNEL_CLOSE_EVENT, JSON.stringify({ reason }));
                cleanup();
            };

            // ---------- Idle timeout (no delivery ⇒ close) ----------
            let idleTimer: ReturnType<typeof setTimeout> | null = null;
            const armIdle = (): void => {
                if (idleMs <= 0 || disposed) return;
                if (idleTimer !== null) clearTimeout(idleTimer);
                idleTimer = setTimeout(() => {
                    idleTimer = null;
                    void terminateSubscription("idle");
                }, idleMs);
                const unref = (idleTimer as { unref?: () => void }).unref;
                if (typeof unref === "function") unref.call(idleTimer);
            };

            // ---------- Heartbeat (transport, never a delivery) ----------
            let heartbeat: ReturnType<typeof setInterval> | null = null;
            if (heartbeatMs > 0) {
                heartbeat = setInterval(() => {
                    if (disposed) return;
                    void enqueue(": ping\n\n");
                }, heartbeatMs);
            }

            // Registered before the connect snapshot so an emit that lands in
            // between still reaches this subscription. A group this
            // subscription opens fires `onGroupOpen` with the subscription's
            // own args, awaited before the snapshot.
            sse.onAbort(cleanup);
            armIdle();
            if (heartbeat !== null) {
                const unref = (heartbeat as unknown as { unref?: () => void }).unref;
                if (typeof unref === "function") unref.call(heartbeat);
            }
            for (const entry of entries) {
                const opened = addConnection(entry);
                if (opened) {
                    await openGroup(entry.channel, entry.partition, {
                        params: {},
                        args,
                    });
                }
            }

            // Snapshot on connection: the action executed once with the
            // declared args — the loading gesture of the tab. A remount is a
            // new subscription and therefore a new snapshot — no extra refetch.
            const snapshotSpan = t.span("snapshot");
            const snapshotStatus = await pushSnapshot(entries[0]!);
            snapshotSpan.end(snapshotStatus);
            t.end({ status: snapshotStatus });

            await done;
        });

        // The same ruler as the channel answer: a cached live value is exactly
        // the illusion this surface exists to kill.
        const headers = new Headers(response.headers);
        headers.set("Cache-Control", "no-store");
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
        });
    };

    if (middlewares.length > 0) {
        app.on(["GET"], [path], ...middlewares, handler);
    } else {
        app.on(["GET"], [path], handler);
    }
}
