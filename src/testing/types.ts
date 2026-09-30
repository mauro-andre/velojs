/**
 * Public types for the VeloJS testing toolkit.
 */

import type { Hono, Context } from "hono";
import type { AppRoutes, RouteModule } from "../types.js";
import type { EventStream } from "../events.js";
import type { SocketHandler, SocketStub } from "../sockets.js";
import type { ChannelMap, ChannelRegistryOptions } from "../channels.js";

export type Cookies = Record<string, string>;
export type Headers = Record<string, string>;
export type Query = Record<string, string | string[]>;
export type Params = Record<string, string>;

export interface CreateTestAppOptions {
    /** App routes — typically `import routes from "./app/routes.js"` (the default export of `routes.tsx`). */
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
    /**
     * The app's live-loader channel map — the same object `app/channels.ts`
     * exports. Registered before the app is created, so the channel routes and
     * `emit()` can resolve partitions. May also be registered from `bootstrap`
     * via `registerChannels()`.
     */
    channels?: ChannelMap;
    /**
     * Options of the channel registration: the coalescing window of the
     * invalidation mode and the emit log. `createTestApp` registers with
     * `coalesceMs: 0` (immediate, deterministic) unless this option says
     * otherwise; `logEmits` defaults to on, as in production.
     */
    channelOptions?: ChannelRegistryOptions;
    /**
     * Serve the app over real TCP on this port, in addition to the in-memory
     * API. Needed when an actor outside this process must reach the app over
     * HTTP (a callback from a worker, a remote webhook sender) — the in-memory
     * methods (`app.get`, `app.action`, …) never leave the process.
     *
     * `0` picks a free port; the real one is on `app.port`/`app.url`. The
     * listener serves the same app instance as the in-memory API, so a request
     * over TCP and a `app.subscribe()` on the same stream see the same registry.
     *
     * Ports always come from this option — never from `process.env.PORT`/`HOST`.
     */
    port?: number;
    /**
     * Interface to bind when `port` is set, mirroring `StartServerOptions`
     * (e.g. `"127.0.0.1"`). Omitted, Node's default applies — all interfaces,
     * which makes the test listener reachable from the local network.
     */
    hostname?: string;
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

export interface SocketTestOptions extends RequestOptions {
    /** Channel ID — sent as `?channel=...` on the WS URL. */
    channel?: string;
    /** URL params (for socket paths with `:param`). */
    params?: Params;
    /** `c.get("user")` value (shortcut — avoids a full middleware chain). */
    user?: any;
}

export interface TestSocketSession {
    /** Send a frame. Objects are `JSON.stringify`'d, strings/Uint8Array pass through. */
    send(msg: string | Uint8Array | object): void;
    /** Wait for the next incoming frame from the server. Rejects on timeout. */
    next(opts: NextOptions): Promise<string | Uint8Array>;
    /** Wait for N incoming frames total (order preserved). */
    nextN(n: number, opts: NextOptions): Promise<(string | Uint8Array)[]>;
    /** All frames received from the server so far. */
    readonly messages: ReadonlyArray<string | Uint8Array>;
    /** True once the server-side handler has finished (or the session was aborted). */
    readonly closed: boolean;
    /** Client-side close — aborts the server handler's abortSignal. */
    close(code?: number, reason?: string): Promise<void>;
    /** Resolves when the handler finishes or the session is aborted. */
    readonly done: Promise<void>;
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

/**
 * A live-loader channel subscription. Every update — the snapshot on connect,
 * each emit's snapshot and each slice — arrives through `next()` as the `data`
 * exactly as it went on the wire (a whole snapshot or a raw slice), so `await
 * next({ timeoutMs })` is the clock: no sleep, no retry, no timing assertion.
 *
 * `nextEvent()` is the same arrival stream discriminated as
 * `{ type: "snapshot" | "slice", data }` — use it when the test cares which
 * mode delivered the update. `next()` and `nextEvent()` each advance their own
 * cursor over the same arrivals, so use one or the other within a test.
 *
 * The connection only exists after the connect snapshot: await the first
 * `next()` before emitting, and the server is guaranteed to have registered it.
 */
export interface TestChannelSubscription<T = any> extends TestSubscription<T, T> {
    /** Next arrival, discriminated by the mode that delivered it. */
    nextEvent(opts: NextOptions): Promise<ChannelEvent<T>>;
}

/** One channel arrival: a whole snapshot or a slice to be merged. */
export interface ChannelEvent<T = any> {
    type: "snapshot" | "slice";
    data: T;
}

/** The module (or moduleId) a channel belongs to, as `app.channel()` accepts it. */
export type ChannelModuleRef =
    | string
    | { metadata?: { moduleId?: string } | undefined };

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

    /**
     * Real port this app listens on when `port` was passed to `createTestApp`
     * (the OS-assigned port when it was `0`). `undefined` in the default
     * in-memory-only mode.
     */
    readonly port: number | undefined;
    /**
     * Base URL of the TCP listener (`http://localhost:<port>` for wildcard or
     * omitted hostnames). `undefined` in the default in-memory-only mode.
     */
    readonly url: string | undefined;

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
     * - Redirected (3xx) → returns a `TestResponse` for status inspection
     * - Non-2xx (a `c.status()` set by the loader, or a 500 from a thrown
     *   error) → returns a `TestResponse`. Nothing is re-thrown: the loader
     *   runs inside a Hono handler, which catches and turns the throw into a
     *   500 response, so `hono.fetch` resolves. Assert on `res.status`, not
     *   with `rejects.toThrow()`.
     */
    loader<T = any>(fn: Function | string, opts?: LoaderRequestOptions): Promise<T | TestResponse>;

    // Streams
    subscribe<TEvent = any, TSnapshot = any>(
        stream: EventStream<TEvent, TSnapshot> | string,
        opts?: SubscribeOptions
    ): Promise<TestSubscription<TEvent, TSnapshot>>;

    // Live loader
    /**
     * Open a live-loader channel connection for a module's declared channel.
     *
     * The module may be the imported route module (its `metadata.moduleId` is
     * read) or a moduleId string. Cookies (and therefore the principal) come
     * from the options or from `app.as(user)`; the route node's middlewares run
     * for real, so an unauthenticated subscription is denied exactly as in
     * production.
     *
     * ```ts
     * const sub = await app.as({ id: 7 }).channel(Gastos, "gastosFamilia");
     * await sub.next({ timeoutMs: 1000 });        // snapshot on connect
     * await emit("gastosFamilia", { familiaId: 7 });
     * expect(await sub.next({ timeoutMs: 1000 })).toEqual({ somaFamilia: 2 });
     *
     * // The same arrivals discriminated: nextEvent() tells a snapshot from a slice.
     * await emit(Gastos, "gastosFamilia", { familiaId: 7 }, { somaFamilia: 880 });
     * expect(await sub.nextEvent({ timeoutMs: 1000 })).toEqual({
     *     type: "slice",
     *     data: { somaFamilia: 880 },
     * });
     * ```
     */
    channel<T = any>(
        module: ChannelModuleRef,
        name: string,
        opts?: SubscribeOptions
    ): Promise<TestChannelSubscription<T>>;

    // Sockets
    /**
     * Open an in-memory session against a `socket_*` handler.
     *
     * Accepts the socket handler function directly (server-imported), a
     * `{ __path }` stub, or a string path. **Middleware is not simulated** —
     * test middleware separately through a regular endpoint or page that uses
     * it. Use `opts.user` to shortcut `c.get("user")`.
     */
    socket(
        handler: SocketHandler | SocketStub | { __path: string } | string,
        opts?: SocketTestOptions
    ): Promise<TestSocketSession>;

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
