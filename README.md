# VeloJS

> Full-stack framework with Server Actions, SSR and Signals

The productivity of React Router v7 with the flexibility of Hono and the lightness of Preact.

## Features

- ✅ **File-based routing** (inspired by React Router v7)
- ✅ **Server Actions** with `action_*` convention
- ✅ **Loaders** for server-side data fetching
- ✅ **Automatic SSR** with hydration
- ✅ **Signals** for reactivity (Preact Signals)
- ✅ **Type-safe** with automatic inference
- ✅ **Native Hono middlewares**
- ✅ **Automatic code splitting** (server/client)
- ✅ **Zero config** - convention over configuration

## Stack

- **Backend**: Hono 4.x
- **Frontend**: Preact 10.x
- **State**: @preact/signals
- **Routing**: wouter-preact (client-side)
- **SSR**: preact-render-to-string
- **Build**: Vite 7.x + Custom plugin
- **Language**: TypeScript (strict mode)

## Installation

```bash
npm install velojs
```

## Quick Start

### 1. Configure routes

```typescript
// routes.ts
import { route, layout } from "velojs";

export default [
  layout("./admin/layout.tsx", {
    prefix: "/admin",
    middleware: [authMiddleware],
    routes: [
      route("/users", "./admin/users/page.tsx"),
    ],
  }),
];
```

### 2. Create a page

```typescript
// app/admin/users/page.tsx
import { useLoaderData, useAction } from "velojs/hooks";

// Loader: fetch data server-side
export async function loader({ context }) {
  const { getUsers } = await import("~/modules/user/repository");
  return { users: await getUsers() };
}

// Server Action: mutations
export async function action_createUser(name: string, email: string) {
  const { saveUser } = await import("~/modules/user/repository");
  return await saveUser({ name, email });
}

// Component: UI
export default function UsersPage() {
  const { value: data } = useLoaderData<typeof loader>();
  const [create, creating] = useAction(action_createUser);

  return (
    <div>
      <button onClick={() => create("John", "john@example.com")}>
        {creating.value ? "Creating..." : "Create User"}
      </button>
      <ul>
        {data.value?.users.map(user => (
          <li key={user.id}>{user.name}</li>
        ))}
      </ul>
    </div>
  );
}
```

### 3. Configure Vite

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import velojs from "velojs/vite-plugin";

export default defineConfig({
  plugins: [velojs()],
});
```

## Development Status

🚧 **Phase 1: Foundation** - ✅ Complete
- [x] Project setup
- [x] TypeScript configuration
- [x] Core types
- [x] Helpers (route, layout)
- [x] Build configuration

🚧 **Phase 2: Vite Plugin - Scanner** - ⏳ In Progress
- [ ] Route scanner
- [ ] Path resolution
- [ ] Middleware extraction

🚧 **Phase 3: Code Splitter** - ⏳ Pending
🚧 **Phase 4: Generator** - ⏳ Pending
🚧 **Phase 5: Hooks** - ⏳ Pending
🚧 **Phase 6: Runtime** - ⏳ Pending
🚧 **Phase 7: Example App** - ⏳ Pending

## License

MIT
