---
description: "Native telemetry: the framework records its own boundaries — the page SSR (with a span per hierarchy loader plus the render), the `?_data=1` refetch, the action, the endpoint, the stream connect, the socket setup, the channel connect and every `emit` — as JSONL lines carrying duration, status, response bytes, child spans and, on long connections, one delivery line per frame plus a closing line. Enable it by destination (`VELO_TELEMETRY_FILE` and/or `VELO_TELEMETRY_SINK_URL`, values expanding `~`/`$VAR`, instance-suffixed file, `VELO_TELEMETRY_MAX_MB` rotation) and rank the file with `velojs telemetry`. Use when a production page is slow, when a response is too fat, or to see which routes, loaders, actions and channels are actually being called."
---

# Telemetry

The framework knows its own bottlenecks — they are finite: a page SSR (with the loaders of the hierarchy), a `?_data=1` refetch, an action, a declarative endpoint, a stream connect, a socket setup, a channel connect. It also knows the part that runs **outside any request**: when `emit()` invalidates a channel, the loader re-executes on an already-open connection, with no new request involved. Native telemetry turns each of those executions into one JSON line — duration, status, response bytes, child spans — and each long connection into one light line per delivery plus a final line when it closes.

What this buys you: **which route is slow, how big its response is, and why**. A page trace names every loader that ran and how long each took; an emit trace names the channel, the partition and how many connections re-executed. The file is plain JSONL in an operator-chosen path — no dev overlay, no dashboard inside the app, nothing to attack in production.

## The destination is the trigger

There is no on/off flag. **The destination env is the activation**: `VELO_TELEMETRY_FILE` and/or `VELO_TELEMETRY_SINK_URL`, present and non-empty, turn collection on; none of them — absent or empty — leaves the module completely inert (no file, no event, no cost) in **any environment, dev included**. The dev server never turns telemetry on by itself: an app that wants it in development puts the env in its `.env`, like any other environment.

The framework never picks a destination for you: there is no default file path anywhere. The path is the deployment's decision, read from the env. The values expand `~` (home) and `$VAR` / `${VAR}`, so an operator can point at `$ALGO_PRIVADO/telemetry.jsonl`; an undefined reference is kept literally, and the [boot record](#the-boot-record) shows the destination that was actually in force.

| Variable | Default | Role |
|----------|---------|------|
| `VELO_TELEMETRY_FILE` | — | Destination file. Present and non-empty activates the file collection (append-only JSONL). Expands `~` and `$VAR`. No default path |
| `VELO_TELEMETRY_SINK_URL` | — | Destination sink. Present and non-empty activates the HTTP collection: one `POST` per event with the JSON line as the body |
| `VELO_TELEMETRY_MAX_MB` | `10` | Rotation limit of the file, in MB. The only pruning mechanism — there is no retention by days |

Both destinations at once feed both; one alone is enough. The values are read from the process environment first and from the project's `.env` as the fallback (an env var exported in the shell wins over the file) — the same precedence the release script uses.

```bash
# .env — production, or a dev machine that wants the traces
VELO_TELEMETRY_FILE=$DATA_DIR/telemetry.jsonl
VELO_TELEMETRY_MAX_MB=10
# ...or ship them somewhere:
# VELO_TELEMETRY_SINK_URL=https://collector.example.com/ingest
```

## What gets recorded

Each execution in one of the framework's bottlenecks produces a trace (type → fields):

| Type | Produced by | Carries |
|------|-------------|---------|
| `page` | A page request (SSR HTML) | `route` (path pattern), `module` (the page's moduleId), duration, status, `bytes`, one child span per loader of the hierarchy (plus the `render` span) |
| `data` | A `?_data=1` refetch (SPA navigation) | `route`, `module`, duration, status, `bytes` of the JSON, a span per loader executed |
| `action` | `/_action/{moduleId}/{name}` | `route`, `module`, `name`, duration, status, `bytes` |
| `endpoint` | A declarative `{ method, handler }` node | `method`, `route`, duration, status, `bytes` where there is a body |
| `stream-connect` | A `stream_*` / standalone SSE connect | `route`, `module`, `name`, `channel`, duration, status |
| `socket-connect` | A `socket_*` upgrade | `route`, `module`, `name`, duration, status |
| `channel-connect` | A live-loader channel connect | `route`, `module`, `channel`, duration, status, the `snapshot` span of the connect snapshot |
| `emit` | Every `emit()` gesture | `channel`, `partition`, `mode` (`invalidate` / `slice`), `connections` reached, duration; in the invalidation mode, one child span per loader re-execution per connection |
| `delivery` | Every frame a long connection delivers | `channel`/`route`/`module`, the cumulative ordinal (`deliveries`), `bytes` of the frame |
| `close` | The end of a long connection | `channel`/`route`/`module`, the total of `deliveries`, the connection's lifetime as `duration` |

The emission is **transparent to the app**: no import, no wrapper, no change in a route module. The spans are automatic too — the trace of a page knows the loaders because the framework is the one executing them.

## The event format

One JSON object per line. The same envelope for every type:

```json
{
  "trace": "m3k9x1-4-f8a2q7",
  "ts": "2026-10-07T18:22:03.482Z",
  "type": "page",
  "route": "/:mes",
  "module": "MesPage",
  "status": "ok",
  "duration": 45.2,
  "bytes": 122880,
  "spans": [
    { "name": "loader:AppLayout", "start": 0.8, "duration": 3.1, "status": "ok" },
    { "name": "loader:MesPage", "start": 1.2, "duration": 43.9, "status": "ok" },
    { "name": "render", "start": 44.3, "duration": 3.5, "status": "ok" }
  ]
}
```

- **`trace`** identifies the execution (and ties a connection's delivery/close lines to its connect line); **`ts`** is the line's own timestamp — both exist on **every** type, including `delivery`, `close` and `boot`.
- **`route`** is always the path **pattern** (`/:mes`), never the materialized URL — this is what makes aggregation by route possible. The channel and stream routes travel as their registered paths (`/_channel/{moduleId}/{channel}`, `/_event/{moduleId}/{name}`).
- **`duration`** is in milliseconds, with decimals; **`status`** is `ok` or `error` (a loader, action or handler that throws). `bytes` is the size of the response body where there is one: pages, data refetches, actions and endpoints. Time and weight travel together, so a slow screen is either a slow server or a fat response — the trace says which.
- **`spans`** are the children of the trace, when the type has them: `name`, `start` (relative to the trace), `duration` and `status` each. Loader spans are named after the module (`loader:MesPage`); `render` delimits the SSR itself. `total − (loaders + render)` is the gap of the middlewares, which this slice deliberately leaves uninstrumented.
- **`deliveries`** is the cumulative ordinal of a connection's deliveries. A long connection is a stream of evidence: fifty snapshots on one channel is the symptom of "re-executing too much", and the volume is proportional to what it measures — whoever delivers a lot, records a lot. Rotation limits the rest.

### Delivery and closing lines

Long connections (channel, stream and socket) never keep one line growing: each delivered frame is a light line of its own — no spans — carrying the ordinal and the frame's bytes when there are any:

```json
{ "trace": "m3k9x1-4-f8a2q7", "ts": "…", "type": "delivery", "channel": "teamExpenses", "deliveries": 2, "bytes": 31 }
```

When the connection ends — the client left, the server closed it, the idle timeout elapsed — the final line reports the total and the lifetime:

```json
{ "trace": "m3k9x1-4-f8a2q7", "ts": "…", "type": "close", "channel": "teamExpenses", "deliveries": 2, "status": "ok", "duration": 120000.4 }
```

Heartbeats are transport, not delivery: a `: ping` comment never counts as a delivery and never moves the idle clock.

### The emit chain

The emit trace has **no request parent at all** — that is the point:

```json
{
  "trace": "m3k9x2-1-b41c9d",
  "ts": "…",
  "type": "emit",
  "channel": "teamExpenses",
  "partition": "team:7",
  "mode": "invalidate",
  "connections": 2,
  "status": "ok",
  "duration": 12.7,
  "spans": [
    { "name": "loader:Expenses", "start": 0.1, "duration": 5.4, "status": "ok" },
    { "name": "loader:Expenses", "start": 0.2, "duration": 6.1, "status": "ok" }
  ]
}
```

In the invalidation mode every re-executed loader is a child span — one per connection; a scope that resolves to a partition with no subscribers still produces the trace, with `connections: 0` (an emit that reaches nobody is exactly what you want to see). In the slice mode the producer already holds the value, so the trace carries the connections that received it and no spans. When the coalescing window folds a burst, each gesture that fell inside it gets its trace, carrying the round's spans.

## The boot record

The first event of every active destination — the file's first line, the sink's first POST — is the boot record, the cheap "where am I writing and how far can I grow" diagnosis:

```json
{ "trace": "m3k9x0-0-0a1b2c", "ts": "…", "type": "boot", "version": "1.4.2", "env": "production", "file": "/srv/app/logs/telemetry.8123-host.jsonl", "sink": null, "maxMb": 10 }
```

`version` is the served app's `package.json` version; `env` is `NODE_ENV`; `file` and `sink` are the **effective** destinations (a null one is off), and `maxMb` is the rotation limit in force — the default or the override.

## File, instance and rotation

The file destination is append-only JSONL. The **effective name carries an instance suffix** with the pid and the hostname — `telemetry.jsonl` becomes `telemetry.8123-host.jsonl` — so replicas of the same app sharing a volume write different files and a concurrent append never corrupts one another's JSONL.

Rotation is by size only (`VELO_TELEMETRY_MAX_MB`, default `10`): when the next line would push the file past the limit, the file is renamed to `<effective>.<n>` and a fresh one takes its place — the effective path always holds the newest lines, and the rotated files stay behind it. There is no retention by days; the limit is the whole pruning policy.

## The sink

With `VELO_TELEMETRY_SINK_URL` set (alone or alongside `VELO_TELEMETRY_FILE`), every event also leaves as one `POST` with the JSON line as the body — that is what the consumer's platform ingests. Without the env, nothing leaves the machine. A sink failure — refused connection, non-2xx — is logged and **never** affects the request that produced the event.

## The CLI

`velojs telemetry` is the inaugural consumption surface: it ranks the JSONL by route, action and channel — count, errors, p50/p95 and volume in bytes — and prints the timeline. No UI, no server route: the operator's terminal.

```bash
# The whole file resolved from the env (or the project's .env), instance and
# rotation files included:
velojs telemetry

# Only the last hour of a long-lived file:
velojs telemetry --last 60m

# A JSONL copied from production:
velojs telemetry ./telemetry.prod.jsonl
```

The window is the whole file by default; `--last` accepts `ms`, `s`, `m`, `h` and `d` (`--last 60m`, `--last 2h`, `--last 7d`). Without a path, the destination comes from `VELO_TELEMETRY_FILE` (environment or `.env`), including every file that derives from it — the instance suffixes and the rotated ones. An explicit path reads exactly that file (or a directory of them).

```
VeloJS telemetry
files:  1
  /srv/app/logs/telemetry.8123-host.jsonl
window: last 60m — since 2026-10-07T17:22:03.482Z
events: 412

By route
  key                      count  errors     p50      p95     bytes
  /:mes                       48       1   45.2ms   88.1ms    5.6MB
  GET /api/health            120       0    1.2ms    3.0ms   12.0KB

By action
  key                      count  errors     p50      p95     bytes
  Jobs/notify                  6       0   12.4ms   30.2ms    1.2KB

By channel
  key                      count  errors     p50      p95     bytes
  teamExpenses                52       0   12.7ms   20.1ms    1.3KB
```

## What is not here yet

The visual viewer over the route tree (`velojs telemetry --view`, following the `velojs graph --view` pattern), a manual `trace()` API for app spans, OTLP/OpenTelemetry export, middleware spans, client-side telemetry and the retention/continuous aggregation layer are deliberately out of this slice. The nested format is the one that will receive them without a migration — the model is already parent-and-children.