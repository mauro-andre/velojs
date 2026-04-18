# Actions

Actions are server-side functions that you can call from the client as if they were regular functions. VeloJS transforms them into HTTP calls automatically — you write server code, the framework handles the rest.

## How actions work

Any exported function starting with `action_` is treated as a server action:

```typescript
export const action_login = async ({
    body,
    c,
}: ActionArgs<{ email: string; password: string }>) => {
    const { authenticate } = await import("./auth.service.js");
    const token = await authenticate(body.email, body.password);

    const { setCookie } = await import("@mauroandre/velojs/cookie");
    setCookie(c!, "session", token, { path: "/" });

    return { ok: true };
};
```

On the **server**, this function runs normally — it has access to the Hono context (`c`), can read cookies, access the database, and do anything a server function can do.

On the **client**, the Vite plugin replaces the function body with a `fetch()` call. The client version looks like this:

```typescript
// What the client actually executes (generated automatically):
export const action_login = async ({ body }: { body: { email: string; password: string } }) => {
    return fetch("/_action/auth/Login/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    }).then(r => r.json());
};
```

You don't write this — the Vite plugin generates it at build time by analyzing the AST of your code.

## The ActionArgs type

Every action receives an object with these properties:

| Property | Type | Available on | Description |
|----------|------|-------------|-------------|
| `body` | `TBody` | Server + Client | The data sent from the client |
| `c` | `Context` | Server only | Hono request context (cookies, headers, etc) |
| `params` | `Record<string, string>` | Server only | URL parameters |
| `query` | `Record<string, string>` | Server only | Query string parameters |

On the client, only `body` is available (the rest are stripped by the Vite plugin).

## Error handling

Actions **do not throw** on server errors. Instead, they resolve with `{ error: "message" }`. Always check for errors explicitly:

```typescript
const result = await action_login({ body: { email, password } });

if (result.error) {
    showToast(result.error, "danger");
    return;
}

// Success
window.location.href = "/admin";
```

## Remember: use dynamic imports

Just like loaders, actions should use `await import()` for server-only code:

```typescript
export const action_delete = async ({ body }: ActionArgs<{ id: string }>) => {
    // GOOD — dynamic import
    const { deleteUser } = await import("./user.service.js");
    await deleteUser(body.id);
    return { ok: true };
};
```

## Sharing actions across pages

Every action lives at a fixed URL: `/_action/{moduleId}/{actionName}`. The `moduleId` comes from the file where the action is **declared** — never from the file where it's imported. This means you can declare an action once in a layout and import it from any child page.

### When to use this

Common cases:

- **Logout** — every page under an auth layout needs the same action
- **Global forms** — like a "contact us" that appears in multiple pages
- **Shared mutations** — like toggling a theme or closing a notification

### Example: logout action in a layout

```typescript
// app/admin/Layout.tsx
import type { ActionArgs } from "@mauroandre/velojs";

export const action_logout = async ({ c }: ActionArgs) => {
    const { deleteCookie } = await import("@mauroandre/velojs/cookie");
    deleteCookie(c!, "session");
    return { ok: true };
};

export const Component = ({ children }) => (
    <div>
        <nav>/* ... */</nav>
        {children}
    </div>
);
```

Now any page under the layout can import and call it:

```typescript
// app/admin/Dashboard.tsx
import { action_logout } from "./Layout.js";

export const Component = () => (
    <button onClick={async () => {
        await action_logout({});
        window.location.href = "/login";
    }}>
        Logout
    </button>
);
```

```typescript
// app/admin/Settings.tsx — same action, different page
import { action_logout } from "./Layout.js";

export const Component = () => (
    <a onClick={() => action_logout({})}>Leave</a>
);
```

Both imports compile to the **same URL**: `POST /_action/admin/Layout/logout`. Middlewares on the layout (like `authMiddleware`) apply automatically.

### Why this works

The Vite plugin replaces the action body with a `fetch()` call to its registered URL **during compile time**, using the `moduleId` of the file where the export lives. Imports in other files just reuse that compiled stub — they never change the URL.
