# Event Streams

Event Streams are how you push data from the server to the client in real time using **Server-Sent Events (SSE)**. They cover live progress updates, notifications, metrics, log streaming, AI token generation, and any scenario where the server needs to notify clients of something happening.

VeloJS makes event streams as simple as declaring a function — the framework handles routing, type safety, listener management, snapshots, lifecycle, reconnection, and cleanup for you.

## Why Event Streams?

In a typical web app, the client asks the server for data. But sometimes you need the **server to tell the client** something happened — without polling. Three options:

- **Polling** — wasteful and laggy
- **WebSocket** — bidirectional, complex setup, proxy issues
- **Server-Sent Events (SSE)** — one-way over plain HTTP, auto-reconnect built-in, works through any proxy

VeloJS picks SSE because it covers ~90% of real-time use cases with minimal complexity. For bidirectional needs (rare — interactive terminals, live cursors), drop down to a raw WebSocket via `onServer`.

## The shortest example

```typescript
// app/admin/Provision.tsx
import { createEventStream } from "@mauroandre/velojs";
import { useEventStream } from "@mauroandre/velojs/hooks";

export const stream_logs = createEventStream<string>();

export const Component = () => {
    const { snapshot, data, closed } = useEventStream(stream_logs, {
        channel: sessionId,
    });

    const allLines = [...(snapshot.value ?? []), ...(data.value ? [data.value] : [])];

    return (
        <pre>
            {allLines.join("\n")}
            {closed.value && "\n[done]"}
        </pre>
    );
};
```

```typescript
// app/admin/provision.service.ts
import { stream_logs } from "./Provision.js";

export async function provision(sessionId: string) {
    try {
        stream_logs.emit(sessionId, "Connecting...", { snapshot: true });
        // ... real work
        stream_logs.emit(sessionId, "Worker ready.", { snapshot: true });
    } catch (err) {
        stream_logs.emit(sessionId, `Error: ${err.message}`, { snapshot: true });
    } finally {
        stream_logs.close(sessionId);
    }
}
```

That's it. One line to declare. Three verbs to use (`emit`, `close`, `useEventStream`). The framework handles:
- Route registration at `/_event/admin/Provision/logs`
- Channel routing per `sessionId`
- Internal buffer for `{ snapshot: true }` emits, sent to late subscribers
- Auto-close signaling
- Heartbeat to keep proxies happy
- Cleanup of buffer 5 minutes after `close()`

## Two ways to declare a stream

### 1. The `stream_*` convention (recommended for most cases)

Declare a stream as a named export starting with `stream_` in any page or layout module. The framework registers an SSE route at `/_event/{moduleId}/{name}` automatically.

```typescript
// app/admin/Deploy.tsx
export const stream_progress = createEventStream<DeployState>();
// → registered at /_event/admin/Deploy/progress
```

This is the same pattern as `loader` and `action_*`. Middlewares from parent route nodes are inherited automatically.

**When to use:** logically tied to a specific page or feature.

### 2. Standalone (cross-cutting streams)

Some streams don't belong to any single page — global metrics, app-wide notifications. Pass an explicit `path`:

```typescript
// app/streams/metrics.ts
import { createEventStream } from "@mauroandre/velojs";
import { authMiddleware } from "../middlewares/auth.js";

export const containerMetrics = createEventStream<Metric[]>({
    path: "/api/metrics/containers",
    middlewares: [authMiddleware],  // explicit, since not in a route
});
```

**When to use:** consumed by multiple unrelated pages, doesn't belong to one.

## Three ways to emit events

### Reactive — call `emit()` from anywhere (most common)

The service does its work and calls `.emit()` whenever something happens:

```typescript
import { stream_progress } from "./Deploy.js";

export async function runDeploy(id: string) {
    stream_progress.emit(id, { step: "building", status: "running" }, { snapshot: true });
    // ... build
    stream_progress.emit(id, { step: "uploading", status: "running" }, { snapshot: true });
    // ... upload
    stream_progress.emit(id, { step: "done", status: "success" }, { snapshot: true });
    stream_progress.close(id);
}
```

This is the right pattern when emission is **caused by application logic** — a deploy starts, a payment confirms, a backup finishes.

### Source-driven — let the framework call your producer

For streams that **continuously generate data** (polling metrics, listening to a global event bus), pass a `source` function. The framework only invokes it while there are active subscribers.

```typescript
import { createEventStream, poll } from "@mauroandre/velojs";

export const stream_workerMetrics = createEventStream<WorkerMetrics[]>({
    source: poll({
        intervalMs: 3000,
        tick: async (emit) => {
            const { collectMetrics } = await import("./metrics.service.js");
            emit(await collectMetrics());
        },
    }),
});
```

When the first user opens the metrics page, the polling starts. When the last user closes it, polling stops. **Zero CPU when nobody is watching.** No `setInterval` in your code, no manual wiring, no leaks.

For event-driven (non-polling) sources, write the function yourself with the `AbortSignal`:

```typescript
export const stream_busEvents = createEventStream<BusEvent>({
    source: async (emit, { abortSignal }) => {
        const handler = (e: BusEvent) => emit(e);
        bus.on("event", handler);
        abortSignal.addEventListener("abort", () => bus.off("event", handler));
        await new Promise((r) => abortSignal.addEventListener("abort", r));
    },
});
```

The `AbortSignal` fires when the last subscriber disconnects. Your code uses it to clean up listeners and exit gracefully.

> **Anti-pattern**: ignoring `abortSignal` keeps your producer running forever, leaking resources every time someone opens and closes the page. Only do this if the producer is truly meant to run independently of UI (rare).

### Stateful snapshot — for state-machine patterns

When **each emit is a complete state** (deploy progress, migration status), use the `snapshot` callback. It returns the current state to send on connect:

```typescript
const activeDeploys = new Map<string, DeployState>();

export const stream_deploy = createEventStream<DeployState>({
    snapshot: (channel) => activeDeploys.get(channel ?? ""),
});

// In service:
function updateDeploy(id: string, state: DeployState) {
    activeDeploys.set(id, state);
    stream_deploy.emit(id, state);  // no { snapshot: true } needed
}
```

Use this when the snapshot type is different from the event type, or when you only care about the **latest** state, not the full history.

## Configuration

`createEventStream` accepts these options — all optional:

| Option | Type | Description |
|--------|------|-------------|
| `path` | `string` | (Standalone only) Explicit URL path for the SSE endpoint |
| `channel` | `(c: Context) => string` | Extract a channel ID from the request. Defaults to `?channel=...` query param |
| `snapshot` | `(channel) => TSnapshot` | Returns the current state on connect (state-machine pattern) |
| `closeOn` | `(event: TEvent) => boolean` | Closes the SSE connection when this returns true for an emitted event |
| `source` | `(emit, { abortSignal }) => Promise<void>` | Self-running producer that runs only while subscribed |
| `retainMs` | `number` | Time (ms) the snapshot buffer is kept after `close()`. Default: `300000` (5 min) |
| `heartbeatMs` | `number \| false` | Keep-alive heartbeat interval. Default: `20000` (20s). `false` to disable |
| `middlewares` | `MiddlewareHandler[]` | (Standalone only) Hono middlewares applied to the SSE route |

## Snapshots in depth

There are **two snapshot mechanisms** for two different patterns:

### Pattern A — Append (use `{ snapshot: true }` per emit)

For logs, AI tokens, or anything where each emit is a small piece of a growing whole. The framework keeps a buffer per channel and sends it as a single snapshot to late subscribers.

```typescript
export const stream_logs = createEventStream<string>();

stream_logs.emit("session-1", "Line 1", { snapshot: true });
stream_logs.emit("session-1", "Line 2", { snapshot: true });
// Late subscriber connects → receives ["Line 1", "Line 2"] as snapshot
```

On the client:
```typescript
const { snapshot, data } = useEventStream(stream_logs, { channel: sessionId });
// snapshot.value: string[] — all buffered lines
// data.value: string — most recent line received after connect
```

### Pattern B — Replace (use `snapshot: callback` config)

For state-machine patterns where **each emit is the complete current state**. Only the latest matters. The callback returns whatever your application considers "the current state".

```typescript
const deploys = new Map<string, DeployState>();

export const stream_deploy = createEventStream<DeployState>({
    snapshot: (id) => deploys.get(id ?? ""),
});

// Late subscriber connects → snapshot.value = the latest DeployState
```

On the client:
```typescript
const { snapshot, data } = useEventStream(stream_deploy, { channel: deployId });
// snapshot.value: DeployState — the latest snapshot returned by your callback
// data.value: DeployState — most recent emitted state
```

### Snapshots survive after close

When you call `stream.close(channel)`, the SSE connection closes for current subscribers but the **snapshot buffer persists for `retainMs`** (default 5 minutes). If a user refreshes the page right after a deploy fails, they still see "Deploy failed" — not a blank screen.

After `retainMs`, the buffer is cleared. Adjust `retainMs` if you need longer (or shorter) retention.

## Closing a stream

There are **two ways** to close, for different needs:

### `stream.close(channel?)` — imperative

Call this when **your application** decides the stream is done. Useful for finally-blocks, manual close after a workflow finishes:

```typescript
try {
    await runDeploy(id);
} finally {
    stream_deploy.close(id);  // always close, success or fail
}
```

The current subscribers' `closed.value` becomes `true`. Subsequent `emit()` calls to that channel are ignored with a warning.

### `closeOn` — declarative

Configure a predicate. The framework closes automatically when an event matches:

```typescript
export const stream_deploy = createEventStream<DeployState>({
    closeOn: (state) => state.status === "success" || state.status === "error",
});
```

Use this when the close decision is **a function of the event itself**, not external state.

You can use either, both, or neither. They compose cleanly.

## The `useEventStream` hook

```typescript
const { data, snapshot, closed, error } = useEventStream(stream, options);
```

| Signal | Type | Description |
|--------|------|-------------|
| `data` | `Signal<TEvent \| null>` | Latest event received from the server |
| `snapshot` | `Signal<TSnapshot \| null>` | Initial state on connect (buffer or callback) |
| `closed` | `Signal<boolean>` | `true` when server closed the stream (via `close()` or `closeOn`) |
| `error` | `Signal<Error \| null>` | Set on parse or connection error |

Options:
```typescript
useEventStream(stream, {
    channel: "app-123",  // sent as ?channel=app-123
    enabled: true,       // skip the connection when false
});
```

The hook handles `EventSource` lifecycle automatically: opens on mount, closes on unmount, re-opens with a fresh connection when `channel` changes.

## Heartbeat

VeloJS sends a `:heartbeat` SSE comment every 20 seconds by default. Without this, idle connections are closed by Cloudflare (~100s), Nginx (~60s), and AWS ALB (~60s) — and the client doesn't even notice.

Configure if needed:
```typescript
createEventStream({ heartbeatMs: 10000 });   // every 10s
createEventStream({ heartbeatMs: false });   // disabled
```

Heartbeats are invisible to your application — they just keep the pipe open.

## Authentication and middlewares

### Convention `stream_*`

Streams declared with the `stream_*` convention **inherit middlewares** from parent route nodes:

```typescript
// app/routes.tsx
{
    module: AdminLayout,
    middlewares: [authMiddleware],
    children: [
        { path: "/deploy/:id", module: Deploy },  // stream_progress here is protected
    ],
}
```

No extra wiring. The `stream_progress` declared in `Deploy.tsx` is automatically protected by `authMiddleware`. Unauthenticated clients get 401 before the SSE connection even opens.

### Standalone

Standalone streams aren't part of the route tree. Pass middlewares directly:

```typescript
export const containerMetrics = createEventStream<Metric[]>({
    path: "/api/metrics/containers",
    middlewares: [authMiddleware],  // ← required
});
```

If the middleware short-circuits with `c.json(..., 401)`, the SSE never starts.

## Real-world patterns

### Pattern 1 — Replicated state machine

Server keeps the authoritative state. Each emit is the complete state.

```typescript
const deploys = new Map<string, DeployState>();

export const stream_deploy = createEventStream<DeployState>({
    snapshot: (id) => deploys.get(id ?? ""),
    closeOn: (s) => s.status === "success" || s.status === "error",
});

function updateDeploy(id: string, state: DeployState) {
    deploys.set(id, state);
    stream_deploy.emit(id, state);
}
```

Use cases: deploy progress, migration status, provisioning workflows.

### Pattern 2 — Append-only log

Each event is a delta. Snapshot is the accumulated buffer.

```typescript
export const stream_logs = createEventStream<string>();

function appendLog(sessionId: string, line: string) {
    stream_logs.emit(sessionId, line, { snapshot: true });
}

function finishSession(sessionId: string) {
    stream_logs.close(sessionId);
}
```

Use cases: bootstrap logs, AI token streaming, container logs.

### Pattern 3 — Polling broadcast

No channel, no manual emit. The framework runs the producer only while subscribed.

```typescript
import { poll } from "@mauroandre/velojs";

export const stream_metrics = createEventStream<Metric[]>({
    source: poll({
        intervalMs: 3000,
        tick: async (emit) => emit(await collectMetrics()),
    }),
});
```

Use cases: live metrics, presence indicators.

### Pattern 4 — Event-driven broadcast

Listen to a global bus, emit when something happens.

```typescript
export const stream_notifications = createEventStream<Notification>({
    source: async (emit, { abortSignal }) => {
        const handler = (n: Notification) => emit(n);
        notificationBus.on("new", handler);
        abortSignal.addEventListener("abort", () => notificationBus.off("new", handler));
        await new Promise((r) => abortSignal.addEventListener("abort", r));
    },
});
```

Use cases: cross-tab notifications, system-wide events.

## Frequently asked questions

### When does the source function run?

Only while there is at least one active SSE subscriber across any channel. As soon as the last subscriber disconnects, the `AbortSignal` fires. As soon as a new subscriber connects, the source is invoked fresh with a new signal.

This means **zero CPU when nobody is watching**. You don't need to start/stop your polling job manually.

### Can I emit before any subscribers exist?

Yes — emits with `{ snapshot: true }` go to the buffer and reach the next subscriber. Emits without that flag are dropped (no listeners, nowhere to deliver). This is intentional: ephemeral events are for current observers only.

### What happens if I call `emit` after `close()`?

The emit is ignored and a warning is logged. After `retainMs`, the channel becomes "fresh" again — you can use the same channel ID for a new session.

### Can I have multiple streams in the same module?

Yes. Each `stream_*` export is its own SSE route:
```typescript
export const stream_progress = createEventStream<DeployState>();
export const stream_logs = createEventStream<string>();
// → /_event/.../progress and /_event/.../logs
```

### Does this work without `useEventStream` (raw EventSource)?

Yes. The hook is just a convenience. You can construct the URL (`stream.__path` plus `?channel=...`) and use `new EventSource(url)`. The framework still handles routing and emission.

### What about WebSocket?

VeloJS doesn't include WebSocket helpers because most real-time use cases (~90%) are server-to-client only, where SSE is simpler. For bidirectional needs (interactive terminals, live cursors), use `onServer` to attach a WebSocket library directly.

### How many concurrent subscribers can the server handle?

Modern Node.js handles thousands of concurrent SSE connections per process. If you need more, scale horizontally — VeloJS state is per-process (the listener Map and buffers don't sync across instances).

### What happens during deploys when the server restarts?

The browser's `EventSource` auto-reconnects. With snapshots configured (callback or buffer), the client immediately sees the current state on reconnect, so the user experience is nearly seamless.
