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

### Re-fetching on route changes

If your page depends on URL parameters (like a user ID), pass them as dependencies. The data will re-fetch whenever the dependencies change:

```typescript
const params = useParams<{ id: string }>();
const { data } = useLoader<User>([params.id]);
```

## Loader — Module-level shared data

Use `Loader` (capital L, outside of components) when you need data that's shared across multiple pages. This is typically used in **layouts** to load data that child pages need.

```typescript
// app/admin/Layout.tsx
import { Loader } from "@mauroandre/velojs/hooks";

// This runs once when the module is imported — not inside a component
export const { data: userData } = Loader<UserData>();

export const loader = async ({ c }: LoaderArgs) => {
    const user = c.get("user");
    return { name: user.name, role: user.role };
};

export const Component = ({ children }) => (
    <div>
        <header>Hello, {userData.value?.name}</header>
        {children}
    </div>
);
```

Child pages can import the shared data directly:

```typescript
// app/admin/Dashboard.tsx
import { userData } from "./Layout.js";

export const Component = () => (
    <div>Role: {userData.value?.role}</div>
);
```

**Important difference from useLoader:** `Loader` only hydrates from SSR data. It does **not** re-fetch on client-side navigation. It's designed for data that stays constant across an entire section of your app (like the current user in a layout).

## When to use which

| Scenario | Use |
|----------|-----|
| Page-specific data (list of users, post details) | `useLoader` |
| Data that changes when URL params change | `useLoader` with deps |
| Shared data in a layout (current user, permissions) | `Loader` |
| Data needed by multiple sibling pages | `Loader` in their parent layout |

## How data flows

Understanding the data flow helps you debug issues:

**First page load (SSR):**
1. All loaders in the route hierarchy run in parallel on the server
2. The server injects the data into the HTML as `window.__PAGE_DATA__`
3. `useLoader()` and `Loader()` hydrate from `__PAGE_DATA__` — no extra fetch needed

**Client-side navigation (SPA):**
1. User clicks a link
2. `useLoader()` fetches `currentPath?_data=1` from the server
3. The server runs all loaders and returns JSON
4. `useLoader()` updates its signal with the new data
5. `Loader()` does nothing — it keeps the data from the initial SSR
