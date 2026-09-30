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

/** SSE event carrying the loader's current value. */
export const SNAPSHOT_EVENT = "snapshot";
/** SSE event signaling that the loader re-execution failed on the server. */
export const CHANNEL_ERROR_EVENT = "error";
/** SSE event signaling a deliberate server-side close. */
export const CHANNEL_CLOSE_EVENT = "close";

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

/** Registers (replaces) the app's channel map. Idempotent. */
export function registerChannels(map: ChannelMap | undefined): void {
    channelMap = map ? { ...map } : {};
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
    loader: (args: LoaderArgs) => Promise<unknown>;
    /** The subscribing request's context — the loader re-runs against it. */
    c: Context;
    params: Record<string, string>;
    query: Record<string, string>;
    /** Writes one SSE event on this connection. */
    send: (event: string, data: string) => void;
}

/** channel → partition key → live connections. Empty groups do not exist. */
const groups = new Map<string, Map<string, Set<ChannelConnection>>>();

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

/** Test-only. Drops every live connection (groups become empty). */
export function __resetChannels(): void {
    groups.clear();
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

// ============================================
// SNAPSHOT
// ============================================

/**
 * Executes the connection's loader with the connection's own principal and
 * pushes the result as a snapshot. Per-connection execution (rather than one
 * execution per partition) is deliberate in this slice: every subscriber always
 * receives the snapshot computed with its own scope, which makes the
 * homogeneous-partition rule unnecessary as a security invariant. Coalescing
 * one computation per partition is a later slice.
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
        conn.send(
            CHANNEL_ERROR_EVENT,
            JSON.stringify({
                message: err instanceof Error ? err.message : String(err),
            }),
        );
        return;
    }
    if (value instanceof Response) return;
    conn.send(SNAPSHOT_EVENT, JSON.stringify(value ?? null));
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
export async function emit(channel: string, ctx?: unknown): Promise<void> {
    const def = channelMap[channel];
    if (!def) {
        throw new Error(
            `[velojs] emit("${channel}"): this channel has no entry in app/channels.ts. ` +
            `Add one — a typo or a renamed channel would otherwise be a silent no-op.`,
        );
    }

    const partition = await resolvePartition(def, ctx);
    if (partition == null) return;

    const group = groups.get(channel)?.get(partition);
    if (!group || group.size === 0) return; // no subscribers: no-op, no error

    await Promise.all([...group].map((conn) => pushSnapshot(conn)));
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
                loader,
                c,
                params: c.req.param(),
                query: c.req.query(),
                send: (event, data) => {
                    if (disposed) return;
                    void enqueue({ event, data });
                },
            };

            const cleanup = (): void => {
                if (disposed) return;
                disposed = true;
                removeConnection(conn);
                resolveDone();
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
