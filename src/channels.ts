/**
 * Live loader — server-side runtime (slice 1).
 *
 * A route module opts into state synchronization with a sibling `channels`
 * export (an array of channel names). The framework derives one internal SSE
 * route per declared channel — `GET /_channel/{moduleId}/{channel}`, the same
 * family as `/_action` and `/_event` — which inherits the middlewares of the
 * module's route node and serves the module's loader as a stream of snapshots.
 *
 * The app owns the partition policy in `app/channels.ts`, a name → resolver map:
 *
 * ```ts
 * export const channels = {
 *     gastosFamilia: { scope: (ctx) => `familia:${ctx.familiaId}` },
 * };
 * ```
 *
 * On subscribe the resolver receives the materialized principal (`c.get("user")`,
 * the house key); without an authenticated principal it receives `undefined`, so
 * a public channel ignores it (`() => "all"`) and an authenticated one returns
 * `null` (which denies the subscription with 403). The partition NEVER derives
 * from the query string or from any client input.
 *
 * `emit(channel, ctx)` resolves the same partition key on the producer side,
 * finds the group of connections in that partition and re-executes the loader
 * for each connection — with that connection's own principal — pushing a fresh
 * snapshot down the wire. Emitting to a channel with no subscribers is a no-op;
 * emitting to a channel with no entry in the app map throws immediately.
 *
 * `emit(module, channel, ctx, slice)` is the second mode, addressed to the
 * (module, channel) pair: the producer already holds the value, so it travels
 * as a slice — the connections of that pair in the emitting partition merge it
 * shallowly by key, and no loader runs. The slice is typed as a `Partial` of
 * the module's loader return, which is why the module is part of the address:
 * one channel can be declared by modules with different `Data` (a layout and a
 * page), and a slice is the shape of exactly one of them.
 *
 * Every emit logs one line (channel, partition, kind, connections at the
 * moment of the gesture, timestamp) unless `logEmits: false` is registered,
 * and invalidations are folded by a coalescing window per (channel, partition)
 * (`coalesceMs`, default 50, `0` disables). Before delivering anything the
 * runtime re-derives each connection's partition with the principal captured
 * on subscribe: a connection that moved (or whose scope now returns null) is
 * dropped and closed instead of receiving data of a group it left.
 */

import type { Context, Hono, MiddlewareHandler } from "hono";
import type { LoaderArgs, RouteModule } from "./types.js";

// ============================================
// TYPES
// ============================================

/** Result of a partition resolver. `null`/`undefined` denies the subscription. */
export type ChannelScopeResult = string | null | undefined;

/**
 * One entry of the app's channel map (`app/channels.ts`).
 *
 * `scope` receives the materialized principal on subscribe (`c.get("user")`)
 * and the emitter's object on emit. Returning `null` denies with 403.
 * Omitted → the channel is public (`() => "all"`).
 */
export interface ChannelDefinition {
    scope?: (ctx: any) => ChannelScopeResult | Promise<ChannelScopeResult>;
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
 */
export interface ChannelRegistryOptions {
    coalesceMs?: number;
    logEmits?: boolean;
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
    logEmits = options?.logEmits ?? true;
    // A re-registration invalidates the windows still open.
    cancelPendingWindows();
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
     * The principal materialized at subscribe (`c.get("user")`), captured for
     * the partition revalidation of every emit — the scope re-runs against it.
     */
    principal: unknown;
    loader: (args: LoaderArgs) => Promise<unknown>;
    /** The subscribing request's context — the loader re-runs against it. */
    c: Context;
    params: Record<string, string>;
    query: Record<string, string>;
    /** Writes one SSE event on this connection. Resolves when it hits the wire. */
    send: (event: string, data: string) => Promise<void>;
    /**
     * Ends this connection: a `close` event on the wire, then the group entry
     * and the stream. Used when the connection's partition no longer holds.
     */
    terminate: () => Promise<void>;
}

/** channel → partition key → live connections. Empty groups do not exist. */
const groups = new Map<string, Map<string, Set<ChannelConnection>>>();

/** One open coalescing window: `(channel, partition)` → its timer. */
interface CoalesceWindow {
    timer: ReturnType<typeof setTimeout>;
    channel: string;
    partition: string;
}

const windows = new Map<string, CoalesceWindow>();

function windowKey(channel: string, partition: string): string {
    return `${channel}\u0000${partition}`;
}

/**
 * Closes the open window of a (channel, partition): one re-execution round is
 * the effect of every emit that fell inside it — no invalidation is lost.
 */
function openWindow(channel: string, partition: string): void {
    const key = windowKey(channel, partition);
    // The first emit opens the window; the later ones join it without moving
    // the deadline (a sliding window would postpone the round indefinitely on
    // a hot producer).
    if (windows.has(key)) return;

    const timer = setTimeout(() => {
        windows.delete(key);
        void runInvalidationRound(channel, partition);
    }, coalesceMs);

    // A pending window must never hold the process open.
    const unref = (timer as { unref?: () => void }).unref;
    if (typeof unref === "function") unref.call(timer);

    windows.set(key, { timer, channel, partition });
}

function cancelPendingWindows(): void {
    for (const window of windows.values()) clearTimeout(window.timer);
    windows.clear();
}

function addConnection(conn: ChannelConnection): void {
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
    set.add(conn);
}

function removeConnection(conn: ChannelConnection): void {
    const byPartition = groups.get(conn.channel);
    const set = byPartition?.get(conn.partition);
    if (!byPartition || !set) return;
    set.delete(conn);
    if (set.size === 0) byPartition.delete(conn.partition);
    if (byPartition.size === 0) groups.delete(conn.channel);
}

/** Test-only. Drops every live connection and closes every open window. */
export function __resetChannels(): void {
    groups.clear();
    cancelPendingWindows();
}

// ============================================
// PARTITION
// ============================================

async function resolvePartition(
    def: ChannelDefinition,
    ctx: unknown,
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
 * with the principal captured at subscribe. A connection whose partition moved
 * — or whose scope now returns `null` — is closed and removed from the group
 * before any delivery: it must not receive data of a grouping it left.
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
            next = await resolvePartition(def, conn.principal);
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
 * Delivers one invalidation round: the loader re-executed once per connection
 * still in the group, each with its own principal.
 */
async function runInvalidationRound(channel: string, partition: string): Promise<void> {
    const kept = await revalidateGroup(channel, partition);
    if (!kept) return;
    await Promise.all(kept.map((conn) => pushSnapshot(conn)));
}

// ============================================
// SNAPSHOT
// ============================================

/**
 * Executes the connection's loader with the connection's own principal and
 * pushes the result as a snapshot. Per-connection execution (rather than one
 * execution per partition) is deliberate: every subscriber always receives the
 * snapshot computed with its own scope, which makes the homogeneous-partition
 * rule unnecessary as a security invariant. What a burst of invalidations
 * amortizes is the number of *rounds*, not the executions inside one — a single
 * computation serving the whole partition is a later slice.
 *
 * A loader that throws reports the failure on the connection (`error` event)
 * instead of dying silently; a loader that returns a `Response` (a redirect
 * short-circuit) has no state to send.
 */
export async function pushSnapshot(conn: ChannelConnection): Promise<void> {
    let value: unknown;
    try {
        value = await conn.loader({
            params: conn.params,
            query: conn.query,
            c: conn.c,
        });
    } catch (err) {
        await conn.send(
            CHANNEL_ERROR_EVENT,
            JSON.stringify({
                message: err instanceof Error ? err.message : String(err),
            }),
        );
        return;
    }
    if (value instanceof Response) return;
    await conn.send(SNAPSHOT_EVENT, JSON.stringify(value ?? null));
}

// ============================================
// EMIT
// ============================================

/**
 * Signals that a channel's partition changed: every connection in that
 * partition receives a fresh snapshot (its loader re-executed with the
 * connection's own principal). Connections in other partitions receive
 * nothing; a channel with no subscribers is a no-op; a channel with no entry
 * in the app map throws immediately, naming the channel.
 *
 * ```ts
 * import { emit } from "@mauroandre/velojs/server";
 * await emit("gastosFamilia", { familiaId: 7 });
 * ```
 */
export function emit(channel: string, ctx?: unknown): Promise<void>;
/**
 * Slice mode: pushes the value the producer already holds to the connections
 * of the (module, channel) pair in the emitting partition — **without**
 * re-executing the loader. The slice is typed as a `Partial` of what the
 * module's loader returns, and the merge on arrival is shallow by key.
 *
 * ```ts
 * import * as Gastos from "../app/gastos/Gastos.js";
 * await emit(Gastos, "gastosFamilia", { familiaId: 7 }, { somaFamilia: 880 });
 * ```
 */
export function emit<M extends ChannelEmitModule>(
    module: M,
    channel: string,
    ctx: unknown,
    slice: ChannelSlice<M>,
): Promise<void>;
export function emit(
    channelOrModule: string | ChannelEmitModule,
    channelOrCtx?: unknown,
    ctx?: unknown,
    slice?: unknown,
): Promise<void> {
    return typeof channelOrModule === "string"
        ? emitInvalidation(channelOrModule, channelOrCtx)
        : emitSlice(channelOrModule, channelOrCtx as string, ctx, slice);
}

/**
 * The invalidation mode: the channel's partition changed, so every connection
 * in it gets a fresh snapshot. Connections in other partitions receive
 * nothing; a channel with no subscribers is a no-op (but still logged); a
 * channel with no entry in the app map throws immediately, naming the channel.
 */
async function emitInvalidation(channel: string, ctx: unknown): Promise<void> {
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
    if (partition == null) return;
    if (size === 0) return; // no subscribers: no-op, no error

    if (coalesceMs <= 0) {
        await runInvalidationRound(channel, partition);
        return;
    }
    openWindow(channel, partition);
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
    ctx: unknown,
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
    if (partition == null) return;
    if (!group || size === 0) return;

    const kept = await revalidateGroup(channel, partition);
    if (!kept) return;

    // The slice belongs to one module's data shape: only the connections of
    // that module merge it. A layout and a page may share the channel name and
    // hold different shapes.
    const targets = kept.filter((conn) => conn.moduleId === moduleId);
    if (targets.length === 0) return;

    const payload = JSON.stringify(slice);
    await Promise.all(targets.map((conn) => conn.send(SLICE_EVENT, payload)));
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
    write: (payload: { event: string; data: string }) => Promise<unknown>,
): (payload: { event: string; data: string }) => Promise<void> {
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
 * Registers the internal SSE route of one declared channel:
 * `GET /_channel/{moduleId}/{channel}`, inheriting the route node's
 * middlewares (auth policy is declared once per node).
 *
 * Guards are loud: a module that declares `channels` without a `loader`, or a
 * channel with no entry in `app/channels.ts`, is an explicit error — never a
 * silent inert route.
 *
 * The principal is captured on the connection for the partition revalidation
 * of every emit, and `terminate` lets an emit close a connection whose
 * partition no longer holds.
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

    const handler = async (c: Context) => {
        const def = channelMap[channel]!;

        // The ctx contract is fixed: the materialized principal, by convention
        // under the house key "user". No principal → undefined; the scope may
        // ignore it (public channel) or return null (denies with 403).
        const principal = contextVariable(c, "user");

        let partition: string | null | undefined;
        try {
            partition = await resolvePartition(def, principal);
        } catch (err) {
            console.error(`[velojs] channel "${channel}" scope threw:`, err);
            return c.json({ error: "internal" }, 500);
        }
        if (partition == null) {
            return c.json({ error: "forbidden" }, 403);
        }

        const { streamSSE } = await import("hono/streaming");

        return streamSSE(c, async (sse) => {
            let disposed = false;
            let resolveDone: () => void = () => {};
            const done = new Promise<void>((resolve) => {
                resolveDone = resolve;
            });

            // Serialize writes: a burst of emits must not interleave mid-event,
            // and a dead connection is logged, never silenced.
            const enqueue = createChannelWriteChain(channel, (payload) =>
                sse.writeSSE(payload),
            );

            const conn: ChannelConnection = {
                channel,
                partition,
                moduleId,
                principal,
                loader,
                c,
                params: c.req.param(),
                query: c.req.query(),
                send: (event, data) => {
                    if (disposed) return Promise.resolve();
                    return enqueue({ event, data });
                },
                terminate: () => terminateConnection(),
            };

            const cleanup = (): void => {
                if (disposed) return;
                disposed = true;
                removeConnection(conn);
                resolveDone();
            };

            /**
             * Ends the connection from the server side: the client sees the
             * `close` event (and the stream end) and follows the normal flow —
             * no retry, no silent resubscription on a partition it left.
             */
            const terminateConnection = async (): Promise<void> => {
                if (disposed) return;
                await conn.send(CHANNEL_CLOSE_EVENT, JSON.stringify({ reason: "partition" }));
                cleanup();
            };

            // Registered before the connect snapshot so an emit that lands in
            // between still reaches this connection.
            addConnection(conn);
            sse.onAbort(cleanup);

            // Snapshot on connect: the pane never shows the SSR value while the
            // server has already moved on. A reconnect is a new connection and
            // therefore a new snapshot — no extra refetch.
            await pushSnapshot(conn);

            await done;
        });
    };

    if (middlewares.length > 0) {
        app.on(["GET"], [path], ...middlewares, handler);
    } else {
        app.on(["GET"], [path], handler);
    }
}
