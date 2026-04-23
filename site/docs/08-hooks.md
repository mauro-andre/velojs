# Hooks

VeloJS provides a set of hooks that work identically on both server (SSR) and client. On the server, they read from `AsyncLocalStorage` (isolated per request). On the client, they use the DOM and wouter-preact.

## Available hooks

| Hook | Returns | Description |
|------|---------|-------------|
| `useLoader<T>(deps?)` | `{ data, loading, refetch }` | Page data with SSR + SPA support |
| `Loader<T>()` | `{ data, loading }` | Module-level SSR-only data |
| `useEventStream<T, S>(stream, opts?)` | `{ data, snapshot, closed, error }` | Real-time SSE stream subscription |
| `useParams<T>()` | `T` | URL parameters (`:id`, etc) |
| `useQuery<T>()` | `T` | Query string parameters |
| `useNavigate()` | `navigate(path)` | Programmatic navigation |
| `usePathname()` | `string` | Absolute URL pathname |
| `touch(signal)` | `void` | Force signal notification after mutation |

## useParams

Reads URL parameters from the current route. For example, if your route path is `/users/:id`:

```typescript
const params = useParams<{ id: string }>();
console.log(params.id); // "123" when visiting /users/123
```

## useQuery

Reads query string parameters from the URL. For example, visiting `/search?q=hello&page=2`:

```typescript
const query = useQuery<{ q: string; page: string }>();
console.log(query.q);    // "hello"
console.log(query.page); // "2"
```

## useNavigate

Returns a function for programmatic navigation (when you need to navigate from code, not from a link):

```typescript
const navigate = useNavigate();

const handleLogin = async () => {
    const result = await action_login({ body: credentials });
    if (!result.error) {
        navigate("/admin");
    }
};
```

## usePathname

Returns the **absolute** pathname of the current URL. This is different from wouter's `useLocation`, which returns a path relative to the current layout context.

```typescript
const pathname = usePathname();
// Always returns the full path, e.g., "/admin/users/123"
// Even when inside a nested layout like /admin
```

This is useful when you need to know the exact URL, regardless of layout nesting.

## useEventStream

Subscribes to a server-sent event stream created with `createEventStream`. Returns reactive signals for the latest event, initial snapshot, close state, and errors.

```typescript
const { data, snapshot, closed, error } = useEventStream(stream, {
    channel: "deploy-123",  // optional
    enabled: true,          // optional, default true
});

// data.value     — latest event received from the server
// snapshot.value — initial state on connect (if configured)
// closed.value   — true when server closed the stream (closeOn matched)
// error.value    — parse or connection error, if any
```

The hook handles `EventSource` lifecycle automatically: opens on mount, closes on unmount, re-opens when `channel` changes. See [Event Streams](/docs/event-streams) for the full guide.

## touch

Preact signals are great for reactivity, but they have a limitation: mutating a nested property (like changing `items[0].checked`) doesn't trigger a signal update. The `touch` function forces the signal to notify its subscribers after a mutation:

```typescript
import { useSignal } from "@preact/signals";
import { touch } from "@mauroandre/velojs/hooks";

const items = useSignal<Item[]>([]);

// Mutating a nested property — signal doesn't know about this
items.value[0].checked = true;

// touch() creates a shallow copy, which triggers the update
touch(items);
```

Use `touch` whenever you mutate nested properties on a signal value instead of replacing the entire value.
