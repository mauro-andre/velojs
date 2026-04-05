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

Your page file is bundled for **both** server and client. The Vite plugin strips the loader body and transforms actions into fetch stubs for the client — but **top-level imports are kept in the client bundle**.

This means if you import a server-only module (database driver, file system, secrets) at the top of the file, it will leak into the client bundle and likely break the build.

**The rule**: always use `await import()` inside loaders and actions for server-only code.

```typescript
// BAD — this import goes into the client bundle
import { getUsers } from "./user.service.js";
import { db } from "../db/engine.js";

export const loader = async () => {
    return db.collection("users").find().toArray();
};
```

```typescript
// GOOD — dynamic import only runs on the server
export const loader = async () => {
    const { getUsers } = await import("./user.service.js");
    return getUsers();
};
```

Why does this matter? Because `user.service.js` might import a database driver, which imports Node.js native modules like `fs` or `crypto`. If that code ends up in the client bundle, Vite will throw errors or include unnecessary code.

**Think of it this way**: any `import` at the top of the file is shared between server and client. Any `await import()` inside a function is server-only (because loaders and actions only run on the server).
