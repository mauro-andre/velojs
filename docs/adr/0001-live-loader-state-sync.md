# ADR 0001: Live loader state synchronization

## Status

Accepted

## Date

2026-09-30

## Context

VeloJS route modules already export `loader` to provide server-side data to a page. That data is fetched once per request (SSR) and re-fetched as JSON on client-side navigation (`?_data=1`), but it has no way to stay faithful to server state over time. An application that needs a page value to track a server-side value in real time must build its own replication on top of the existing realtime primitives.

The design of state synchronization in the loader ("live loader": page data that stays faithful to server state in real time) matured over a long design cycle between the pair and the architect. It was validated by consulting three real production applications built with VeloJS. Each of the three had already hand-rewritten, over `stream_*`, the exact state-replication pattern this feature formalizes:

- a snapshot emitter with an in-memory cache and staleness handling;
- a global broadcast that sends a snapshot on connect;
- a background scheduler mutating data that the UI never saw.

The three independent feedbacks converged on the same contracts: a snapshot on connect, merge on arrival, explicit removal, a first-class partition resolver, inherited middlewares, and observability of freshness. Because each app reinvented the same machinery, the framework should own the convention instead of leaving it to every application.

All decisions below — language, transport, addressing, partition, security, merge semantics, and slicing — existed only in the pair's conversation. They were not in the repository or in any artifact readable by a builder or a reviewer. Implementation will arrive in slices across several cycles; without a common recorded anchor, each future spec would relitigate settled decisions and pinned decisions could diverge between slices.

The project has no ADR practice yet. This document establishes the format, and future implementation specs will cite it as a design reference.

## Decision

State synchronization is a first-class part of the loader contract, opt-in per module, delivered over automatic SSE routes addressed per channel, partitioned server-side by an authenticated resolver, with a mandatory snapshot on connect, shallow key-wise merge on arrival, inherited route middlewares, and observable freshness. The framework does not push JSX; it exposes data that CSS reacts to.

### D1 — Language: `loader` plus a sibling `channels` export

**Context.** Route modules already export `loader` for server data, and the module conventions (`Component`, optional `loader`, `action_*`, `stream_*`, `socket_*`, `metadata`) are stable. A live loader is still a loader — the same `useLoader` read, the same SSR/hydration path — that additionally declares which channels should keep it fresh.

**Decision.** State synchronization enters the existing `loader` export. The opt-in is the sibling export `channels`, an array of channel names on the route module. There is no new `loaderStream` export.

**Alternatives considered and rejected.** A dedicated export with mutual exclusivity between `loader` and `loaderStream`. Rejected: the opt-in already lives in `channels`, and swapping the export would be an unnecessary migration of the language surface.

**Consequences.** One mental model: a module either declares `channels` or it does not; the presence of `channels` is the whole opt-in. Existing modules are untouched. The convention is discoverable next to `loader` and can reuse the existing module-convention guarantees. A module that declares `channels` without a `loader` is an explicit dev/build error, not a silent no-op.

### D2 — Channel is a route

**Context.** The framework already derives routes from module conventions: actions at `/_action/{moduleId}/{name}`, event streams at `/_event/{moduleId}/{name}`, sockets at `/_socket/{moduleId}/{name}`. Addressing is uniform and observable, and the client already speaks one protocol per primitive.

**Decision.** Every declared channel generates an automatic SSE route in the same family as `stream_*` and `/_action` (the literal path was amended to `/_channel/{moduleId}/{channel}` — see Amendments). After hydration, the client opens one `EventSource` per channel of the page.

**Alternatives considered and rejected.** A single multiplexed connection with an internal tag protocol. Rejected: a new abstraction with no counterpart in the framework, incoherent with the existing addressing patterns.

**Consequences.** Addressing and middleware behavior are inherited for free from the existing route conventions, and the channel route is inspectable like any other. The accepted cost is N connections per page, mitigated by HTTP/2.

### D3 — Partition by authenticated resolver

**Context.** A channel's data is per-subject: one page can watch many independent subjects (a user, an organization, a resource). The framework already resolves stream channels server-side (a `stream_*` resolver) with the request context available, but a partition of loader data is a security boundary, not just a routing key.

**Decision.** Which partition of a channel a connection belongs to is resolved on the server by a resolver that receives the request context. The default derives from the authenticated session/principal; it supports scoping by resource or by role. The partition never derives from the query string or from any client input, and it is revalidated on every emit.

**Alternatives considered and rejected.** A client-declared partition. Rejected: untrusted input and an IDOR vector — a client must not choose which subject's data it receives.

**Consequences.** Partition isolation is a server invariant, auditable in one place, and the client cannot widen its own scope. Every emit re-checks the partition so a stale connection cannot keep receiving a subject it no longer owns. The resolver is testable directly (fake principal, two connections).

### D4 — Emit addressed in two modes

**Context.** A producer (a mutation, a background job, a request handler) must be able to signal that a partition's data changed. The state lives in the loader; the producer usually does not know its shape, and duplicating the shape outside the loader would drift.

**Decision.** `emit(channel, partition-context)` with no payload makes the runtime re-execute the partition's loader on the server and push the snapshot through the channel. `emit(module, channel, partition-context, slice)` pushes only the named keys, addressed to the (module, channel) pair (the address was amended from D4's literal — see Amendments).

**Alternatives considered and rejected.** Invalidation with a client-side refetch. Rejected: the data must travel through the channel, not be pulled again by the client. Always emitting with a payload. Rejected: it would duplicate the computation of the data's shape outside the loader.

**Consequences.** The common case (a value changed, push the current snapshot) needs no knowledge of the loader's return shape; the producer stays decoupled from the data. The targeted case sends a `Partial` of the loader's return, valid only for named keys. Slicing semantics are defined in D6 and land in Slice 2.

### D5 — Mandatory snapshot on connect

**Context.** Between SSR paint and the client's first channel connection there is a window in which the page shows the SSR value while the server may have already moved on. The three consulted apps each patched this window by hand, and the naive fix (only react to future emits) leaves the page showing stale data until the next change.

**Decision.** Every new channel connection receives the current state of the partition at the moment of connection, eliminating the SSR-to-channel window and the empty flash.

**Alternatives considered and rejected.** Covering the gap with a replay by `Last-Event-ID` or a refetch on reconnect. Rejected: that does not cover the interval between paint and the first connection (there was no disconnect at all) and reintroduces an empty screen; a snapshot on connect solves it by construction.

**Consequences.** No flash of empty state and no hand-written catch-up logic in applications. The snapshot is computed at connect time, which is a loader execution per connection — acceptable because a connection is a page-level event, not a hot path, and mitigable later by coalescing (Slice 2).

### D6 — Merge semantics

**Context.** A channel carries snapshots and slices of the loader's return. The client must combine them with the value it already has, deterministically, without knowing the data's shape. The consulted apps hit two concrete failure modes: patch semantics with no answer for "absent vs removed", and merges deferred to render that lost slices arriving between renders.

**Decision.** The merge is shallow by key and applied on arrival (an accumulator, never at render). A slice replaces the whole value of its key; an absent key never removes a value (removal is explicit, by re-sending the key with its new value); lists are always whole inside their key. The slice is typed as `Partial` of the loader's return.

**Alternatives considered and rejected.** Deep patch or list diffing (no answer for absent-vs-removed or for individual list items). Deferring the merge to render (loses slices between renders — a failure observed in production in the consulted apps).

**Consequences.** Merge results are deterministic and order-independent for distinct keys, and cannot silently drop a slice. Lists are replaced whole, so item-level merging is out of scope by design. The `Partial` typing keeps the slice honest against the loader's return type.

### D7 — Rule for choosing state versus flow

**Context.** The framework has four ways to move data to the client: `loader`, `stream_*`, `socket_*`, and actions with a subsequent refetch. Without a clear rule, every project decides ad hoc, and channels get switched on where a refetch would suffice. A single question ("does it need realtime?") does not separate a value from a sequence and invites exactly that mistake.

**Decision.** State data ("what is it now?", replacement) uses the loader with `channels`; flow data ("what happened?", accumulation: chat, log, a metric series, one-off progress) uses `stream_*`/`socket_*` as today; a change caused by the user themselves uses `refetch()` after the action, with no channel. The design guiding questions are two, and only two: **"is this a value or a sequence?"** and **"does the change come from someone else or from me?"**

**Alternatives considered and rejected.** A single "does it need realtime?" question. Rejected: it does not separate value from sequence and invites turning on a channel where a post-action refetch would suffice.

**Consequences.** A single rule governs every realtime decision and can be documented identically in README, site docs, and AGENTS.md. `stream_*` is repositioned in the documentation as the flow tool, without breaking its API. `socket_*` remains for bidirectional flow.

### D8 — Inherited middlewares

**Context.** Route nodes already carry `middlewares` (Hono) inherited by their subtree, and the generated `stream_*`/`socket_*` routes inherit them. A channel route is a data endpoint of the page that declares it, so it must share the page's access policy.

**Decision.** The SSE route generated for a channel inherits the middlewares of the module's route node, with no escape route from auth.

**Alternatives considered and rejected.** Giving the channel route its own authorization, independent of the node. Rejected: it would duplicate the per-route auth policy and create a bypass surface — the concrete case raised in consultation was a channel on a `requireMaster` route that, without inheritance, becomes an unguarded route.

**Consequences.** Auth policy is declared once per route node and applies to pages, actions, streams, sockets, and channels alike. A reviewer can audit channel exposure by reading the route tree.

### D9 — Observable freshness

**Context.** A live page must be able to show whether its data is live, stale, or errored, but the framework has no business dictating the presentation. The house rule is that visual state is CSS reacting to data.

**Decision.** On a live page, the `{ data }` of `useLoader` exposes the freshness state (live/stale/error) as data for CSS to react to. The framework does not push conditional JSX.

**Alternatives considered and rejected.** The framework rendering its own visual indicator (a banner or status overlay). Rejected: it violates the house rule that visual state is CSS reacting to data, and each app needs to shape freshness feedback to its own visual language.

**Consequences.** Applications style freshness however they want, keyed off a stable piece of data. The framework stays presentation-agnostic. The live/stale/error states land in Slice 1, aggregated per page; Slice 3 refines them (see Amendments).

### D10 — First load unchanged, full compatibility

**Context.** The feature must not alter the behavior of existing applications, and the cost of a connection and emissions must not fall on pages that do not need them.

**Decision.** Without `channels`, behavior is bit-for-bit that of the current loader. The channel only exists after hydration. `stream_*`, `socket_*`, and actions do not change (the `stream_*` is repositioned in documentation as the flow tool).

**Alternatives considered and rejected.** Life by default (every loader opens a channel automatically). Rejected: connection and emission cost for pages that do not need them, a broken compatibility expectation, and operational surface with no counterpart — the opt-in through `channels` is deliberate.

**Consequences.** Adoption is incremental and zero-risk for existing apps. Nothing opens a connection unless a module declares `channels`. The opt-in is explicit and readable in the module.

## Implementation slice plan

The slices are ordered and non-overlapping.

### Slice 1 — End-to-end core

The `loader` + `channels` convention with guards (channels without a loader in the module is an explicit dev/build error; `.tsx` module conventions inside `app/` hold as today); automatic routes (`/_channel/{moduleId}/{channel}`, see Amendments) with inherited middlewares; per-channel connection with a snapshot on connect; partition by resolver with the session default; emit in invalidation mode (no payload); basic freshness (live/stale/error, aggregated per page, in `useLoader`/`Loader`); deterministic tests in `createTestApp` (emit-and-observe without sleeps, partition testable with a fake principal and two connections, inherited middleware testable); synchronization of AGENTS.md, README, and site/docs with the state-vs-flow rule and the D7 guiding questions ("is this a value or a sequence?" and "does the change come from someone else or from me?").

### Slice 2 — Named slices and rich emission

Emit with a typed `Partial`, addressed to the (module, channel) pair (see Amendment 3); shallow merge on arrival with an accumulator; explicit removal and whole lists; server-side coalescing per partition; emit logging (channel, partition, timestamp); partition revalidation on every emit.

### Slice 3 — Operations and observability

Channel idle timeout; `Cache-Control: no-store`, heartbeat, and operational notes for proxies; an inspector of live channels per page; freshness refinements — stagnation by inactivity timeout (an open connection that has said nothing for N — proxy/sleeping tab) and per-channel granularity (per connection, not aggregated). The three states themselves are Slice 1's (see Amendments).

## Amendments

### Amendment 1 — Channel path: `/_channel/{moduleId}/{channel}` (supersedes the D2 literal)

D2 recorded the channel route as `/_event/{moduleId}/{channel}`, the same path family as `stream_*`. That literal collides with a `stream_*` declared by the same module: a module with both `stream_logs` and a `channels: ["logs"]` declaration would register two different handlers at one path, and whichever won would silently swallow the other.

The path was therefore amended to `/_channel/{moduleId}/{channel}`. This is a detail of path **inside** the family D2 chose — addressing stays uniform with `/_action`/`/_event`/`/_socket`, inheritance of middlewares and inspectability are unchanged, and D2's rejected alternative (a single multiplexed connection with an internal tag protocol) stays rejected. The deviation is conscious and local: a channel and a stream of the same module never share a path.

### Amendment 2 — Freshness reallocated between slices (supersedes D9's "Slice 3" consequence)

The three freshness states (`live`/`stale`/`error`) are delivered by **Slice 1**, aggregated per page and exposed on the `useLoader()`/`Loader()` handle — without them a live page has no way to say it lost the wire, and the slice would ship a stream nobody can observe.

Slice 3 keeps the refinements: stagnation by inactivity timeout (an open connection that has said nothing for N) and per-channel granularity (freshness per connection rather than aggregated per page). This document is the anchor of the following slices and must not contradict what Slice 1 delivers.

### Amendment 3 — Slice mode is addressed to the (module, channel) pair (supersedes D4's `emit(channel, partition-context, slice)` literal)

D4 recorded the second mode as `emit(channel, partition-context, slice)` — addressed by channel name, exactly as the invalidation mode is. That literal does not survive the data: one channel can be declared by more than one module (a layout and a page of the same subtree both hold a live value from it), and each module has its **own** `loader` and therefore its own `Data`. A slice typed as a `Partial` of "the loader's return" has no referent when the channel names two loaders, and a slice pushed by name would reach connections whose `Data` has a different shape.

The slice mode is therefore addressed to the **(module, channel) pair**: `emit(module, channel, partition-context, slice)`. The module is the imported route module — its `metadata.moduleId` is what identifies the connections — the slice is typed `Partial<Awaited<ReturnType<typeof Module.loader>>>`, and the runtime delivers it **only** to the connections of that pair in the resolved partition. The invalidation mode stays exactly as D4 wrote it: `emit(channel, partition-context)`, by name, reaching every module that declares the channel, each connection re-executed with its own principal.

This is a deviation of the **address**, not of the decision: the payload's nature (a `Partial` of the loader's return), the shallow merge on arrival (D6) and the delivery without re-execution are D4's. D4's rejected alternative — always emitting with a payload — stays rejected, and the invalidation mode remains the one that needs no knowledge of the loader's shape.

## Non-goals (future)

These themes are recorded only as future work and are not part of the slices above:

- `afterWrite` (entity mutation automatically emits the dependent slices);
- pub/sub between server instances;
- offline/background sync;
- PWA (its own spec);
- advanced devtools.