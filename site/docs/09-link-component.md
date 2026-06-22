# Link Component

The `Link` component handles navigation in VeloJS. It supports both simple string paths and type-safe module references.

All link paths are **root-absolute** — they resolve from the root of your app, exactly as the server does. There is no per-layout relative context to keep track of.

## Basic usage

```typescript
import { Link } from "@mauroandre/velojs";

// Simple string path
<Link to="/users">Users</Link>

// With URL parameters
<Link to="/users/123">View User</Link>
```

## Module references

Instead of hardcoding paths, you can pass a route module directly. The link uses the module's `fullPath`, so if the path changes in `routes.tsx`, your links update automatically:

```typescript
import { Link } from "@mauroandre/velojs";
import * as UserPage from "./users/UserDetail.js";

// Navigates to the module's full path (e.g. /users/:id)
<Link to={UserPage} params={{ id: "123" }}>View</Link>
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

String paths may start with `~/`. This is wouter-preact's root-absolute prefix: the `~` is stripped and the path resolves from the root. Since VeloJS links are already root-absolute, `~/x` and `/x` resolve to the same place:

```typescript
<Link to="~/stacks">Stacks</Link>   // → /stacks
<Link to="/stacks">Stacks</Link>    // → /stacks  (identical)
```

The prefix is supported for backward compatibility — you can keep existing `~/` links as-is, or drop the `~` in new code.

> **Migrating from older versions:** earlier releases resolved string and module links relative to the current layout's nest context, and `~/` escaped to the root. Layout nesting on the client now mirrors the server (full-path matching, no nested base), so every link is root-absolute. In practice: keep using absolute paths (`/stacks`) or module references; existing `~/` links keep working.

## Props reference

| Prop | Type | Description |
|------|------|-------------|
| `to` | `string \| RouteModule` | Destination path or module. A string may start with `~/` (root-absolute); a module resolves to its `fullPath`. |
| `params` | `Record<string, string>` | Substitutes `:param` placeholders in the path. |
| `search` | `Record<string, string>` | Appends query string parameters to the URL. |
| `absolute` | `boolean` | Deprecated, no-op. Module references always use `fullPath`. Kept for backward compatibility. |
