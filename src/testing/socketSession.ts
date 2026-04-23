/**
 * In-memory WebSocket session for tests.
 *
 * Invokes a `socket_*` handler directly with a mock Context — bypassing the
 * real HTTP upgrade path. Middlewares do NOT run; set `opts.user` to supply
 * `c.get("user")`.
 */

import type { Hono } from "hono";
import type { SocketHandler, SocketHandlerArgs } from "../sockets.js";
import type { SocketTestOptions, TestSocketSession, NextOptions } from "./types.js";
import { getAppSockets, trackSocketSession } from "../sockets.js";
import { buildMockContext } from "./mockContext.js";

function resolveHandler(
    hono: Hono,
    input: SocketHandler | { __path?: string } | string
): { handler: SocketHandler; path: string } {
    // String path
    if (typeof input === "string") {
        const reg = getAppSockets(hono).get(input);
        if (!reg) {
            throw new Error(
                `[velojs/testing] no socket handler registered at "${input}". ` +
                `Make sure the route exports a socket_* handler and routes are wired.`
            );
        }
        return { handler: reg.handler, path: input };
    }
    // Function (server-imported socket_* handler)
    if (typeof input === "function") {
        const path = (input as any).__path as string | undefined;
        if (!path) {
            throw new Error(
                "[velojs/testing] socket handler has no __path. Make sure your " +
                "vitest.config.ts loads veloPlugin() and your routes are registered."
            );
        }
        return { handler: input as SocketHandler, path };
    }
    // Stub (client-side shape { __path })
    if (input && typeof input === "object" && typeof input.__path === "string") {
        const path = input.__path;
        const reg = getAppSockets(hono).get(path);
        if (!reg) {
            throw new Error(
                `[velojs/testing] stub with __path="${path}" has no matching server handler.`
            );
        }
        return { handler: reg.handler, path };
    }
    throw new Error("[velojs/testing] socket(): unrecognized handler argument");
}

export async function buildSocketSession(
    hono: Hono,
    handlerInput: SocketHandler | { __path?: string } | string,
    opts: SocketTestOptions = {}
): Promise<TestSocketSession> {
    const { handler, path: _path } = resolveHandler(hono, handlerInput);

    // Build a mock Context so the handler gets `c.get("user")`, params, query, etc.
    const mockOpts: Parameters<typeof buildMockContext>[0] = {
        params: opts.params ?? {},
        query: {
            ...(opts.query as Record<string, string> | undefined),
            ...(opts.channel ? { channel: opts.channel } : {}),
        },
    };
    if (opts.user !== undefined) mockOpts.user = opts.user;
    if (opts.headers) mockOpts.headers = opts.headers;
    if (opts.cookies) mockOpts.cookies = opts.cookies;
    const c = buildMockContext(mockOpts);

    // ---------- Incoming (client → server) queue ----------
    const incomingQueue: (string | Uint8Array)[] = [];
    let incomingResolve: (() => void) | null = null;
    let incomingClosed = false;

    const incoming: AsyncIterable<string | Uint8Array> = {
        async *[Symbol.asyncIterator]() {
            while (true) {
                while (incomingQueue.length > 0) {
                    yield incomingQueue.shift()!;
                }
                if (incomingClosed) return;
                await new Promise<void>((r) => (incomingResolve = r));
                incomingResolve = null;
            }
        },
    };

    const pushIncoming = (msg: string | Uint8Array) => {
        if (incomingClosed) return;
        incomingQueue.push(msg);
        incomingResolve?.();
    };

    const closeIncoming = () => {
        if (incomingClosed) return;
        incomingClosed = true;
        incomingResolve?.();
    };

    // ---------- Outgoing (server → client) messages ----------
    const messages: (string | Uint8Array)[] = [];
    let messageWaiters: Array<() => void> = [];

    const pushOutgoing = (msg: string | Uint8Array) => {
        messages.push(msg);
        const waiters = messageWaiters;
        messageWaiters = [];
        for (const w of waiters) {
            try { w(); } catch {}
        }
    };

    // ---------- Lifecycle ----------
    const ctrl = new AbortController();
    const untrack = trackSocketSession(hono, ctrl);
    let kept = false;
    let finished = false;

    const send: SocketHandlerArgs["send"] = (msg) => {
        if (finished) return;
        if (typeof msg === "string") {
            pushOutgoing(msg);
        } else if (msg instanceof Uint8Array) {
            pushOutgoing(msg);
        } else {
            pushOutgoing(JSON.stringify(msg));
        }
    };

    const close: SocketHandlerArgs["close"] = (_code?: number, _reason?: string) => {
        // Server-initiated close: end incoming, abort
        void _code; void _reason;
        finalize();
    };

    const keepOpen: SocketHandlerArgs["keepOpen"] = () => {
        kept = true;
    };

    const finalize = () => {
        if (finished) return;
        finished = true;
        if (!ctrl.signal.aborted) {
            try { ctrl.abort(); } catch {}
        }
        untrack();
        closeIncoming();
        const waiters = messageWaiters;
        messageWaiters = [];
        for (const w of waiters) {
            try { w(); } catch {}
        }
    };

    // Run the handler
    const handlerArgs: SocketHandlerArgs = {
        incoming,
        send,
        close,
        keepOpen,
        abortSignal: ctrl.signal,
        c,
        params: opts.params ?? {},
        query: {
            ...(opts.query as Record<string, string> | undefined ?? {}),
            ...(opts.channel ? { channel: opts.channel } : {}),
        },
    };

    const done = (async () => {
        try {
            await handler(handlerArgs);
        } catch (err) {
            console.error("[velojs/testing] socket handler threw:", err);
        }
        // If the handler returned without keepOpen, finalize — same rule as
        // the production runtime (keepOpen controls auto-close on return).
        if (!kept) finalize();
    })();

    // ---------- TestSocketSession API ----------
    const waitForNextMessage = (timeoutMs: number): Promise<void> => {
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                messageWaiters = messageWaiters.filter((w) => w !== onResolve);
                reject(new Error(`[velojs/testing] socket.next() timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            const onResolve = () => {
                clearTimeout(timer);
                resolve();
            };
            messageWaiters.push(onResolve);
        });
    };

    // Consumer cursor — advances as next()/nextN() are called.
    let nextCursor = 0;

    const session: TestSocketSession = {
        send(msg) {
            if (finished) return;
            if (typeof msg === "string" || msg instanceof Uint8Array) {
                pushIncoming(msg);
            } else {
                pushIncoming(JSON.stringify(msg));
            }
        },
        get messages(): ReadonlyArray<string | Uint8Array> {
            return messages;
        },
        get closed() {
            return finished;
        },
        async next(nextOpts: NextOptions) {
            while (nextCursor >= messages.length) {
                if (finished) {
                    throw new Error("[velojs/testing] socket closed before next()");
                }
                await waitForNextMessage(nextOpts.timeoutMs);
            }
            return messages[nextCursor++]!;
        },
        async nextN(n: number, nextOpts: NextOptions) {
            const deadline = Date.now() + nextOpts.timeoutMs;
            const collected: (string | Uint8Array)[] = [];
            while (collected.length < n) {
                if (nextCursor < messages.length) {
                    collected.push(messages[nextCursor++]!);
                    continue;
                }
                if (finished) {
                    throw new Error("[velojs/testing] socket closed before nextN()");
                }
                const remaining = deadline - Date.now();
                if (remaining <= 0) {
                    throw new Error(
                        `[velojs/testing] socket.nextN() timed out after ${nextOpts.timeoutMs}ms`
                    );
                }
                await waitForNextMessage(remaining);
            }
            return collected;
        },
        async close(_code?: number, _reason?: string) {
            void _code; void _reason;
            finalize();
            // Let the handler's return logic run briefly so microtasks flush
            await Promise.race([
                done,
                new Promise<void>((r) => setTimeout(r, 50)),
            ]);
        },
        done,
    };

    return session;
}
