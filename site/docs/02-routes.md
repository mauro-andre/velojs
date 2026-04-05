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

## Route node properties

| Property | Type | Description |
|----------|------|-------------|
| `path` | `string` | URL path segment. Supports `:params` (e.g., `/users/:id`). |
| `module` | `RouteModule` | The module with `Component`, `loader`, and `action_*` exports. |
| `children` | `RouteNode[]` | Nested routes. When present, the module acts as a layout. |
| `middlewares` | `MiddlewareHandler[]` | Server-side middlewares. Inherited by all children. |
| `isRoot` | `boolean` | Marks the root node (the HTML shell). |

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
