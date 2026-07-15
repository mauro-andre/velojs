---
name: velojs-testing
description: "Writing tests with `createTestApp` from `@mauroandre/velojs/testing`: HTTP requests, actions, loaders, auth, SSE subscriptions, sockets. Use when writing or fixing a test for a VeloJS app."
---

# Testing

VeloJS ships a backend testing toolkit at `@mauroandre/velojs/testing`. It spins up your app in memory, fires HTTP requests against the registered handlers, subscribes to event streams, and asserts on the result. No socket. No browser. No fragile mocks of the framework internals.

You test the whole stack — middleware, auth, routing, conventions, serialization — through the API your real users hit.

## Why a built-in toolkit?

Writing integration tests for a VeloJS app without this toolkit means one of:
- Spinning up a real HTTP server, opening sockets, racing on ports
- Calling `loader`/`action_*`/`stream_*` functions directly and mocking the Hono `Context` by hand
- Reaching into the database to assert state, bypassing services

All three pull tests away from the API your code actually exposes. The toolkit closes that gap.

## Prerequisite — Vitest must load the VeloJS Vite plugin

The toolkit relies on metadata that the VeloJS Vite plugin injects at build time (`metadata.moduleId`, `metadata.fullPath`, stream `__path`). For tests to see this metadata, your `vitest.config.ts` must include `veloPlugin()`:

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";
import { veloPlugin } from "@mauroandre/velojs/vite";

export default defineConfig({
    plugins: [veloPlugin()],
    test: {
        // your test config
    },
});
```

If you have a `vite.config.ts` with the plugin already, you can extend it with `mergeConfig`. Without this step, `.action(fn)`, `.loader(fn)`, and `.subscribe(stream)` won't be able to resolve URLs.

## Quick start

```typescript
import { createTestApp } from "@mauroandre/velojs/testing";
import routes from "../app/routes.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

describe("API", () => {
    let app: Awaited<ReturnType<typeof createTestApp>>;

    beforeAll(async () => {
        app = await createTestApp({
            routes,
            bootstrap: async () => {
                await connect(process.env.MONGO_URI!);
            },
            getSessionCookie: async ({ user }) => ({
                session: await createToken(user),
            }),
        });
    });

    afterAll(async () => await app.close());

    it("returns 200 for health check", async () => {
        const res = await app.get("/api/health");
        expect(res.status).toBe(200);
    });
});
```

That's the whole shape. Below is each piece in detail.

## createTestApp

```typescript
const app = await createTestApp({
    routes,
    bootstrap?: async () => { ... },
    getSessionCookie?: async ({ user }) => ({ ... }),
});
```

| Option | Purpose |
|--------|---------|
| `routes` | Required. Your app's `routes` array — typically `import routes from "./app/routes.js"` (it is the **default** export of `routes.tsx`) |
| `bootstrap` | Runs once before the app is created. Use for DB connections, index creation, anything `app/server.tsx` does at startup. `addRoutes()` and `onServer()` calls here are **scoped to this app only** |
| `getSessionCookie` | Maps a user object to cookies the test client will attach. Required for `app.as(user)` and `app.sessionCookies(user)` |

### app.close()

Tears down everything: heartbeats, retention timers, listeners, callbacks. After `close()`, Vitest must report **zero open handles**. Always call it in `afterAll`.

### app.reset()

Zeros transient state without re-importing routes or re-running `bootstrap`:
- All event stream buffers (`{ snapshot: true }` accumulator)
- All listeners (residual subscribers)
- All closed-channel sets
- All `perChannelSource` AbortControllers

Call it in `beforeEach` to keep tests isolated:

```typescript
beforeEach(async () => {
    await app.reset();
    await cleanTestDb(); // your responsibility
});
```

## HTTP client

```typescript
const res = await app.get("/api/repos", {
    cookies: { session: "jwt" },
    headers: { "X-Trace": "abc" },
    query: { filter: "active" },
});

await app.post("/api/payments/webhook", {
    body: { txid: "abc" }, // auto JSON-serialized + Content-Type set
});

await app.post("/api/upload", {
    body: formData, // FormData passed as-is
});
```

Methods: `.get`, `.post`, `.put`, `.patch`, `.delete`.

These methods hit everything registered under your `routes` — **pages, actions, streams, and endpoints**. A webhook declared as `{ path: "/api/github/webhook", method: "POST", handler: githubWebhook }` in `routes.tsx` is exercised exactly like any other POST route:

```typescript
const res = await app.post("/api/github/webhook", {
    headers: { "x-hub-signature-256": sig },
    body: { action: "push" },
});
```

See [06-endpoints.md](/docs/endpoints) for declaring endpoints.

`TestResponse` mirrors the Fetch `Response`:

| Field | Description |
|-------|-------------|
| `status` | HTTP status |
| `headers` | Plain object. **Keys are lowercased** (Fetch `Headers` normalization) — use `res.headers["x-trace"]`, not `res.headers["X-Trace"]` |
| `cookies` | Set-Cookie headers parsed into a record |
| `json<T>()` | Parse body as JSON |
| `text()` | Body as text |
| `blob()` | Body as Blob |
| `raw` | The underlying Response |

### Cookies and query strings

Pass `cookies: { name: value }` and the toolkit serializes them into the `Cookie` header. Query strings accept arrays:

```typescript
await app.get("/api/posts", { query: { tag: ["preact", "ssr"] } });
// → /api/posts?tag=preact&tag=ssr
```

## Auth — getSessionCookie and .as

Most authenticated tests look like:

```typescript
const cookies = await app.sessionCookies({ user: alice });
const res = await app.get("/api/me", { cookies });
```

But that gets repetitive. Use `app.as({ user })` to scope a sub-client:

```typescript
const asAlice = app.as({ user: alice });
await asAlice.get("/api/me");
await asAlice.action(action_save, { body: {...} });
await asAlice.subscribe(stream_progress, { channel: appId });
```

Every method of the sub-client carries Alice's cookies automatically.

If `getSessionCookie` was not provided, `.as()` throws a clear error. The framework doesn't know your app's session format — you provide it.

## Conventions — .action(fn) and .loader(fn)

For VeloJS conventions, you don't need to know the URL. Pass the imported function:

```typescript
import { action_setBackup } from "../app/stacks/Backup.js";

const res = await app.action(action_setBackup, {
    body: { appId, schedule: "daily" },
    cookies: { session: jwt },
});
expect(res.status).toBe(200);
```

```typescript
import { loader as homeLoader } from "../app/Home.js";

const data = await app.loader(homeLoader, {
    cookies: { session: jwt },
    params: { id: "abc" },
});
// `data` is the loader's return value, unwrapped from the HTTP response
expect(data.user.name).toBe("Alice");
```

### .loader unwrapping rules

| Loader behavior | Returned by `.loader()` |
|-----------------|------------------------|
| Returned a value | The value directly (unwrapped) |
| Redirected (`c.redirect(...)`) | `TestResponse` for status inspection |
| Set a non-2xx status (`c.status(403)`) | `TestResponse` for status inspection |
| Threw an exception | `TestResponse` with status 500 — **not** re-thrown |

A loader runs inside a Hono handler, and Hono catches a throw and turns it into a 500 response — so `.loader()` resolves either way. Assert on `res.status`; `await expect(app.loader(fn)).rejects.toThrow()` can never pass.

If the function isn't found in the route tree, `.action`/`.loader` throws a clear error pointing at the most likely cause (Vitest config missing the VeloJS plugin).

### Fallback — string URL

If you need to bypass resolution, pass a URL string:

```typescript
await app.action("/_action/Login/login", { body: {...} });
```

## Streams — .subscribe(stream)

Subscribing to a stream returns a `TestSubscription`:

```typescript
const sub = await app.as({ user: alice }).subscribe(stream_progress, {
    channel: deployId,
});
```

| Field/method | Description |
|--------------|-------------|
| `sub.status` | HTTP status of the initial response (200, 403, etc) |
| `sub.snapshot` | Snapshot from the server (buffer or callback). `null` if none |
| `sub.events` | All events received since connect, in order |
| `sub.closed` | `true` after server signals deliberate close |
| `sub.next({ timeoutMs })` | Wait for next event. **Rejects on timeout** (no silent undefined) |
| `sub.nextN(n, { timeoutMs })` | Wait for N events. Total timeout is shared across them |
| `sub.close()` | Force disconnect — triggers `perChannelSource` `abortSignal` server-side |

### Asserting cross-user isolation

```typescript
it("user B cannot subscribe to user A's app", async () => {
    const sub = await app.as({ user: userB }).subscribe(stream_appLogs, {
        channel: userAsAppId,
    });
    expect(sub.status).toBe(403);
    expect(sub.events).toEqual([]);
});
```

### Asserting snapshot replay on reconnect

```typescript
it("F5 mid-deploy shows current state immediately", async () => {
    const subA = await app.subscribe(stream_progress, { channel: appId });
    await app.action(action_startDeploy, { body: { appId } });
    await subA.next({ timeoutMs: 2000 });
    await subA.close();

    // Reconnect — buffer/snapshot still available within retainMs
    const subB = await app.subscribe(stream_progress, { channel: appId });
    expect(subB.snapshot?.[0]).toMatchObject({ status: "running" });
});
```

### Asserting perChannelSource lifecycle

```typescript
it("perChannelSource aborts when the last subscriber leaves", async () => {
    const a = await app.subscribe(stream_logs, { channel: "session" });
    const b = await app.subscribe(stream_logs, { channel: "session" });

    await a.close();
    // Source still running — b is still subscribed
    expect(activeSshConnections.get("session")).toBeDefined();

    await b.close();
    // Source aborted
    expect(activeSshConnections.get("session")).toBeUndefined();
});
```

## Sockets — `.socket(handler)`

`app.socket(handlerOrStubOrPath, opts)` opens an **in-memory** WebSocket session against a `socket_*` handler — no real TCP, no upgrade handshake. The handler runs directly with a mock Context.

```typescript
import { socket_terminal } from "../app/workers/WorkerTerminal.js";

const ws = await app.socket(socket_terminal, {
    user: { id: "alice" },
    params: { workerId: "w42" },
    channel: "w42",
});

// Send frames client → server
ws.send({ type: "data", data: "ls\n" });

// Receive frames server → client
const reply = await ws.next({ timeoutMs: 500 });
expect(JSON.parse(reply as string)).toMatchObject({ type: "data" });

// Consume a batch
const batch = await ws.nextN(3, { timeoutMs: 1000 });

// Close from the client — fires abortSignal inside the handler
await ws.close();
```

| Field / method | Description |
|---|---|
| `ws.send(msg)` | Send a frame. `string` / `Uint8Array` pass through; objects → `JSON.stringify`. |
| `ws.next({ timeoutMs })` | Wait for the next server-sent frame (cursor advances). |
| `ws.nextN(n, { timeoutMs })` | Collect `n` consecutive frames (total timeout, not per-frame). |
| `ws.messages` | All frames received so far. |
| `ws.closed` | `true` when the handler finished or `close()` was called. |
| `ws.done` | Promise that resolves when the handler finishes. |
| `ws.close(code?, reason?)` | Client-initiated close. Aborts `abortSignal` inside the handler. |

### What `app.socket()` does NOT do

- **Middleware does not run.** If your socket handler reads `c.get("user")`, pass `user` via the option:
  ```typescript
  const ws = await app.socket(handler, { user: await buildUserForTest(...) });
  ```
  Test middleware correctness separately through a regular endpoint or page that exercises the same middleware.
- **No real HTTP upgrade.** Binary frames (`Uint8Array`) pass through the queue, but the adapter is a buffered channel, not a socket.

### Accepting multiple input shapes

- **Function**: the server-imported `socket_*` handler.
  `app.socket(socket_terminal, ...)`
- **Path string**: resolve by route path.
  `app.socket("/_socket/workers/WorkerTerminal/terminal", ...)`
- **Stub**: the client stub `{ __path }` produced by the Vite plugin.
  `app.socket(terminalStub, ...)`

`app.close()` aborts every open socket session on the app — no leaked handlers between tests.

## mockContext — escape hatch

Last resort. Build a partial Hono `Context` for direct invocation of background jobs or internal helpers that aren't routes:

```typescript
const c = app.mockContext({
    user: { id, email, role },
    params: { id: "abc" },
    query: { filter: "active" },
    body: { foo: "bar" },
});

await someJob({ c });
```

Middlewares **don't run** with `mockContext`. That's the trade-off — direct invocation skips the stack. Use `.action`/`.loader`/`.subscribe` whenever possible; reach for `mockContext` only for code that isn't behind a route.

## Putting it together — full example

```typescript
import { createTestApp } from "@mauroandre/velojs/testing";
import routes from "../app/routes.js";
import { stream_backup } from "../app/layouts/AdminLayout.js";
import { action_setBackup, action_backupNow } from "../app/stacks/apps/AppEdit.js";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

describe("Backup — stream + auth + ownership", () => {
    let app: Awaited<ReturnType<typeof createTestApp>>;
    let userA: any, userB: any, appId: string;

    beforeAll(async () => {
        app = await createTestApp({
            routes,
            bootstrap: async () => {
                const { connect } = await import("@mauroandre/zodmongo");
                await connect(process.env.MONGO_URI!, "podcubo_test");
            },
            getSessionCookie: async ({ user }) => {
                const { createToken } = await import("../app/modules/user/user.service.js");
                return { session: await createToken({ user }) };
            },
        });
    });

    afterAll(async () => await app.close());

    beforeEach(async () => {
        await app.reset();
        await cleanTestDb();
        userA = await factory.user({ email: "a@x.com" });
        userB = await factory.user({ email: "b@x.com" });
        appId = await factory.dbApp(userA, "postgresql");
    });

    it("backup events reach the app owner", async () => {
        const sub = await app.as({ user: userA }).subscribe(stream_backup, {
            channel: appId,
        });
        expect(sub.status).toBe(200);

        await app.as({ user: userA }).action(action_setBackup, {
            body: { appId, schedule: "daily" },
        });
        await app.as({ user: userA }).action(action_backupNow, { body: { appId } });

        const event = await sub.next({ timeoutMs: 2000 });
        expect(event).toMatchObject({ kind: "backup", status: "running" });
        await sub.close();
    });

    it("user B cannot subscribe to user A's app stream", async () => {
        const sub = await app.as({ user: userB }).subscribe(stream_backup, {
            channel: appId,
        });
        expect(sub.status).toBe(403);
        expect(sub.events).toEqual([]);
    });
});
```

A single test exercises: channel resolver with auth, middleware chain, cookie parsing, action invocation, service → stream emit, snapshot persistence, reconnection. **No mocks of framework internals.** Real DB. Stack complete.

## Patterns that are NOT in scope

The toolkit covers backend testing (HTTP, streams, server-side functions). It **does not** cover:

- **Driver / service mocking** — use `vi.mock(path, factory)` from Vitest. The toolkit doesn't try to abstract this since Vitest already does it well.
- **Frontend testing** — use Preact Testing Library or Playwright. These are well-served by external tools; VeloJS doesn't duplicate them.
- **End-to-end with browser** — use Playwright with `velojs start`.

## FAQ

### Can I run tests in parallel?

Yes. Each test file runs in its own Vitest worker, and the toolkit isolates state per `createTestApp` instance. Within a file, `it.concurrent` works as long as each test has its own app or you avoid shared streams across concurrent tests.

### Does `app.close()` really clean up everything?

Yes — that's an invariant, not a feature. Heartbeats, retention timers, source AbortControllers, listeners — all go away. If Vitest reports open handles after `close()`, that's a bug in the toolkit.

### What about `addRoutes` and `onServer` called at top-level import?

If your `app/server.tsx` calls `addRoutes(...)` at the top level, those calls happen at import time, before any `createTestApp`. The toolkit captures a snapshot of the default context when each `createTestApp` is created, so top-level registrations are included.

If your test needs **additional** route registration scoped to that test, do it inside `bootstrap`:

```typescript
const app = await createTestApp({
    routes,
    bootstrap: async () => {
        addRoutes((a) => a.get("/test-only", (c) => c.json({ ok: true })));
    },
});
```

### How do I test a stream without a real perChannelSource resource?

Mock the resource (e.g., the SSH client) with `vi.mock`, then subscribe normally. The framework's lifecycle (subscribe → start → unsubscribe → abort) runs as in production; only the underlying resource is mocked.

### Why no top-level await on createTestApp?

Top-level await works in Vitest, but the explicit `beforeAll` is clearer and lets you call `app.close()` symmetrically in `afterAll`.
