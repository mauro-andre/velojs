---
name: velojs-middlewares
description: "Route middleware: auth guards, redirects, per-route server logic, passing values via `c.set`/`c.get`. Use when protecting a route, requiring login, checking permissions, or running server logic before a page or action."
---

# Middlewares

Middlewares are server-side functions that run before your loaders and actions. They're perfect for authentication, authorization, logging, and other cross-cutting concerns. The Vite plugin automatically removes them from the client bundle.

## Creating a middleware

Use `createMiddleware` from `@mauroandre/velojs/factory`. It wraps Hono's middleware API:

```typescript
// app/modules/auth/auth.middleware.ts
import { createMiddleware } from "@mauroandre/velojs/factory";
import { getCookie } from "@mauroandre/velojs/cookie";

export const authMiddleware = createMiddleware(async (c, next) => {
    const token = getCookie(c, "session");

    if (!token) {
        // No token: redirect GET requests, return 401 for API calls
        if (c.req.method === "GET") return c.redirect("/login");
        return c.json({ error: "unauthorized" }, 401);
    }

    // Verify the token and attach user data to the context
    const user = await verifyToken(token);
    c.set("user", user);

    // Continue to the next middleware or handler
    await next();
});
```

## Using in routes

Add the `middlewares` property to any route node. All children of that node will inherit the middleware:

```typescript
export default [
    {
        module: Root,
        isRoot: true,
        children: [
            // Public routes — no middleware
            {
                module: AuthLayout,
                children: [
                    { path: "/login", module: Login },
                ],
            },
            // Protected routes — authMiddleware applies to everything below
            {
                module: AdminLayout,
                middlewares: [authMiddleware],
                children: [
                    { path: "/", module: Dashboard },
                    { path: "/stacks", module: Stacks },

                    // Admin-only routes — both middlewares apply
                    {
                        path: "/master",
                        module: MasterLayout,
                        middlewares: [masterMiddleware],
                        children: [
                            { path: "/workers", module: Workers },
                            { path: "/settings", module: Settings },
                        ],
                    },
                ],
            },
        ],
    },
] satisfies AppRoutes;
```

## Inheritance

Middlewares **accumulate** from parent to child. In the example above:

- `/` and `/stacks` → only `authMiddleware` runs
- `/master/workers` and `/master/settings` → `authMiddleware` runs first, then `masterMiddleware`

### What middlewares protect

A middleware on a layout guards **every request** that reaches a nested route, including:

| Request type | URL pattern | When it happens |
|--------------|-------------|-----------------|
| Page load | `GET /stacks` | User opens the page directly (first visit, refresh) |
| Data fetch | `GET /stacks?_data=1` | SPA navigation — `useLoader` fetches JSON |
| Action call | `POST /_action/admin/Stacks/delete` | User triggers a server action |

You don't need to add the middleware to each route manually — declaring it once on the layout covers all three paths automatically. This is especially important for authentication: without it, your API endpoints could be reached even if the page itself is protected.

### Example: protecting an action via layout middleware

```typescript
// app/routes.tsx
{
    module: AdminLayout,
    middlewares: [authMiddleware],
    children: [
        { path: "/stacks", module: Stacks },
    ],
}
```

```typescript
// app/admin/Stacks.tsx
export const action_delete = async ({ body, c }: ActionArgs<{ id: string }>) => {
    // authMiddleware already ran — user is guaranteed to be authenticated
    const user = c!.get("user");
    // ... delete logic
};
```

When the client calls `action_delete({ body: { id: "abc" } })`, it hits `POST /_action/admin/Stacks/delete`. Hono runs `authMiddleware` before the action executes. If the middleware returns an error (e.g., 401), the action never runs.

## Sharing data between middleware and handlers

Use Hono's `c.set()` in the middleware and `c.get()` in your loaders and actions:

```typescript
// Middleware sets the user
c.set("user", { id: "123", name: "Mauro", role: "master" });

// Loader reads it
export const loader = async ({ c }: LoaderArgs) => {
    const user = c.get("user");
    return { greeting: `Hello, ${user.name}` };
};

// Action reads it
export const action_save = async ({ body, c }: ActionArgs<{ name: string }>) => {
    const user = c!.get("user");
    // user is available here
};
```

This is the recommended pattern for passing authentication data (current user, permissions, etc) from middleware to your page code.
