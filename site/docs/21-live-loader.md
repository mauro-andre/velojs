---
description: "Keep a loader value faithful to server state in real time: declare `channels` next to the loader, map each channel to a partition resolver in `app/channels.ts`, and signal changes server-side with `emit()`. Use when a page value must track server state over time instead of being fetched once."
---

# Live loader

A `loader` fetches a page's data once per request and re-fetches it on SPA navigation. That is everything a page needs when its data changes because of the user themselves — or not at all. A **value that must track server state over time** (a family total another person's request changes, data a background scheduler mutates) needs the loader to stay faithful. That is the live loader: the same `loader`, the same `useLoader()` read, plus a sibling `channels` export.

## The three declarations

```tsx
// app/gastos/Gastos.tsx — the page module
export const loader = async ({ c }: LoaderArgs) => {
    const user = c.get("user");
    return {
        somaFamilia: await gastosService.somaFamilia(user.familiaId),
        gastos: await gastosService.daFamilia(user.familiaId),
    };
};
export const channels = ["gastosFamilia"];

export const Component = () => {
    const { data, freshness } = useLoader();
    return <h2 class={freshness.value}>Família: R$ {data.value?.somaFamilia}</h2>;
};
```

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

```ts
// anywhere server-side: an action, server.tsx, a scheduler, a webhook
import { emit } from "@mauroandre/velojs/server";

await emit("gastosFamilia", { familiaId: 7 });
```

`export const channels = [...]` is the whole opt-in. A module without it behaves exactly as before — no connection, no cost.

## What happens

- The framework derives one internal SSE route per declared channel — `GET /_channel/{moduleId}/{channel}`, the same family as `/_action` and `/_event` — inheriting the `middlewares` of the module's route node, so `requireAuth`/`requireMaster` guard the subscription exactly as they guard the page.
- After hydration the client opens one connection per (module, channel) of the rendered hierarchy — layouts and pages alike — and closes it on unmount (SPA navigation, page close). A channel declared by both a layout and a page produces one connection per module, each feeding its own module's data; a single `emit` by channel name reaches both.
- Every new connection immediately receives the **current state**, computed by re-executing the loader with that connection's own principal. The pane never shows the SSR value while the server has already moved on, and a reconnect is a new connection with a new snapshot — no extra refetch.
- `emit(channel, ctx)` resolves the partition with the same `scope`, finds the connections of that partition and pushes a fresh snapshot to each — the loader re-executed with each connection's own principal. Connections of other partitions receive nothing. A channel with no subscribers is a no-op; a channel with no entry in `app/channels.ts` throws immediately, naming it.
- The snapshot **replaces** the module's loader data, so the component reading `data.value` re-renders on its own. No subscription code, no merge, no manual refresh.

## Freshness

`useLoader()` and `Loader()` expose `freshness` — a signal with three values:

| Value | Meaning |
|---|---|
| `"live"` | connected |
| `"stale"` | the connection closed or is reconnecting |
| `"error"` | the last loader re-execution failed (the server reported it) |

It is aggregated per page and is **data for CSS to react to** — the framework renders no JSX of its own:

```tsx
const { data, freshness } = useLoader();
return <h2 class={freshness.value}>Família: R$ {data.value?.somaFamilia}</h2>;
```

On a page with no `channels` the field exists and stays `"live"` for its whole life.

## The partition contract

On subscribe the `scope` receives `c.get("user")` — the house key, the same one the stream/socket channel resolvers use. A middleware that materializes the principal somewhere else should set it in `"user"` too:

```ts
const auth = async (c, next) => {
    const user = await currentUser(c);
    c.set("user", user);          // the live loader reads this key
    c.set("currentUser", user);   // the app's own key, if it has one
    await next();
};
```

- No authenticated principal → the scope receives `undefined`. A public channel ignores it (`() => "all"`); an authenticated one returns `null`, which denies the subscription with **403**.
- The partition **never** derives from the query string or from any client input. A client cannot choose which subject's data it receives.
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
- `emit()` on a channel with no entry in the map: throws immediately, naming it (a typo or a rename would otherwise be a no-op). `emit()` on a valid channel with no subscribers is a no-op, no error.
- `velojs build --static` with a module declaring `channels`: the channels are **inert** — no server for SSE, so the client opens no connection, `freshness` stays `"live"` and the build warns, naming the module.
- A module outside the conventions (`.jsx`/`.js`, or outside `app/`) is the one genuinely silent line: no transform, so the channel is simply inert.

## Testing

`createTestApp({ channels })` wires the same map the app uses, and `app.channel(module, name)` opens a real connection — either with cookies or through `app.as(user)`, so the route's middlewares run for real. Snapshots arrive through `next()`; no sleep, no retry, no timing assertion.

```ts
import { createTestApp } from "@mauroandre/velojs/testing";
import { emit } from "@mauroandre/velojs/server";
import { channels } from "../app/channels.js";
import * as Gastos from "../app/gastos/Gastos.js";

const app = await createTestApp({
    routes,
    channels,
    getSessionCookie: async ({ user }) => ({ session: await sign(user) }),
});

const sub = await app.as({ user: { familiaId: 7 } }).channel(Gastos, "gastosFamilia");
expect(await sub.next({ timeoutMs: 1000 })).toEqual({ somaFamilia: 4 });  // connect

await emit("gastosFamilia", { familiaId: 7 });
expect(await sub.next({ timeoutMs: 1000 })).toEqual({ somaFamilia: 9 });  // emit

await sub.close();
await app.close();
```

The connection only exists after the connect snapshot, so awaiting the first `next()` before emitting is what makes the test deterministic.

## Reference

| Piece | Behavior |
|---|---|
| `export const channels = ["name"]` | Module opt-in: one internal route and one client connection per name |
| `app/channels.ts` | Channel name → `{ scope }`; imported by the framework |
| `scope(ctx)` | Returns the partition key; `null` denies with 403; omitted → `"all"` |
| `emit(channel, ctx)` | Re-executes the loader per connection of the partition and pushes snapshots |
| `freshness` | `"live"` / `"stale"` / `"error"`, aggregated per page |
| `app.channel(module, name)` | Test subscription; snapshots through `next()` |
