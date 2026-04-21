/**
 * App context — scoped via a swappable global slot so multiple test apps
 * can coexist without polluting each other's pending route registrations.
 *
 * Production runtime uses a single default context implicitly. Tests create
 * isolated contexts via `withAppContext()` which swaps the slot for the
 * duration of the call.
 *
 * NOTE: this module is client-safe (no `node:async_hooks` import). Vitest runs
 * each test file in its own worker, so a simple swappable slot is sufficient
 * for parallelism between files. Within a single file, tests run sequentially
 * unless `describe.concurrent`/`it.concurrent` is used.
 */

import type { Hono } from "hono";

type RouteRegisterFn = (app: Hono) => void | Promise<void>;
type StreamRouteRegisterFn = (app: Hono) => void;
type ServerCallbackFn = (server: any) => void;

export interface AppContext {
    pendingRoutes: RouteRegisterFn[];
    pendingStreamRoutes: StreamRouteRegisterFn[];
    serverCallbacks: ServerCallbackFn[];
    disposers: Set<() => void>;
}

function emptyContext(): AppContext {
    return {
        pendingRoutes: [],
        pendingStreamRoutes: [],
        serverCallbacks: [],
        disposers: new Set(),
    };
}

const defaultContext = emptyContext();
let currentContext: AppContext = defaultContext;

export function getAppContext(): AppContext {
    return currentContext;
}

/**
 * Run a function within an isolated app context (for tests).
 * Restores the previous context after the function resolves/rejects.
 */
export async function withAppContext<T>(
    ctx: AppContext,
    fn: () => T | Promise<T>
): Promise<T> {
    const prev = currentContext;
    currentContext = ctx;
    try {
        return await fn();
    } finally {
        currentContext = prev;
    }
}

/**
 * Create a new isolated context. Inherits a SNAPSHOT of the default context
 * so any addRoutes/onServer/createEventStream calls that happened at top-level
 * import time are captured.
 */
export function createIsolatedContext(): AppContext {
    return {
        pendingRoutes: [...defaultContext.pendingRoutes],
        pendingStreamRoutes: [...defaultContext.pendingStreamRoutes],
        serverCallbacks: [...defaultContext.serverCallbacks],
        disposers: new Set(),
    };
}

export function registerDisposer(dispose: () => void): void {
    currentContext.disposers.add(dispose);
}

export function unregisterDisposer(dispose: () => void): void {
    currentContext.disposers.delete(dispose);
}
