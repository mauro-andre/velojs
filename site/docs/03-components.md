---
description: "Page and layout modules: the `Component` export, `metadata`/title, `children`, and keeping server-only code out of the client bundle. Use when creating a page or layout, setting a page title, or asked why a server import leaked to the browser."
---

# Components

Every page and layout in VeloJS is a module that can export up to three things. Understanding these conventions is key to building with VeloJS.

## The three exports

| Export | Purpose |
|--------|---------|
| `export const Component` | The Preact component that renders the UI (required) |
| `export const loader` | A server-side function that fetches data for the page |
| `export const action_*` | Server-side functions callable from the client (RPC) |

## Example page

Here's a complete page that uses all three:

```typescript
// app/admin/Users.tsx
import type { LoaderArgs, ActionArgs } from "@mauroandre/velojs";
import { useLoader } from "@mauroandre/velojs/hooks";

interface User { id: string; name: string; }

// 1. Loader — runs on the server, fetches data
export const loader = async ({ params, query, c }: LoaderArgs) => {
    const { getUsers } = await import("./user.service.js");
    return getUsers();
};

// 2. Action — runs on the server, called from the client
export const action_delete = async ({
    body,
    c,
}: ActionArgs<{ id: string }>) => {
    const { deleteUser } = await import("./user.service.js");
    await deleteUser(body.id);
    return { ok: true };
};

// 3. Component — renders on both server (SSR) and client
export const Component = () => {
    const { data, loading, refetch } = useLoader<User[]>();

    if (loading.value) return <div>Loading...</div>;

    return (
        <ul>
            {data.value?.map((u) => (
                <li key={u.id}>
                    {u.name}
                    <button onClick={async () => {
                        await action_delete({ body: { id: u.id } });
                        refetch();
                    }}>Delete</button>
                </li>
            ))}
        </ul>
    );
};
```

## Server-only imports (critical)

This is the **most important convention** in VeloJS. Read this carefully.

Your page file is bundled for **both** server and client. For the client, the Vite plugin removes the `loader` export, stubs `action_*` into `fetch()` calls, and then prunes any top-level import left **unreferenced** by that strip.

So an import used only inside a loader is dropped for you. What survives the strip keeps its imports — and that's where server code leaks:

**The rule**: always use `await import()` inside loaders and actions for server-only code. Never reference it from anything that survives into the client bundle.

```typescript
// BAD — `conn` is module-scope, so it survives the strip, so the import survives
// with it, and the database driver lands in the browser.
import { db } from "../db/engine.js";

const conn = db.connect();

export const loader = async () => conn.query("select * from users");
```

```typescript
// GOOD — dynamic import only runs on the server
export const loader = async () => {
    const { getUsers } = await import("./user.service.js");
    return getUsers();
};
```

Why does this matter? Because `user.service.js` might import a database driver, which imports Node.js native modules like `fs` or `crypto`. If that code ends up in the client bundle, Vite will throw errors or include unnecessary code.

The same applies anywhere the strip leaves a reference behind — a value used in the `Component`, a helper called at module scope, or a type kept in an action's signature. When in doubt, move the import inside the function that needs it.

**Think of it this way**: any `import` at the top of the file is shared between server and client. Any `await import()` inside a function is server-only (because loaders and actions only run on the server).
