# VeloJS — Agent Rules

You are building an application **with** VeloJS. This file is the constitution and the
map. It is not documentation: load the matching skill (below) before writing anything
non-trivial.

## The stack is a premise, not a choice

Server: **Hono**. UI: **Preact** + `@preact/signals`. Router: **wouter-preact**.
Build: **Vite** + the VeloJS Babel plugin.

Never introduce, suggest, or import: Express, Fastify, Next, Remix, React Router,
`react`/`react-dom` (both are aliased to `preact/compat` — import from `preact`),
Redux/Zustand/Jotai (component state is `@preact/signals`), or any router other than
the route tree. If a task seems to need one, you have misread the task — re-read the
relevant skill first.

## Rules that fail silently

These do not fail typecheck. They do not throw at build. They produce a broken app that
looks fine. Every row below was verified against the compiler transforms — treat them as
hard constraints, not style.

| Never write | Always write | What silently happens |
|---|---|---|
| `export default routes` (a variable) | the array literal inline in the `export default` — `satisfies AppRoutes` or `as AppRoutes` both work | the path map is built by reading the array **literal**; an identifier yields an empty map → no module gets `fullPath` → **every route 404s** |
| `import Home from "./pages/Home.js"`<br>`import { Component } from "./pages/Home.js"` | `import * as Home from "./pages/Home.js"` | only `import * as` is registered → **that route silently disappears** |
| `import * as Home from "../shared/Home.js"`<br>or a tsconfig alias, in `routes.tsx` | `./`-relative paths inside `appDirectory` | the map key won't match the module id → **route dropped** |
| `export async function action_x(...)` | `export const action_x = async ({ body }) => {}` | no client stub is generated → **the action body and its server imports ship to the browser and execute there** |
| `export const action_x = async (args) => {}` | `export const action_x = async ({ body }) => {}` | the generated stub references an undeclared `body` → **ReferenceError in the browser** when called |
| `export const action_x = ({ body }) => {}` (not `async`) | `async ({ body }) => {}` | not recognized → no stub → **server code runs in the browser** |
| `export async function loader(...)` | `export const loader = async ({ params }) => {}` | only `const` loaders are stripped → **the whole loader ships to the client bundle** |
| `export const action_a = ..., action_b = ...` | one `export const` per declaration | only the **first** declarator is read → **the second is silently ignored** (same for `loader`, `stream_*`, `socket_*`, `metadata`) |
| `useParams()` / `useQuery()` / `usePathname()` inside a `loader` | the loader's own args: `async ({ params, query, c }) => {}` | the async context wraps only rendering; loaders run **before** it → returns `{}` / `"/"` |
| `c.req.param(...)` or `params.x` inside `action_*`, `stream_*`, `socket_*` | actions: read it from `body`. streams/sockets: send `?channel=` from the client and read `query.channel` | these register at **static** paths (`/_action/{moduleId}/{name}`, `/_event/…`, `/_socket/…`) — the page's `:params` are not in scope → always `{}` / `undefined` |
| a page in `.jsx` / `.js`, or any page outside `appDirectory` | `.tsx` inside `app/` | **zero transforms**: no metadata, no stubs, loader ships to the client |
| `export const channels = [...]` in a `.jsx` / `.js` page, or any page outside `appDirectory` | `.tsx` inside `app/` | **zero transforms**: the channel guards never run, so the channel is inert — no route, no connection, no error |
| a root layout that doesn't render a literal `<head>` | `isRoot` component renders `<html><head>…</head><body>{children}</body></html>` | `__PAGE_DATA__` is injected by replacing `</head>` → **every loader hydrates `null`** and refetches |

Never pass a module id to `useLoader()` / `Loader()` yourself — the plugin injects it.

## The server→client leak report

`velojs build` (and `build --static`, `velojs dev`) prints a report of every **server module** the browser can reach — a module that touches a Node builtin in its own code (static import, re-export or `await import()`), or that matches a `serverOnly` pattern.
The analysis reads the code **after** the client transforms (the table above describes what those remove), so a `loader`/`action_*`/`stream_*`/`socket_*`/`middlewares` importing server code where the framework strips it is silent by construction.

What the warning means: the module named in the item reaches what ships to the browser; the chain lists every import from the client entry to it (file and line per link); `entry point (cut here)` marks the import where the chain pulls the first server module — that is where the cut happens.
The report never blocks, rewrites, stubs or moves anything: the build finishes with success, the dev keeps serving, and cutting any edge is always your call.
Two chains to the same module are two items — every cut point shows up.

Code that touches **no** Node builtin is invisible to the analysis — the framework does not guess your app's domain. Declare it:

```typescript
veloPlugin({
    serverOnly: ["src/fsm/**", "server/**"],
});
```

Patterns are globs (`*`, `**`, `?`) matched against the module's file path relative to the project root, always with `/` as separator.
The declaration feeds the diagnostic only — nothing is blocked or altered because of it.
A server module with no builtin and no declaration generates no item: that limitation is craved, and the declaration is how you lift it.

## Sharing a layout's data with its children

`Loader()` is the importable handle for a module's loader data; `useLoader()` is the
component-local form. Both read the same entry, so a child can read — and optimistically
mutate — its layout's data:

```ts
// app/admin/CompaniesLayout.tsx
export const { data: companiesData, refetch } = Loader<LoaderData>();

// app/admin/companies/CompanyInfo.tsx — rendered inside it
import { companiesData } from "../CompaniesLayout.js";
companiesData.value!.companies[i] = saved;
touch(companiesData);        // you already know the result — no round-trip
refetch();                   // or make the server recompute
```

Never mirror loader data into a module-level `export let`: on the server a module binding
is per-process, so a value stored there belongs to whichever request wrote it last.
`Loader()`'s server value is an AsyncLocalStorage getter — per-request by construction.

An entry refreshes on navigation when the params **its own route declares** change
(`/x/:id`). A query string is not declared in `routes.tsx`, so nothing infers it — use
`useLoader([query.tab])` when data depends on one.

## Keeping a page value faithful: `loader` + `channels`

The loader has two faces. The common one fetches once per request (SSR) and
re-fetches on SPA navigation — that is all a page needs when its data changes
because of the user themselves or not at all. When a value must **track server
state over time** (a team's total updated by another person's request, a
background scheduler mutating data), declare channels next to the loader:

```tsx
// app/expenses/Expenses.tsx
export const loader = async ({ c }: LoaderArgs) => {
    const user = c.get("user");
    return { teamTotal: await expensesService.teamTotal(user.teamId) };
};
export const channels = ["teamExpenses"];

export const Component = () => {
    const { data, freshness } = useLoader();
    return <h2 class={freshness.value}>Team: ${data.value?.teamTotal}</h2>;
};
```

And declare the partition of each channel once, in `app/channels.ts`:

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

Any server-side code signals that the partition changed:

```ts
import { emit } from "@mauroandre/velojs/server";
await emit("teamExpenses", { user: { teamId: 7 } });
```

An `emit` is addressed to the partition's group — clients outside the group never hear about it (not a broadcast the client filters); partitions exist by duty (authorization) or by interest (relevance).

Or, when the producer already holds the new value, it pushes it as a typed slice:

```ts
import * as Expenses from "../app/expenses/Expenses.js";
await emit(Expenses, "teamExpenses", { user: { teamId: 7 } }, { teamTotal: 880 });
```

The framework derives `GET /_channel/{moduleId}/{channel}` (same family as
`/_action` and `/_event`), inheriting the route node's `middlewares`; after
hydration the client opens one connection per (module, channel) of the rendered
hierarchy and closes it on unmount. Every new connection receives the **current
state** (the loader re-executed with that connection's own principal and route
params), and every `emit` re-executes the loader per connection in the emitting
partition, pushing a snapshot that replaces the module's data. The component
re-renders on its own — the page has no code for any of it.

### Routes with `:params` — declare, do not choose

A channel declared in a module whose route declares `:params` (`/projeto/:id`, a
page or a layout) partitions per **resource**, and the loader re-executes with
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

- The client **declares** the address it is already seeing: it extracts the params the module's `fullPath` declares, matching as a **prefix** of the pathname (a layout `/projeto/:id` covers `/projeto/7/sala` and extracts `id=7`; the child's suffix takes no part), and sends them in `?_route=<json>`. A catch-all (`/docs/*`) declares no `:` key — the connection travels by principal.
- The server **decides**: it validates the keys against the module's declared path (a key the path does not declare rejects the subscription with **400**) and the `scope` validates the policy — possession/permission — deriving the key. `params` are never an authorization input: they are not free input, they are the declared route, validated by shape and then by policy.
- The internal `_route` key never reaches the loader's `query` — it is transport, not page data.
- The connection is **keyed by the extracted params**, not by the pathname: `/projeto/7` → `/projeto/9` closes the connection and opens a new one (snapshot on connect); `/projeto/7` → `/projeto/7/sala` does not reconnect. Do not expect a refetch on a pathname change that does not move the params.

### Group lifecycle — arming a source with a cost of life

A watcher (filesystem, process, an external subscription) must not run forever
for an empty group. `onGroupOpen` fires when the **first** connection enters a
group (channel + partition) and `onGroupClose` when the **last** one leaves —
by any cause (disconnect, idle, revalidation):

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

- A second connection of the same group fires nothing. One that arrives while the close hook is still running joins the surviving group without arming it: the runtime re-arms the group when the disarm finishes — a live group is never left without its source.
- Both hooks may be async and are **awaited**: on open, before the connect snapshot; on close, before the group is discarded. A hook that throws (or rejects) is logged loudly, naming channel and partition, and the group continues — the cold-source snapshot still arrives; only the live data waits for the fix.
- The hook is infrastructure, not policy: it does not receive `user`.
- The `params` of `onGroupOpen` belong to the connection that opened the group. They are identical across the group **only when the partition derives from them** (a watcher per resource). A channel partitioned by **principal** declared in a module with `:params` mixes resources in one group: do not consume the hook's params there — they are arbitrary for the rest of the group.

### Two ways to emit — invalidation or the value itself

| Mode | Call | What the runtime does |
|---|---|---|
| Invalidation | `emit(channel, ctx)` | Re-executes the loader **per connection** of the partition and pushes a snapshot. The producer does not know the shape of the data |
| Slice | `emit(module, channel, ctx, slice)` | Pushes the payload as-is to the connections of that (module, channel) pair in the partition — **no loader runs** |

Use invalidation when only the server knows the new value (a background job, a
request from another user). Use the slice when the producer already has it — a
webhook that arrived with the payload, a job that just computed the total.

The slice is typed `Partial<Awaited<ReturnType<typeof Module.loader>>>`: an
unknown key or a wrong value type is a `tsc` error, never `any`. The module is
part of the address because one channel can be declared by modules with
different `Data` (a layout and a page): a slice is the shape of exactly **one**
of them, and it reaches only that module's connections. The invalidation mode by
name keeps reaching every module of the channel.

### The merge contract — snapshot replaces, slice merges

- A snapshot (connect or invalidation) is the whole value: it **replaces** the module's data, gone keys included.
- A slice applies a **shallow** merge by key: the key sent is replaced by the **whole** value sent (a list travels whole inside its key); keys not sent stay intact.
- **Removal is explicit**: removing an item is re-sending the key with the new whole list (without the item). An absent key never means "remove".
- The merge happens **on arrival**, never at render: slices that land in the same frame are applied together before the next render — none is lost — and for the same key the last one in arrival order wins. A malformed payload keeps the previous value.
- No deep patch and no list diff: the semantics stop at one level, by design. The runtime merges blindly (it is JavaScript) — shape safety comes from the emit typing. A key that does not exist in the `Data` only gets in through a cast: a usage error, documented, not a silent failure.

### Bursts, log and revalidation

- **Coalescing.** Invalidation emits fold per (channel, partition): the first opens a window, the emits inside it join it (the deadline does not move), and closing the window fires **one** re-execution round per connection — no invalidation is lost. Default `50ms` in any registration without options; `registerChannels(map, { coalesceMs: 0 })` disables it (immediate). A slice never waits for a window: it is pushed directly.
  **The window changes what `await emit(…)` means.** With the window off (`0`, and the test toolkit's default) the await resolves after the round was delivered; with a window open it resolves as soon as the gesture is registered — the log line is already out, the delivery comes later. Never assert a screen update right after `await emit(…)` under the default window: assert the arrival (`next()`/`nextEvent()`) or wait for the effect.
- **Emit log.** Every `emit`, in either mode, writes one `console.log` line at the moment of the gesture: `channel`, `partition`, `kind` (`invalidate`/`slice`), `connections` (the size of the group at that instant — before coalescing and before revalidation) and a timestamp. The consolidated delivery writes no second line; an emit whose `scope` resolves to nothing logs `partition=null connections=0`. `registerChannels(map, { logEmits: false })` silences it; `createTestApp` registers with window `0` and takes the same options in `channelOptions` — the map itself stays in `channels`, the options are a sibling key.
- **Partition revalidation.** Before delivering anything, the runtime re-derives each connection's partition by running the `scope` again with the ctx captured at subscribe — the principal and the validated route params of that connection. A connection whose partition moved — or whose scope now returns `null` — is removed from the group and closed: the client sees the connection closed (`freshness` goes `"stale"`) and receives none of that emit's data. A `scope` that **throws** on re-derivation is treated the same way (fail-closed: a resolver that failed cannot vouch for the partition) and the failure is logged naming the channel — a scope that does I/O must handle its own failures. Only the partition is revalidated; session/cookie expiry stays with the normal request pipeline.
- **Heartbeat and idle timeout — the transport clocks.** Every channel answer carries `Cache-Control: no-store` (a proxy or the browser must never serve a cached snapshot) and a heartbeat: an SSE comment (`: ping`) written through the write chain every `heartbeatMs` — default `20000`, the same ruler the `stream_*` SSE surface uses; `0` disables it. A comment generates no client event and does not count as a delivery. A connection with **no deliveries** (snapshot or slice) for `idleMs` — default `300000` (5 min); `0` disables — is closed by the server, and the heartbeat does **not** reset the idle clock: idle is about data, heartbeat is transport.
  **Practical consequences.** A live but quiet page cycles by design: the server closes it, the `EventSource` reconnects by itself and the snapshot on connect repairs the state — do not build anything against that cycle, and do not interpret a periodic reconnect of a quiet page as a bug. In tests, `createTestApp` defaults both clocks to `0` (deterministic); a test exercising them passes `idleMs`/`heartbeatMs` in `channelOptions` and drives them with fake timers — **never assert freshness without advancing the fake timers through the window**.
- **Behind a reverse proxy (the house recipe, Caddy).** SSE needs the proxy to flush immediately and never buffer the response, or the page goes silent with everything alive. In the Caddyfile: `flush_interval -1` on the app's `reverse_proxy` (negative value = flush as data arrives; a positive interval would batch chunks and delay every snapshot). For nginx in front: `X-Accel-Buffering: no`. The heartbeat keeps the proxy from killing the idle stream; the idle timeout closes what nobody reads anymore.
- **Inspector — asking the server what is alive.** `inspectChannels()` (from `@mauroandre/velojs/server`) returns the live state: per channel, the groups identified by the pair (moduleId, partition key) — which page holds every connection — each with its connection count and the timestamp of its last delivery; the coalescing windows still open; the grand totals. Always available; expose it with whatever guard the app judges. In development only, `GET /_channel-inspect` answers the same JSON in the browser — it never ships in a production build (the map of channels and partitions is internal information); a production app that wants something similar exposes `inspectChannels()` itself.

**The partition contract is fixed.** On subscribe the scope receives
`{ user, params }`: `user` is `c.get("user")` — the house key, the same one used
by stream/socket resolvers; if your middlewares materialize the principal under
another key, set it in `"user"` too — and `params` are the route params the
connection declared, already validated. With no authenticated principal `user`
is `undefined`: a public channel ignores it (`() => "all"`), an authenticated one
returns `null`, which denies the subscription with 403; an app that does not
materialize a principal at all (a network guard, e.g. loopback) writes
`({ params }) => …`. On emit the scope receives the object the producer built,
with the fields it consumes (`{ params: … }` or `{ user: … }`). A scope that
**throws** on subscribe denies with **403** and logs loudly, naming the channel.
The partition **never** comes from the query string or from any other client
input.

Same channel declared by a layout and by a page → one connection per module,
each feeding its own module's data; a single `emit` by channel name reaches both.

`useLoader()` and `Loader()` also expose `freshness` — a signal with `"live"`,
`"stale"` (connection closed, reconnecting **or silent**) and `"error"` (the
last re-execution failed), aggregated per page — and `freshnessByChannel`, the
same states keyed by the channel names the module declares: a page with two
channels, one fallen and one following, shows both states at once. They are
data for CSS to react to; the framework renders no JSX for them. Without
`channels`, the record is empty and `freshness` stays `"live"`.

The **silence detector** is the client half of the idle timeout: a connection
open but without deliveries for `CHANNEL_SILENCE_MS` (60s, a runtime constant,
not a configuration) is marked `"stale"` even with `EventSource` in `OPEN` —
the tab in the background, the sleeping notebook, the proxy that stopped
flushing without closing. Any delivery (or a reconnect's snapshot) brings the
channel back to `"live"`; the heartbeat comment cannot mask the silence because
it generates no client event. The aggregate folds it by the same rule: a
silenced channel counts as not-open.

Guards are explicit, never silent: `channels` in a module without a `loader`
("nothing to synchronize") and a channel with no entry in `app/channels.ts` both
fail the dev server and the build; `emit()` on an unknown channel throws
immediately naming it (`emit` on a valid channel with no subscribers is a no-op);
and `emit(module, channel, …)` on a module that does not declare that channel, or
that has no `loader`, throws immediately naming both (a slice that is not an
object throws too).
A subscription whose route params carry a key the module's path does not declare
is rejected with **400**, naming the key — the client may only declare what the
route declares. A `scope` that **throws** on subscribe denies with **403** and
logs loudly, naming the channel (it used to answer 500).
In `velojs build --static` the channels are **inert** — no server, so the client
opens no connection and freshness stays `"live"` — and the build warns, naming
the module.

### State or flow? Two questions, always the same two

| Question | Answer | Tool |
|---|---|---|
| Is this a **value** or a **sequence**? | value — "what is it now?", replacement | `loader` + `channels` (live loader) |
| | sequence — "what happened?", accumulation (chat, log, metric series, progress) | `stream_*` / `socket_*` |
| Does the change come from **someone else** or from **me**? | from someone else / from a background job | `loader` + `channels` |
| | from me (my own action) | `refetch()` after the action — no channel |

Do not turn on a channel where a post-action `refetch()` suffices, and do not
use `stream_*` for a value that is simply replaced.

## A stream/socket `channel` is untrusted client input

`useEventStream(s, { channel })` and `useSocket(s, { channel })` put the channel on the
query string. Anyone can send any value. A resolver that echoes it back subscribes the
caller to **someone else's data**:

```ts
channel: (c) => c.req.query("channel") ?? ""   // IDOR unless the route is already role-gated
```

Resolve it through an ownership check instead. Returning `null` denies with 403:

```ts
export const ownAppChannel = async (c: Context): Promise<string | null> => {
    const appId = c.req.query("channel");
    if (!appId) return null;
    const user = c.get("user");                       // set by the route's middleware
    if (!user?.id) return null;
    const { getApp } = await import("./app.service.js");   // keep the service off the client graph
    const app = await getApp({ id: appId });
    if (!app) return null;
    if (user.role !== "master" && app.ownerId !== user.id) return null;
    return appId;
};
```

Echoing the raw query value is only acceptable when the route's middleware already
restricts every subscriber (e.g. a master-only page). Deriving the channel from the
session instead — `channel: (c) => c.get("user").id` — needs no check, since the client
cannot influence it.

## The map

| File | Role |
|---|---|
| `app/routes.tsx` | The route tree. `export default [...] satisfies AppRoutes`, `import * as` for every page/layout |
| `app/channels.ts` | The live-loader channel map: channel name → `{ scope, onGroupOpen, onGroupClose }` — the partition resolver and the group lifecycle. Convention file, imported by the framework |
| `app/<domain>/Page.tsx` | One module per route: `Component`, plus optional `loader`, `action_*`, `stream_*`, `socket_*`, `metadata`. Group by domain (`app/auth/`, `app/admin/`), not in a flat `pages/` folder |
| `app/layouts/*.tsx` | Shared layouts. Long-lived `stream_*` declarations usually live on the layout that spans their pages |
| `app/modules/<domain>/` | Server-side logic imported by pages: `*.service.ts`, `*.middleware.ts`, `*.stream.ts`. Not routed |
| `app/components/*.tsx` | Shared UI with no route of its own |
| `app/client-root.tsx` | The `isRoot` HTML shell — must render `<head>` with `<Scripts />` |
| `app/server.tsx` | Server-only init (`addRoutes`, `onServer`, connections) |
| `app/client.tsx` | Client-only init (global CSS) |
| `vite.config.ts` | `veloPlugin()` |

Import subpaths (the package root exports only types, `defineConfig`, `Scripts`, `Link`,
`createEventStream`, `poll`): `@mauroandre/velojs/hooks`, `/server`, `/client`,
`/events`, `/sockets`, `/testing`, `/vite`, `/config`, `/cookie`.

Conventions that carry meaning: a route node is `{ path, module, children, middlewares,
isRoot, statusCode }`; `{ path: "*" }` is the catch-all (served via Hono's `notFound`,
defaults to 404); a node with `{ method, handler }` and no `module` is an HTTP endpoint.

## Load the skill first

Before writing anything non-trivial, load the skill for the subject. Do not infer the
API from this file — it is deliberately incomplete.

| Subject | Skill |
|---|---|
| New project, first page, project layout | `getting-started` |
| Route tree, nesting, layouts, params, catch-all, status codes | `routes` |
| Page modules, `Component`, `metadata` | `components` |
| Server data for a page, SSR + SPA fetch | `loaders` |
| Calling server code from the client, forms, mutations | `actions` |
| REST/JSON endpoints, webhooks, non-page HTTP | `endpoints` |
| Auth, guards, per-route server logic | `middlewares` |
| `useLoader`, `useParams`, `useQuery`, `usePathname`, `useNavigate` | `hooks` |
| Navigation, `<Link>` | `link-component` |
| `<Scripts />`, assets, favicon | `scripts-component` |
| SSE, live/progress/streaming data | `event-streams` |
| A page value that must track server state (`loader` + `channels`) | `live-loader` |
| WebSockets, bidirectional realtime | `sockets` |
| `addRoutes`, `onServer`, ports, server lifecycle | `server-api` |
| The build, transforms, `veloPlugin` options | `vite-plugin` |
| SSG, prerendering, `staticPaths` | `static-generation` |
| Deploy, env vars, Docker, production | `production-deploy` |
| Writing tests, `createTestApp` | `testing` |
| Exact type signatures | `type-reference` |
