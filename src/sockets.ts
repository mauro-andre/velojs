/**
 * VeloJS Sockets — declarative WebSocket convention.
 *
 * Dev pattern: export `socket_<name>` from a page/layout module.
 *
 * ```typescript
 * // app/workers/WorkerTerminal.tsx
 * export const socket_terminal = async ({
 *     incoming, send, keepOpen, close, abortSignal, c, params, query,
 * }) => {
 *     const user = c.get("user");
 *     const session = await createTerminal(params.workerId);
 *     session.on("data", (d) => send({ type: "data", data: d.toString() }));
 *     abortSignal.addEventListener("abort", () => session.destroy());
 *     keepOpen();
 *     for await (const raw of incoming) {
 *         const msg = JSON.parse(typeof raw === "string" ? raw : "");
 *         if (msg.type === "resize") session.resize(msg.cols, msg.rows);
 *         else if (msg.type === "data") session.write(msg.data);
 *     }
 * };
 * ```
 *
 * The plugin strips `socket_*` bodies from the client bundle and replaces them
 * with a stub carrying `__path`. On the client, use `useSocket(socket_terminal)`.
 */

import type { Context, Hono, MiddlewareHandler } from "hono";
import type { RouteNode } from "./types.js";

// ============================================
// TYPES
// ============================================

export interface SocketHandlerArgs {
    /** Raw message frames from the client. Text frames → `string`, binary → `Uint8Array`. */
    incoming: AsyncIterable<string | Uint8Array>;
    /** Send a message. Objects are auto-serialized with `JSON.stringify`. */
    send: (msg: string | Uint8Array | object) => void;
    /** Close the socket imperatively. Accepts an optional WS close code + reason. */
    close: (code?: number, reason?: string) => void;
    /**
     * Mark the socket as long-running. If the handler returns without calling
     * `keepOpen()`, the framework closes the socket. When `keepOpen()` is set,
     * the socket stays open until the abort signal fires.
     *
     * `for await (const msg of incoming)` naturally keeps the handler alive
     * while messages flow — `keepOpen()` is redundant in that case but not
     * harmful.
     */
    keepOpen: () => void;
    /** Fires when the client disconnects, the server aborts, or `app.close()` is called. */
    abortSignal: AbortSignal;
    /** Hono Context — use `c.get("user")` etc. for middleware-provided values. */
    c: Context;
    /** URL params (e.g. `/:workerId`). */
    params: Record<string, string>;
    /** Query-string values. */
    query: Record<string, string>;
}

export type SocketHandler = ((args: SocketHandlerArgs) => void | Promise<void>) & {
    /**
     * Populated at runtime by the socket registrar (and by the Vite plugin on the
     * client bundle, where the function is replaced by a stub). Lets consumers
     * pass the declared `socket_*` value straight into `useSocket(...)` without
     * casting.
     */
    readonly __path?: string;
};

/** Client-side stub shape — what the Vite plugin replaces `socket_*` with on the client bundle. */
export interface SocketStub {
    readonly __isVeloSocket: true;
    readonly __path: string;
}

// ============================================
// PARSE JSON HELPER
// ============================================

/**
 * Wraps a raw `incoming` iterable so each frame is JSON-parsed. Invalid JSON
 * frames are skipped with a console warning (not thrown). Use when all client
 * messages are JSON objects.
 *
 * ```typescript
 * for await (const msg of parseJson<TerminalMsg>(incoming)) {
 *     if (msg.type === "resize") session.resize(msg.cols, msg.rows);
 * }
 * ```
 */
export async function* parseJson<T = unknown>(
    incoming: AsyncIterable<string | Uint8Array>
): AsyncIterable<T> {
    for await (const raw of incoming) {
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        try {
            yield JSON.parse(text) as T;
        } catch {
            console.warn("[velojs] parseJson: invalid JSON frame, skipped");
        }
    }
}

// ============================================
// PER-APP ADAPTER + REGISTRY
// ============================================

interface NodeWsAdapter {
    upgradeWebSocket: (...args: any[]) => MiddlewareHandler;
    injectWebSocket: (server: any) => void;
}

const adapters = new WeakMap<Hono, NodeWsAdapter>();

interface RegisteredSocket {
    path: string;
    handler: SocketHandler;
    middlewares: MiddlewareHandler[];
}

const appSockets = new WeakMap<Hono, Map<string, RegisteredSocket>>();
const activeSessions = new WeakMap<Hono, Set<AbortController>>();

async function getAdapter(app: Hono): Promise<NodeWsAdapter | null> {
    let adapter = adapters.get(app);
    if (adapter) return adapter;
    try {
        const mod = await import("@hono/node-ws");
        adapter = mod.createNodeWebSocket({ app }) as NodeWsAdapter;
        adapters.set(app, adapter);
        return adapter;
    } catch (err) {
        console.error("[velojs] failed to load @hono/node-ws:", err);
        return null;
    }
}

function addSession(app: Hono, ctrl: AbortController): void {
    let set = activeSessions.get(app);
    if (!set) {
        set = new Set();
        activeSessions.set(app, set);
    }
    set.add(ctrl);
}

function removeSession(app: Hono, ctrl: AbortController): void {
    activeSessions.get(app)?.delete(ctrl);
}

/** @internal Used by the testing toolkit so `app.close()` aborts in-memory sessions too. */
export function trackSocketSession(app: Hono, ctrl: AbortController): () => void {
    addSession(app, ctrl);
    return () => removeSession(app, ctrl);
}

/** @internal Abort every open socket session on `app`. Called by testing toolkit + disposers. */
export function abortAllSocketSessions(app: Hono): void {
    const set = activeSessions.get(app);
    if (!set) return;
    for (const ctrl of set) {
        try { ctrl.abort(); } catch {}
    }
    set.clear();
}

/** @internal Returns registered sockets for `app` (used by the testing toolkit). */
export function getAppSockets(app: Hono): ReadonlyMap<string, RegisteredSocket> {
    return appSockets.get(app) ?? new Map();
}

// ============================================
// HANDLER WRAPPER — builds the upgradeWebSocket event shape
// ============================================

function buildEvents(
    app: Hono,
    handler: SocketHandler,
    c: Context
) {
    const queue: (string | Uint8Array)[] = [];
    let resolveNext: (() => void) | null = null;
    let streamClosed = false;
    let kept = false;
    let wsRef: any = null;

    const ctrl = new AbortController();
    addSession(app, ctrl);

    const incoming: AsyncIterable<string | Uint8Array> = {
        async *[Symbol.asyncIterator]() {
            while (true) {
                while (queue.length > 0) {
                    yield queue.shift()!;
                }
                if (streamClosed) return;
                await new Promise<void>((r) => {
                    resolveNext = r;
                });
                resolveNext = null;
            }
        },
    };

    const send = (msg: string | Uint8Array | object): void => {
        if (!wsRef || streamClosed) return;
        try {
            if (typeof msg === "string" || msg instanceof Uint8Array) {
                wsRef.send(msg);
            } else {
                wsRef.send(JSON.stringify(msg));
            }
        } catch (err) {
            console.error("[velojs] socket send failed:", err);
        }
    };

    const closeFn = (code?: number, reason?: string): void => {
        if (!wsRef) return;
        try {
            wsRef.close(code, reason);
        } catch {}
    };

    const keepOpen = (): void => {
        kept = true;
    };

    const finalize = () => {
        if (!streamClosed) {
            streamClosed = true;
            resolveNext?.();
        }
        if (!ctrl.signal.aborted) {
            try { ctrl.abort(); } catch {}
        }
        removeSession(app, ctrl);
    };

    return {
        events: {
            onOpen(_evt: any, ws: any) {
                wsRef = ws;
                Promise.resolve(
                    handler({
                        incoming,
                        send,
                        close: closeFn,
                        keepOpen,
                        abortSignal: ctrl.signal,
                        c,
                        params: c.req.param(),
                        query: c.req.query(),
                    })
                )
                    .then(() => {
                        // If the handler returned without keepOpen, close the socket.
                        if (!kept && wsRef && !streamClosed) {
                            try { wsRef.close(); } catch {}
                        }
                    })
                    .catch((err) => {
                        console.error("[velojs] socket handler threw:", err);
                        try { wsRef?.close(1011, "handler error"); } catch {}
                    });
            },
            onMessage(evt: any) {
                if (streamClosed) return;
                const data = evt.data;
                if (typeof data === "string") {
                    queue.push(data);
                } else if (data instanceof ArrayBuffer) {
                    queue.push(new Uint8Array(data));
                } else if (data && typeof data === "object" && "buffer" in data && data.buffer instanceof ArrayBuffer) {
                    queue.push(new Uint8Array(data.buffer as ArrayBuffer));
                }
                resolveNext?.();
            },
            onClose() {
                finalize();
            },
            onError() {
                finalize();
            },
        },
        cleanup: finalize,
    };
}

// ============================================
// REGISTRATION
// ============================================

export async function registerSocketHandler(
    app: Hono,
    path: string,
    handler: SocketHandler,
    middlewares: MiddlewareHandler[] = []
): Promise<void> {
    // Always store in the per-app registry (for the testing toolkit).
    let reg = appSockets.get(app);
    if (!reg) {
        reg = new Map();
        appSockets.set(app, reg);
    }
    reg.set(path, { path, handler, middlewares });

    // Get adapter (loads @hono/node-ws on first use per app).
    const adapter = await getAdapter(app);
    if (!adapter) return;

    const routeMw = adapter.upgradeWebSocket((c: Context) => {
        return buildEvents(app, handler, c).events;
    });

    if (middlewares.length > 0) {
        app.on(["GET"], [path], ...middlewares, routeMw);
    } else {
        app.on(["GET"], [path], routeMw);
    }
}

/** Walks the route tree and registers every `socket_*` export. */
export async function registerSocketRoutes(
    app: Hono,
    nodes: RouteNode[],
    parentMiddlewares: MiddlewareHandler[] = []
): Promise<void> {
    const visit = async (
        subNodes: RouteNode[],
        inherited: MiddlewareHandler[]
    ): Promise<void> => {
        for (const node of subNodes) {
            const moduleId = node.module?.metadata?.moduleId;
            const currentMw = [...inherited, ...(node.middlewares ?? [])];

            if (node.module && moduleId) {
                for (const key of Object.keys(node.module)) {
                    if (!key.startsWith("socket_")) continue;
                    const handler = (node.module as unknown as Record<string, unknown>)[key];
                    if (typeof handler !== "function") {
                        console.warn(
                            `[velojs] socket_* export ${moduleId}/${key} is not a function; skipped`
                        );
                        continue;
                    }
                    const name = key.replace("socket_", "");
                    const path = `/_socket/${moduleId}/${name}`;
                    // Attach `__path` to the function so testing toolkit can do `app.socket(fn)`
                    try { (handler as any).__path = path; } catch {}
                    try { (handler as any).__isVeloSocket = true; } catch {}
                    await registerSocketHandler(app, path, handler as SocketHandler, currentMw);
                }
            }

            if (node.children) await visit(node.children, currentMw);
        }
    };
    await visit(nodes, parentMiddlewares);
}

// ============================================
// INJECT INTO HTTP SERVER (dev + prod)
// ============================================

/**
 * Inject the WebSocket adapter into an HTTP server. Call after `serve()`
 * returns (prod) or with Vite's dev http server (dev).
 *
 * No-op when no sockets are registered on `app`.
 *
 * The server is wrapped so that `upgrade` listeners registered by
 * `@hono/node-ws` only fire for requests whose pathname matches a registered
 * `socket_*` route. Without this, the adapter's listener treats every upgrade
 * as a candidate and replies with an HTTP status, which corrupts the handshake
 * for other listeners on the same server (notably Vite's HMR WebSocket in
 * dev mode).
 */
export async function injectWebSocketServer(app: Hono, server: any): Promise<void> {
    const adapter = adapters.get(app);
    if (!adapter) return;

    const filteredServer = new Proxy(server, {
        get(target, prop, receiver) {
            if (prop === "on" || prop === "addListener") {
                return (event: string, listener: (...args: any[]) => void) => {
                    if (event !== "upgrade") {
                        return target[prop](event, listener);
                    }
                    return target[prop]("upgrade", (req: any, socket: any, head: any) => {
                        const host = req.headers?.host ?? "localhost";
                        let pathname: string;
                        try {
                            pathname = new URL(req.url ?? "/", `http://${host}`).pathname;
                        } catch {
                            return;
                        }
                        if (!appSockets.get(app)?.has(pathname)) return;
                        listener(req, socket, head);
                    });
                };
            }
            return Reflect.get(target, prop, receiver);
        },
    });

    try {
        adapter.injectWebSocket(filteredServer);
    } catch (err) {
        console.error("[velojs] injectWebSocket failed:", err);
    }
}
