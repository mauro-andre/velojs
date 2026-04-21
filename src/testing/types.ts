/**
 * Public types for the VeloJS testing toolkit.
 */

import type { Hono, Context } from "hono";
import type { AppRoutes } from "../types.js";
import type { EventStream } from "../events.js";

export type Cookies = Record<string, string>;
export type Headers = Record<string, string>;
export type Query = Record<string, string | string[]>;
export type Params = Record<string, string>;

export interface CreateTestAppOptions {
    /** App routes — typically `import { routes } from "./app/routes.js"`. */
    routes: AppRoutes;
    /**
     * Optional setup that runs once before the app is created.
     * Use for DB connections, index creation, or any side effects that the
     * production `app/server.tsx` would do at startup.
     *
     * `addRoutes()` and `onServer()` calls here are scoped to this app only.
     */
    bootstrap?: () => void | Promise<void>;
    /**
     * Optional callback that maps a `user` (or any opaque object) to the
     * cookies the test client should attach. Required for `app.as(user)` and
     * `app.sessionCookies(user)`.
     */
    getSessionCookie?: (input: { user: any }) => Promise<Cookies> | Cookies;
}

export interface RequestOptions {
    /** Cookies serialized into the `Cookie` header. */
    cookies?: Cookies;
    /** Extra headers (case-insensitive). */
    headers?: Headers;
    /** Query string. Arrays become repeated keys: `{ tag: ["a","b"] }` → `?tag=a&tag=b`. */
    query?: Query;
}

export interface BodyRequestOptions extends RequestOptions {
    /** Body — plain object → JSON; FormData/URLSearchParams/Blob/string passed as-is. */
    body?: unknown;
}

export interface LoaderRequestOptions extends RequestOptions {
    /** URL params (for routes with `:id` placeholders). */
    params?: Params;
}

/** Wraps the Hono Response. */
export interface TestResponse {
    status: number;
    headers: Headers;
    json<T = any>(): Promise<T>;
    text(): Promise<string>;
    blob(): Promise<Blob>;
    /** Cookie header parsed: `{ session: "value" }`. */
    cookies: Cookies;
    /** Underlying Response (Fetch spec). */
    raw: Response;
}

export interface SubscribeOptions extends RequestOptions {
    /** Channel ID — sent as `?channel=...`. */
    channel?: string;
}

export interface NextOptions {
    /** Reject if no event arrives within this many ms. */
    timeoutMs: number;
}

export interface TestSubscription<TEvent = any, TSnapshot = any> {
    /** HTTP status of the initial SSE response (200, 403, etc). */
    readonly status: number;
    /** All events received since connect, in order. */
    readonly events: ReadonlyArray<TEvent>;
    /** Snapshot from the server (if any). */
    readonly snapshot: TSnapshot | null;
    /** True when the server signaled a deliberate close (closeOn / stream.close). */
    readonly closed: boolean;

    /** Wait for the next event. Rejects on timeout. */
    next(opts: NextOptions): Promise<TEvent>;
    /** Wait for N events. Total timeout, not per-event. */
    nextN(n: number, opts: NextOptions): Promise<TEvent[]>;
    /** Force disconnect. Triggers per-channel source abortSignal server-side. */
    close(): Promise<void>;
}

export interface MockContextOptions {
    user?: any;
    params?: Params;
    query?: Record<string, string>;
    body?: unknown;
    headers?: Headers;
    cookies?: Cookies;
}

export interface TestApp {
    /** Underlying Hono app. */
    readonly hono: Hono;

    // HTTP
    get(path: string, opts?: RequestOptions): Promise<TestResponse>;
    post(path: string, opts?: BodyRequestOptions): Promise<TestResponse>;
    put(path: string, opts?: BodyRequestOptions): Promise<TestResponse>;
    patch(path: string, opts?: BodyRequestOptions): Promise<TestResponse>;
    delete(path: string, opts?: RequestOptions): Promise<TestResponse>;

    // Conventions
    /**
     * Invoke a `action_*` server function via HTTP. Auto-resolves URL from the
     * function's metadata (injected by the VeloJS Vite plugin).
     */
    action(fn: Function | string, opts?: BodyRequestOptions): Promise<TestResponse>;

    /**
     * Invoke a `loader` server function. By default unwraps the response data:
     * - Resolved normally → returns the loader's return value
     * - Threw → re-throws
     * - Redirected → returns a `TestResponse` for status inspection
     */
    loader<T = any>(fn: Function | string, opts?: LoaderRequestOptions): Promise<T | TestResponse>;

    // Streams
    subscribe<TEvent = any, TSnapshot = any>(
        stream: EventStream<TEvent, TSnapshot> | string,
        opts?: SubscribeOptions
    ): Promise<TestSubscription<TEvent, TSnapshot>>;

    // Auth
    /** Build cookies for a user via `getSessionCookie` config. */
    sessionCookies(input: { user: any }): Promise<Cookies>;
    /** Sub-client with cookies automatically applied to every request. */
    as(input: { user: any }): TestApp;

    // Escape hatches
    mockContext(opts?: MockContextOptions): Context;

    // Lifecycle
    /** Reset all transient state (stream buffers, listeners, retention timers). */
    reset(): Promise<void>;
    /** Tear down everything (timers, callbacks). Vitest must report zero open handles. */
    close(): Promise<void>;
}
