---
description: "Keep a loader value faithful to server state in real time: declare `channels` next to the loader, map each channel to a partition resolver in `app/channels.ts`, and signal changes server-side with `emit()` — by name (the runtime re-executes the loader) or with a typed `Partial` slice when the producer already holds the value. Use when a page value must track server state over time instead of being fetched once."
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

## Two ways to emit

The emit has two modes, and the difference is *who knows the new value*.

**Invalidation** — `emit(channel, ctx)`. The producer knows that something changed, not what. The runtime re-executes the loader of every connection in the partition and pushes a fresh snapshot. This is the mode that keeps the producer decoupled from the shape of the data, and the one to reach for from a scheduler, a webhook handler that only got an id, or another user's request.

**Slice** — `emit(module, channel, ctx, slice)`. The producer already holds the new value (the webhook arrived with the payload, the job just computed the total). The slice travels to the connections of that (module, channel) pair in the partition exactly as it is, and **no loader runs**.

```ts
import * as Gastos from "../app/gastos/Gastos.js";

// Invalidation: Gastos.loader runs once per connection of the partition.
await emit("gastosFamilia", { familiaId: 7 });

// Slice: nothing runs; the connections merge this payload into their data.
await emit(Gastos, "gastosFamilia", { familiaId: 7 }, { somaFamilia: 880 });
```

The slice is typed as `Partial` of what the module's loader returns:

```ts
export const loader = async ({ c }: LoaderArgs) => {
    const user = c.get("user");
    return {
        somaFamilia: await gastosService.somaFamilia(user.familiaId),
        gastos: await gastosService.daFamilia(user.familiaId),
    };
};

// OK — known key, right type
await emit(Gastos, "gastosFamilia", { familiaId: 7 }, { somaFamilia: 880 });
// tsc error — the key does not exist in the loader's return
await emit(Gastos, "gastosFamilia", { familiaId: 7 }, { total: 880 });
// tsc error — wrong value type
await emit(Gastos, "gastosFamilia", { familiaId: 7 }, { somaFamilia: "880" });
```

Why does the module take part in the address? Because the same channel can be declared by a layout **and** by a page, and each has its own loader and its own data shape — a slice is the shape of one of them. The runtime delivers the slice only to the connections of the pair `(module, channel)`; `emit(channel, ctx)` by name keeps reaching every module that declares the channel.

## The merge

The client merges every slice into the module's current value, with rules short enough to memorize:

| Rule | Meaning |
|---|---|
| A snapshot **replaces**, a slice **merges** | The connect snapshot and the invalidation snapshot are the whole value; a slice is applied on top of the current one |
| The key sent is replaced **whole** | Sending `somaFamilia` replaces the entire `somaFamilia`; lists travel whole inside their key |
| Keys not sent stay **intact** | A slice with only `somaFamilia` leaves `gastos` exactly as it was |
| An absent key **never removes** | Removal is explicit: re-send the key with the new whole list, without the item |
| The merge happens **on arrival** | Slices that arrive in the same frame are applied together before the next render; for the same key, the last one in arrival order wins |
| A malformed payload **keeps the previous value** | A slice that fails to parse never blanks the screen |

```ts
// Current data: { somaFamilia: 4, gastos: ["mercado", "luz"] }
await emit("gastosFamilia", { familiaId: 7 });                          // whole value
await emit(Gastos, "gastosFamilia", { familiaId: 7 }, { somaFamilia: 9 });
// → { somaFamilia: 9, gastos: ["mercado", "luz"] }

// Removing "luz" is re-sending the whole list without it
await emit(Gastos, "gastosFamilia", { familiaId: 7 }, { gastos: ["mercado"] });
// → { somaFamilia: 9, gastos: ["mercado"] }
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
[velojs] emit kind=invalidate channel="gastosFamilia" partition="familia:7" connections=2 at=2026-09-30T12:00:00.000Z
[velojs] emit kind=slice channel="gastosFamilia" partition="familia:7" connections=2 at=2026-09-30T12:00:01.104Z
```

`connections` is the size of the group **at the instant of the gesture** — before coalescing and before revalidation — and the consolidated delivery writes no second line. An emit whose `scope` resolves to nothing logs `partition=null connections=0`: reaching nobody is exactly what the log is for. The log is off with `registerChannels(channels, { logEmits: false })`.

**Partition revalidation.** Before delivering anything (a re-executed snapshot or a slice), the runtime re-derives each connection's partition by running the `scope` again with the principal captured at subscribe. A connection whose partition moved — or whose scope now returns `null` — is removed from the group and closed: the client sees the connection closed and `freshness` goes `"stale"`, no data of a group it left. A `scope` that **throws** on re-derivation is treated the same way — fail-closed, with the failure logged naming the channel — so a scope that talks to an external service must handle its own failures. Only the partition is revalidated; an expired session is covered by the normal request pipeline on the next access.

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
- `emit(module, channel, …)` on a module that does **not declare** that channel, or that has **no loader**: throws immediately, naming both. A slice that is not an object throws too.
- `velojs build --static` with a module declaring `channels`: the channels are **inert** — no server for SSE, so the client opens no connection, `freshness` stays `"live"` and the build warns, naming the module.
- A module outside the conventions (`.jsx`/`.js`, or outside `app/`) is the one genuinely silent line: no transform, so the channel is simply inert.

## Testing

`createTestApp({ channels })` wires the same map the app uses, and `app.channel(module, name)` opens a real connection — either with cookies or through `app.as(user)`, so the route's middlewares run for real. Snapshots and slices arrive through `next()`; no sleep, no retry, no timing assertion.

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

await emit(Gastos, "gastosFamilia", { familiaId: 7 }, { somaFamilia: 880 });
expect(await sub.next({ timeoutMs: 1000 })).toEqual({ somaFamilia: 880 }); // raw slice

expect(await sub.nextEvent({ timeoutMs: 1000 })).toEqual({              // discriminated
    type: "slice",
    data: { somaFamilia: 880 },
});

await sub.close();
await app.close();
```

The connection only exists after the connect snapshot, so awaiting the first `next()` before emitting is what makes the test deterministic. `next()` returns the payload exactly as it travelled on the wire (a whole snapshot or a raw slice) — the same contract as the first slice; `nextEvent()` returns the same arrivals discriminated as `{ type: "snapshot" | "slice", data }`, for the tests that care which mode delivered the update. Use one or the other: each walks its own cursor over the arrivals.

The toolkit registers the channels with the coalescing window off (`coalesceMs: 0`), so `await emit(…)` is the delivery. A test that exercises the window passes it explicitly and drives it with fake timers. Note where the options go: `channels` is the map, and the registration options are a **sibling** key, `channelOptions`:

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
| `app/channels.ts` | Channel name → `{ scope }`; imported by the framework |
| `scope(ctx)` | Returns the partition key; `null` denies with 403; omitted → `"all"`. Re-derived on every emit with the principal captured at subscribe |
| `emit(channel, ctx)` | Invalidation: re-executes the loader per connection of the partition and pushes snapshots |
| `emit(module, channel, ctx, slice)` | Slice: pushes the typed `Partial` to the connections of that (module, channel) pair — no re-execution |
| Merge | Shallow by key, on arrival; key sent replaced whole, absent key never removes, whole lists |
| `registerChannels(map, opts)` | `coalesceMs` (default 50, `0` off) and `logEmits` (default on); in the toolkit the map stays in `channels` and these go in `channelOptions` |
| `freshness` | `"live"` / `"stale"` / `"error"`, aggregated per page |
| `app.channel(module, name)` | Test subscription; `next()` (raw data) and `nextEvent()` (`{ type, data }`) |
