/**
 * VeloJS Event Streams
 * Server-Sent Events (SSE) with snapshot, channels, source-driven emission, and auto-close.
 *
 * Two ways to declare:
 *
 * 1. Convention `stream_*` (per-page or per-layout, route registered automatically):
 * ```typescript
 * // app/admin/Deploy.tsx
 * export const stream_progress = createEventStream<DeployState>();
 * ```
 *
 * 2. Standalone (cross-cutting streams like global metrics):
 * ```typescript
 * export const metricsStream = createEventStream<Metric[]>({
 *     path: "/api/metrics",
 *     middlewares: [authMiddleware],
 * });
 * ```
 *
 * Three ways to emit (server-side):
 *
 * - Reactive (call from anywhere when something happens):
 *   `stream.emit(channelId, value, { snapshot: true })`
 * - Source-driven (framework runs your producer only when subscribed):
 *   `createEventStream({ source: poll({ intervalMs, tick }) })`
 * - Stateful snapshot via callback (for state-machine patterns):
 *   `createEventStream({ snapshot: (channelId) => activeStates.get(channelId) })`
 */

import type { Context, Hono, MiddlewareHandler } from "hono";
import { getAppContext, registerDisposer, unregisterDisposer } from "./app-context.js";

// ============================================
// TYPES
// ============================================

/** Function passed to `source` for emitting values. */
export type EmitFn<TEvent> = {
    /** Broadcast emit (no channel) */
    (event: TEvent, options?: EmitOptions): void;
    /** Channel-targeted emit */
    (channel: string, event: TEvent, options?: EmitOptions): void;
};

/** Options accepted by `emit()` per call. */
export interface EmitOptions {
    /**
     * If true, the value is appended to the stream's internal buffer for that channel.
     * Late subscribers receive the full buffer as a snapshot on connect.
     * Default: false (event is broadcast-only, not retained).
     */
    snapshot?: boolean;
}

/**
 * A producer function that runs **only when there are active subscribers**.
 * The framework passes an `AbortSignal` that fires when the last subscriber disconnects.
 *
 * Example (event-driven):
 * ```typescript
 * source: async (emit, { abortSignal }) => {
 *     const handler = (e) => emit(e);
 *     bus.on("event", handler);
 *     abortSignal.addEventListener("abort", () => bus.off("event", handler));
 *     await new Promise(r => abortSignal.addEventListener("abort", r));
 * }
 * ```
 *
 * For polling, use the `poll` helper instead of writing the loop yourself.
 *
 * **Anti-pattern**: ignoring `abortSignal` keeps the source running forever (and leaks
 * resources). Only do this if the producer is meant to run independently of UI.
 */
export type SourceFn<TEvent> = (
    emit: EmitFn<TEvent>,
    ctx: { abortSignal: AbortSignal }
) => void | Promise<void>;

/**
 * A per-channel producer function. Invoked when the **first** subscriber connects
 * to a specific channel. Aborted when the **last** subscriber of that channel disconnects.
 *
 * The provided `emit` function is bound to the current channel — call it with just
 * the event value (no need to pass the channel ID again).
 *
 * Example (per-channel SSH log stream):
 * ```typescript
 * perChannelSource: async (channelKey, emit, { abortSignal }) => {
 *     const conn = await ssh.connect(...);
 *     const stream = conn.exec(`podman logs -f ${channelKey}`);
 *     stream.on("data", (d) => emit(d.toString(), { snapshot: true }));
 *     abortSignal.addEventListener("abort", () => { stream.close(); conn.end(); });
 * }
 * ```
 *
 * Use this for resources that are **per-channel and expensive** (SSH connections,
 * DB cursors, external pub/sub subscriptions). Mutually exclusive with `source`.
 */
export type PerChannelSourceFn<TEvent> = (
    channelKey: string,
    emit: (event: TEvent, options?: EmitOptions) => void,
    ctx: { abortSignal: AbortSignal }
) => void | Promise<void>;

/**
 * Async-capable channel resolver. Returns a channel ID, or `null`/`undefined`
 * to reject the connection (framework responds 403).
 *
 * Useful for combining channel extraction with authorization in one place.
 */
export type ChannelResolver = (c: Context) =>
    | string
    | null
    | undefined
    | Promise<string | null | undefined>;

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
     * When omitted, defaults to `c.req.query("channel") ?? ""` so client-side
     * `useEventStream(stream, { channel })` works out of the box.
     *
     * Can be **async** — return a Promise to perform DB lookups, auth checks, etc.
     * Return `null` or `undefined` to reject the connection (framework responds 403).
     *
     * Ignored when `broadcast: true` is set.
     */
    channel?: ChannelResolver;

    /**
     * If true, this stream has no channels — every emit goes to all subscribers.
     * - `emit(value, options?)` (no channel arg)
     * - `useEventStream(stream)` (no channel option)
     * - Server uses a single broadcast bucket regardless of `?channel=` query.
     *
     * Default: false (channel-aware — `emit(channel, value, options?)`).
     */
    broadcast?: boolean;

    /**
     * Returns the current state of a channel for snapshot-on-connect.
     * Sent before any new events to bring the client up to date.
     *
     * Use this for **state-machine patterns** where each emit is a complete state
     * (deploy progress, migration status). The callback returns the latest state.
     *
     * For **append-only patterns** (logs, tokens), prefer `emit(..., { snapshot: true })`
     * which uses an internal buffer managed by the framework.
     */
    snapshot?: (channel: string | undefined) => TSnapshot | undefined | Promise<TSnapshot | undefined>;

    /**
     * Returns true when an event marks the end of the stream for that channel.
     * The server closes the SSE connection after sending such an event.
     *
     * For imperative close from anywhere, use `stream.close(channel)` instead.
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

    /**
     * Self-running producer that emits values into the stream.
     * The framework only invokes `source` while there are active subscribers.
     * When the last subscriber disconnects, the AbortSignal fires.
     *
     * Use the `poll` helper for the common interval-based pattern.
     *
     * Mutually exclusive with `perChannelSource`.
     */
    source?: SourceFn<TEvent>;

    /**
     * Per-channel producer. Invoked when the **first** subscriber of a channel connects.
     * Aborted when the **last** subscriber of that channel disconnects.
     *
     * Use this for resources that scale per channel (SSH connections, DB cursors,
     * external pub/sub subscriptions). The `emit` provided is bound to the current
     * channel — call it with just the value.
     *
     * Mutually exclusive with `source`.
     */
    perChannelSource?: PerChannelSourceFn<TEvent>;

    /**
     * Time (ms) the per-channel snapshot buffer is retained after `close()`.
     * Reconnecting clients within this window still see the final state.
     * Default: 5 * 60 * 1000 (5 minutes).
     */
    retainMs?: number;

    /**
     * Maximum number of events kept in the per-channel snapshot buffer
     * (only applies to `emit(..., { snapshot: true })`).
     *
     * When the buffer reaches this size, the oldest entries are dropped (FIFO ring).
     * Use this to prevent memory growth in long-running log streams.
     *
     * Default: `Infinity` (no limit, current behavior).
     */
    bufferSize?: number;
}

export interface EventStream<TEvent, TSnapshot = TEvent> {
    /**
     * Emit an event.
     * - For channel-aware streams (default): `emit(channel, value, options?)`
     * - For broadcast streams (`config.broadcast: true`): `emit(value, options?)`
     */
    emit(event: TEvent, options?: EmitOptions): void;
    emit(channel: string, event: TEvent, options?: EmitOptions): void;

    /**
     * Closes the stream (or a specific channel).
     * - Notifies current subscribers so their `useEventStream().closed` becomes true.
     * - Schedules cleanup of the per-channel buffer after `retainMs`.
     * - Idempotent: calling close on an already-closed channel is a no-op.
     */
    close(channel?: string): void;

    /** Internal: marker for runtime detection */
    readonly __isVeloEventStream: true;
    /** Internal: configuration */
    readonly __config: EventStreamConfig<TEvent, TSnapshot>;
    /** Internal: registered listeners by channel ("" for broadcast) */
    readonly __listeners: Map<string, Set<StreamListener<TEvent>>>;
    /** Internal: per-channel buffer for { snapshot: true } emits */
    readonly __buffers: Map<string, TEvent[]>;
    /** Internal: assigned URL path (set by standalone or by stream_* discovery) */
    __path: string | undefined;
    /** Internal: source lifecycle hook */
    __onConnect(channelKey: string, listener: StreamListener<TEvent>): void;
    /** Internal: source lifecycle hook */
    __onDisconnect(channelKey: string, listener: StreamListener<TEvent>): void;
    /** @internal Test-only: reset all transient state (buffers, listeners, controllers, timers). */
    __reset(): void;
}

/** Internal listener — receives events and a close signal. */
interface StreamListener<TEvent> {
    (event: TEvent): void;
    close(): void;
}

// ============================================
// CONSTANTS
// ============================================

const DEFAULT_HEARTBEAT_MS = 20000;
const DEFAULT_RETAIN_MS = 5 * 60 * 1000;
const BROADCAST_CHANNEL = "";

// ============================================
// PENDING ROUTES (standalone)
// ============================================

export function flushPendingStreamRoutes(app: Hono): void {
    const ctx = getAppContext();
    const pending = ctx.pendingStreamRoutes.splice(0);
    for (const fn of pending) fn(app);
}

// ============================================
// STREAM REGISTRY — for app.reset() in tests
// ============================================

/**
 * Tracks every event stream created at runtime so test helpers can iterate
 * and reset them between tests. Streams are objects, not values per-app, so
 * the registry is process-global. `app.reset()` walks this set.
 */
const streamRegistry = new Set<EventStream<unknown, unknown>>();

/** @internal Used by `@mauroandre/velojs/testing` to reset all streams. */
export function getRegisteredStreams(): ReadonlySet<EventStream<unknown, unknown>> {
    return streamRegistry;
}

// ============================================
// FACTORY
// ============================================

export function createEventStream<TEvent, TSnapshot = TEvent>(
    config: EventStreamConfig<TEvent, TSnapshot> = {}
): EventStream<TEvent, TSnapshot> {
    // Sanity: broadcast and channel are mutually exclusive concepts
    if (config.broadcast && config.channel) {
        console.warn(
            "[velojs] createEventStream: `broadcast: true` ignores `channel`. " +
            "Remove one of them — broadcast streams have no channels."
        );
    }

    // Sanity: source and perChannelSource are mutually exclusive
    if (config.source && config.perChannelSource) {
        throw new Error(
            "[velojs] createEventStream: `source` and `perChannelSource` are mutually " +
            "exclusive. Use `source` for stream-wide producers or `perChannelSource` " +
            "for per-channel resources, not both."
        );
    }

    const listeners = new Map<string, Set<StreamListener<TEvent>>>();
    const buffers = new Map<string, TEvent[]>();
    const closedChannels = new Set<string>();
    const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

    // Source lifecycle: started on first subscriber across all channels,
    // aborted when last subscriber disappears.
    let sourceController: AbortController | null = null;
    let totalSubscribers = 0;

    // Per-channel source lifecycle: one AbortController per active channel.
    const perChannelControllers = new Map<string, AbortController>();

    const startSourceIfNeeded = () => {
        if (!config.source) return;
        if (sourceController) return; // already running
        sourceController = new AbortController();
        // Fire-and-forget; user controls lifecycle via abortSignal.
        Promise.resolve(
            config.source(emit as EmitFn<TEvent>, { abortSignal: sourceController.signal })
        ).catch((err) => {
            console.error("[velojs] event stream source threw:", err);
        });
    };

    const stopSourceIfIdle = () => {
        if (totalSubscribers > 0) return;
        if (!sourceController) return;
        sourceController.abort();
        sourceController = null;
    };

    const startPerChannelSource = (channelKey: string) => {
        if (!config.perChannelSource) return;
        if (perChannelControllers.has(channelKey)) return; // already running
        const ctrl = new AbortController();
        perChannelControllers.set(channelKey, ctrl);

        // Channel-bound emit: user passes only the value
        const channelEmit = (event: TEvent, options?: EmitOptions) => {
            (stream.emit as any)(channelKey, event, options);
        };

        Promise.resolve(
            config.perChannelSource(channelKey, channelEmit, { abortSignal: ctrl.signal })
        ).catch((err) => {
            console.error(
                `[velojs] perChannelSource threw for channel "${channelKey}":`,
                err
            );
        });
    };

    const stopPerChannelSource = (channelKey: string) => {
        const ctrl = perChannelControllers.get(channelKey);
        if (!ctrl) return;
        ctrl.abort();
        perChannelControllers.delete(channelKey);
    };

    function emit(
        eventOrChannel: TEvent | string,
        valueOrOptions?: TEvent | EmitOptions,
        maybeOptions?: EmitOptions
    ): void {
        let channel: string;
        let event: TEvent;
        let options: EmitOptions | undefined;

        // Default: channel-aware. Opt-in to broadcast via `broadcast: true`.
        const isBroadcast = !!config.broadcast;

        if (isBroadcast) {
            channel = BROADCAST_CHANNEL;
            event = eventOrChannel as TEvent;
            options = valueOrOptions as EmitOptions | undefined;
        } else {
            channel = eventOrChannel as string;
            event = valueOrOptions as TEvent;
            options = maybeOptions;
        }

        // Warn-and-ignore if emitting to a closed channel
        if (closedChannels.has(channel)) {
            console.warn(
                `[velojs] emit() called on closed channel "${channel}" — ignored. ` +
                `Reopen the channel by emitting to a fresh ID, or remove the close() call.`
            );
            return;
        }

        // Append to buffer if snapshot:true (with optional FIFO ring limit)
        if (options?.snapshot) {
            const buffer = buffers.get(channel) ?? [];
            buffer.push(event);
            const limit = config.bufferSize ?? Infinity;
            if (buffer.length > limit) {
                buffer.splice(0, buffer.length - limit);
            }
            buffers.set(channel, buffer);
        }

        const channelListeners = listeners.get(channel);
        if (channelListeners) {
            for (const listener of channelListeners) listener(event);
        }
    }

    function close(channel: string = BROADCAST_CHANNEL): void {
        if (closedChannels.has(channel)) return;
        closedChannels.add(channel);

        // Notify current subscribers so client-side `closed.value = true`
        const channelListeners = listeners.get(channel);
        if (channelListeners) {
            for (const listener of channelListeners) listener.close();
        }

        // Schedule buffer cleanup after retainMs
        const retain = config.retainMs ?? DEFAULT_RETAIN_MS;
        const existing = cleanupTimers.get(channel);
        if (existing) clearTimeout(existing);
        cleanupTimers.set(
            channel,
            setTimeout(() => {
                buffers.delete(channel);
                cleanupTimers.delete(channel);
                closedChannels.delete(channel);
            }, retain)
        );
    }

    const stream: EventStream<TEvent, TSnapshot> = {
        emit: emit as EventStream<TEvent, TSnapshot>["emit"],
        close,
        __isVeloEventStream: true,
        __config: config,
        __listeners: listeners,
        __buffers: buffers,
        __path: config.path,
        __onConnect(channelKey: string, listener: StreamListener<TEvent>) {
            let set = listeners.get(channelKey);
            const wasFirstInChannel = !set || set.size === 0;
            if (!set) {
                set = new Set();
                listeners.set(channelKey, set);
            }
            set.add(listener);
            totalSubscribers++;
            startSourceIfNeeded();
            if (wasFirstInChannel) startPerChannelSource(channelKey);
        },
        __onDisconnect(channelKey: string, listener: StreamListener<TEvent>) {
            const set = listeners.get(channelKey);
            if (!set) return;
            set.delete(listener);
            if (set.size === 0) {
                listeners.delete(channelKey);
                stopPerChannelSource(channelKey);
            }
            totalSubscribers--;
            stopSourceIfIdle();
        },
        __reset() {
            // Notify subscribers and clear listeners
            for (const set of listeners.values()) {
                for (const l of set) {
                    try { l.close(); } catch {}
                }
            }
            listeners.clear();
            buffers.clear();
            closedChannels.clear();
            // Clear pending retention timers
            for (const t of cleanupTimers.values()) clearTimeout(t);
            cleanupTimers.clear();
            // Abort source / perChannelSources
            if (sourceController) {
                sourceController.abort();
                sourceController = null;
            }
            for (const ctrl of perChannelControllers.values()) ctrl.abort();
            perChannelControllers.clear();
            totalSubscribers = 0;
        },
    };

    // Standalone usage: register the route immediately via the pending queue
    if (config.path) {
        getAppContext().pendingStreamRoutes.push((app) => {
            registerStreamHandler(app, config.path!, stream, config.middlewares ?? []);
        });
    }

    // Register stream in the global registry so app.reset() can find it
    streamRegistry.add(stream as EventStream<unknown, unknown>);

    return stream;
}

// ============================================
// POLL HELPER
// ============================================

/**
 * Creates a `source` function that runs `tick` every `intervalMs` while subscribed.
 * The tick function is wrapped in try/catch — errors are logged but don't stop the loop.
 *
 * ```typescript
 * export const stream_metrics = createEventStream<Metric[]>({
 *     source: poll({
 *         intervalMs: 3000,
 *         tick: async (emit) => emit(await collectMetrics()),
 *     }),
 * });
 * ```
 */
export function poll<TEvent>(opts: {
    intervalMs: number;
    tick: (emit: EmitFn<TEvent>) => void | Promise<void>;
}): SourceFn<TEvent> {
    return async (emit, { abortSignal }) => {
        while (!abortSignal.aborted) {
            try {
                await opts.tick(emit);
            } catch (err) {
                console.error("[velojs] poll tick threw:", err);
            }
            // Cancellable sleep
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, opts.intervalMs);
                abortSignal.addEventListener(
                    "abort",
                    () => {
                        clearTimeout(timer);
                        resolve();
                    },
                    { once: true }
                );
            });
        }
    };
}

// ============================================
// SSE HANDLER
// ============================================

/**
 * Default channel function: reads `?channel=...` from the request URL.
 * Used when the stream config doesn't provide one.
 */
function defaultChannelFn(c: Context): string {
    return c.req.query("channel") ?? BROADCAST_CHANNEL;
}

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

        // Resolve channel (may be async, may reject the connection)
        let channelKey: string;
        if (stream.__config.broadcast) {
            channelKey = BROADCAST_CHANNEL;
        } else {
            const resolver = stream.__config.channel ?? defaultChannelFn;
            let resolved: string | null | undefined;
            try {
                resolved = await resolver(c);
            } catch (err) {
                console.error("[velojs] channel resolver threw:", err);
                return c.json({ error: "internal" }, 500);
            }
            if (resolved == null) {
                return c.json({ error: "forbidden" }, 403);
            }
            channelKey = resolved;
        }

        const heartbeatMs = stream.__config.heartbeatMs;
        const heartbeatInterval =
            heartbeatMs === false ? 0 : (heartbeatMs ?? DEFAULT_HEARTBEAT_MS);

        return streamSSE(c, async (sse) => {
            // ---------- Snapshot-on-connect ----------
            // 1. Buffered events from { snapshot: true } emits
            const bufferedEvents = stream.__buffers.get(channelKey);
            if (bufferedEvents && bufferedEvents.length > 0) {
                await sse.writeSSE({
                    event: "snapshot",
                    data: JSON.stringify(bufferedEvents),
                });
            }

            // 2. Custom snapshot callback (state-machine pattern)
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

            // ---------- Connection lifecycle ----------
            let resolveDone: () => void;
            const done = new Promise<void>((resolve) => {
                resolveDone = resolve;
            });

            let disposed = false;
            let heartbeat: ReturnType<typeof setInterval> | null = null;

            // Write chain — serializes sse.writeSSE calls so that a fast burst
            // of emit(...) followed by sse.close() doesn't drop the tail.
            // Writes are enqueued; close waits for the chain to drain.
            let writeChain: Promise<void> = Promise.resolve();
            const enqueueWrite = (payload: Parameters<typeof sse.writeSSE>[0]) => {
                writeChain = writeChain
                    .then(() => sse.writeSSE(payload))
                    .catch(() => {});
                return writeChain;
            };

            const cleanup = () => {
                if (disposed) return;
                disposed = true;
                if (heartbeat) clearInterval(heartbeat);
                stream.__onDisconnect(channelKey, listener);
                resolveDone();
            };

            // Listener function with attached `close()` for explicit close() signaling
            const listener = ((event: TEvent) => {
                if (disposed) return;
                enqueueWrite({ data: JSON.stringify(event) });

                if (stream.__config.closeOn?.(event)) {
                    // Wait for the event write (and any prior pending writes) to drain
                    // before closing the writable, otherwise the tail is lost.
                    writeChain.then(() => {
                        sse.close();
                        cleanup();
                    });
                }
            }) as StreamListener<TEvent>;

            listener.close = () => {
                if (disposed) return;
                // Send close event so client distinguishes deliberate close from network drop
                enqueueWrite({ event: "close", data: "" });
                // Drain first — any emits queued before us must reach the client.
                writeChain.then(() => {
                    sse.close();
                    cleanup();
                });
            };

            stream.__onConnect(channelKey, listener);

            // Heartbeat to keep idle proxies open — also goes through the chain
            // so it doesn't interleave mid-event with actual data writes.
            heartbeat =
                heartbeatInterval > 0
                    ? setInterval(() => {
                          if (disposed) return;
                          enqueueWrite({ event: "heartbeat", data: "" });
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
