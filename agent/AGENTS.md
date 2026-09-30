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
state over time** (a family's total updated by another person's request, a
background scheduler mutating data), declare channels next to the loader:

```tsx
// app/gastos/Gastos.tsx
export const loader = async ({ c }: LoaderArgs) => {
    const user = c.get("user");
    return { somaFamilia: await gastosService.somaFamilia(user.familiaId) };
};
export const channels = ["gastosFamilia"];

export const Component = () => {
    const { data, freshness } = useLoader();
    return <h2 class={freshness.value}>Família: R$ {data.value?.somaFamilia}</h2>;
};
```

And declare the partition of each channel once, in `app/channels.ts`:

```ts
// app/channels.ts — the app's channel map: name → partition resolver
export const channels = {
    gastosFamilia: {
        // ctx: on subscribe, the principal materialized in c.get("user");
        // on emit, the object the emitter passed. Returns the partition key.
        scope: (ctx) => `familia:${ctx.familiaId}`,
    },
};
```

Any server-side code signals that the partition changed:

```ts
import { emit } from "@mauroandre/velojs/server";
await emit("gastosFamilia", { familiaId: 7 });
```

Or, when the producer already holds the new value, it pushes it as a typed slice:

```ts
import * as Gastos from "../app/gastos/Gastos.js";
await emit(Gastos, "gastosFamilia", { familiaId: 7 }, { somaFamilia: 880 });
```

The framework derives `GET /_channel/{moduleId}/{channel}` (same family as
`/_action` and `/_event`), inheriting the route node's `middlewares`; after
hydration the client opens one connection per (module, channel) of the rendered
hierarchy and closes it on unmount. Every new connection receives the **current
state** (the loader re-executed with that connection's own principal), and every
`emit` re-executes the loader per connection in the emitting partition, pushing
a snapshot that replaces the module's data. The component re-renders on its own —
the page has no code for any of it.

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
- **Partition revalidation.** Before delivering anything, the runtime re-derives each connection's partition by running the `scope` again with the principal captured at subscribe. A connection whose partition moved — or whose scope now returns `null` — is removed from the group and closed: the client sees the connection closed (`freshness` goes `"stale"`) and receives none of that emit's data. A `scope` that **throws** on re-derivation is treated the same way (fail-closed: a resolver that failed cannot vouch for the partition) and the failure is logged naming the channel — a scope that does I/O must handle its own failures. Only the partition is revalidated; session/cookie expiry stays with the normal request pipeline.

**The partition contract is fixed.** On subscribe the scope receives
`c.get("user")` — the house key, the same one used by stream/socket resolvers. If
your middlewares materialize the principal under another key, set it in `"user"`
too. With no authenticated principal the scope receives `undefined`: a public
channel ignores it (`() => "all"`), an authenticated one returns `null`, which
denies the subscription with 403. The partition **never** comes from the query
string or from any client input.

Same channel declared by a layout and by a page → one connection per module,
each feeding its own module's data; a single `emit` by channel name reaches both.

`useLoader()` and `Loader()` also expose `freshness` — a signal with `"live"`,
`"stale"` (connection closed/reconnecting) and `"error"` (the last re-execution
failed), aggregated per page. It is data for CSS to react to; the framework
renders no JSX for it. Without `channels` it exists and stays `"live"`.

Guards are explicit, never silent: `channels` in a module without a `loader`
("nothing to synchronize") and a channel with no entry in `app/channels.ts` both
fail the dev server and the build; `emit()` on an unknown channel throws
immediately naming it (`emit` on a valid channel with no subscribers is a no-op);
and `emit(module, channel, …)` on a module that does not declare that channel, or
that has no `loader`, throws immediately naming both (a slice that is not an
object throws too).
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
| `app/channels.ts` | The live-loader channel map: channel name → partition resolver (`scope`). Convention file, imported by the framework |
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
