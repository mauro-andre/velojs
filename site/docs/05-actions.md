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
