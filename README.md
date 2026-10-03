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

To expose the dev server beyond loopback — a VPS behind a reverse proxy, an app reached by hostname — set `HOST=0.0.0.0`, in the shell or in the project's `.env`; no `--host` flag by hand. The security trade-off: a broad bind in dev (`0.0.0.0`, `::`, or `--host` with no value) turns Vite's Host check off, so a request whose `Host` header carries that domain is served instead of 403'd — the DNS-rebinding protection you get on loopback is consciously given up. Stay on localhost unless you are behind a proxy; a `server.allowedHosts` declared in `vite.config.ts` still pins the allowed list.

### Configuration

```typescript
veloPlugin({
    appDirectory: "./app",      // default
    routesFile: "routes.tsx",   // default
    serverInit: "server.tsx",   // default
    clientInit: "client.tsx",   // default
    hostname: "127.0.0.1",      // bind interface, dev and production (the HOST env wins)
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

## Live Loader

A page value that must **track server state over time** — a total another
person's request changes, data a background scheduler mutates — declares the
channels that keep it fresh. No extra component, no manual subscription: the
module exports `channels` next to its `loader`.
The one-sentence model: the live loader keeps a page's state replica faithful to the server — the first payload arrives through the usual path (SSR, `__PAGE_DATA__`, the `?_data=1` refetch), and from then on every change is **addressed**, by the app's own rules, to the group of clients it concerns, **by duty or by interest**, each one receiving the state computed for its own scope.

```tsx
// app/expenses/Expenses.tsx
export const loader = async ({ c }: LoaderArgs) => {
    const user = c.get("user");
    return {
        teamTotal: await expensesService.teamTotal(user.teamId),
        expenses: await expensesService.byTeam(user.teamId),
    };
};
export const channels = ["teamExpenses"];

export const Component = () => {
    const { data, freshness } = useLoader();
    return <h2 class={freshness.value}>Team: ${data.value?.teamTotal}</h2>;
};
```

```ts
// app/channels.ts — the app's channel map: name → partition resolver
export const channels = {
    teamExpenses: {
        // On subscribe the ctx is { user, params }: the principal materialized
        // in c.get("user") and the route params the connection declared. On
        // emit it is the object the producer built, with the fields this scope
        // consumes. Returns the partition key.
        scope: ({ user }) => `team:${user.teamId}`,
    },
};
```

```ts
// anywhere server-side: an action, server.tsx, a scheduler, a webhook
import { emit } from "@mauroandre/velojs/server";

await emit("teamExpenses", { user: { teamId: 7 } });
```

### What happens

- The framework derives one internal SSE route per declared channel —
  `GET /_channel/{moduleId}/{channel}`, the same family as `/_action` and
  `/_event` — inheriting the `middlewares` of the module's route node.
- After hydration the client opens one connection per (module, channel) of the
  rendered hierarchy (layout and page alike) and closes it on unmount. A
  channel declared by both a layout and a page produces one connection per
  module, each feeding its own module's data; a single `emit` reaches both.
- Every new connection immediately receives the **current state**, computed by
  re-executing the loader with that connection's own principal and route
  params — so the pane never shows the SSR value while the server has already
  moved on.
- `emit(channel, ctx)` resolves the partition with the same `scope` — the
  producer builds the same `{ user, params }` shape with the fields its scope
  consumes — finds the connections in that partition and pushes a fresh
  snapshot to each one: its loader re-executed with its own principal and route
  params. Connections of other partitions receive nothing.
- The snapshot **replaces** the module's loader data; the component re-renders
  by itself. `useLoader()` and `Loader()` also expose `freshness` — `"live"`,
  `"stale"` (connection closed/reconnecting/silent), `"error"` (the last
  re-execution failed) — aggregated per page, plus `freshnessByChannel`, the
  same states keyed by each of the module's channel names. They are data for
  CSS to react to.

### Routes with `:params` — the client declares, the server decides

A channel declared in a module whose route has `:params` (`/projeto/:id`, a page
or a layout) partitions per **resource**, and the loader re-executes with
`params.id` filled — the connect snapshot and every emit.

```tsx
// app/projeto/Projeto.tsx — the route /projeto/:id
export const loader = async ({ params }: LoaderArgs) => ({
    arquivos: await projetoService.arquivos(params.id),
});
export const channels = ["projetoArquivos"];
```

```ts
// app/channels.ts
export const channels = {
    projetoArquivos: {
        scope: ({ user, params }) => {
            if (!params?.id) return null;
            if (user && !podeVer(user, params.id)) return null;   // 403
            return `projeto:${params.id}`;
        },
    },
};
```

- The client **declares** the address it is already seeing: it extracts the
  params the module's `fullPath` declares, matching as a **prefix** of the
  pathname (a layout `/projeto/:id` covers `/projeto/7/sala` and extracts
  `id=7`; the child's suffix takes no part) and sends them in `?_route=<json>`.
  A catch-all (`/docs/*`) declares no `:` key — the connection travels by
  principal.
- The server **decides**: it validates the keys against the module's declared
  path — a key the path does not declare rejects the subscription with **400** —
  and the `scope` validates the policy (possession/permission), deriving the
  key. `params` are never an authorization input: they are the declared route,
  validated by shape and then by policy.
- The internal `_route` key never reaches the loader's `query`: it is transport,
  not page data.
- The connection is **keyed by the extracted params**, not by the pathname:
  `/projeto/7` → `/projeto/9` closes the connection and opens a new one (with a
  snapshot on connect); `/projeto/7` → `/projeto/7/sala` does not reconnect.

### Group lifecycle: `onGroupOpen` / `onGroupClose`

A source with a **cost of life** — a filesystem watcher, a process, a
subscription to an external service — must not run forever for an empty group.
The first connection of a group (channel + partition) arms it and the last one
disarms it, by any cause (disconnect, idle, revalidation):

```ts
export const channels = {
    projetoArquivos: {
        scope: ({ params }) => (params?.id ? `projeto:${params.id}` : null),
        onGroupOpen: ({ params }) =>
            watchers.armar(params.id, () => emit("projetoArquivos", { params: { id: params.id } })),
        onGroupClose: ({ partition }) => watchers.desarmar(),
    },
};
```

- A second connection of the same group fires nothing.
- Both hooks may be async and are **awaited**: on open, before the connect
  snapshot (the source is armed before the first data arrives); on close, before
  the group is discarded. A hook that throws (or rejects) is logged loudly,
  naming channel and partition, and the group continues — the cold-source
  snapshot still arrives, only the live data waits for the fix.
- The hook is infrastructure, not policy: it does not receive `user`.
- The `params` of `onGroupOpen` belong to the connection that opened the group
  and are identical across it **only when the partition derives from them** (a
  watcher per resource). A channel partitioned by **principal**, declared in a
  module with `:params`, mixes resources in one group: do not consume the
  hook's params there.

### Two ways to emit

**Invalidation** — `emit(channel, ctx)` says *this partition changed*, without
knowing the shape of the data: the runtime re-executes the loader per connection
and pushes the snapshot. Use it when only the server knows the new value (a
background job, another request).

**Slice** — `emit(module, channel, ctx, slice)` says *here is the new value*: the
producer already holds it, so it travels as-is to the connections of that
(module, channel) pair in the partition, and **no loader runs**. The slice is
typed as a `Partial` of what that module's loader returns, so `tsc` rejects an
unknown key or a wrong value type.

```ts
import { emit } from "@mauroandre/velojs/server";
import * as Expenses from "../app/expenses/Expenses.js";

// invalidation: the runtime re-executes Expenses.loader per connection
await emit("teamExpenses", { user: { teamId: 7 } });

// slice: the value is already in hand — delivered as-is, no re-execution
await emit(Expenses, "teamExpenses", { user: { teamId: 7 } }, { teamTotal: 880 });
```

Why the module, and not just the channel name? Because the same channel can be
declared by a layout **and** by a page, each with its own loader and its own
`Data` — a slice is the shape of exactly one of them, and it reaches only that
module's connections. `emit(channel, ctx)` keeps reaching every module of the
channel.

### The merge contract

- **Snapshot replaces; slice merges.** A snapshot (connect or invalidation) is
the whole value of the module's data; a slice applies a **shallow** merge by
key on top of the current value.
- The key sent is replaced by the **whole value** sent — lists travel whole
  inside their key; there is no list diff. Keys not sent stay intact.
- **Removal is explicit**: removing an item is re-sending the key with the new
  whole list (without the item). An absent key never means "remove".
- The merge happens **on arrival**, never at render: slices that land in the
  same frame are applied together before the next render — none is lost — and
  for the same key the last one in arrival order wins. A malformed payload keeps
  the previous value.
- The runtime merges blindly (it is JavaScript); shape safety comes from the
  emit typing. A key that does not exist in the loader's `Data` only gets in
  through a cast, and that is a usage error.

### Bursts, log and revalidation

- **Coalescing.** Invalidation emits are folded per (channel, partition): the
  first opens a window, the emits inside it join, and closing the window fires
  **one** re-execution round per connection — no invalidation is lost. The
  default window is `50ms`; `registerChannels(map, { coalesceMs: 0 })` turns it
  off (immediate), and a slice never waits for it (a slice is pushed directly).

  The window decides what `await emit(…)` waits for: with it off (`0`, and the
  test toolkit's default) the await resolves after the round was delivered;
  with it open it resolves as soon as the gesture is registered — the log line
  is out, the delivery comes later. Never assert a screen update right after
  `await emit(…)` under the default window: await the arrival (`next()` /
  `nextEvent()`) or wait for the effect.
- **Emit log.** Every `emit`, in either mode, writes one `console.log` line at
  the moment of the gesture:

  ```
  [velojs] emit kind=invalidate channel="teamExpenses" partition="team:7" connections=2 at=2026-09-30T12:00:00.000Z
  ```

  `connections` is the size of the group at that instant — before coalescing and
  before revalidation — and the consolidated delivery writes no second line. An
  emit whose `scope` resolves to nothing logs `partition=null connections=0`:
  reaching nobody is exactly what the log is for.
  `registerChannels(map, { logEmits: false })` silences it. In tests,
  `createTestApp` registers with the window off and takes the same options in
  `channelOptions`.
- **Partition revalidation.** Before delivering anything, the runtime re-derives
  each connection's partition by running the `scope` again with the ctx captured
  at subscribe — the principal and the validated route params of that
  connection. A connection whose partition moved — or whose scope now
  returns `null` — is removed from the group and closed: the client sees the
  connection closed (`freshness` goes `"stale"`) and receives none of that
  emit's data. A `scope` that **throws** on re-derivation is treated the same
  way — fail-closed, with the failure logged naming the channel — so a scope
  that does I/O must handle its own failures. Only the partition is revalidated;
  session expiry stays with the normal request pipeline.

### Transport: heartbeat, idle timeout and the proxy

An SSE connection crosses infrastructure that was not built for it — proxies,
load balancers, browsers with sleeping tabs. The channel answer is built for
that traffic, and its transport has exactly two clocks:

- **Heartbeat** — an SSE comment (`: ping`) written through the write chain
every `heartbeatMs`. It keeps proxies and browsers from buffering or closing an
idle stream, and it is pure transport: it generates no event in the client and
does not count as a delivery — it touches neither freshness nor idle. The
default is `20000` (20s), the same `DEFAULT_HEARTBEAT_MS` the `stream_*` SSE
surface uses — one transport ruler in the house. `0` disables it.
- **Idle timeout** — a connection with **no deliveries** (snapshot or slice) for
`idleMs` is closed by the server. The heartbeat does not reset it: idle is
about data, heartbeat is transport. A live but quiet page cycles by design —
close, `EventSource` reconnects by itself, snapshot on connect repairs the
state — and an abandoned page's resources are freed for good. The default is
`300000` (5 min) in any registration without options; `0` disables it.

```ts
// app/channels.ts registration with explicit windows
registerChannels(channels, { idleMs: 60000, heartbeatMs: 15000 });
```

The answer also carries `Cache-Control: no-store`: a proxy or the browser must
never serve a cached channel snapshot — a stale snapshot is exactly the illusion
the live loader exists to kill.

**Behind a reverse proxy (the house recipe, Caddy).** SSE needs the proxy to
flush immediately and never buffer the response, or the page goes silent even
with everything alive. In the Caddyfile, the reverse_proxy for the app needs
`flush_interval -1` (flush as soon as data arrives — a negative value means
"immediately", which is what SSE requires; a positive interval would batch
chunks and delay every snapshot). Caddy passes the request through with
streaming by default and closes dead upstreams on its own probes — the
heartbeat then does its part at 20s, and the idle timeout closes what nobody is
reading anymore. If you put another proxy in front (nginx, a cloud LB), the
same two rules apply: no response buffering, and `X-Accel-Buffering: no` for
nginx or the equivalent for the LB.

### Inspecting the live channels

When the incident happens, the server answers "what is alive?":

```ts
// anywhere server-side (an action, a guarded endpoint of your own)
import { inspectChannels } from "@mauroandre/velojs/server";

const report = inspectChannels();
// {
//   channels: [{
//     channel: "teamExpenses",
//     groups: [
//       { moduleId: "expenses/Layout", partition: "team:7",
//         connections: 1, lastDeliveryAt: "2026-09-30T12:00:00.000Z" },
//       { moduleId: "expenses/Expenses", partition: "team:7",
//         connections: 1, lastDeliveryAt: "2026-09-30T12:00:01.104Z" },
//     ],
//     connections: 2,
//   }],
//   openCoalesceWindows: [],
//   totalConnections: 2,
// }
```

Per channel, the groups are identified by the pair (moduleId, partition key) —
in the incident you know which page/module holds every connection — each with
its connection count and the timestamp of the last delivery; the coalescing
windows still open; the grand totals. `inspectChannels()` is always available:
the app decides how (and with what guard) to expose it.

In development there is a ready-made lens: `GET /_channel-inspect` answers the
same JSON in the browser. It exists **only in dev** — the map of channels and
partitions is internal information, and it never ships in a production build.

### The partition contract

**Addressed, not broadcast.** A partition is not a filter applied after a broadcast. The `emit` is addressed: the runtime resolves the partition key and writes only to the connections of that group — a client outside the group never hears about the change, not even a byte. Two reasons make a partition matter, and they compose: **by duty** (authorization — the data belongs to that team, that family, that project; others must not see it) and **by interest** (relevance — the tab watching project 9 has nothing to wake up for when project 7 changes). The same `scope` serves both; the app decides which, or both at once.

On subscribe the `scope` receives `{ user, params }`. `user` is `c.get("user")`
— the house key, the same one the stream/socket channel resolvers use (a
middleware that materializes the principal elsewhere should set it in `"user"`
too) — and `params` are the route params the connection declared, already
validated. Without an authenticated principal `user` is `undefined`: a public
channel ignores it (`() => "all"`), an authenticated one returns `null`, which
denies the subscription with 403; an app that does not materialize a principal
at all (a network guard, e.g. loopback) writes `({ params }) => …`. On emit the
same scope receives the object the producer built, with the fields it consumes
(`{ params: … }` or `{ user: … }`). A scope that **throws** on subscribe denies
with **403** and logs loudly, naming the channel.
The partition **never** derives from the query string or from any other client
input: `params` are the declared route — validated by shape — not a choice of
subject.

### State or flow?

Two questions decide, every time:

| Question | Answer | Tool |
|---|---|---|
| Is this a **value** or a **sequence**? | value — "what is it now?", replacement | `loader` + `channels` |
| | sequence — "what happened?", accumulation (chat, log, progress) | `stream_*` / `socket_*` |
| Does the change come from **someone else** or from **me**? | someone else / a background job | `loader` + `channels` |
| | me, through my own action | `refetch()` after the action |

### Guards

- `channels` in a module **without** a `loader`: explicit error in the dev
  server and in the build ("nothing to synchronize").
- A channel **without an entry** in `app/channels.ts`: explicit error in the dev
  server and in the build, naming the channel.
- `emit()` on a channel with no entry in the map: throws immediately, naming
  the channel. `emit()` on a valid channel with no subscribers is a no-op.
- Route params with a key the module's path does **not** declare: the
  subscription is rejected with **400**, naming the key — the client may only
  declare what the route declares.
- A `scope` that **throws** on subscribe: denied with **403** and logged
  loudly, naming the channel.
- `emit(module, channel, …)` on a module that does not declare that channel, or
  that has no `loader`: throws immediately, naming both. A slice that is not an
  object throws too.
- `velojs build --static` with a module declaring `channels`: the channels are
  **inert** (no server for SSE) — the client opens no connection, `freshness`
  stays `"live"` and the build warns, naming the module.
- A module outside the conventions (`.jsx`/`.js`, or outside `app/`) is the one
  genuinely silent line: no transform, so the channel is simply inert.

### Testing a live loader

```ts
import { createTestApp } from "@mauroandre/velojs/testing";
import { emit } from "@mauroandre/velojs/server";
import { channels } from "../app/channels.js";
import * as Expenses from "../app/expenses/Expenses.js";

const app = await createTestApp({
    routes,
    channels,
    getSessionCookie: async ({ user }) => ({ session: await sign(user) }),
});

const sub = await app.as({ user: { teamId: 7 } }).channel(Expenses, "teamExpenses");
await sub.next({ timeoutMs: 1000 });     // snapshot on connect
await emit("teamExpenses", { user: { teamId: 7 } });
const snapshot = await sub.next({ timeoutMs: 1000 });
await emit(Expenses, "teamExpenses", { user: { teamId: 7 } }, { teamTotal: 880 });
const slice = await sub.next({ timeoutMs: 1000 });

// A route with `:params`: the connection declares them (validated for real).
const project = await app.channel(Project, "projetoArquivos", { params: { id: "7" } });
expect(await project.next({ timeoutMs: 1000 })).toEqual({ id: "7", files: ["a.txt"] });
```

`next()` returns the payload exactly as it travelled (a whole snapshot or a raw
slice); `nextEvent()` returns the same arrivals discriminated —
`{ type: "snapshot" | "slice", data }`. The toolkit registers the channels with
the coalescing window off, so `await emit(…)` is the delivery; a test that
exercises the window passes it in `channelOptions` — a sibling of `channels`,
which stays the map — and drives it with fake timers:

```ts
const app = await createTestApp({
    routes,
    channels,                                    // the map
    channelOptions: { coalesceMs: 20 },          // the registration options
    getSessionCookie,
});
```

The same `channelOptions` accepts `idleMs` and `heartbeatMs` — both default to
`0` in the toolkit (deterministic: no connection dies, no comment is written
unless the test asks for it and advances fake timers through the window it
meant). `inspectChannels()` is process-wide and sees the test app's real
channels: subscribe, emit, inspect, close, inspect again — all without network.
A test that exercises the idle timeout or the heartbeat arms the window
explicitly and drives it with fake timers; never assert freshness (in either
surface) without advancing the fake timers through the window.

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

Lifecycle is automatic: opens on mount, closes on unmount, re-opens when `channel` changes.

**Reconnect is stale-while-revalidate.** When the connection re-opens — `channel`, `stream` or `enabled` changed — `data` and `snapshot` keep their previous values until the first event of the new connection overwrites them, the same choice the loader store makes (a refresh must not blank the screen). A channel switch therefore never paints an empty state; only `closed` and `error` reset, because a re-open is a fresh attempt. First mount still starts at `null` and fills in when the snapshot arrives. An app that wants to blank the view on a new channel can clear the signals itself when the channel changes.

**Channel coming from loader data?** Pass `enabled` so the hook does not connect before the channel exists — the first render of a SPA navigation has `data = null`, and connecting with `channel: undefined` reaches the server without `?channel=`, which a resolver answers with `null` → 403 → a flash of `closed`:

```tsx
const { data } = useLoader<{ id: string }>();
const channel = data.value?.id;

// no connection until the loader resolves the channel
const { snapshot, closed } = useEventStream(stream_logs, {
    // spread only when it exists — `exactOptionalPropertyTypes` (the repo's own
    // tsconfig) rejects an explicit `undefined` in an optional property
    ...(channel != null && { channel }),
    enabled: channel != null,
});
```

### `poll` helper

For interval-based polling sources. Wraps your tick function in a loop that respects the `AbortSignal`. Errors in tick are logged but don't stop the loop.

```typescript
poll({ intervalMs: 3000, tick: async (emit) => emit(await collect()) })
```

### Per-channel sources

Use `perChannelSource` for resources that scale per channel (SSH connections, DB cursors, pub/sub topics). Invoked once per channel on first subscriber, aborted when the last subscriber of that channel leaves.

```typescript
// The client sends the composite key: useEventStream(stream_logs, { channel: `${worker}:${container}` })
export const stream_logs = createEventStream<string>({
    channel: (c) => c.req.query("channel") ?? "",
    bufferSize: 500,
    perChannelSource: async (key, emit, { abortSignal }) => {
        const [worker, container] = key.split(":");
        const conn = await ssh.connect(worker);
        const stream = conn.exec(`podman logs -f ${container}`);
        stream.on("data", (d) => emit(d.toString(), { snapshot: true }));
        abortSignal.addEventListener("abort", () => { stream.close(); conn.end(); });
    },
});
```

> `c.req.param()` does **not** work in a `stream_*` resolver — convention streams mount at a static path (`/_event/{moduleId}/{name}`), so the page's `:params` are not in scope and it always returns empty. The channel travels as `?channel=`. (Params do work in a standalone stream given an explicit `path` containing `:segments`.)

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
- `lastMessage: Signal<string | Uint8Array | null>` — last frame received.
- **Reconnect preserves `lastMessage`** — changing `stub.__path`, `channel` or `enabled` opens a new socket, but the previous frame stays until the first frame of the new one arrives (stale-while-revalidate, same as `useEventStream`); `status` restarts at `"connecting"` and `error` resets. Swapping the stub object with the same `__path` does not reconnect. Clear `lastMessage` yourself in `onOpen` if a channel switch must blank the view.
- **Channel coming from loader data?** Pass `enabled: channel != null` so the socket only opens once the channel resolves — same reason as `useEventStream`.
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
| `PORT` | `3000` | Server port. Overrides the `port` set in `defineConfig` |
| `HOST` | — | Bind interface, in dev and production. Overrides `defineConfig`'s `hostname`; in dev an explicit `--host`/`server.host` still wins |
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
| 1 | `removeMiddlewares` | Client only | Removes every `middlewares` property and the imports only it referenced |
| 2 | `removeEndpointRoutes` | Client only | Strips `handler:` endpoint nodes from `routes.tsx` |
| 3 | `injectMetadata` | Server + Client | Adds `export const metadata = { moduleId, fullPath, path }` |
| 4 | `transformLoaderFunctions` | Server + Client | Injects moduleId: `useLoader()` → `useLoader("moduleId")` |
| 5 | `transformActionsForClient` | Client only | Replaces action body with `fetch()` stub |
| 6 | `transformStreamsForClient` | Client only | `stream_*` → `{ __isVeloEventStream, __path }` stub |
| 7 | `transformSocketsForClient` | Client only | `socket_*` → `{ __isVeloSocket, __path }` stub |
| 8 | `removeLoaders` | Client only | Removes `export const loader` entirely |
| 9 | `pruneClientOnlyImports` | Client only | Drops imports left unreferenced by the strips above |

Only `.ts`/`.tsx` files inside `appDirectory` are transformed — a `.jsx`/`.js` page, or one outside it, is not touched at all.

### Build Process

```bash
velojs build
# 1. vite build              → dist/client/ (client.[hash].js, client.[hash].css, .vite/manifest.json)
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

VeloJS ships a backend testing toolkit at `@mauroandre/velojs/testing`. Spin up the app in memory, fire HTTP requests against the registered handlers, subscribe to event streams. No browser, no fragile mocks of framework internals — and a real TCP port when an external actor has to reach the app.

```typescript
import { createTestApp } from "@mauroandre/velojs/testing";
import routes from "../app/routes.js";
import { stream_progress } from "../app/Deploy.js";
import { action_startDeploy } from "../app/Deploy.js";

const app = await createTestApp({
    routes,
    bootstrap: async () => { await connect(process.env.MONGO_URI!); },
    getSessionCookie: async ({ user }) => ({ session: await sign(user) }),
    // port: 0,   // optional — also serve this app over real TCP (see below)
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

// Live loader — open a channel with a principal, emit, await the next snapshot
const live = await app.as({ user: { teamId: 7 } }).channel(Expenses, "teamExpenses");
await live.next({ timeoutMs: 1000 });            // snapshot on connect
await emit("teamExpenses", { user: { teamId: 7 } });
const snapshot = await live.next({ timeoutMs: 1000 });

await app.close();
```

**Prerequisite:** `vitest.config.ts` must include `veloPlugin()` so action/loader/stream metadata is injected.

| API | Purpose |
|-----|---------|
| `createTestApp(options)` | Build isolated app with bootstrap + auth callback |
| `app.port` / `app.url` | Real port and base URL of the TCP listener — `undefined` in the default in-memory mode |
| `app.get/post/put/patch/delete` | HTTP requests (cookies, headers, query, JSON/FormData body) |
| `app.action(fn, opts)` | Invoke `action_*` by function reference |
| `app.loader(fn, opts)` | Invoke `loader` and unwrap response data |
| `app.subscribe(stream, opts)` | Subscribe to a stream; returns `TestSubscription` with `next/nextN/snapshot/close/closed` |
| `app.channel(module, name, opts)` | Open a live-loader channel connection; `opts.params` declares the route params (validated for real — a wrong key rejects with 400); snapshots and slices arrive through `next()` (raw) or `nextEvent()` (`{ type, data }`) |
| `app.as({ user })` | Sub-client with cookies bound to a user |
| `app.sessionCookies({ user })` | Build cookies via `getSessionCookie` |
| `app.mockContext(opts)` | Escape hatch — partial Hono Context for direct invocation |
| `app.reset()` | Clear stream buffers/listeners between tests |
| `app.close()` | Tear down everything (zero open handles guaranteed) |

### External actors over TCP

In-memory requests never leave the process, so an actor that does — a worker in another VM POSTing a notify callback — needs a real socket. Pass `port` and the **same app instance** is served over TCP as well:

```typescript
const app = await createTestApp({ routes, port: 0 });   // 0 → free port

// Hand the URL to the external client (worker, container, another test process)
await provisioning.startWorker({ notifyUrl: `${app.url}/_action/Jobs/notify` });

// The worker POSTs over real HTTP; the in-memory subscription sees the event —
// same app, same stream registry, no glue and no second instance
const sub = await app.subscribe(stream_progress, { channel: jobId });
const event = await sub.next({ timeoutMs: 5000 });

await app.close();   // closes the listener, dropping in-flight SSE/WebSocket connections
```

Pages, endpoints, actions, `?_data=1` loaders, SSE and WebSocket all answer as in production; `app.close()` also terminates connections still open on the listener. `port` and `hostname` come from the options only — never from `process.env.PORT`/`HOST` (test determinism). Omitted `hostname` follows Node's default bind (all interfaces — the listener is reachable from the local network); `app.url` reports `http://localhost:<port>` unless an explicit hostname was given.

See [Testing docs](https://github.com/mauro-andre/velojs/blob/dev/site/docs/17-testing.md) for the full guide with patterns, isolation, and FAQ.

---

## Subpath Exports

| Import | Contents |
|--------|----------|
| `@mauroandre/velojs` | Types (`AppRoutes`, `ActionArgs`, `LoaderArgs`, `Metadata`, `EventStream`, `EventStreamConfig`, `EmitFn`, `EmitOptions`, `SourceFn`, `PerChannelSourceFn`, `ChannelResolver`), `Scripts`, `Link`, `createEventStream`, `poll`, `defineConfig` |
| `@mauroandre/velojs/server` | `startServer`, `createApp`, `addRoutes`, `onServer`, `serverDataStorage`, `emit`, `registerChannels`, `ChannelDefinition`, `ChannelMap`, `ChannelRegistryOptions` |
| `@mauroandre/velojs/client` | `startClient` |
| `@mauroandre/velojs/hooks` | `Loader`, `useLoader`, `useEventStream`, `useParams`, `useQuery`, `useNavigate`, `usePathname`, `touch`, `Freshness` |
| `@mauroandre/velojs/events` | `createEventStream`, `poll`, `EventStream`, `EventStreamConfig`, `EmitFn`, `EmitOptions`, `SourceFn`, `PerChannelSourceFn`, `ChannelResolver` (also re-exported from root) |
| `@mauroandre/velojs/testing` | `createTestApp`, `TestApp`, `TestResponse`, `TestSubscription`, `TestChannelSubscription`, `ChannelEvent`, `CreateTestAppOptions`, `MockContextOptions` |
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
    channels?: readonly string[];   // live loader: channel names kept fresh
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
    port?: number;           // default: 3000; the PORT env wins
    hostname?: string;       // bind interface, dev and production; the HOST env wins
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

### Live loader in a static build

A module that declares `channels` keeps rendering, but its channels are **inert** there: there is no server to speak SSE, so the client opens no connection, `freshness` stays `"live"` and the build warns, naming the module. Static output has no live data by construction.

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

ENV PORT=3000
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

In production, `velojs start` sets `NODE_ENV=production` automatically and serves static files from `dist/client/`. Assets carry content hashes and are **public by design**, so the server answers an existing file **before the app's route table** — a page route, an action endpoint or a route middleware (an auth guard redirecting to `/login`, for instance) never sees an asset path. Only the framework's own infra middlewares (trailing-slash normalization, the logger) run ahead of the asset lookup. Paths that are not files fall through to the app routes as usual (SSR pages, actions, streams, sockets, endpoints, the catch-all 404). HTML responses are served with `Cache-Control: no-cache` so browsers always fetch the latest HTML (which references the current hashed assets).

### Static assets on CDN

Set `STATIC_BASE_URL` to serve static assets from a CDN or S3 bucket:

```bash
STATIC_BASE_URL=https://cdn.example.com/assets node dist/server.js
```

The `<Scripts />` component and CSS `url()` references will use this prefix automatically. When `STATIC_BASE_URL` starts with `http`, the server mounts no local static at all — every path is an app path, and the assets' public-by-design semantics come from the bucket/CDN.

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
