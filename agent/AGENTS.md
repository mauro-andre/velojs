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

The framework derives `GET /_channel/{moduleId}/{channel}` (same family as
`/_action` and `/_event`), inheriting the route node's `middlewares`; after
hydration the client opens one connection per (module, channel) of the rendered
hierarchy and closes it on unmount. Every new connection receives the **current
state** (the loader re-executed with that connection's own principal), and every
`emit` re-executes the loader per connection in the emitting partition, pushing
a snapshot that replaces the module's data. The component re-renders on its own —
the page has no code for any of it.

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
immediately naming it (`emit` on a valid channel with no subscribers is a no-op).
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
