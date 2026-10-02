---
description: "Keep a loader value faithful to server state in real time: declare `channels` next to the loader, map each channel to a partition resolver in `app/channels.ts`, and signal changes server-side with `emit()` — by name (the runtime re-executes the loader) or with a typed `Partial` slice when the producer already holds the value. Covers routes with `:params` (the client declares the address it is seeing, the server validates it) and the group lifecycle (`onGroupOpen`/`onGroupClose`) for sources with a cost of life. Use when a page value must track server state over time instead of being fetched once."
---

# Live loader

A `loader` fetches a page's data once per request and re-fetches it on SPA navigation. That is everything a page needs when its data changes because of the user themselves — or not at all. A **value that must track server state over time** (a team total another person's request changes, data a background scheduler mutates) needs the loader to stay faithful. That is the live loader: the same `loader`, the same `useLoader()` read, plus a sibling `channels` export.

## The three declarations

```tsx
// app/expenses/Expenses.tsx — the page module
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
        // in c.get("user") and the route params the connection declared.
        // On emit it is the object the producer built, with the fields this
        // scope consumes. Returns the partition key.
        scope: ({ user }) => `team:${user.teamId}`,
    },
};
```

```ts
// anywhere server-side: an action, server.tsx, a scheduler, a webhook
import { emit } from "@mauroandre/velojs/server";

await emit("teamExpenses", { user: { teamId: 7 } });
```

`export const channels = [...]` is the whole opt-in. A module without it behaves exactly as before — no connection, no cost.

## What happens

- The framework derives one internal SSE route per declared channel — `GET /_channel/{moduleId}/{channel}`, the same family as `/_action` and `/_event` — inheriting the `middlewares` of the module's route node, so `requireAuth`/`requireMaster` guard the subscription exactly as they guard the page.
- After hydration the client opens one connection per (module, channel) of the rendered hierarchy — layouts and pages alike — and closes it on unmount (SPA navigation, page close). A channel declared by both a layout and a page produces one connection per module, each feeding its own module's data; a single `emit` by channel name reaches both.
- Every new connection immediately receives the **current state**, computed by re-executing the loader with that connection's own principal and route params. The pane never shows the SSR value while the server has already moved on, and a reconnect is a new connection with a new snapshot — no extra refetch.
- `emit(channel, ctx)` resolves the partition with the same `scope` — the producer builds the same `{ user, params }` shape with the fields its scope consumes — finds the connections of that partition and pushes a fresh snapshot to each, the loader re-executed with each connection's own principal and route params. Connections of other partitions receive nothing. A channel with no subscribers is a no-op; a channel with no entry in `app/channels.ts` throws immediately, naming it.
- The snapshot **replaces** the module's loader data, so the component reading `data.value` re-renders on its own. No subscription code, no merge, no manual refresh.

## Routes with `:params`

A channel declared in a module whose route declares `:params` — a page `/projeto/:id`, a layout — partitions per **resource**. The address travels with the connection, but it is not the client choosing its scope: the client **declares** the route it is already seeing (the same information `?_data=1` sends on every SPA navigation), and the server **decides** — validates the shape against the module's path and the policy in the `scope`.

```tsx
// app/projeto/Projeto.tsx — the route /projeto/:id
export const loader = async ({ params }: LoaderArgs) => ({
    arquivos: await projetoService.arquivos(params.id),   // params.id arrives, always
});
export const channels = ["projetoArquivos"];
```

```ts
// app/channels.ts
export const channels = {
    projetoArquivos: {
        // On subscribe the scope receives { user, params }: the resource is
        // validated against the principal (ownership) and the key derived
        // from it.
        scope: ({ user, params }) => {
            if (!params?.id) return null;
            if (user && !podeVer(user, params.id)) return null;   // 403
            return `projeto:${params.id}`;
        },
        // The emit side is trusted server code: it builds the same shape with
        // the fields the scope consumes — for a resource channel, the params
        // are the whole address (see `emit("projetoArquivos", { params: … })`
        // in the group lifecycle example below).
    },
};
```

- **Extraction (client).** The connection of a module extracts the params its route declares, matching the module's `fullPath` as a **prefix** of the pathname: a layout declared at `/projeto/:id` covers `/projeto/7/sala` and extracts `id=7` — the child's suffix takes no part. A path with a catch-all (`/docs/*`) declares no `:` key: the connection travels by principal only. The params go serialized in one query param, `?_route=<json>`.
- **Validation (server).** The runtime checks the received keys against the `:params` of the module's declared path. A key the path does not declare rejects the subscription with **400**, naming what is wrong — a declaration is not free input. Values are always URL strings.
- **Policy (scope).** The partition resolves with the validated params: it is the **relevance** of the group (only the connections of that resource wake up on an emit) with the **authorization** validated on entry and re-derived on every emit, now with the connection's stored params.
- **The loader re-executes** with `{ params, query, c }` of the connection — `params.id` filled exactly as on the rendered page. The internal `_route` key is transport, never data: the query the loader sees excludes it.
- **The connection is keyed by the extracted params**, not by the pathname. `/projeto/7` → `/projeto/9` closes the old connection and opens a new one (with a snapshot on connect); `/projeto/7` → `/projeto/7/sala` does **not** reconnect — the child's suffix is not part of the connection's identity.

## Group lifecycle: `onGroupOpen` / `onGroupClose`

A source with a **cost of life** — a filesystem watcher, a process, a subscription to an external service — must not run forever for an empty group. The channel definition declares when it should live:

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

- The **first** connection of a group (channel + partition) fires `onGroupOpen({ partition, params })` and the **last** one fires `onGroupClose({ partition })` — by any cause: disconnect, idle timeout, partition revalidation. A second connection of the same group fires nothing; one that arrives while the close hook is still running joins the surviving group without opening it — the runtime re-arms the group when the disarm finishes, so a live group is never left without its source.
- Both hooks may be async and are **awaited**: on open, before the connect snapshot (the source is armed before the first data arrives); on close, before the group is discarded (the watcher is disarmed before the group stops existing).
- A hook that throws (or rejects) is logged loudly, naming channel and partition, and the group continues: the connect snapshot still delivers data from the cold source, the live data simply does not arrive until it is fixed — and the log is what says so.
- The `params` of `onGroupOpen` are the declared params of the connection that opened the group. They are identical across the group only when the partition derives from them (a watcher per resource). A channel partitioned by **principal**, declared in a module with `:params`, mixes resources in the same group: the hook's params are the first connection's and are arbitrary for the rest — such a channel must not consume them.
- The hook is infrastructure, not policy: it does not receive `user`.

## Two ways to emit

The emit has two modes, and the difference is *who knows the new value*.

**Invalidation** — `emit(channel, ctx)`. The producer knows that something changed, not what. The runtime re-executes the loader of every connection in the partition and pushes a fresh snapshot. This is the mode that keeps the producer decoupled from the shape of the data, and the one to reach for from a scheduler, a webhook handler that only got an id, or another user's request.

**Slice** — `emit(module, channel, ctx, slice)`. The producer already holds the new value (the webhook arrived with the payload, the job just computed the total). The slice travels to the connections of that (module, channel) pair in the partition exactly as it is, and **no loader runs**.

```ts
import * as Expenses from "../app/expenses/Expenses.js";

// Invalidation: Expenses.loader runs once per connection of the partition.
await emit("teamExpenses", { user: { teamId: 7 } });

// Slice: nothing runs; the connections merge this payload into their data.
await emit(Expenses, "teamExpenses", { user: { teamId: 7 } }, { teamTotal: 880 });
```

The slice is typed as `Partial` of what the module's loader returns:

```ts
export const loader = async ({ c }: LoaderArgs) => {
    const user = c.get("user");
    return {
        teamTotal: await expensesService.teamTotal(user.teamId),
        expenses: await expensesService.byTeam(user.teamId),
    };
};

// OK — known key, right type
await emit(Expenses, "teamExpenses", { user: { teamId: 7 } }, { teamTotal: 880 });
// tsc error — the key does not exist in the loader's return
await emit(Expenses, "teamExpenses", { user: { teamId: 7 } }, { total: 880 });
// tsc error — wrong value type
await emit(Expenses, "teamExpenses", { user: { teamId: 7 } }, { teamTotal: "880" });
```

Why does the module take part in the address? Because the same channel can be declared by a layout **and** by a page, and each has its own loader and its own data shape — a slice is the shape of one of them. The runtime delivers the slice only to the connections of the pair `(module, channel)`; `emit(channel, ctx)` by name keeps reaching every module that declares the channel.

## The merge

The client merges every slice into the module's current value, with rules short enough to memorize:

| Rule | Meaning |
|---|---|
| A snapshot **replaces**, a slice **merges** | The connect snapshot and the invalidation snapshot are the whole value; a slice is applied on top of the current one |
| The key sent is replaced **whole** | Sending `teamTotal` replaces the entire `teamTotal`; lists travel whole inside their key |
| Keys not sent stay **intact** | A slice with only `teamTotal` leaves `expenses` exactly as it was |
| An absent key **never removes** | Removal is explicit: re-send the key with the new whole list, without the item |
| The merge happens **on arrival** | Slices that arrive in the same frame are applied together before the next render; for the same key, the last one in arrival order wins |
| A malformed payload **keeps the previous value** | A slice that fails to parse never blanks the screen |

```ts
// Current data: { teamTotal: 4, expenses: ["mercado", "luz"] }
await emit("teamExpenses", { user: { teamId: 7 } });               // whole value
await emit(Expenses, "teamExpenses", { user: { teamId: 7 } }, { teamTotal: 9 });
// → { teamTotal: 9, expenses: ["mercado", "luz"] }

// Removing "luz" is re-sending the whole list without it
await emit(Expenses, "teamExpenses", { user: { teamId: 7 } }, { expenses: ["mercado"] });
// → { teamTotal: 9, expenses: ["mercado"] }
```

There is no deep patch and no list diff: the semantics stop at one level, by design. The runtime merges blindly — it is JavaScript — so the shape safety comes from the emit typing; a key that does not exist in the loader's data only gets in through a cast, and that is a usage error, not a feature.

## Bursts: coalescing, log and revalidation

Three behaviours make the emit usable on a busy server.

**Coalescing.** Invalidation emits are folded per (channel, partition). The first opens a window, the emits inside it join, and closing the window fires **one** re-execution round per connection — the consolidated round is the effect of all of them, so no invalidation is lost. A job writing N rows in sequence therefore costs one round, not N.

```ts
// Default: 50ms window, in any registration without options.
// 0 turns it off (immediate, the behavior of the first slice).
registerChannels(channels, { coalesceMs: 0 });
```

A slice never waits for the window: it is a direct push, with no re-execution to amortize. Bursts of slices are absorbed by the merge accumulator on the client.

The window also decides what `await emit(…)` waits for. With the window off (`0`) the await resolves after the round was delivered; with a window open (the default `50ms`) it resolves as soon as the gesture is registered — the log line is already out and the delivery comes later. So never assert a screen update right after `await emit(…)` under the default window: await the arrival (`next()` / `nextEvent()`) or wait for the effect.

**Emit log.** Every emit, in either mode, writes one line the moment it happens — so an incident ("the screen did not update") has a starting point: who emitted, to which partition, how many connections were in it.

```
[velojs] emit kind=invalidate channel="teamExpenses" partition="team:7" connections=2 at=2026-09-30T12:00:00.000Z
[velojs] emit kind=slice channel="teamExpenses" partition="team:7" connections=2 at=2026-09-30T12:00:01.104Z
```

`connections` is the size of the group **at the instant of the gesture** — before coalescing and before revalidation — and the consolidated delivery writes no second line. An emit whose `scope` resolves to nothing logs `partition=null connections=0`: reaching nobody is exactly what the log is for. The log is off with `registerChannels(channels, { logEmits: false })`.

**Partition revalidation.** Before delivering anything (a re-executed snapshot or a slice), the runtime re-derives each connection's partition by running the `scope` again with the ctx captured at subscribe — the principal and the validated route params of that connection. A connection whose partition moved — or whose scope now returns `null` — is removed from the group and closed: the client sees the connection closed and `freshness` goes `"stale"`, no data of a group it left. A `scope` that **throws** on re-derivation is treated the same way — fail-closed, with the failure logged naming the channel — so a scope that talks to an external service must handle its own failures. Only the partition is revalidated; an expired session is covered by the normal request pipeline on the next access.

## Transport: heartbeat, idle timeout and the proxy

An SSE connection crosses infrastructure that was not built for it — proxies, load balancers, browsers with sleeping tabs. The channel answer is built for that traffic, and its transport has exactly two clocks:

- **Heartbeat** — an SSE comment (`: ping`) written through the write chain every `heartbeatMs`. It keeps proxies and browsers from buffering or closing an idle stream, and it is pure transport: it generates no event in the client and does not count as a delivery — it touches neither freshness nor idle. The default is `20000` (20s), the same `DEFAULT_HEARTBEAT_MS` the `stream_*` SSE surface uses — one transport ruler in the house. `0` disables it.
- **Idle timeout** — a connection with **no deliveries** (snapshot or slice) for `idleMs` is closed by the server, with the same closing gesture as the partition revalidation (close event waiting for the write chain, group cleanup). The heartbeat does **not** reset it: idle is about data, heartbeat is transport. A live but quiet page cycles by design — close, the `EventSource` reconnects by itself, and the snapshot on connect repairs the state — while an abandoned page's resources are freed for good. The default is `300000` (5 min) in any registration without options; `0` disables it.

```ts
// Registration with explicit windows (app/server.tsx or wherever the app wires)
registerChannels(channels, { idleMs: 60000, heartbeatMs: 15000 });
```

The SSE answer also carries `Cache-Control: no-store`: a proxy or the browser must never serve a cached channel snapshot — a stale snapshot is exactly the illusion the live loader exists to kill.

**Behind a reverse proxy (the house recipe, Caddy).** SSE needs the proxy to flush immediately and never buffer the response, or the page goes silent even with everything alive on both ends. In the Caddyfile, the app's `reverse_proxy` needs `flush_interval -1` — a negative value means "flush as soon as data arrives", which is what SSE requires; a positive interval would batch chunks and delay every snapshot. Caddy streams by default and probes dead upstreams on its own — the heartbeat then does its part every 20s, and the idle timeout closes what nobody is reading anymore. Another proxy in front (nginx, a cloud load balancer) follows the same two rules: no response buffering, and `X-Accel-Buffering: no` for nginx or the equivalent for the LB.

## Inspecting the live channels

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

Per channel, the groups are identified by the pair (moduleId, partition key) — in the incident you know which page/module holds every connection — each with its connection count and the timestamp of its last delivery; the coalescing windows still open; and the grand totals. `inspectChannels()` is always available: the app decides how (and with what guard) to expose it.

In development there is a ready-made lens: `GET /_channel-inspect` answers the same JSON in the browser. It exists **only in dev** — the map of channels and partitions is internal information, and it never ships in a production build.

## Freshness

`useLoader()` and `Loader()` expose `freshness` — a signal with three values:

| Value | Meaning |
|---|---|
| `"live"` | connected and delivering |
| `"stale"` | the connection closed, is reconnecting, or is **silent** — open past 60s with no delivery |
| `"error"` | the last loader re-execution failed (the server reported it) |

It is aggregated per page and is **data for CSS to react to** — the framework renders no JSX of its own:

```tsx
const { data, freshness } = useLoader();
return <h2 class={freshness.value}>Team: ${data.value?.teamTotal}</h2>;
```

The same handles expose `freshnessByChannel` — a signal record keyed by the channel names the module declares, with the same three values per channel. A page with two channels, one fallen and one following, shows both states at once:

```tsx
const { freshness, freshnessByChannel } = useLoader();
// freshnessByChannel.value → { teamExpenses: "stale", precos: "live" }
```

The aggregate folds the per-channel states by one rule: any channel in error errors the page; a silenced or closed channel counts as not-open — the page is stale only when nothing is open and delivering.

The **silence detector** is the client half of the idle timeout: a connection that stays without deliveries for `CHANNEL_SILENCE_MS` (60s, a runtime constant — not a configuration) is marked stale even though `EventSource` still reads `OPEN`. That is the tab in the background, the sleeping notebook, the proxy that stopped flushing without closing the connection. Any delivery — or a reconnect's snapshot — brings the channel back to `"live"`. The server's heartbeat comment generates no client event, so it cannot mask the silence. Never assert freshness in a test without advancing the fake timers through the window.

On a page with no `channels` the fields exist, the record is empty and the aggregate stays `"live"` for its whole life.

## The partition contract

On subscribe the `scope` receives `{ user, params }`. `user` is whatever a middleware materialized under the house key `"user"` — the same key the stream/socket channel resolvers use; a middleware that materializes the principal somewhere else should set it in `"user"` too:

```ts
const auth = async (c, next) => {
    const user = await currentUser(c);
    c.set("user", user);          // the live loader reads this key
    c.set("currentUser", user);   // the app's own key, if it has one
    await next();
};
```

`params` are the route params the connection declared, already validated against the module's path. On emit the same scope receives the object the producer built, with the fields it consumes (`{ params: { id: 7 } }` for a resource channel, `{ user: … }` for a principal one).

- No authenticated principal → `user` is `undefined`. A public channel ignores it (`() => "all"`); an authenticated one returns `null`, which denies the subscription with **403**. An app that does not materialize a principal at all (the border is a network guard, e.g. loopback) writes `({ params }) => …`.
- **Declare, not choose.** `params` are not an authorization input: they are the address the client is already seeing, validated by shape on the server and by policy in the `scope`. The partition **never** derives from the query string or from any other client input.
- A scope that **throws** on subscribe denies with **403** and logs loudly, naming the channel — fail-closed, never silent. A scope that resolves to `null` denies the same way.
- No scope at all → the channel is public (`() => "all"`).

## State or flow?

Two questions decide, and they are always the same two:

| Question | Answer | Tool |
|---|---|---|
| Is this a **value** or a **sequence**? | value — "what is it now?", replacement | `loader` + `channels` |
| | sequence — "what happened?", accumulation (chat, log, a metric series, one-off progress) | `stream_*` / `socket_*` |
| Does the change come from **someone else** or from **me**? | someone else, or a background job | `loader` + `channels` |
| | me, through my own action | `refetch()` after the action |

Do not turn on a channel where a post-action `refetch()` suffices.

## Guards

The failures that would otherwise be silent are explicit:

- `channels` in a module **without** a `loader`: error in the dev server and in the build — there is nothing to synchronize.
- A channel **without an entry** in `app/channels.ts`: error in the dev server and in the build, naming the channel.
- Route params with a key the module's path does **not** declare: the subscription is rejected with **400**, naming the key — the client may only declare what the route declares.
- A `scope` that **throws** on subscribe: denied with **403** and logged loudly, naming the channel.
- `emit()` on a channel with no entry in the map: throws immediately, naming it (a typo or a rename would otherwise be a no-op). `emit()` on a valid channel with no subscribers is a no-op, no error.
- `emit(module, channel, …)` on a module that does **not declare** that channel, or that has **no loader**: throws immediately, naming both. A slice that is not an object throws too.
- `velojs build --static` with a module declaring `channels`: the channels are **inert** — no server for SSE, so the client opens no connection, `freshness` stays `"live"` and the build warns, naming the module.
- A module outside the conventions (`.jsx`/`.js`, or outside `app/`) is the one genuinely silent line: no transform, so the channel is simply inert.

## Testing

`createTestApp({ channels })` wires the same map the app uses, and `app.channel(module, name)` opens a real connection — either with cookies or through `app.as(user)`, so the route's middlewares run for real. Snapshots and slices arrive through `next()`; no sleep, no retry, no timing assertion.

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
expect(await sub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 4 });  // connect

await emit("teamExpenses", { user: { teamId: 7 } });
expect(await sub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 9 });  // emit

await emit(Expenses, "teamExpenses", { user: { teamId: 7 } }, { teamTotal: 880 });
expect(await sub.next({ timeoutMs: 1000 })).toEqual({ teamTotal: 880 }); // raw slice

expect(await sub.nextEvent({ timeoutMs: 1000 })).toEqual({              // discriminated
    type: "slice",
    data: { teamTotal: 880 },
});

await sub.close();
await app.close();
```

The connection only exists after the connect snapshot, so awaiting the first `next()` before emitting is what makes the test deterministic. `next()` returns the payload exactly as it travelled on the wire (a whole snapshot or a raw slice) — the same contract as the first slice; `nextEvent()` returns the same arrivals discriminated as `{ type: "snapshot" | "slice", data }`, for the tests that care which mode delivered the update. Use one or the other: each walks its own cursor over the arrivals.

A route with `:params` declares them in the connection options; the server-side validation runs for real, so a key the module's path does not declare rejects the subscription at `status === 400`:

```ts
const project = await app.channel(Project, "projetoArquivos", { params: { id: "7" } });
expect(await project.next({ timeoutMs: 1000 })).toEqual({ id: "7", files: ["a.txt"] });

const forged = await app.channel(Project, "projetoArquivos", { params: { id: "7", outro: "9" } });
expect(forged.status).toBe(400);
```

The group hooks are testable the same way: `onGroupOpen`/`onGroupClose` fire as connections enter and leave the group (first/last), including the exits by idle and by revalidation.

The toolkit registers the channels with the coalescing window off (`coalesceMs: 0`), so `await emit(…)` is the delivery. The same determinism holds for the transport clocks: `idleMs` and `heartbeatMs` default to `0` in the toolkit — no connection dies and no comment is written unless the test asks for it. A test that exercises any of the three passes it explicitly and drives it with fake timers. Note where the options go: `channels` is the map, and the registration options are a **sibling** key, `channelOptions`:

```ts
const app = await createTestApp({
    routes,
    channels,                                    // the map (app/channels.ts)
    channelOptions: { coalesceMs: 20, logEmits: false },   // the options
    getSessionCookie,
});
await vi.advanceTimersByTimeAsync(20);   // the window closes: one round
```

## Reference

| Piece | Behavior |
|---|---|
| `export const channels = ["name"]` | Module opt-in: one internal route and one client connection per name |
| `app/channels.ts` | Channel name → `{ scope, onGroupOpen, onGroupClose }`; imported by the framework |
| `scope(ctx)` | `{ user, params }` on subscribe, the producer's object on emit; returns the partition key; `null` denies with 403; omitted → `"all"`. Re-derived on every emit with the ctx captured at subscribe |
| Route params | The client extracts the params the module's path declares (prefix match of `fullPath`) and sends them in `?_route=`; the server validates the keys (400 on an undeclared one) and the connection is keyed by them — moving to another resource reconnects |
| `onGroupOpen({ partition, params })` | Fires on the first connection of a (channel, partition) group; awaited before the connect snapshot; a throw is logged and the group continues |
| `onGroupClose({ partition })` | Fires on the last connection out of the group, by any cause (disconnect, idle, revalidation); awaited before the group is discarded |
| `emit(channel, ctx)` | Invalidation: re-executes the loader per connection of the partition and pushes snapshots |
| `emit(module, channel, ctx, slice)` | Slice: pushes the typed `Partial` to the connections of that (module, channel) pair — no re-execution |
| Merge | Shallow by key, on arrival; key sent replaced whole, absent key never removes, whole lists |
| `registerChannels(map, opts)` | `coalesceMs` (default 50, `0` off), `logEmits` (default on), `idleMs` (default 300000, `0` off) and `heartbeatMs` (default 20000, `0` off); in the toolkit the map stays in `channels` and these go in `channelOptions` — all four default `0` there |
| `freshness` | `"live"` / `"stale"` / `"error"`, aggregated per page |
| `freshnessByChannel` | Same states keyed by the module's channel names; empty record without `channels` |
| `CHANNEL_SILENCE_MS` | 60000 — client-side silence window; an open connection without deliveries past it is `"stale"` |
| `inspectChannels()` | Server-side live report: groups per (moduleId, partition) with connections and last delivery, open coalesce windows, totals |
| `GET /_channel-inspect` | Dev-only endpoint answering `inspectChannels()` as JSON; absent in production builds |
| `app.channel(module, name, opts)` | Test subscription; `opts.params` declares the route params (validated for real); `next()` (raw data) and `nextEvent()` (`{ type, data }`) |
