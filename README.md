# VeloJS

Fullstack web framework with SSR, hydration, and file-based conventions.

- **Server**: Hono (web framework) + Preact SSR
- **Client**: Preact + @preact/signals + wouter-preact
- **Build**: Vite with custom plugin (Babel AST transforms)

---

## Getting Started

### Create a new project

```bash
npx @mauroandre/velojs init my-app
cd my-app
npm install
npx velojs dev
```

### Project structure

```
my-app/
├── app/
│   ├── routes.tsx        # Route definitions (export default)
│   ├── server.tsx        # Server init (DB connections, custom routes, etc)
│   ├── client.tsx        # Client init (global CSS, etc)
│   ├── client-root.tsx   # Root component (<html>, <head>, <body>)
│   └── pages/            # Pages, layouts, modules
├── vite.config.ts
├── tsconfig.json
└── package.json
```

### vite.config.ts

```typescript
import { defineConfig } from "vite";
import { veloPlugin } from "@mauroandre/velojs/vite";

export default defineConfig({
    plugins: [veloPlugin()],
});
```

### package.json scripts

```json
{
    "scripts": {
        "dev": "velojs dev",
        "build": "velojs build",
        "build:static": "velojs build --static",
        "start": "velojs start"
    }
}
```

### app/client-root.tsx — Root component

The root component renders the HTML shell. It must accept `children` and include `<Scripts />`.

```tsx
import type { ComponentChildren } from "preact";
import { Scripts } from "@mauroandre/velojs";

export const Component = ({ children }: { children?: ComponentChildren }) => (
    <html lang="en">
        <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>My App</title>
            <Scripts />
        </head>
        <body>{children}</body>
    </html>
);
```

### app/client.tsx — Client entry

Runs on the client only. Use it to import global CSS, initialize client-side libraries, or set up global components like toasts.

```typescript
// Import global styles
import "./styles/global.css";

// Optional: set up global client-side features
// import { initAnalytics } from "./modules/analytics.js";
// initAnalytics();
```

### app/server.tsx — Server entry

Runs on the server only. Use it to connect to databases, create indexes, register custom API routes, start background jobs, and set up WebSocket handlers.

```typescript
import type { Hono } from "hono";
import { addRoutes, onServer } from "@mauroandre/velojs/server";

// Connect to database
import { connectDB } from "../db/engine.js";
await connectDB();

// Create indexes
import { getDB } from "../db/engine.js";
const db = getDB();
await db.collection("users").createIndex({ email: 1 }, { unique: true });

// Register custom API routes
addRoutes((app: Hono) => {
    app.get("/api/health", (c) => c.json({ ok: true }));
});

// Start background jobs
const { runCleanup } = await import("./modules/cleanup.js");
setInterval(() => runCleanup().catch(console.error), 60_000);
```

### app/routes.tsx — Route definitions

```typescript
import type { AppRoutes } from "@mauroandre/velojs";
import * as Root from "./client-root.js";
import * as Home from "./pages/Home.js";

export default [
    {
        module: Root,
        isRoot: true,
        children: [
            { path: "/", module: Home },
        ],
    },
] satisfies AppRoutes;
```

### app/pages/Home.tsx — First page

```typescript
import type { LoaderArgs } from "@mauroandre/velojs";
import { useLoader } from "@mauroandre/velojs/hooks";

export const loader = async ({ c }: LoaderArgs) => {
    return { message: "Hello, VeloJS!" };
};

export const Component = () => {
    const { data } = useLoader<{ message: string }>();
    return <h1>{data.value?.message}</h1>;
};
```

### Run

```bash
npm run dev     # http://localhost:3000
```

### Configuration

```typescript
veloPlugin({
    appDirectory: "./app",      // default
    routesFile: "routes.tsx",   // default
    serverInit: "server.tsx",   // default
    clientInit: "client.tsx",   // default
});
```

---

## Routes

Routes are defined in `app/routes.tsx` as a tree structure. Each node can have a `module` (component + loader + actions), `children` (nested routes), and `middlewares`.

```typescript
// app/routes.tsx
import type { AppRoutes } from "@mauroandre/velojs";
import * as Root from "./client-root.js";
import * as AuthLayout from "./auth/Layout.js";
import * as Login from "./auth/Login.js";
import * as AdminLayout from "./admin/Layout.js";
import * as Dashboard from "./admin/Dashboard.js";
import * as Users from "./admin/Users.js";
import * as UserDetail from "./admin/UserDetail.js";
import { authMiddleware } from "./modules/auth/auth.middleware.js";

export default [
    {
        module: Root,
        isRoot: true,
        children: [
            // Public routes
            {
                module: AuthLayout,
                children: [
                    { path: "/login", module: Login },
                ],
            },
            // Authenticated routes
            {
                module: AdminLayout,
                middlewares: [authMiddleware],
                children: [
                    { path: "/", module: Dashboard },
                    { path: "/users", module: Users },
                    { path: "/users/:id", module: UserDetail },
                ],
            },
        ],
    },
] satisfies AppRoutes;
```

### Component nesting

Routes with `children` act as **layouts**. Their `Component` receives `children` and wraps nested routes. VeloJS renders the full hierarchy from root to leaf:

```
GET /users/123 renders:

Root (isRoot — <html>, <head>, <body>)
  └─ AdminLayout (sidebar, nav)
       └─ UserDetail (page content)
```

```typescript
// app/client-root.tsx — Root component
import { Scripts } from "@mauroandre/velojs";

export const Component = ({ children }: { children: any }) => (
    <html>
        <head><Scripts /></head>
        <body>{children}</body>
    </html>
);

// app/admin/Layout.tsx — Layout component
export const Component = ({ children }: { children: any }) => (
    <div class={css.layout}>
        <nav class={css.sidebar}>...</nav>
        <main class={css.content}>{children}</main>
    </div>
);

// app/admin/UserDetail.tsx — Page component (leaf, no children)
export const Component = () => {
    const { data } = useLoader<User>();
    return <div>{data.value?.name}</div>;
};
```

Every layout and page can have its own `loader`. On a request, **all loaders in the hierarchy run in parallel** — Root loader + AdminLayout loader + UserDetail loader all execute at the same time.

### Route Node Properties

| Property | Type | Description |
|----------|------|-------------|
| `path` | `string` | URL path segment. Supports `:params` (e.g., `/users/:id`). |
| `module` | `RouteModule` | Module with `Component`, `loader`, `action_*` |
| `children` | `RouteNode[]` | Nested routes (module acts as layout) |
| `middlewares` | `MiddlewareHandler[]` | Hono middlewares (server-only, inherited by children) |
| `isRoot` | `boolean` | Marks the root node (renders `<html>`, `<head>`, `<body>`) |

### Path resolution

Paths are **relative segments** that concatenate with parent paths:

```
Root (no path)
  └─ AdminLayout (no path)
       ├─ Dashboard    → path: "/"           → fullPath: "/"
       ├─ Users        → path: "/users"      → fullPath: "/users"
       └─ UserDetail   → path: "/users/:id"  → fullPath: "/users/:id"
```

Nodes without `path` don't add a segment — they're pure layout wrappers. The Vite plugin parses `routes.tsx` at build-time and calculates both `fullPath` (absolute) and `path` (relative segment), injecting them into each module's `metadata` export.

### Shared layouts, different paths

You can reuse the same layout for different route groups:

```typescript
export default [
    {
        module: Root,
        isRoot: true,
        children: [
            // Public pages — same layout, no auth
            {
                module: PublicLayout,
                children: [
                    { path: "/", module: Home },
                    { path: "/about", module: About },
                ],
            },
            // Dashboard — same root, different layout + auth
            {
                path: "/dashboard",
                module: DashboardLayout,
                middlewares: [authMiddleware],
                children: [
                    { path: "/", module: Overview },
                    { path: "/settings", module: Settings },
                ],
            },
        ],
    },
] satisfies AppRoutes;
```

---

## Components

### Conventions

| Export | Purpose |
|--------|---------|
| `export const Component` | Preact component (required) |
| `export const loader` | Server-side data loader |
| `export const action_*` | Server-side actions (RPC) |

### Example Page

```typescript
// app/admin/Users.tsx
import type { LoaderArgs, ActionArgs } from "@mauroandre/velojs";
import { useLoader } from "@mauroandre/velojs/hooks";

interface User { id: string; name: string; }

export const loader = async ({ params, query, c }: LoaderArgs) => {
    const { getUsers } = await import("./user.service.js");
    return getUsers();
};

export const action_delete = async ({
    body,
    c,
}: ActionArgs<{ id: string }>) => {
    const { deleteUser } = await import("./user.service.js");
    await deleteUser(body.id);
    return { ok: true };
};

export const Component = () => {
    const { data, loading, refetch } = useLoader<User[]>();

    if (loading.value) return <div>Loading...</div>;

    return (
        <ul>
            {data.value?.map((u) => (
                <li key={u.id}>
                    {u.name}
                    <button onClick={async () => {
                        await action_delete({ body: { id: u.id } });
                        refetch();
                    }}>Delete</button>
                </li>
            ))}
        </ul>
    );
};
```

### Server-only imports

Loaders and actions run on the server, but the **file itself** is also bundled for the client (the Vite plugin strips the loader body and transforms actions into fetch stubs). This means **top-level imports are included in the client bundle**.

Always use `await import()` inside loaders and actions for server-only code (database access, file system, secrets, etc.):

```typescript
// BAD — leaks server code into client bundle
import { getUsers } from "./user.service.js";
import { db } from "../db/engine.js";

export const loader = async () => {
    return db.collection("users").find().toArray();
};

// GOOD — dynamic import, only runs on server
export const loader = async () => {
    const { getUsers } = await import("./user.service.js");
    return getUsers();
};
```

This is the most important convention in VeloJS. If you top-level import a module that uses Node.js APIs (fs, crypto, database drivers), the client build will fail or include unnecessary code.

---

## Loaders

Two patterns for consuming loader data:

### `useLoader<T>()` — Component-level (SSR + SPA)

Use for page-specific data. Supports SSR hydration and SPA navigation (auto-fetches on navigation).

```typescript
export const Component = () => {
    const { data, loading, refetch } = useLoader<MyType>();
    // data: Signal<T | null>
    // loading: Signal<boolean>
    // refetch: () => void — manually re-fetch data
};
```

With dependencies (re-fetch when deps change):

```typescript
const params = useParams<{ id: string }>();
const { data } = useLoader<User>([params.id]);
```

### `Loader<T>()` — Module-level (SSR only)

Use for global/shared data loaded in a Layout and exported to child modules. Runs once on import — does **not** re-fetch on SPA navigation.

```typescript
// app/admin/Layout.tsx
import { Loader } from "@mauroandre/velojs/hooks";

export const { data: globalData } = Loader<GlobalType>();

export const Component = ({ children }) => (
    <div>
        <header>Hello, {globalData.value?.user.name}</header>
        {children}
    </div>
);

// app/admin/Home.tsx — import from Layout
import { globalData } from "./Layout.js";

export const Component = () => (
    <div>Permissions: {globalData.value?.permissions.join(", ")}</div>
);
```

### Data Flow

```
SSR:
    loader() → server runs all loaders in parallel
    → injects window.__PAGE_DATA__ = { moduleId: data, ... }
    → Loader()/useLoader() hydrate from __PAGE_DATA__

SPA navigation:
    useLoader() → fetch(currentPath?_data=1) → JSON { moduleId: data }
    Loader() → returns null (no re-fetch)
```

---

## Actions

Server-side functions callable from the client via RPC.

### Definition

```typescript
export const action_login = async ({
    body,
    c,
}: ActionArgs<{ email: string; password: string }>) => {
    const { authenticate } = await import("./auth.service.js");
    const token = await authenticate(body.email, body.password);

    const { setCookie } = await import("@mauroandre/velojs/cookie");
    setCookie(c!, "session", token, { path: "/" });

    return { ok: true };
};
```

### Client-Side Behavior

The Vite plugin transforms action bodies into fetch stubs at build time:

```typescript
// Original (server)
export const action_login = async ({ body, c }: ActionArgs<LoginBody>) => {
    // ... server logic
};

// Transformed (client)
export const action_login = async ({ body }: { body: LoginBody }) => {
    return fetch("/_action/auth/Login/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    }).then(r => r.json());
};
```

**Error handling**: Actions do NOT throw on server errors. They resolve with `{ error: "message" }`. Always check `result.error` explicitly.

### Shared actions in Layouts

Actions are tied to the module where they're declared — the route is always `/_action/{moduleId}/{actionName}`. Declare an action in a Layout and import it from any child module to share it across multiple pages.

```typescript
// app/admin/Layout.tsx — action declared once in the layout
import type { ActionArgs } from "@mauroandre/velojs";

export const action_logout = async ({ c }: ActionArgs) => {
    const { deleteCookie } = await import("@mauroandre/velojs/cookie");
    deleteCookie(c!, "session");
    return { ok: true };
};

export const Component = ({ children }) => (/* layout with children */);
```

```typescript
// app/admin/Dashboard.tsx — imports and uses the action from Layout
import { action_logout } from "./Layout.js";

export const Component = () => (
    <button onClick={async () => {
        await action_logout({});
        window.location.href = "/login";
    }}>Logout</button>
);
```

The client-side transform rewrites the import to fetch `/_action/admin/Layout/logout`, so the action always points to the correct URL regardless of where it's imported. Middlewares on the Layout apply automatically.

---

## Endpoints

Declarative HTTP endpoints for anything that isn't a page — webhooks, email-verification redirects, OAuth callbacks, health checks.

Declare them directly in `routes.tsx`:

```tsx
import type { AppRoutes, EndpointHandler } from "@mauroandre/velojs";
import * as Home from "./pages/Home.js";
import { githubWebhook } from "./webhooks/github.handler.js";

export default [
    { path: "/", module: Home },
    { path: "/api/github/webhook", method: "POST", handler: githubWebhook },
] satisfies AppRoutes;
```

The handler gets `{ c, params, query }` and must return a `Response`:

```ts
import type { EndpointHandler } from "@mauroandre/velojs";

export const githubWebhook: EndpointHandler = async ({ c }) => {
    const body = await c.req.json();
    // ...verify signature, process event...
    return c.json({ ok: true });
};
```

Endpoints inherit parent `middlewares` and can be nested inside grouping nodes. The Vite plugin strips endpoint objects (and their handler imports) from the client bundle, so server-only code never ships to the browser.

Because endpoints live in `routes.tsx`, the testing toolkit sees them automatically:

```ts
const res = await app.post("/api/github/webhook", { body: {...}, headers: {...} });
```

Full documentation: [site/docs/06-endpoints.md](./site/docs/06-endpoints.md).

---

## Event Streams

Push real-time updates from server to client via Server-Sent Events (SSE). Live progress, notifications, metrics, log streaming, AI tokens — anything server → client.

Three verbs: `emit`, `close`, `useEventStream`. The framework handles routing, types, listener management, snapshots, lifecycle, reconnection, and cleanup.

### Shortest example

```typescript
// app/admin/Provision.tsx
import { createEventStream } from "@mauroandre/velojs";
import { useEventStream } from "@mauroandre/velojs/hooks";

export const stream_logs = createEventStream<string>();

export const Component = () => {
    const { snapshot, data, closed } = useEventStream(stream_logs, { channel: sessionId });
    const lines = [...(snapshot.value ?? []), ...(data.value ? [data.value] : [])];
    return <pre>{lines.join("\n")}{closed.value && "\n[done]"}</pre>;
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
    } finally {
        stream_logs.close(sessionId);
    }
}
```

One line to declare, three verbs to use. Route at `/_event/admin/Provision/logs` is registered automatically. Middlewares inherited from parent route nodes.

### Two ways to declare

**Convention `stream_*`** (recommended) — for streams logically tied to a page/layout. Path derived from module ID, middlewares inherited.

```typescript
export const stream_progress = createEventStream<DeployState>();
```

**Standalone** — for cross-cutting streams (global metrics, notifications). Pass `path` and (if needed) `middlewares` explicitly. Use `broadcast: true` for streams without channels.

```typescript
export const containerMetrics = createEventStream<Metric[]>({
    path: "/api/metrics/containers",
    broadcast: true,
    middlewares: [authMiddleware],
});
```

### Three ways to emit

**Reactive** — call `emit()` from anywhere when something happens. Most common:

```typescript
stream_logs.emit(sessionId, "Line", { snapshot: true });
```

**Source-driven** — pass a `source` function. Framework runs it only while subscribed (zero CPU when nobody is watching):

```typescript
import { poll } from "@mauroandre/velojs";

export const stream_metrics = createEventStream<Metric[]>({
    broadcast: true,
    source: poll({
        intervalMs: 3000,
        tick: async (emit) => emit(await collectMetrics()),
    }),
});
```

**Stateful snapshot** — for state-machine patterns where each emit is the complete current state:

```typescript
const deploys = new Map<string, DeployState>();

export const stream_deploy = createEventStream<DeployState>({
    snapshot: (id) => deploys.get(id ?? ""),
});
```

### Configuration

| Option | Type | Description |
|--------|------|-------------|
| `path` | `string` | (Standalone) Explicit URL path |
| `broadcast` | `boolean` | If true, every emit goes to all subscribers (no channels). Default: false |
| `channel` | `(c) => string \| null \| Promise<...>` | Resolve channel ID. Sync or async. Return `null`/`undefined` to reject (403). Default: `?channel=...` |
| `snapshot` | `(channel) => TSnapshot` | Returns current state on connect (state-machine pattern) |
| `closeOn` | `(event) => boolean` | Closes SSE when matching event is sent (declarative) |
| `source` | `(emit, { abortSignal }) => Promise<void>` | Stream-wide producer, only runs while subscribed |
| `perChannelSource` | `(channelKey, emit, { abortSignal }) => Promise<void>` | Per-channel producer. Mutually exclusive with `source` |
| `bufferSize` | `number` | Max entries kept in snapshot buffer per channel (FIFO). Default `Infinity` |
| `retainMs` | `number` | Buffer retention after `close()`. Default `300000` (5 min) |
| `heartbeatMs` | `number \| false` | Heartbeat interval. Default `20000` (20s). `false` to disable |
| `middlewares` | `MiddlewareHandler[]` | (Standalone) Hono middlewares for the SSE route |

### Snapshot mechanisms

Two snapshot patterns for two cases:

**Per-emit `{ snapshot: true }` — append pattern.** Framework keeps a buffer per channel. Late subscribers receive the array.

```typescript
stream_logs.emit(id, "line 1", { snapshot: true });
stream_logs.emit(id, "line 2", { snapshot: true });
// Late subscriber → snapshot.value = ["line 1", "line 2"]
```

**`snapshot: callback` config — replace pattern.** You return the latest state from your own data structure.

```typescript
createEventStream({ snapshot: (id) => deploys.get(id ?? "") });
// Late subscriber → snapshot.value = the latest DeployState
```

Both survive after `close()` for `retainMs` (default 5 min) so refresh-after-finish still shows final state.

### Closing

Two ways, choose either or both:

```typescript
// Imperative — call from anywhere
stream.close(channelId);

// Declarative — predicate on event
createEventStream({ closeOn: (s) => s.status === "success" });
```

After close, subsequent `emit()` to that channel is ignored with a warning.

### `useEventStream` hook

```typescript
const { data, snapshot, closed, error } = useEventStream(stream, {
    channel: "deploy-123",  // optional
    enabled: true,          // optional
});
```

| Signal | Description |
|--------|-------------|
| `data` | Latest event received |
| `snapshot` | Initial state on connect (buffer or callback) |
| `closed` | `true` when server closed the stream |
| `error` | Parse or connection error, if any |

Lifecycle is automatic: opens on mount, closes on unmount, re-opens fresh when `channel` changes.

### `poll` helper

For interval-based polling sources. Wraps your tick function in a loop that respects the `AbortSignal`. Errors in tick are logged but don't stop the loop.

```typescript
poll({ intervalMs: 3000, tick: async (emit) => emit(await collect()) })
```

### Per-channel sources

Use `perChannelSource` for resources that scale per channel (SSH connections, DB cursors, pub/sub topics). Invoked once per channel on first subscriber, aborted when the last subscriber of that channel leaves.

```typescript
export const stream_logs = createEventStream<string>({
    channel: (c) => `${c.req.param("worker")}:${c.req.param("container")}`,
    bufferSize: 500,
    perChannelSource: async (key, emit, { abortSignal }) => {
        const conn = await ssh.connect(...);
        const stream = conn.exec(`podman logs -f ${key.split(":")[1]}`);
        stream.on("data", (d) => emit(d.toString(), { snapshot: true }));
        abortSignal.addEventListener("abort", () => { stream.close(); conn.end(); });
    },
});
```

Mutually exclusive with `source`.

### Async channel resolver (auth + ownership)

The `channel` resolver can be async and reject the connection by returning `null`/`undefined`:

```typescript
createEventStream({
    channel: async (c) => {
        const user = c.get("user");
        const appId = c.req.query("channel");
        const app = await getApp({ id: appId });
        if (app?.owner !== user.id) return null; // → 403
        return appId;
    },
});
```

Combines auth and channel extraction in one place.

### Buffer size limits

Cap memory usage of long-running log streams via FIFO ring:

```typescript
createEventStream<string>({ bufferSize: 500 });  // keep last 500 entries per channel
```

Only affects emits with `{ snapshot: true }`.

---

## Sockets

Declarative WebSocket handlers, co-located with the page that needs bidirectional communication. Use for interactive terminals, collaborative editing, live cursors — anything where the client also sends messages.

Export `socket_<name>` from a page or layout, and VeloJS registers a WebSocket route at `/_socket/{moduleId}/{name}` with middleware inheritance.

### Shortest example

```tsx
// app/workers/WorkerTerminal.tsx
import type { SocketHandler } from "@mauroandre/velojs";
import { parseJson } from "@mauroandre/velojs/sockets";
import { useSocket } from "@mauroandre/velojs/hooks";

export const socket_terminal: SocketHandler = async ({
    incoming, send, keepOpen, abortSignal, c, params,
}) => {
    const session = await createTerminal(params.workerId);
    session.on("data", (chunk) => send({ type: "data", data: chunk }));
    abortSignal.addEventListener("abort", () => session.destroy());
    keepOpen();

    for await (const msg of parseJson<{ type: string; data?: string; cols?: number; rows?: number }>(incoming)) {
        if (msg.type === "data" && msg.data) session.write(msg.data);
        if (msg.type === "resize") session.resize(msg.cols!, msg.rows!);
    }
};

export const Component = () => {
    const { send, status } = useSocket(socket_terminal, { channel: workerId });
    // ...
};
```

### Handler args

| Arg | Description |
|---|---|
| `incoming` | `AsyncIterable<string \| Uint8Array>` — raw frames. Wrap with `parseJson<T>()` for JSON auto-parse. |
| `send(msg)` | Send a frame. `string` / `Uint8Array` pass through; `object` → `JSON.stringify`. |
| `close(code?, reason?)` | Server-initiated close. |
| `keepOpen()` | Required for long-lived handlers. If you return without it, the socket closes. `for await (const m of incoming)` implicitly holds the handler. |
| `abortSignal` | Fires on disconnect / `app.close()`. Register all cleanup here. |
| `c`, `params`, `query` | Hono context, URL params, query. Auth via `c.get("user")` from middleware. |

### Middleware inheritance

Middleware runs **before** the WebSocket upgrade — an `authMiddleware` that rejects returns an HTTP error and the client never sees an open socket. Same `middlewares` array on parent route nodes as pages/actions/streams.

### Client hook

```ts
const { send, status, lastMessage, close } = useSocket(socket_terminal, {
    channel: workerId,
    onMessage: (msg) => { /* ... */ },
});
```

- `status: Signal<"connecting" | "open" | "closed">` — reactive.
- **No auto-reconnect** — sockets are usually stateful (pty sessions, collaborative state); blind reconnect loses state silently. Re-mount or toggle `enabled` to reconnect.

### Testing

```ts
const ws = await app.socket(socket_terminal, {
    user: { id: "alice" },
    params: { workerId: "w42" },
});
ws.send({ type: "data", data: "ls\n" });
const reply = await ws.next({ timeoutMs: 500 });
await ws.close();
```

`app.socket()` invokes the handler in-memory and aborts on `app.close()`. **Middleware does NOT run** — pass `user` via options to shortcut `c.get("user")`; test middleware via regular endpoint tests that use the same middleware.

Full reference: [site/docs/12-sockets.md](./site/docs/12-sockets.md).

---

## Hooks

All hooks work in both SSR and client (via AsyncLocalStorage on server, wouter/DOM on client).

| Hook | Description |
|------|-------------|
| `useLoader<T>(deps?)` | Loader data with SSR + SPA support. Returns `{ data, loading, refetch }` |
| `Loader<T>()` | Module-level SSR-only loader. Returns `{ data, loading }` |
| `useEventStream<T, S>(stream, opts?)` | Subscribe to a server-sent event stream. Returns `{ data, snapshot, closed, error }` |
| `useParams<T>()` | Route parameters (e.g., `:id`) |
| `useQuery<T>()` | Query string parameters |
| `useNavigate()` | Programmatic navigation. Returns `navigate(path)` function |
| `usePathname()` | Absolute pathname (unlike wouter's `useLocation` which is relative to nest context) |
| `touch(signal)` | Force signal notification after nested property mutation |

### touch

```typescript
const items = useSignal<Item[]>([]);

// Mutating nested properties doesn't trigger signal updates
items.value[0].checked = true;

// touch() forces the update
touch(items);
```

---

## Link Component

Navigation with type-safe module references or string paths.

```typescript
import { Link } from "@mauroandre/velojs";
import * as UserPage from "./users/UserDetail.js";
import * as LoginPage from "./auth/Login.js";

// With route module (relative — uses metadata.path, works with wouter nest context)
<Link to={UserPage} params={{ id: "123" }}>View</Link>

// With route module (absolute — uses metadata.fullPath)
<Link to={LoginPage} absolute>Login</Link>

// With query string
<Link to={UserPage} params={{ id: "123" }} search={{ tab: "settings" }}>
    Settings
</Link>

// String path (relative to current nest context)
<Link to="/users">Users</Link>

// String path with ~/ prefix (absolute — escapes nest context)
<Link to="~/stacks">Stacks</Link>
<Link to={`~/stacks/apps/${appId}/edit`}>Edit App</Link>
```

### The `~/` prefix

VeloJS uses wouter-preact for routing. When routes are nested (layouts wrapping children), wouter creates a **nest context** — relative paths resolve within the current layout's scope.

The `~/` prefix escapes the nest context and navigates from the root. Use it when navigating between sections:

```typescript
// Inside /master/workers layout, these behave differently:
<Link to="/details">   → resolves to /master/workers/details (relative)
<Link to="~/stacks">   → resolves to /stacks (absolute from root)
```

**When to use `~/`**: anytime you navigate to a route outside the current layout's scope. In practice, most cross-section links use `~/`.

### Props

| Prop | Type | Description |
|------|------|-------------|
| `to` | `string \| RouteModule` | Destination path or module. String paths support `~/` prefix for absolute navigation |
| `params` | `Record<string, string>` | URL parameter substitution (`:id` → value) |
| `search` | `Record<string, string>` | Query string parameters |
| `absolute` | `boolean` | When using module reference: use `fullPath` instead of `path` (default: `false`) |

---

## Scripts Component

Injects necessary scripts and styles in `<head>`.

```tsx
import { Scripts } from "@mauroandre/velojs";

export const Component = ({ children }) => (
    <html>
        <head>
            <Scripts />
        </head>
        <body>{children}</body>
    </html>
);
```

### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `basePath` | `string` | `process.env.STATIC_BASE_URL \|\| ""` | Base path for static assets |
| `favicon` | `string \| false` | `"/favicon.ico"` | Favicon path, or `false` to disable |

### Output

**Development:**
```html
<link rel="icon" href="/favicon.ico" type="image/x-icon" />
<script type="module" src="/@vite/client"></script>
<script type="module" src="/__velo_client.js"></script>
```

**Production:**
```html
<link rel="icon" href="/favicon.ico" type="image/x-icon" />
<link rel="stylesheet" href="/client.a1b2c3.css" />
<script type="module" src="/client.x9y8z7.js"></script>
```

Asset filenames include a content hash for cache busting. The hash changes only when the file content changes.

---

## Middlewares

Server-side only. Removed from client bundle at build time.

### Creating a middleware

Use `createMiddleware` from `velojs/factory` (wraps Hono's middleware):

```typescript
// app/modules/auth/auth.middleware.ts
import { createMiddleware } from "@mauroandre/velojs/factory";
import { getCookie } from "@mauroandre/velojs/cookie";

export const authMiddleware = createMiddleware(async (c, next) => {
    const token = getCookie(c, "session");

    if (!token) {
        if (c.req.method === "GET") return c.redirect("/login");
        return c.json({ error: "unauthorized" }, 401);
    }

    // Set data on context — accessible in loaders and actions via c.get()
    const user = await verifyToken(token);
    c.set("user", user);

    await next();
});
```

### Using in routes

Add `middlewares` to any route node. All children inherit the middleware:

```typescript
// app/routes.tsx
import { authMiddleware } from "./modules/auth/auth.middleware.js";
import { masterMiddleware } from "./modules/auth/master.middleware.js";

export default [
    {
        module: Root,
        isRoot: true,
        children: [
            // Public routes — no middleware
            { path: "/login", module: AuthLayout, children: [{ module: Login }] },

            // Authenticated routes
            {
                module: AdminLayout,
                middlewares: [authMiddleware],
                children: [
                    { path: "/", module: Dashboard },     // authMiddleware applies
                    { path: "/stacks", module: Stacks },  // authMiddleware applies

                    // Admin-only routes — both middlewares apply
                    {
                        path: "/master",
                        module: MasterLayout,
                        middlewares: [masterMiddleware],
                        children: [
                            { path: "/workers", module: Workers },  // auth + master
                            { path: "/settings", module: Settings },// auth + master
                        ],
                    },
                ],
            },
        ],
    },
] satisfies AppRoutes;
```

### Inheritance

Middlewares accumulate from parent to child and apply to **every nested route**, including:

- **Page routes** (GET) — when loading a page
- **Action routes** (POST `/_action/...`) — when calling a server action
- **Data fetches** (GET with `?_data=1`) — during SPA navigation

In the example above, `/master/workers` runs `authMiddleware` first, then `masterMiddleware`. The same applies when calling `action_*` functions from any page under `MasterLayout` — both middlewares run before the action executes.

```typescript
// This action, defined in app/master/Workers.tsx, is registered as
// POST /_action/master/Workers/delete
// with authMiddleware + masterMiddleware applied.
export const action_delete = async ({ body, c }: ActionArgs<{ id: string }>) => {
    const user = c!.get("user"); // set by authMiddleware
    // ...
};
```

A middleware on a Layout guards everything underneath it — pages, loaders, and actions — with no extra wiring.

### Accessing middleware data in loaders and actions

Use Hono's `c.get()` / `c.set()`:

```typescript
// Middleware sets data
c.set("user", { id: "123", name: "Mauro", role: "master" });

// Loader reads it
export const loader = async ({ c }: LoaderArgs) => {
    const user = c.get("user");
    return { greeting: `Hello, ${user.name}` };
};

// Action reads it
export const action_save = async ({ body, c }: ActionArgs<{ name: string }>) => {
    const user = c!.get("user");
    // ...
};
```

---

## Server API

### `addRoutes(fn)`

Register custom Hono routes before page/action routes. Call in `app/server.tsx`. Use this for REST APIs, SSE streams, file uploads, webhooks, and any custom HTTP endpoints.

```typescript
// app/server.tsx
import { addRoutes } from "@mauroandre/velojs/server";
import type { Hono } from "hono";

addRoutes((app: Hono) => {
    // REST API
    app.get("/api/health", (c) => c.json({ ok: true }));

    app.post("/api/upload", async (c) => {
        const body = await c.req.parseBody();
        const file = body.file;
        // ...
        return c.json({ ok: true });
    });

    // Middleware for a group of routes
    app.use("/api/admin/*", async (c, next) => {
        const token = c.req.header("Authorization");
        if (!token) return c.json({ error: "Unauthorized" }, 401);
        await next();
    });
});
```

### Server-Sent Events (SSE)

Use Hono's `streamSSE` for real-time server-to-client communication.

```typescript
import { addRoutes } from "@mauroandre/velojs/server";

addRoutes((app) => {
    app.get("/api/events", async (c) => {
        const { streamSSE } = await import("hono/streaming");

        return streamSSE(c, async (stream) => {
            // Send snapshot on connect
            await stream.writeSSE({ event: "snapshot", data: JSON.stringify({ count: 0 }) });

            // Subscribe to updates
            const unsubscribe = subscribe((data) => {
                stream.writeSSE({ event: "update", data: JSON.stringify(data) });
            });

            // Cleanup on disconnect
            stream.onAbort(() => { unsubscribe(); });

            // Keep stream open
            await new Promise<void>(() => {});
        });
    });
});
```

Client-side consumption with `EventSource`:

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

### SSE with polling (live metrics)

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

### `onServer(fn)`

Access the underlying Node.js HTTP server. Useful for WebSocket handlers.

```typescript
import { onServer } from "@mauroandre/velojs/server";

onServer((httpServer) => {
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
                    // Cleanup
                });
            });
        }
    });
});
```

Callbacks queue until the server starts. If called after startup, executes immediately.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_PORT` | `3000` | Server port |
| `NODE_ENV` | — | Set automatically by `velojs start`. Enables static file serving |
| `STATIC_BASE_URL` | `""` | CDN/bucket prefix for static assets |

---

## Vite Plugin Architecture

`veloPlugin()` returns 6 plugins:

| Plugin | Purpose |
|--------|---------|
| `velo:config` | Build config (client/server modes, aliases, defines) |
| `velo:transform` | AST transforms (metadata injection, action stubs, loader removal) |
| `velo:static-url` | Rewrites CSS `url(/path)` to `url(STATIC_BASE_URL/path)` at build time |
| `@preact/preset-vite` | Preact JSX support |
| `@hono/vite-dev-server` | Dev server with SSR |
| `velo:ws-bridge` | Exposes Vite's HTTP server for WebSocket handlers in dev mode |

### AST Transformations

Applied during Vite's `transform` hook to files in `appDirectory`:

| # | Transform | When | What it does |
|---|-----------|------|-------------|
| 1 | `injectMetadata` | Server + Client | Adds `export const metadata = { moduleId, fullPath, path }` |
| 2 | `transformLoaderFunctions` | Server + Client | Injects moduleId: `useLoader()` → `useLoader("moduleId")` |
| 3 | `transformActionsForClient` | Client only | Replaces action body with `fetch()` stub |
| 4 | `removeLoaders` | Client only | Removes `export const loader` entirely |
| 5 | `removeMiddlewares` | Client only | Removes `middlewares: [...]` and related imports |

### Build Process

```bash
velojs build
# 1. vite build              → dist/client/ (client.js, client.css, manifest.json)
# 2. vite build --mode server → dist/server.js (SSR entry)
```

### Virtual Modules

| Module | Purpose |
|--------|---------|
| `virtual:velo/server-entry` | Server entry — imports `server.tsx` + routes, calls `startServer()` |
| `virtual:velo/client-entry` | Client entry — imports `client.tsx` + routes, calls `startClient()` |
| `/__velo_client.js` | Alias for client entry (used in dev) |

### Hot Reload

When `routes.tsx` changes, the plugin rebuilds the fullPath map and triggers a full page reload (not partial HMR).

---

## Request Isolation

VeloJS uses Node's `AsyncLocalStorage` to isolate data per request. Each SSR render runs in its own storage context, preventing data leaks between concurrent requests.

Hooks (`useParams`, `useQuery`, `usePathname`, `Loader`, `useLoader`) access this storage on the server via `globalThis.__veloServerData`.

---

## Testing

VeloJS ships a backend testing toolkit at `@mauroandre/velojs/testing`. Spin up the app in memory, fire HTTP requests against the registered handlers, subscribe to event streams. No socket, no browser, no fragile mocks of framework internals.

```typescript
import { createTestApp } from "@mauroandre/velojs/testing";
import { routes } from "../app/routes.js";
import { stream_progress } from "../app/Deploy.js";
import { action_startDeploy } from "../app/Deploy.js";

const app = await createTestApp({
    routes,
    bootstrap: async () => { await connect(process.env.MONGO_URI!); },
    getSessionCookie: async ({ user }) => ({ session: await sign(user) }),
});

// HTTP
const res = await app.get("/api/health");

// Convention helpers — pass the function, framework resolves the URL
const data = await app.loader(homeLoader, { params: { id: "abc" } });
await app.action(action_startDeploy, { body: { appId } });

// Streams — TestSubscription with snapshot, next(), close, etc
const sub = await app.subscribe(stream_progress, { channel: appId });
expect(sub.status).toBe(200);
const event = await sub.next({ timeoutMs: 2000 });

// Auth — sub-client with cookies bound automatically
const asAlice = app.as({ user: alice });
await asAlice.subscribe(stream_progress, { channel: appId });

await app.close();
```

**Prerequisite:** `vitest.config.ts` must include `veloPlugin()` so action/loader/stream metadata is injected.

| API | Purpose |
|-----|---------|
| `createTestApp(options)` | Build isolated app with bootstrap + auth callback |
| `app.get/post/put/patch/delete` | HTTP requests (cookies, headers, query, JSON/FormData body) |
| `app.action(fn, opts)` | Invoke `action_*` by function reference |
| `app.loader(fn, opts)` | Invoke `loader` and unwrap response data |
| `app.subscribe(stream, opts)` | Subscribe to a stream; returns `TestSubscription` with `next/nextN/snapshot/close/closed` |
| `app.as({ user })` | Sub-client with cookies bound to a user |
| `app.sessionCookies({ user })` | Build cookies via `getSessionCookie` |
| `app.mockContext(opts)` | Escape hatch — partial Hono Context for direct invocation |
| `app.reset()` | Clear stream buffers/listeners between tests |
| `app.close()` | Tear down everything (zero open handles guaranteed) |

See [Testing docs](https://github.com/mauro-andre/velojs/blob/dev/site/docs/17-testing.md) for the full guide with patterns, isolation, and FAQ.

---

## Subpath Exports

| Import | Contents |
|--------|----------|
| `@mauroandre/velojs` | Types (`AppRoutes`, `ActionArgs`, `LoaderArgs`, `Metadata`, `EventStream`, `EventStreamConfig`, `EmitFn`, `EmitOptions`, `SourceFn`, `PerChannelSourceFn`, `ChannelResolver`), `Scripts`, `Link`, `createEventStream`, `poll`, `defineConfig` |
| `@mauroandre/velojs/server` | `startServer`, `createApp`, `addRoutes`, `onServer`, `serverDataStorage` |
| `@mauroandre/velojs/client` | `startClient` |
| `@mauroandre/velojs/hooks` | `Loader`, `useLoader`, `useEventStream`, `useParams`, `useQuery`, `useNavigate`, `usePathname`, `touch` |
| `@mauroandre/velojs/events` | `createEventStream`, `poll`, `EventStream`, `EventStreamConfig`, `EmitFn`, `EmitOptions`, `SourceFn`, `PerChannelSourceFn`, `ChannelResolver` (also re-exported from root) |
| `@mauroandre/velojs/testing` | `createTestApp`, `TestApp`, `TestResponse`, `TestSubscription`, `CreateTestAppOptions`, `MockContextOptions` |
| `@mauroandre/velojs/cookie` | `getCookie`, `setCookie`, `deleteCookie`, `getSignedCookie`, `setSignedCookie` |
| `@mauroandre/velojs/factory` | `createMiddleware`, `createFactory` |
| `@mauroandre/velojs/vite` | `veloPlugin` |
| `@mauroandre/velojs/config` | `defineConfig`, `VeloConfig` |

---

## Type Reference

```typescript
interface LoaderArgs {
    params: Record<string, string>;
    query: Record<string, string>;
    c: Context; // Hono Context
}

interface ActionArgs<TBody = unknown> {
    body: TBody;
    params?: Record<string, string>;
    query?: Record<string, string>;
    c?: Context;
}

interface Metadata {
    moduleId: string;
    fullPath?: string;
    path?: string;
}

interface RouteModule {
    Component: ComponentType<any>;
    loader?: (args: LoaderArgs) => Promise<any>;
    metadata?: Metadata;
    [key: `action_${string}`]: (args: ActionArgs) => Promise<any>;
}

interface RouteNode {
    path?: string;
    module: RouteModule;
    children?: RouteNode[];
    middlewares?: MiddlewareHandler[];
    isRoot?: boolean;
}

type AppRoutes = RouteNode[];

interface VeloConfig {
    appDirectory?: string;   // default: "./app"
    routesFile?: string;     // default: "routes.tsx"
    serverInit?: string;     // default: "server.tsx"
    clientInit?: string;     // default: "client.tsx"
}
```

---

## Static Site Generation (SSG)

Build a fully static site with pre-rendered HTML and JSON files:

```bash
velojs build --static
```

### Output

```
dist/
  index.html              # Pre-rendered HTML
  index.json              # Loader data
  about/
    index.html
    index.json
  client/
    client.a1b2c3.js
    client.x9y8z7.css
  logos/                   # Files from public/ are copied to dist/
    logo.svg
```

### Public assets

Files in the `public/` folder are automatically copied to `dist/` root during static generation. Reference them with absolute paths:

```tsx
<img src="/logos/logo.svg" />
```

This works in both dev mode (Vite serves `public/` at root) and static builds (`public/` is copied to `dist/`).

### Dynamic routes

For routes with `:params`, export a `staticPaths` function that returns all possible parameter combinations:

```typescript
// app/pages/UserDetail.tsx
export const staticPaths = async () => {
    const { getUsers } = await import("./user.service.js");
    const users = await getUsers();
    return users.map((u) => ({ id: u.id }));
};
```

Routes without `staticPaths` are skipped with a warning.

### Deploying

The `dist/` folder is self-contained. Deploy to any static hosting (Nginx, Cloudflare Pages, S3, etc.). No server required.

---

## Cache Busting & Auto-Update Detection

VeloJS has built-in cache management for zero-downtime deployments:

### Content-hashed assets

JS and CSS files are generated with content hashes (`client.a1b2c3.js`). When the content changes, the hash changes, and browsers automatically fetch the new version. Unchanged assets stay cached indefinitely.

### HTML no-cache

HTML responses include `Cache-Control: no-cache`, so browsers always check for the latest version. Since HTML is small (a few KB), this has negligible performance impact.

### SPA deploy detection

When a user is navigating a SPA and a new deploy happens, VeloJS detects it automatically:

1. Each build generates a unique `__VELO_BUILD_HASH__`, embedded in the client JS
2. JSON data responses (both SSR and SSG) include a `__buildHash` field
3. On SPA navigation, `useLoader` compares the response hash with the client hash
4. If they differ, an internal `__veloUpdatePending` flag is set
5. On the next `<Link>` click, VeloJS does a full page navigation instead of SPA — loading the new HTML with updated asset references

This means users get the new version without needing `Ctrl+Shift+R`. The transition is seamless — from the user's perspective, it looks like a normal page navigation.

---

## Docker / Production Deploy

### Dockerfile

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY app ./app
COPY tsconfig.json vite.config.ts ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

ENV SERVER_PORT=3000
EXPOSE 3000
CMD ["npx", "velojs", "start"]
```

### Build output

```bash
velojs build
# dist/
#   client/         # Static assets (JS, CSS, images)
#     client.a1b2c3.js
#     client.x9y8z7.css
#     .vite/manifest.json
#   server.js       # SSR server entry (single file)
```

Asset filenames include content hashes for long-term browser caching. The server build reads the Vite manifest to inject the correct filenames into `<Scripts>`.

In production, `velojs start` sets `NODE_ENV=production` automatically and serves static files from `dist/client/`. HTML responses are served with `Cache-Control: no-cache` so browsers always fetch the latest HTML (which references the current hashed assets).

### Static assets on CDN

Set `STATIC_BASE_URL` to serve static assets from a CDN or S3 bucket:

```bash
STATIC_BASE_URL=https://cdn.example.com/assets node dist/server.js
```

The `<Scripts />` component and CSS `url()` references will use this prefix automatically.

---

## Included Dependencies

VeloJS includes everything you need. A single `npm install @mauroandre/velojs` brings:

- **Hono** — HTTP server and routing
- **Preact** — UI rendering (SSR + client)
- **@preact/signals** — Reactive state management
- **wouter-preact** — Client-side routing
- **Vite** — Build tool and dev server
- **@preact/preset-vite** — Preact JSX support
- **@hono/vite-dev-server** — SSR dev server

No need to install these separately.
