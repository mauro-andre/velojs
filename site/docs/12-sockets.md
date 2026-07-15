---
description: "WebSockets via `socket_*` and `useSocket`: bidirectional realtime like terminals, chat, collaborative editing. Use when the client must both send and receive continuously; for server-to-client only, prefer event-streams."
---

# Sockets

Sockets are **declarative WebSocket handlers** co-located with the page that uses them. Export `socket_<name>` from a page or layout module and VeloJS registers a WebSocket route at `/_socket/{moduleId}/{name}`, with the same middleware inheritance as pages, actions, and streams.

Use sockets when you need **bidirectional** server ↔ client communication: interactive terminals, collaborative editing, live cursors, anything where the client needs to send messages too. For one-way push (server → client), use [Event Streams](/docs/event-streams).

## The shortest example

```tsx
// app/workers/WorkerTerminal.tsx
import type { SocketHandler } from "@mauroandre/velojs";
import { parseJson } from "@mauroandre/velojs/sockets";
import { useSocket, useParams } from "@mauroandre/velojs/hooks";

type Incoming = { type: "data"; data: string } | { type: "resize"; cols: number; rows: number };
type Outgoing = { type: "data"; data: string } | { type: "exit"; code: number };

export const socket_terminal: SocketHandler = async ({
    incoming, send, close, keepOpen, abortSignal, c, query,
}) => {
    const user = c.get("user");
    // The client sends the id as `?channel=` — see the note below on `params`.
    const workerId = query.channel;
    if (!workerId) { close(1008, "missing channel"); return; }

    const session = await createTerminal({ user, workerId });

    session.on("data", (chunk) => send({ type: "data", data: chunk.toString() }));
    session.on("exit", (code) => send({ type: "exit", code }));
    abortSignal.addEventListener("abort", () => session.destroy());

    keepOpen();

    for await (const msg of parseJson<Incoming>(incoming)) {
        if (msg.type === "data") session.write(msg.data);
        else if (msg.type === "resize") session.resize(msg.cols, msg.rows);
    }
};

export const Component = () => {
    const params = useParams<{ workerId: string }>();
    const { send, status, lastMessage } = useSocket(socket_terminal, {
        channel: params.workerId,
        onMessage: (raw) => {
            if (typeof raw !== "string") return;
            const msg = JSON.parse(raw) as Outgoing;
            if (msg.type === "data") appendToBuffer(msg.data);
        },
    });

    return (
        <div>
            <pre>{/* terminal buffer */}</pre>
            <input onKeyDown={(e) => send({ type: "data", data: e.key })} />
            <span>{status.value}</span>
        </div>
    );
};
```

## The handler signature

```ts
export type SocketHandler = (args: {
    incoming: AsyncIterable<string | Uint8Array>;
    send: (msg: string | Uint8Array | object) => void;
    close: (code?: number, reason?: string) => void;
    keepOpen: () => void;
    abortSignal: AbortSignal;
    /** Always empty for `socket_*` — see below. */
    params: Record<string, string>;
    query: Record<string, string>;
}) => void | Promise<void>;
```

### `params` is always empty — read the id from `query.channel`

A `socket_*` handler is mounted at its own static path — `/_socket/{moduleId}/{name}` — not at the URL of the page it lives on. That path has no `:segments`, so `params` is always `{}`, even when the page route is `/workers/:workerId` and even when a middleware on that route reads the param fine.

The client sends the value as `?channel=`, so it arrives in **`query.channel`**:

```ts
// ❌ undefined in production
const workerId = params.workerId;

// ✅
const workerId = query.channel;
```

> This one is easy to miss because **`app.socket()` lets you inject `params` directly**, so a test written against the wrong version passes while production breaks. Pass `channel` in tests instead, matching what `useSocket({ channel })` really transmits.

### `incoming` — `AsyncIterable<string | Uint8Array>`

Raw WebSocket frames. Text frames arrive as `string`, binary frames as `Uint8Array`. Drive the loop with `for await`:

```ts
for await (const frame of incoming) {
    // handle frame
}
```

For the 90% case where every frame is JSON, wrap with `parseJson`:

```ts
import { parseJson } from "@mauroandre/velojs/sockets";

for await (const msg of parseJson<MyMsgType>(incoming)) {
    // msg is typed, malformed frames are skipped with a console.warn
}
```

### `send(msg)` — push to the client

- `string` / `Uint8Array` → sent as-is
- `object` → `JSON.stringify`'d

```ts
send("hello");                // text frame
send(new Uint8Array([1,2,3])); // binary frame
send({ type: "tick", n: 42 }); // JSON text frame
```

### `keepOpen()` — control auto-close on return

When your handler returns (or its promise resolves), VeloJS checks: did you call `keepOpen()`?

- **Yes** → socket stays open until `abortSignal` fires.
- **No** → socket closes immediately.

A `for await (const msg of incoming)` loop keeps the handler alive naturally while messages flow — `keepOpen()` is redundant in that case but harmless. When you set up listeners and return (no loop), call `keepOpen()` or everything you registered will be torn down immediately.

### `close(code?, reason?)` — server-initiated close

Close the socket imperatively. Useful for protocol-level end-of-session:

```ts
if (!authorize(user, query.channel)) {
    close(1008, "policy violation");
    return;
}
```

### `abortSignal` — lifecycle hook

Fires when:
- The client disconnects (`ws.close()` on the browser side, tab closes, network drop).
- The server calls `close()` (this handler).
- `app.close()` runs in tests.

Register all cleanup here:

```ts
abortSignal.addEventListener("abort", () => {
    session.destroy();
    bus.unsubscribe(sub);
});
```

## Path derivation

`socket_<name>` exported from `app/workers/WorkerTerminal.tsx` registers at `/_socket/workers/WorkerTerminal/<name>`. Same convention as `stream_*` (`/_event/...`) and `action_*` (`/_action/...`) — the plugin preserves the file path casing.

## Middleware inheritance

Sockets inherit `middlewares` from parent route nodes, just like pages, actions, and streams. Auth rejection happens at upgrade time (the client sees an HTTP error before the WebSocket opens):

```tsx
// app/routes.tsx
export default [
    {
        module: Root,
        isRoot: true,
        children: [
            {
                path: "/workers/:workerId",
                middlewares: [authMiddleware, masterMiddleware],
                module: WorkerTerminal,
            },
        ],
    },
];
```

`authMiddleware` runs **before** the upgrade. If it rejects, no WebSocket is opened and the client's `useSocket` hook sees `status = "closed"` with an error.

## The client hook — `useSocket`

```ts
const { send, status, lastMessage, error, close } = useSocket(stub, {
    channel?: string,
    onMessage?: (msg: string | Uint8Array) => void,
    onOpen?: () => void,
    onClose?: (evt: CloseEvent) => void,
    onError?: (err: Event) => void,
    enabled?: boolean,
});
```

- `status: Signal<"connecting" | "open" | "closed">` — reactive, bind to UI.
- `lastMessage: Signal<string | Uint8Array | null>` — the most recent frame.
- `send(msg)` — queues messages sent while `connecting`; drops messages sent while `closed`.
- `close(code?, reason?)` — client-initiated disconnect.

**No auto-reconnect.** If the server closes the socket (network drop, server restart), `status` goes to `"closed"` and stays there. The caller decides whether/when to reconnect — typically by toggling `enabled` or re-mounting the component. This is intentional: sockets are usually stateful (pty session, collaborative cursor) and a blind reconnect would silently lose state.

## Testing

The testing toolkit ships `app.socket()`:

```ts
import { createTestApp } from "@mauroandre/velojs/testing";

const app = await createTestApp({ routes });

const ws = await app.socket(socket_terminal, {
    user: { id: "alice" },
    channel: "w42",
});

ws.send({ type: "data", data: "ls\n" });

const reply = await ws.next({ timeoutMs: 500 });
expect(JSON.parse(reply as string)).toEqual({ type: "data", data: "..." });

await ws.close();
```

### What `app.socket()` does

- Invokes your handler directly with a mock `Context`.
- Wires `incoming` ↔ `ws.send` and `ws.next()` ↔ `send()`.
- Tracks the `AbortController` so `app.close()` aborts open sessions.

### What `app.socket()` does NOT do

- **Middleware does not run.** If your socket relies on `authMiddleware` to set `c.get("user")`, pass `user` via the option:
  ```ts
  const ws = await app.socket(handler, { user: await buildUser(...) });
  ```
  Test middleware behavior separately through a regular endpoint or page that uses the same middleware.
- **No real HTTP upgrade.** Binary frames pass through `Uint8Array`, but there's no true TCP socket.

See [17-testing.md](/docs/testing) for the full toolkit.

## Common patterns

### Terminal / interactive shell

```ts
export const socket_terminal: SocketHandler = async ({ incoming, send, keepOpen, abortSignal, query }) => {
    const pty = await spawnPty(query.channel);
    pty.onData((chunk) => send({ type: "data", data: chunk }));
    pty.onExit((code) => send({ type: "exit", code }));
    abortSignal.addEventListener("abort", () => pty.kill());
    keepOpen();
    for await (const msg of parseJson<{ type: string; data?: string }>(incoming)) {
        if (msg.type === "data" && msg.data) pty.write(msg.data);
    }
};
```

### Event-driven (no `for await`)

```ts
export const socket_notifications: SocketHandler = async ({ send, keepOpen, abortSignal, c }) => {
    const user = c.get("user");
    const sub = bus.subscribe(`notifications:${user.id}`, (notification) => {
        send(notification);
    });
    abortSignal.addEventListener("abort", () => bus.unsubscribe(sub));
    keepOpen(); // required — handler returns but we want the socket to stay open
};
```

### Auth rejection

Use middleware (preferred, rejects before upgrade):

```tsx
{ path: "/workers/:id", middlewares: [authMiddleware], module: WorkerTerminal }
```

Or reject inside the handler after upgrade:

```ts
export const socket_foo: SocketHandler = async ({ c, close }) => {
    const user = c.get("user");
    if (!user) return close(1008, "unauthorized");
    // ...proceed
};
```

## Related

- [Event Streams](/docs/event-streams) — one-way server → client push (SSE). Use when you don't need client → server.
- [`pipe` in streams](/docs/event-streams#pipe-unified-vocabulary) — share vocabulary (`send / keepOpen / abortSignal`) with `socket_*`.
- [Middlewares](/docs/middlewares)
- [Testing](/docs/testing)
