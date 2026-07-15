---
description: "The route tree in `app/routes.tsx`: nesting, layouts, path-less wrappers, URL params, index routes, the catch-all 404, per-route status codes. Use when adding/moving/removing a page or URL, building a layout, or asked why a route 404s."
---

# Routes

In VeloJS, all routes are defined in a single file: `app/routes.tsx`. Instead of filesystem-based routing, you define your routes as a **tree structure**. This gives you full control over layouts, nesting, and middleware inheritance.

## The route tree

Each node in the tree represents either a **page** (leaf node) or a **layout** (node with children). Here's an example with authentication:

```typescript
import type { AppRoutes } from "@mauroandre/velojs";
import * as Root from "./client-root.js";
import * as AuthLayout from "./auth/Layout.js";
import * as Login from "./auth/Login.js";
import * as AdminLayout from "./admin/Layout.js";
import * as Dashboard from "./admin/Dashboard.js";
import * as Users from "./admin/Users.js";
import * as UserDetail from "./admin/UserDetail.js";
import { authMiddleware } from "./modules/auth/auth.middleware.js";

export default [
    {
        module: Root,
        isRoot: true,
        children: [
            // Public routes — no authentication required
            {
                module: AuthLayout,
                children: [
                    { path: "/login", module: Login },
                ],
            },
            // Protected routes — authMiddleware runs first
            {
                module: AdminLayout,
                middlewares: [authMiddleware],
                children: [
                    { path: "/", module: Dashboard },
                    { path: "/users", module: Users },
                    { path: "/users/:id", module: UserDetail },
                ],
            },
        ],
    },
] satisfies AppRoutes;
```

## How nesting works

Routes with `children` act as **layouts**. Their `Component` receives `children` and wraps the nested routes. VeloJS renders the full hierarchy from root to leaf.

For example, when a user visits `/users/123`, VeloJS renders:

```
Root (isRoot — the <html>, <head>, <body> shell)
  └─ AdminLayout (sidebar, navigation bar)
       └─ UserDetail (the actual page content)
```

Here's what the layout components look like:

```typescript
// app/admin/Layout.tsx — Layout wraps its children
export const Component = ({ children }: { children: any }) => (
    <div class="layout">
        <nav class="sidebar">...</nav>
        <main class="content">{children}</main>
    </div>
);

// app/admin/UserDetail.tsx — Page is the leaf (no children)
export const Component = () => {
    const { data } = useLoader<User>();
    return <div>{data.value?.name}</div>;
};
```

Every layout and page can have its own `loader`. When a page is requested, **all loaders in the hierarchy run in parallel** — the Root loader, AdminLayout loader, and UserDetail loader all execute at the same time. This makes data loading fast.

On the client, a layout **stays mounted** while you navigate between its child routes — only the inner content swaps. This follows the tree automatically: navigating between sibling routes never re-mounts anything above them, so a sidebar or nav bar (and its loader, scroll, and state) is preserved instead of flickering. It works the same whether the layout has a `path` (a section like `/admin`) or is a path-less wrapper (an app shell grouping several top-level routes) — no configuration needed.

## Route node properties

| Property | Type | Description |
|----------|------|-------------|
| `path` | `string` | URL path segment. Supports `:params` (e.g., `/users/:id`). |
| `module` | `RouteModule` | The module with `Component`, `loader`, and `action_*` exports. |
| `children` | `RouteNode[]` | Nested routes. When present, the module acts as a layout. |
| `middlewares` | `MiddlewareHandler[]` | Server-side middlewares. Inherited by all children. |
| `isRoot` | `boolean` | Marks the root node (the HTML shell). |
| `statusCode` | `number` | HTTP status code for the rendered page. Defaults to `200`. See [Status codes](#status-codes) and [The 404 page](#the-404-page). |

## Status codes

By default every page responds with HTTP `200`. Set `statusCode` on a route to override it — useful for pages like _gone_ (`410`) or _service unavailable_ (`503`):

```typescript
{ path: "/old-page", module: Gone, statusCode: 410 }
```

The status is applied to both the SSR HTML response and the JSON returned for SPA navigation, so it stays consistent however the page is reached.

For a **conditional** status — a route that exists but whose resource may be missing (e.g. `/users/:id` for an unknown id) — don't use a static `statusCode`. Set it from the loader instead, via the Hono context:

```typescript
export const loader = async ({ params, c }: LoaderArgs) => {
    const user = await getUser(params.id);
    if (!user) c.status(404);
    return { user };
};
```

## The 404 page

To render your own _not found_ page, add a **catch-all** route with `path: "*"` as the **last child of the root**:

```typescript
import * as NotFound from "./pages/NotFound.js";

export default [
    {
        module: Root,
        isRoot: true,
        children: [
            { path: "/", module: Home },
            // Keep the catch-all last — it matches only when nothing else does.
            { path: "*", module: NotFound, statusCode: 404 },
        ],
    },
] satisfies AppRoutes;
```

The `NotFound` page is a normal page component, rendered inside the root layout like any other route:

```typescript
// app/pages/NotFound.tsx
export const Component = () => (
    <main>
        <h1>404</h1>
        <p>Page not found.</p>
        <a href="/">Go home</a>
    </main>
);
```

VeloJS handles the catch-all specially across all modes:

- **SSR** — it's wired to Hono's `notFound` hook, so it runs only after no route matched and no static asset was found. It never shadows your assets, actions, streams, or sockets. The response carries the `statusCode` (default `404`).
- **SPA navigation** — the client router renders it when no route matches, with no round-trip. A top-level unknown URL renders standalone; an unknown sub-route of a section that has a layout (e.g. `/admin/nope`) renders the 404 **inside that section's layout**, so the layout stays mounted (no flicker).
- **Static generation** (`velojs build --static`) — it's emitted as `dist/404.html` at the output root, following the universal `/404.html` convention that static hosts (nginx, GitHub Pages, Netlify, S3/CloudFront…) serve automatically.

The catch-all is **optional**. Without it, an unmatched path still responds `404`, just with a plain-text body instead of your styled page.

> On the server the 404 always renders standalone (inside the root shell only) and its route middlewares don't run — there was no route to match. On the client, a section layout stays mounted when you navigate to a bad sub-route of that section.

## Path resolution

Paths are **segments** that build up from parent to child:

```
Root (no path)
  └─ AdminLayout (no path)
       ├─ Dashboard    → path: "/"           → fullPath: "/"
       ├─ Users        → path: "/users"      → fullPath: "/users"
       └─ UserDetail   → path: "/users/:id"  → fullPath: "/users/:id"
```

Nodes without a `path` don't add a segment to the URL — they are **pure layout wrappers**. This is useful when you want to wrap a group of pages in a shared layout without changing their URLs.

The Vite plugin automatically parses your `routes.tsx` at build time and calculates both `fullPath` (the complete URL) and `path` (the relative segment) for each module.

## Shared layouts, different paths

You can reuse the same layout for different route groups:

```typescript
export default [
    {
        module: Root,
        isRoot: true,
        children: [
            // Public pages — PublicLayout, no auth
            {
                module: PublicLayout,
                children: [
                    { path: "/", module: Home },
                    { path: "/about", module: About },
                ],
            },
            // Dashboard — DashboardLayout + auth middleware
            {
                path: "/dashboard",
                module: DashboardLayout,
                middlewares: [authMiddleware],
                children: [
                    { path: "/", module: Overview },
                    { path: "/settings", module: Settings },
                ],
            },
        ],
    },
] satisfies AppRoutes;
```

Here, `PublicLayout` and `DashboardLayout` are completely separate layouts. Public pages live at `/` and `/about`, while dashboard pages live at `/dashboard` and `/dashboard/settings`.
