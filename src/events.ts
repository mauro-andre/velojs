/**
 * VeloJS Event Streams
 * Server-Sent Events (SSE) with snapshot, channels, and auto-close.
 *
 * Two ways to use:
 *
 * 1. Standalone (cross-cutting streams like global metrics):
 * ```typescript
 * export const metricsStream = createEventStream<Metric[]>({
 *     path: "/api/metrics",
 * });
 * metricsStream.emit(currentMetrics);
 * ```
 *
 * 2. Convention `stream_*` (per-page streams, route registered automatically):
 * ```typescript
 * // app/admin/Deploy.tsx
 * export const stream_progress = createEventStream<DeployState>({
 *     channel: (c) => c.req.param("id"),
 *     snapshot: (id) => activeDeploys.get(id),
 *     closeOn: (s) => s.status === "success" || s.status === "error",
 * });
 * ```
 */

import type { Context, Hono, MiddlewareHandler } from "hono";

// ============================================
// TYPES
// ============================================

export interface EventStreamConfig<TEvent, TSnapshot = TEvent> {
    /**
     * Explicit URL path for the SSE endpoint (standalone usage).
     * When omitted, the path is derived from the module ID at build time
     * (convention `stream_*`).
     */
    path?: string;

    /**
     * Channel selector — extracts a channel ID from the request.
     * Subscribers only receive events emitted to their channel.
     * When omitted, the stream is a broadcast (all subscribers receive all events).
     */
    channel?: (c: Context) => string;

    /**
     * Returns the current state of a channel for snapshot-on-connect.
     * Sent before any new events to bring the client up to date.
     * Must remain available even after the stream "closes" — clients reconnecting
     * after a terminal event still need to see the final state.
     */
    snapshot?: (channel: string | undefined) => TSnapshot | undefined | Promise<TSnapshot | undefined>;

    /**
     * Returns true when an event marks the end of the stream for that channel.
     * The server closes the SSE connection after sending such an event.
     */
    closeOn?: (event: TEvent) => boolean;

    /**
     * Heartbeat interval in milliseconds. Sends `:heartbeat\n\n` to keep
     * proxies (Cloudflare, Nginx, ALB) from closing idle connections.
     * Default: 20000 (20s). Set to `false` to disable.
     */
    heartbeatMs?: number | false;

    /**
     * Middlewares to apply to the SSE route (standalone streams only).
     * For `stream_*` convention streams, middlewares are inherited from
     * parent route nodes automatically.
     */
    middlewares?: MiddlewareHandler[];
}

export interface EventStream<TEvent, TSnapshot = TEvent> {
    /** Broadcast emit (no channel) */
    emit(event: TEvent): void;
    /** Channel-targeted emit */
    emit(channel: string, event: TEvent): void;

    /** Internal: marker for runtime detection */
    readonly __isVeloEventStream: true;
    /** Internal: configuration */
    readonly __config: EventStreamConfig<TEvent, TSnapshot>;
    /** Internal: registered listeners by channel ("" for broadcast) */
    readonly __listeners: Map<string, Set<(event: TEvent) => void>>;
    /** Internal: assigned URL path (set by standalone or by stream_* discovery) */
    __path: string | undefined;
}

// ============================================
// FACTORY
// ============================================

const DEFAULT_HEARTBEAT_MS = 20000;
const BROADCAST_CHANNEL = "";

/**
 * Pending standalone streams that need to be registered when the app starts.
 * Each entry registers a GET SSE handler at the stream's `path`.
 */
const pendingStreamRoutes: Array<(app: Hono) => void> = [];

/**
 * Returns and clears the queue of pending standalone streams.
 * Called by createApp to register their routes.
 */
export function flushPendingStreamRoutes(app: Hono): void {
    for (const fn of pendingStreamRoutes) fn(app);
    pendingStreamRoutes.length = 0;
}

/**
 * Creates a typed event stream with optional channel, snapshot, and close-on-event.
 */
export function createEventStream<TEvent, TSnapshot = TEvent>(
    config: EventStreamConfig<TEvent, TSnapshot> = {}
): EventStream<TEvent, TSnapshot> {
    const listeners = new Map<string, Set<(event: TEvent) => void>>();

    function emit(eventOrChannel: TEvent | string, maybeEvent?: TEvent): void {
        let channel: string;
        let event: TEvent;

        if (arguments.length === 1) {
            channel = BROADCAST_CHANNEL;
            event = eventOrChannel as TEvent;
        } else {
            channel = eventOrChannel as string;
            event = maybeEvent as TEvent;
        }

        const channelListeners = listeners.get(channel);
        if (channelListeners) {
            for (const listener of channelListeners) listener(event);
        }
    }

    const stream: EventStream<TEvent, TSnapshot> = {
        emit: emit as EventStream<TEvent, TSnapshot>["emit"],
        __isVeloEventStream: true,
        __config: config,
        __listeners: listeners,
        __path: config.path,
    };

    // Standalone usage: register the route immediately via the pending queue
    if (config.path) {
        pendingStreamRoutes.push((app) => {
            registerStreamHandler(app, config.path!, stream, config.middlewares ?? []);
        });
    }

    return stream;
}

// ============================================
// SSE HANDLER
// ============================================

/**
 * Registers a GET SSE route for the given stream at the given path.
 * Used both by standalone streams and by stream_* discovery.
 */
export function registerStreamHandler<TEvent, TSnapshot>(
    app: Hono,
    path: string,
    stream: EventStream<TEvent, TSnapshot>,
    middlewares: Array<(c: Context, next: () => Promise<void>) => any> = []
): void {
    const handler = async (c: Context) => {
        const { streamSSE } = await import("hono/streaming");

        const channelKey = stream.__config.channel
            ? stream.__config.channel(c)
            : BROADCAST_CHANNEL;

        const heartbeatMs = stream.__config.heartbeatMs;
        const heartbeatInterval =
            heartbeatMs === false ? 0 : (heartbeatMs ?? DEFAULT_HEARTBEAT_MS);

        return streamSSE(c, async (sse) => {
            // Send snapshot on connect (if configured)
            if (stream.__config.snapshot) {
                const snapshot = await stream.__config.snapshot(
                    channelKey === BROADCAST_CHANNEL ? undefined : channelKey
                );
                if (snapshot !== undefined) {
                    await sse.writeSSE({
                        event: "snapshot",
                        data: JSON.stringify(snapshot),
                    });
                }
            }

            // Promise resolved by cleanup() — replaces a polling loop.
            let resolveDone: () => void;
            const done = new Promise<void>((resolve) => {
                resolveDone = resolve;
            });

            let closed = false;
            let heartbeat: ReturnType<typeof setInterval> | null = null;
            let channelListeners: Set<(event: TEvent) => void> | undefined;

            const cleanup = () => {
                if (closed) return;
                closed = true;
                if (heartbeat) clearInterval(heartbeat);
                channelListeners?.delete(listener);
                if (channelListeners?.size === 0) {
                    stream.__listeners.delete(channelKey);
                }
                resolveDone();
            };

            const listener = (event: TEvent) => {
                if (closed) return;
                sse.writeSSE({ data: JSON.stringify(event) }).catch(() => {});

                if (stream.__config.closeOn?.(event)) {
                    sse.close();
                    cleanup();
                }
            };

            channelListeners = stream.__listeners.get(channelKey);
            if (!channelListeners) {
                channelListeners = new Set();
                stream.__listeners.set(channelKey, channelListeners);
            }
            channelListeners.add(listener);

            // Heartbeat to keep idle proxies open
            heartbeat =
                heartbeatInterval > 0
                    ? setInterval(() => {
                          if (closed) return;
                          sse.writeSSE({ event: "heartbeat", data: "" }).catch(() => {});
                      }, heartbeatInterval)
                    : null;

            sse.onAbort(cleanup);

            await done;
        });
    };

    if (middlewares.length > 0) {
        app.on(["GET"], [path], ...middlewares, handler);
    } else {
        app.on(["GET"], [path], handler);
    }
}
