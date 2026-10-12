---
description: "Live actions: the tab-facing twin of the live loader. Declare `liveActions = { abrirFicha: [\"fichaProjeto\"] }` next to the action and subscribe with `useLiveAction(action, args)` — the connect snapshot is the loading gesture and every `emit()` of the declared channels re-executes the action with the subscription's own args, replacing the value whole. A live action is a parameterized read (no side effects); the partition derives from `args` in `app/channels.ts`. Use when a tab's content must track server state over time instead of being fetched once at open."
---

# Live actions

The newer apps built on VeloJS are tab UIs (the VSCode shape): the page is the hull — sidebar, tab bar — and every content opens in a tab. A tab is **not a route**: it is client state, persisted in `localStorage` and restored on refresh, and its content loads at open time from an action with its own arguments (the resource id, the file path). The page's loader does not know the tabs — it loads only what belongs to the page itself.

When a tab's content is a **value that tracks server state over time** — the expense sheet that grows line by line, the project card whose phase changes without anyone clicking — the one-shot action delivers a portrait that ages minutes after opening, and whoever reads it cannot know they are looking at the past. That is what a live action is for: the action declares interest in **living**, and the tab's value follows the server, addressed by the call's own arguments — one signaling mechanism (`emit()`), zero polling.

It is the tab-facing twin of the live loader: the same channels, the same `emit()`, the same partition policy in `app/channels.ts` — addressed to an **action call with args** instead of a **route with params**.

## The three declarations

```tsx
// app/expenses/Expenses.tsx — the page module (the tab hull)
import type { ActionArgs } from "@mauroandre/velojs";

// A live action is a parameterized read: it returns the tab's content for the
// args it receives. Mutations inside the tab stay common one-shot actions.
export const action_abrirExpense = async ({ body }: ActionArgs<{ id: number }>) => {
    const { expenseSheet } = await import("./expenses.service.js");
    return expenseSheet(body.id);   // { total: 880, linhas: [...] }
};

// The opt-in: the key is the action name WITHOUT the `action_` prefix, the
// value is the list of channels — an emit in any one delivers.
export const liveActions = { abrirExpense: ["expenseSheet"] };

export const Component = () => <ExpensesShell />;   // sidebar + tab bar
```

```tsx
// the tab component — one per open tab
import { useLiveAction } from "@mauroandre/velojs/hooks";
import { action_abrirExpense } from "../expenses/Expenses.js";

function ExpenseTab({ id }: { id: number }) {
    const { data, loading, freshness } = useLiveAction(action_abrirExpense, { id });
    if (loading.value) return <div class="tab-loading" />;
    return (
        <article class={`tab ${freshness.value}`}>
            <h3>{data.value?.total}</h3>
            <ul>{data.value?.linhas.map((linha) => <li>{linha}</li>)}</ul>
        </article>
    );
}
```

```ts
// app/channels.ts — the same map the live loader uses
export const channels = {
    expenseSheet: {
        scope: ({ user, args }) => {
            if (args?.id == null) return null;
            if (user && !podeVerTime(user, args.id)) return null;   // 403
            return `expense:${args.id}`;
        },
    },
};
```

```ts
// anywhere server-side: the same emit() — no second mechanism was born
import { emit } from "@mauroandre/velojs/server";

await emit("expenseSheet", { args: { id: 7 } });
```

`export const liveActions = { ... }` is the whole opt-in. A module without it behaves exactly as before — no route, no connection, no cost. A module may declare `loader` + `channels` (the live page) **and** `liveActions` (the live tabs): the two surfaces coexist without interference.

## What happens

- The framework derives one internal SSE route per declared action — `GET /_live/{moduleId}/{actionName}`, the same family as `/_action`, `/_event` and `/_channel` — inheriting the `middlewares` of the module's route node: the subscription is guarded exactly like the action call and the page are.
- `useLiveAction(action, args)` opens **one connection per subscription** with the args serialized in `?_args=`. The connect snapshot — the action executed once with the declared args — **is the loading gesture**: there is no initial POST, the tab never shows a value the server does not stand behind.
- Every `emit()` in any of the action's declared channels re-executes the action **with the subscription's own args** and pushes the fresh value, which **replaces** `data` whole — the updated payload has the same shape as the original answer, no merge on the client.
- The subscription's life is the mount: the tab component unmounts (tab closed, page left) and the connection closes — nothing arrives afterwards, and the server holds nothing for whoever left (being the last of the group, `onGroupClose` disarms the source). It remounts (tab reopened, refresh restored the tabs) and the subscription is born again with a snapshot of the current state: reopening is indistinguishable from never having closed.
- The args are the identity: changing them reconnects — a new subscription with a new snapshot, the twin of the loader connection keyed by its route params.

## The contract of a live action

A live action is, by contract, a **parameterized read**. The server re-executes it with the subscription's args at every signal of its channels, and the result replaces the previous value whole — a mutation with a side effect in a live action is a **usage error**: the re-execution would repeat the effect (one more row, one more email). The row is explicit in the agent rules' silent-failure table.

The mutation the user makes inside the tab keeps being a **common one-shot action**; the tab updates through the channel. The re-execution receives the same `ActionArgs` as the common call — `body` carries the args declared in the subscription, `c` is the connection's context (the same ruler as the loader re-executed by a channel connection).

## The partition: `args` in the scope

The ctx of a channel's `scope` gains `args` — additively. On a live action subscription the scope receives `{ user, args }`; on a loader connection it receives `{ user, params }` as before. On `emit` the producer builds the same shape of always: `emit("expenseSheet", { args: { id: 7 } })` — the public gesture is the existing `emit()`, nothing new.

A channel declared by **both** ends has one scope that consumes what each end declares and resolves **one partition**. The canonical form is carved here so no reader invents their own — a channel `expenseSheet` declared by the `loader` of the page `/expenses/:id` and by the tab action `abrirExpense`:

```ts
// app/channels.ts
export const channels = {
    expenseSheet: {
        scope: ({ params, args }) => "expense:" + (args?.id ?? params?.id),
    },
};
```

The loader connection (partitioned by the route it is seeing) and the tab subscription (partitioned by its own args) fall in the same partition `expense:{id}` — and **one** `emit("expenseSheet", { args: { id: 7 } })` re-executes the loader on the page and the action on the tab, each with its own data.

The rest of the partition contract is the live loader's, unchanged: `null`, `undefined` or a `throw` from the scope denies the subscription with 403, loudly; the partition **never** derives from anything the client did not declare. `onGroupOpen`/`onGroupClose` receive the args of the connection that opened the group (`{ partition, params, args }`) — with the same arbitrariness caveat the live loader makes for `params` when the partition does not derive from them.

## `useLiveAction(action, args)`

The hook (exported from `@mauroandre/velojs/hooks`, the house of hooks) receives **the action itself** — its client stub, which the Vite plugin marks with the subscription address (`__path`, the socket-stub ruler) — and the args. The types are preserved from the action's own signature: args and return check in the app's typecheck at the same level as the common call.

| Field | Behavior |
|---|---|
| `data` | Signal with the action's return, replaced whole by every snapshot |
| `loading` | True until the first snapshot or error of the current subscription |
| `freshness` | The subscription's own `"live"` / `"stale"` / `"error"` signal |

`freshness` carries the same three states and the same silence detector as the live loader's: a connection open with no deliveries for 60s (`CHANNEL_SILENCE_MS`, a runtime constant) is `"stale"` even though `EventSource` still reads `OPEN`; any delivery brings it back. It is **per subscription** and never touches the page aggregate: a stale tab does not stale the page (`useLoader().freshness`), and the other way around.

On the server (SSR) the hook does not connect — the tab is client state the server does not know — and returns `data` null with `loading` true. In a static build the load really failed (there is no server to run the action): no connection is opened and the handle is `data` undefined with `freshness` `"error"` — the deliberate contrast with a channel, which stays `"live"` in static because there is nothing to synchronize.

An error — the action throwing on the snapshot or on a re-execution — arrives as the error event of the connection: `freshness` goes `"error"`, `loading` ends, and the **last valid value stays** (a failure never blanks the tab). A malformed payload keeps the previous value — the house ruler.

## Transport — the channel ruler, inherited

The live connection enters the same groups by (channel, partition) as the loader connections, with every transport rule of the live loader: the heartbeat is an SSE comment (no client event, no delivery), the idle timeout closes a subscription with no deliveries, invalidations coalesce per (channel, partition), the partition is revalidated before every delivery (the scope re-derived with the ctx captured at subscribe — a partition that moves or denies closes the subscription), and the answer carries `Cache-Control: no-store`. **No periodic request exists anywhere**: the update is born of `emit()`, never of a clock.

One detail belongs to this surface: the subscription of an action that declares **two** channels enters the groups of both (one SSE stream, N group entries) — an emit in either one delivers, and any cause of death (idle, revalidation in any channel) ends the whole subscription: a tab cannot be half alive. In the inspector it counts once.

## Guards

The failures that would otherwise be silent are explicit:

- `liveActions` naming an action the module does **not** export: error in the dev server and in the build, naming module and action — never an inert route.
- A channel with no entry in `app/channels.ts`: error in the dev server and in the build, naming module, action and channel.
- Serialized args above **4096 bytes**: the subscription is rejected with **400**, naming the action and the limit — the args are the tab's address (an id), not a payload; a bigger read wants a common action call.
- A malformed `?_args=` payload: rejected with **400**, legibly.
- A `scope` that returns nothing (or throws): the subscription is denied with **403**, loudly — and the route node's `middlewares` run for real, so a guard middleware denies an unauthenticated subscription exactly as it denies the page.
- `velojs build --static` with a module declaring `liveActions`: the build warns naming module and action — in static the client opens no `/_live` connection and the hook reports the real failure.
- A module outside the conventions (`.jsx`/`.js`, or outside `app/`) is the one genuinely silent line: no transform, so the declaration is simply inert (the row exists in the agent rules' table).

## Telemetry and inspection

The subscription and every delivery are traced as a boundary of their own — `live-action-connect`, carrying `module` and `name` (never a channel) — with one delivery line per snapshot and a closing line with the total: distinguishable from a loader's `channel-connect` in the JSONL and in `velojs telemetry`, which ranks the live actions (times, bytes, deliveries) in their own `By live action` section. The emit log stays one line per gesture, as always.

`inspectChannels()` (and the dev-only `GET /_channel-inspect`) lists the live subscriptions next to the loader groups — each with module, action, declared args and the (channel, partition) groups it holds — and the grand total counts each subscription once.

```ts
import { inspectChannels } from "@mauroandre/velojs/server";

inspectChannels().liveActions;
// [{
//   moduleId: "expenses/Expenses",
//   action: "abrirExpense",
//   channels: [{ channel: "expenseSheet", partition: "expense:7" }],
//   args: { id: 7 },
//   lastDeliveryAt: "2026-10-12T12:00:01.104Z",
// }]
```

## Testing

`app.liveAction(Module, "name", { args })` opens a real subscription — the family of `app.channel(...)`: the middlewares of the route node run for real, cookies come from the options or from `app.as(user)`, and the size guard and the scope run for real too. The toolkit registers the channels with the transport clocks at `0` (deterministic), so `await emit(…)` is the delivery — no sleep, no retry.

```ts
const app = await createTestApp({
    routes,
    channels,                                    // the map (app/channels.ts)
    getSessionCookie,
});

const sub = await app
    .as({ id: 1, teamId: 7 })
    .liveAction(Expenses, "abrirExpense", { args: { id: 7 } });
expect(await sub.next({ timeoutMs: 1000 })).toEqual({ total: 880, linhas: ["mercado"] });  // connect

await emit("expenseSheet", { args: { id: 7 } });
expect(await sub.next({ timeoutMs: 1000 })).toEqual({ total: 940, linhas: ["mercado", "luz"] });

await sub.close();   // the tab closed: the group empties, onGroupClose fires
```

`next()` delivers the payloads in arrival order (the connect snapshot first); `nextEvent()` discriminates the arrival — `{ type: "snapshot" | "error", data }` (an error is an arrival for `nextEvent()`, never a payload for `next()`); `close()` ends the subscription, and `status` reads the guards (403 denied, 400 oversized args). The group hooks are observable at the subscription's entrances and exits, and the denial of the scope and the args limit are observable as status.

## State or flow — the same two questions

| Question | Answer | Tool |
|---|---|---|
| Is this a **value** or a **sequence**? | value — "what is it now?", replacement | `liveActions` + `useLiveAction` (a tab), `loader` + `channels` (the page) |
| | sequence — "what happened?", accumulation (chat, log, progress) | `stream_*` / `socket_*` |
| Is the address a **route** or a **call with args**? | the route the user is seeing | `loader` + `channels` |
| | the tab's own arguments (client state) | `liveActions` + `useLiveAction` |

Do not turn on a live action where the value is fetched once and never moves, and do not use it for flow — tokens being born in a chat keep being `stream_*`; a terminal keeps being `socket_*`.

## Reference

| Piece | Behavior |
|---|---|
| `export const liveActions = { abrir: ["canal"] }` | Module opt-in: key = action name without `action_`, value = channel names (an emit in any one delivers) |
| `GET /_live/{moduleId}/{actionName}?_args=` | The subscription route — inherits the route node's `middlewares` |
| `useLiveAction(action, args)` | `{ data, loading, freshness }`; the life is the mount, the args are the identity (a change reconnects) |
| The connect snapshot | The action executed once with the declared args — the whole loading gesture |
| The re-execution | `emit()` in a declared channel re-runs the action with the subscription's own args; the value replaces whole |
| `scope({ user, args })` | The live half of the partition ctx; `null`/`undefined`/throw denies with 403 |
| Shared channel | `scope: ({ params, args }) => "expense:" + (args?.id ?? params?.id)` — the canonical form for a channel declared by a loader and a live action |
| `onGroupOpen`/`onGroupClose` | Receive `{ partition, params, args }` — the address of the connection that opened the group |
| Args limit | Serialized args above 4096 bytes reject the subscription with 400, naming the action |
| `freshness` | `"live"` / `"stale"` (closed, reconnecting or silent past 60s) / `"error"`, per subscription — never the page aggregate |
| Static build | No connection; `data` undefined with `freshness` `"error"` — the load really failed (the channel stays `"live"` — deliberate contrast) |
| Telemetry | `live-action-connect` + one `delivery` line per snapshot + the closing line; `velojs telemetry` ranks them in `By live action` |
| `inspectChannels().liveActions` | The live subscriptions: module, action, args, groups, last delivery |
| `app.liveAction(Module, "name", { args })` | Test subscription — `next()`, `nextEvent()`, `close()`, `status` |
