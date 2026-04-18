# Event Streams

Event Streams are how you push data from the server to the client in real time using **Server-Sent Events (SSE)**. They're perfect for live progress updates, notifications, metrics, log streaming, AI token generation, and any scenario where the server needs to notify the client of something happening.

VeloJS makes event streams as simple as declaring a function — the framework handles routing, type safety, listener management, reconnection, and cleanup for you.

## Why Event Streams?

In a typical web app, the client asks the server for data. But sometimes you need the **server to tell the client** something happened — without the client constantly asking ("is it done yet? is it done yet?"). Two options:

- **Polling** — client asks every few seconds. Wastes bandwidth, has latency, doesn't scale.
- **WebSocket** — bidirectional channel, but complex to set up, needs reconnection logic, doesn't go through some proxies.
- **Server-Sent Events (SSE)** — one-way channel from server to client over plain HTTP. Auto-reconnect built into the browser, works through any proxy or CDN, dead simple.

VeloJS picks SSE because it covers ~90% of real-time use cases with the smallest amount of complexity. Want bidirectional? Use HTTP actions for client-to-server and event streams for server-to-client.

## Quick example

A deploy progress page:

```typescript
// app/admin/Deploy.tsx
import { createEventStream } from "@mauroandre/velojs";
import { useEventStream, useParams } from "@mauroandre/velojs/hooks";

type DeployState = {
    step: string;
    status: "running" | "success" | "error";
};

// Declare the stream once
export const stream_progress = createEventStream<DeployState>({
    channel: (c) => c.req.query("channel") ?? "",
    closeOn: (s) => s.status === "success" || s.status === "error",
});

// Use it in the component
export const Component = () => {
    const params = useParams<{ id: string }>();
    const { data } = useEventStream(stream_progress, { channel: params.id });

    return <div>Step: {data.value?.step ?? "waiting..."}</div>;
};
```

And in your service:

```typescript
// app/admin/deploy.service.ts
import { stream_progress } from "./Deploy.js";

export async function runDeploy(id: string) {
    stream_progress.emit(id, { step: "building", status: "running" });
    // ... build logic
    stream_progress.emit(id, { step: "uploading", status: "running" });
    // ... upload logic
    stream_progress.emit(id, { step: "done", status: "success" });
}
```

That's it. No routes to register, no listeners to manage, no `EventSource` to set up, no cleanup to remember. The framework wires it all together.

## Two ways to declare a stream

### 1. The `stream_*` convention (per-page)

Declare a stream as a named export starting with `stream_` in any page or layout module. The framework discovers it and registers an SSE route at `/_event/{moduleId}/{name}`.

```typescript
// app/admin/Deploy.tsx
export const stream_progress = createEventStream<DeployState>({...});

// → registered at /_event/admin/Deploy/progress
```

This is the same pattern as `loader` and `action_*` — colocate the stream with the page that uses it. The path is generated from the file's module ID, so you never have to think about URLs.

**When to use:** the stream is logically tied to a specific page or feature.

### 2. Standalone (cross-cutting)

Some streams don't belong to any single page — like global metrics or notifications consumed by many screens. For these, pass an explicit `path`:

```typescript
// app/streams/metrics.ts
import { createEventStream } from "@mauroandre/velojs";

export const metricsStream = createEventStream<Metric[]>({
    path: "/api/metrics/containers",
});
```

The route registers itself when the file is imported on the server.

**When to use:** the stream is consumed by multiple unrelated pages and doesn't belong to one.

## Configuration

`createEventStream` accepts these options:

| Option | Type | Description |
|--------|------|-------------|
| `path` | `string` | (Standalone only) Explicit URL path for the SSE endpoint |
| `channel` | `(c: Context) => string` | Extract a channel ID from the request — subscribers only get events for their channel |
| `snapshot` | `(channel) => TSnapshot \| undefined` | Returns the current state to send on connect (and reconnect) |
| `closeOn` | `(event: TEvent) => boolean` | Returns `true` to close the SSE connection after this event |
| `heartbeatMs` | `number \| false` | Heartbeat interval in ms (default: `20000`). Set to `false` to disable |
| `middlewares` | `MiddlewareHandler[]` | (Standalone only) Hono middlewares applied to the SSE route |

Each is explained in detail below.

## Channels — sending events to specific subscribers

Most real-time features are scoped to a specific resource: a deploy ID, a user ID, a room ID. Channels let you target specific subscribers without making them filter on the client.

```typescript
export const stream_deploy = createEventStream<DeployState>({
    // Extract channel from URL query: ?channel=app-123
    channel: (c) => c.req.query("channel") ?? "",
});

// Server emits to a specific channel:
stream_deploy.emit("app-123", { step: "building", status: "running" });
// → Only subscribers with channel "app-123" receive this event
```

On the client, pass the channel to the hook:

```typescript
const { data } = useEventStream(stream_deploy, { channel: "app-123" });
```

The hook automatically appends `?channel=app-123` to the URL.

### Without channels — broadcast to everyone

Skip the `channel` option for a broadcast stream — every connected client receives every event. Useful for global state like live metrics:

```typescript
export const metricsStream = createEventStream<Metric[]>({
    path: "/api/metrics",
});

// Sends to all subscribers
metricsStream.emit(currentMetrics);
```

## Snapshots — instant state on connect

What happens if the user connects in the **middle** of an ongoing process? Without snapshots, they see "loading..." until the next event fires (which could be 30 seconds away).

Snapshots solve this by sending the current state immediately on connect:

```typescript
const activeDeploys = new Map<string, DeployState>();

export const stream_deploy = createEventStream<DeployState>({
    channel: (c) => c.req.query("channel") ?? "",
    snapshot: (channel) => activeDeploys.get(channel ?? ""),
});
```

Now, when a client connects to channel `"app-123"`:
1. Server immediately sends a `snapshot` event with `activeDeploys.get("app-123")`
2. Then sends every new event as it happens

On the client, the hook exposes both signals:

```typescript
const { data, snapshot } = useEventStream(stream_deploy, { channel: appId });

// snapshot.value — initial state on connect
// data.value — latest event (after connect)
```

A common pattern: read snapshot first, then merge updates from `data`:

```typescript
const currentState = data.value ?? snapshot.value;
```

### Snapshots survive after the stream closes

Even after the stream closes (success or error), keep the state available for ~30 seconds. If the user refreshes the page right after a deploy completes, they should still see "Deploy succeeded", not a blank screen.

```typescript
// In your service, after the stream closes:
setTimeout(() => activeDeploys.delete(deployId), 30000);
```

The `snapshot` function is called on every reconnect, so as long as the data is in the Map, the user sees it.

### Two types: event vs snapshot

Sometimes the snapshot has a different shape than individual events. For instance, events might be deltas (single log lines) while the snapshot is the accumulated buffer (array of all lines so far):

```typescript
const sessions = new Map<string, string[]>();

export const stream_logs = createEventStream<string, string[]>({
    //                                       ^^^^^^^^^^^^^^^
    //                                       TEvent = string (single line)
    //                                       TSnapshot = string[] (full history)
    channel: (c) => c.req.param("sessionId"),
    snapshot: (channel) => sessions.get(channel ?? ""),
});

// Service appends to buffer AND emits delta:
const session = sessions.get(id)!;
const line = "Connected to worker...";
session.push(line);
stream_logs.emit(id, line);
```

On the client, you'd render the snapshot once, then append each new event:

```typescript
const { data, snapshot } = useEventStream(stream_logs, { channel: sessionId });

const allLines = useSignal<string[]>([]);

useEffect(() => {
    if (snapshot.value) allLines.value = snapshot.value;
}, [snapshot.value]);

useEffect(() => {
    if (data.value) allLines.value = [...allLines.value, data.value];
}, [data.value]);
```

## closeOn — auto-close on terminal events

Many streams have a clear "end" — a deploy succeeds or fails, a payment is confirmed, a backup finishes. You want the SSE connection to close automatically when that happens, instead of relying on the client to remember to call `close()`.

```typescript
export const stream_deploy = createEventStream<DeployState>({
    closeOn: (state) => state.status === "success" || state.status === "error",
});
```

When the server emits an event matching `closeOn`, it sends the event and then closes the connection. The client's `useEventStream` will set `closed.value = true`.

```typescript
const { data, closed } = useEventStream(stream_deploy, { channel: appId });

if (closed.value) {
    // Show "Deploy finished" message
}
```

For streams that never close (live metrics, ongoing logs), simply omit `closeOn`.

## Heartbeat — keeping connections alive through proxies

Proxies and CDNs (Cloudflare, Nginx, AWS ALB) often close idle HTTP connections after 60–100 seconds. If your stream doesn't send anything for that long, the connection silently drops — and the client doesn't even know it's disconnected.

VeloJS sends a `:heartbeat` SSE comment every 20 seconds by default to keep the connection warm:

```typescript
// Default: heartbeat every 20 seconds
export const myStream = createEventStream({...});

// Custom interval (e.g., 10 seconds for unstable networks)
export const myStream = createEventStream({
    heartbeatMs: 10000,
});

// Disable entirely (e.g., for short-lived streams)
export const myStream = createEventStream({
    heartbeatMs: false,
});
```

Heartbeats are invisible to your application code — they don't trigger `data` updates, they just keep the pipe open.

## Authentication and middlewares

Streams declared with the `stream_*` convention **inherit middlewares** from their parent route nodes — the same way pages and actions do.

```typescript
// app/routes.tsx
{
    module: AdminLayout,
    middlewares: [authMiddleware],
    children: [
        { path: "/deploy/:id", module: Deploy },
    ],
}
```

The `stream_progress` declared in `Deploy.tsx` is automatically protected by `authMiddleware`. If a client tries to connect without a valid session, the middleware rejects them with 401 before the stream even opens. No extra wiring needed.

### Standalone streams: pass middlewares explicitly

Standalone streams aren't part of the route tree, so they need middlewares declared directly:

```typescript
import { authMiddleware } from "../middlewares/auth.js";

export const metricsStream = createEventStream<Metric[]>({
    path: "/api/metrics/containers",
    middlewares: [authMiddleware],
});
```

The middlewares run before the SSE connection opens — exactly like middlewares on a regular Hono route. If the middleware short-circuits with `c.json(..., 401)`, the stream never starts.

## The useEventStream hook

The hook returns four signals:

```typescript
const { data, snapshot, closed, error } = useEventStream(stream, options);
```

| Signal | Type | Description |
|--------|------|-------------|
| `data` | `Signal<TEvent \| null>` | Latest event received from the server |
| `snapshot` | `Signal<TSnapshot \| null>` | Initial state from the snapshot (if configured) |
| `closed` | `Signal<boolean>` | `true` when the server closed the connection (via `closeOn`) |
| `error` | `Signal<Error \| null>` | Set if there was a parse error or connection failure |

### Options

```typescript
useEventStream(stream, {
    channel: "app-123",  // optional — only for streams with channel function
    enabled: true,       // optional — set to false to skip opening the connection
});
```

The `enabled: false` option is useful when you want to wait for some condition before opening the connection:

```typescript
const userId = useSignal<string | null>(null);

const { data } = useEventStream(notificationsStream, {
    enabled: userId.value !== null,
    channel: userId.value ?? "",
});
```

### Lifecycle

The hook handles everything automatically:
- Opens an `EventSource` when the component mounts (or when `channel` changes)
- Closes the connection when the component unmounts
- Re-opens with a new connection if `channel` or `enabled` changes
- Resets all signals to their initial state on each new connection

You never need to call `EventSource.close()` manually.

## Real-world patterns

### Pattern 1 — Replicated state machine

The server maintains the authoritative state. Each event is the **complete** state, not a delta. Snapshots are trivial because state is always available.

**Use cases:** deploy progress, migration progress, provisioning workflows.

```typescript
const activeDeploys = new Map<string, DeployState>();

export const stream_deploy = createEventStream<DeployState>({
    channel: (c) => c.req.query("channel") ?? "",
    snapshot: (channel) => activeDeploys.get(channel ?? ""),
    closeOn: (s) => s.status === "success" || s.status === "error",
});

// In the service:
function updateDeploy(id: string, partial: Partial<DeployState>) {
    const current = activeDeploys.get(id) ?? { step: "init", status: "running" };
    const next = { ...current, ...partial };
    activeDeploys.set(id, next);
    stream_deploy.emit(id, next);
}
```

### Pattern 2 — Append-only log

Events are individual lines or tokens. The snapshot is the accumulated buffer of everything sent so far.

**Use cases:** worker bootstrap logs, AI token streaming, container logs.

```typescript
const logBuffers = new Map<string, string[]>();

export const stream_logs = createEventStream<string, string[]>({
    channel: (c) => c.req.param("sessionId"),
    snapshot: (channel) => logBuffers.get(channel ?? ""),
    closeOn: (line) => line.startsWith("[done]") || line.startsWith("[error]"),
});

// In the service:
function appendLog(sessionId: string, line: string) {
    const buffer = logBuffers.get(sessionId) ?? [];
    buffer.push(line);
    logBuffers.set(sessionId, buffer);
    stream_logs.emit(sessionId, line);
}
```

### Pattern 3 — Broadcast firehose

No channel, no snapshot, never closes. Every connected client receives every event.

**Use cases:** live metrics, presence indicators.

```typescript
// app/streams/metrics.ts
export const containerMetrics = createEventStream<Metric[]>({
    path: "/api/metrics/containers",
    // No channel, no snapshot, no closeOn
});

// Periodic emission from a background job:
setInterval(() => {
    const metrics = collectMetrics();
    containerMetrics.emit(metrics);
}, 2000);
```

## Frequently asked questions

### Can I use this without `useEventStream` (raw `EventSource`)?

Yes. The hook is just a convenience. You can construct the URL yourself and use `new EventSource(url)`. The framework still registers the route and handles emission.

### What about WebSocket?

VeloJS doesn't have first-class WebSocket helpers because most use cases (~90%) are server-to-client only, and SSE handles those better. For the rare cases where you need bidirectional (interactive terminals, live cursor positions), use `onServer` to access the raw HTTP server and attach a WebSocket library directly.

### How many concurrent streams can the server handle?

SSE uses a long-lived HTTP connection per subscriber. Modern Node.js servers can comfortably handle thousands of concurrent SSE connections per process. If you need more, scale horizontally — VeloJS doesn't store state across connections (the framework's `Map` of listeners is per-process).

### What happens during deploys when the server restarts?

The browser's `EventSource` automatically reconnects when the connection drops. With snapshots configured, the client gets the current state immediately on reconnect, so the user experience is nearly seamless.

### Does the client need any setup?

No. The hook handles `EventSource` construction, event listeners, and cleanup. You just import the stream from the server file and pass it to `useEventStream`.
