# Loaders

Loaders are how you fetch data on the server and make it available to your components. VeloJS provides two patterns, each designed for a different use case.

## useLoader — Component-level data

Use `useLoader` inside a `Component` when you need data that's specific to that page. It supports both SSR (server-side rendering) and SPA navigation (client-side fetch).

```typescript
export const Component = () => {
    const { data, loading, refetch } = useLoader<MyType>();

    // data: Signal<T | null>     — the loader data (reactive)
    // loading: Signal<boolean>   — true while fetching
    // refetch: () => void        — manually re-fetch the data
};
```

**How it works:**
- On the first page load (SSR), the data is rendered on the server and injected into the HTML
- When the user navigates to this page via a link (SPA), `useLoader` fetches the data from the server automatically
- The data is a Preact signal — your UI updates automatically when it changes

### Re-fetching on route changes — automatic

If your page's route declares a param, you don't have to do anything. VeloJS reads the route tree, so it already knows that a module at `/users/:id` depends on `id`, and refreshes its data when you navigate from `/users/1` to `/users/2`:

```typescript
// app/users/Detail.tsx — routed at /users/:id
export const Component = () => {
    const { data } = useLoader<User>();   // refreshes on :id change, no deps needed
};
```

### Deps — for what the route doesn't declare

`routes.tsx` declares path params (`/users/:id`), never query strings or client state. When your data depends on one of those, pass it as a dependency:

```typescript
const query = useQuery<{ tab: string }>();
const { data } = useLoader<Report>([query.tab]);   // ?tab= is not in the route
```

A dep that just repeats a path param is harmless but redundant — the framework already knows.

## Loader — Module-level shared data

Use `Loader` (capital L, outside of components) when **another module needs your data**. It gives you a handle you can export — typically from a layout, so its child pages can read it.

```typescript
// app/admin/Layout.tsx
import { Loader } from "@mauroandre/velojs/hooks";

export const loader = async ({ c }: LoaderArgs) => {
    const user = c.get("user");
    return { name: user.name, role: user.role };
};

// Runs at module import — not inside a component
export const { data: userData, refetch } = Loader<UserData>();

export const Component = ({ children }) => (
    <div>
        <header>Hello, {userData.value?.name}</header>
        {children}
    </div>
);
```

Child pages import the handle directly:

```typescript
// app/admin/Dashboard.tsx
import { userData } from "./Layout.js";

export const Component = () => (
    <div>Role: {userData.value?.role}</div>
);
```

`Loader` and `useLoader` for the same module return the **same signal**, so a layout's data and a child's read of it are one value. A child can update it after a mutation without a round-trip:

```typescript
import { userData } from "./Layout.js";
import { touch } from "@mauroandre/velojs/hooks";

const handleSave = async () => {
    const saved = await action_save({ body: { name: name.value } });
    userData.value!.name = saved.name;   // you already know the result
    touch(userData);                      // notify — see the hooks doc
};
```

Or let the server recompute, when the new state isn't something the client can derive:

```typescript
import { refetch } from "./Layout.js";
await action_reset({ body: { id } });
refetch();                                // e.g. aggregate counters
```

> **Never mirror loader data into a module-level `export let`.** On the server, a module binding is per-process, not per-request — a value stored there belongs to whichever request wrote it last. `Loader`'s server value is an AsyncLocalStorage getter, so it is per-request by construction. That's the whole reason the handle is safe to export.

## When to use which

| Scenario | Use |
|----------|-----|
| Page-specific data (list of users, post details) | `useLoader` |
| Data another module reads (a layout's list, the current record) | `Loader` |
| Data that changes when the route's params change | either — automatic |
| Data that depends on a query string or client state | `useLoader` with deps |
| Refresh after a mutation | `refetch()` (server recomputes) or `touch()` (you already know) |

## How data flows

Understanding the data flow helps you debug issues:

**First page load (SSR):**
1. All loaders in the route hierarchy run in parallel on the server
2. The server injects every module's data into the HTML as `window.__PAGE_DATA__`, keyed by module
3. `useLoader()` and `Loader()` read it — non-destructively, so any number of components can read the same module

**Client-side navigation (SPA):**
1. User clicks a link
2. VeloJS compares each module's route pattern against the new URL and marks stale the ones whose **declared params** changed
3. One `?_data=1` request serves all of them
4. Only the stale modules are written — a module the client owns locally (a filtered list, an optimistic edit) is left alone

That last point is why a layout at `/admin/empresas` keeps a filtered list while you navigate among its children: its route declares no param, so nothing invalidates it.
