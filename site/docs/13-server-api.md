---
description: "Server lifecycle and escape hatches: `addRoutes` for custom Hono routes, `onServer` for the raw HTTP server, port config, env vars. Use when mounting a custom Hono route, attaching a library to the HTTP server, or configuring the port."
---

# Server API

VeloJS gives you direct access to the underlying Hono server. This lets you add custom API endpoints, SSE streams, WebSocket handlers, and anything else that goes beyond page routes.

## addRoutes

Register custom Hono routes in `app/server.tsx`. These routes are added **before** page and action routes, so they take priority:

```typescript
import { addRoutes } from "@mauroandre/velojs/server";
import type { Hono } from "hono";

addRoutes((app: Hono) => {
    // Simple API endpoint
    app.get("/api/health", (c) => c.json({ ok: true }));

    // File upload
    app.post("/api/upload", async (c) => {
        const body = await c.req.parseBody();
        const file = body.file;
        return c.json({ ok: true });
    });

    // Middleware for a group of API routes
    app.use("/api/admin/*", async (c, next) => {
        const token = c.req.header("Authorization");
        if (!token) return c.json({ error: "Unauthorized" }, 401);
        await next();
    });
});
```

## Server-Sent Events (SSE)

> **Recommended:** For most real-time use cases, use [Event Streams](/docs/event-streams) (`createEventStream`). They handle channels, snapshots, auto-close, heartbeat, middleware inheritance, and type safety automatically. Drop down to raw `streamSSE` only when you need fine-grained control over the protocol.

SSE is a simple way to push real-time updates from server to client. If you need raw control, use Hono's `streamSSE` directly:

```typescript
import { addRoutes } from "@mauroandre/velojs/server";

addRoutes((app) => {
    app.get("/api/events", async (c) => {
        const { streamSSE } = await import("hono/streaming");

        return streamSSE(c, async (stream) => {
            // Send initial data when client connects
            await stream.writeSSE({
                event: "snapshot",
                data: JSON.stringify({ count: 0 }),
            });

            // Subscribe to updates
            const unsubscribe = subscribe((data) => {
                stream.writeSSE({
                    event: "update",
                    data: JSON.stringify(data),
                });
            });

            // Clean up when client disconnects
            stream.onAbort(() => { unsubscribe(); });

            // Keep the stream open
            await new Promise<void>(() => {});
        });
    });
});
```

On the client, use the standard `EventSource` API:

```typescript
useEffect(() => {
    const es = new EventSource("/api/events");

    es.addEventListener("snapshot", (e) => {
        state.value = JSON.parse(e.data);
    });

    es.addEventListener("update", (e) => {
        state.value = JSON.parse(e.data);
    });

    return () => es.close();
}, []);
```

### SSE with polling

For live metrics or periodic updates, use a polling loop inside the stream:

```typescript
addRoutes((app) => {
    app.get("/api/metrics/live", async (c) => {
        const { streamSSE } = await import("hono/streaming");

        return streamSSE(c, async (stream) => {
            let running = true;
            stream.onAbort(() => { running = false; });

            while (running) {
                const metrics = await collectMetrics();
                await stream.writeSSE({ data: JSON.stringify(metrics) });
                await new Promise((r) => setTimeout(r, 3000));
            }
        });
    });
});
```

## onServer — WebSocket support

`onServer` gives you access to the underlying Node.js HTTP server. This is mainly used for WebSocket upgrade handlers:

```typescript
import { onServer } from "@mauroandre/velojs/server";

onServer(async (httpServer) => {
    const { WebSocketServer } = await import("ws");
    const wss = new WebSocketServer({ noServer: true });

    httpServer.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url!, `http://${req.headers.host}`);

        if (url.pathname === "/ws") {
            wss.handleUpgrade(req, socket, head, (ws) => {
                ws.on("message", (raw) => {
                    const msg = JSON.parse(raw.toString());
                    // Handle message
                });

                ws.on("close", () => {
                    // Clean up
                });
            });
        }
    });
});
```

Callbacks registered with `onServer` queue until the server starts. If called after the server is already running, the callback executes immediately.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | The port the server listens on. Overrides `defineConfig`'s `port`. |
| `NODE_ENV` | — | Set automatically by `velojs start` to `production` |
| `STATIC_BASE_URL` | `""` | CDN/bucket prefix for static assets |
