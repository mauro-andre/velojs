# Link Component

The `Link` component handles navigation in VeloJS. It supports both simple string paths and type-safe module references.

## Basic usage

```typescript
import { Link } from "@mauroandre/velojs";

// Simple string path
<Link to="/users">Users</Link>

// With URL parameters
<Link to="/users/123">View User</Link>
```

## Module references

Instead of hardcoding paths, you can pass a route module directly. This way, if the path changes in `routes.tsx`, your links update automatically:

```typescript
import { Link } from "@mauroandre/velojs";
import * as UserPage from "./users/UserDetail.js";
import * as LoginPage from "./auth/Login.js";

// Relative path (uses metadata.path — works within the current layout)
<Link to={UserPage} params={{ id: "123" }}>View</Link>

// Absolute path (uses metadata.fullPath — navigates from the root)
<Link to={LoginPage} absolute>Login</Link>
```

## Parameters and query strings

Use `params` to substitute `:param` placeholders in the path, and `search` to add query string parameters:

```typescript
<Link to={UserPage} params={{ id: "123" }} search={{ tab: "settings" }}>
    User Settings
</Link>
// Renders: /users/123?tab=settings
```

## The `~/` prefix

VeloJS uses wouter-preact for client-side routing. When routes are nested (layouts wrapping children), wouter creates a **nest context** — relative paths resolve within the current layout's scope.

This is usually what you want. But sometimes you need to navigate to a completely different section of your app. That's where `~/` comes in:

```typescript
// Inside a layout at /admin/users, these behave differently:

<Link to="/details">     // → /admin/users/details (relative to current layout)
<Link to="~/settings">   // → /settings (absolute, from the root)
```

**When to use `~/`**: anytime you navigate to a route outside the current layout. In practice, most cross-section links (e.g., from admin to settings, from dashboard to billing) use `~/`.

```typescript
// Common pattern: cross-section navigation
<Link to="~/stacks">Stacks</Link>
<Link to={`~/stacks/apps/${appId}/edit`}>Edit App</Link>
```

## Props reference

| Prop | Type | Description |
|------|------|-------------|
| `to` | `string \| RouteModule` | Destination path or module. Strings support `~/` prefix. |
| `params` | `Record<string, string>` | Substitutes `:param` placeholders in the path. |
| `search` | `Record<string, string>` | Appends query string parameters to the URL. |
| `absolute` | `boolean` | When using a module reference: use `fullPath` instead of `path`. Default: `false`. |
