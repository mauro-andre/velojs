# VeloJS

> Full-stack TypeScript framework with Server Actions, SSR and Signals

The productivity of **React Router v7** with the flexibility of **Hono** and the lightness of **Preact**.

## Features

- ✅ **Zero Config** - Convention over configuration
- ✅ **File-based Routing** - Nested layouts and automatic route generation
- ✅ **Server Actions** - Type-safe mutations with `action_*` convention
- ✅ **Data Loaders** - Server-side data fetching with automatic caching
- ✅ **SSR + Hydration** - Automatic server-side rendering
- ✅ **Reactive Signals** - Preact Signals for global state
- ✅ **Code Splitting** - Automatic separation of server/client code
- ✅ **Type-safe** - Full TypeScript with automatic type inference
- ✅ **Hono Middlewares** - Use any Hono middleware

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Hono 4.x |
| Frontend | Preact 10.x |
| State | @preact/signals |
| Routing (Client) | wouter-preact |
| SSR | preact-render-to-string |
| Build | Vite 7.x |
| Language | TypeScript |

## Quick Start

### Installation

```bash
npm create velo@latest my-app
cd my-app
npm install
npm run dev
```

Or manually:

```bash
npm install velojs hono preact @preact/signals wouter-preact
npm install -D vite typescript
```

### Project Structure

```
my-app/
├── vite.config.ts          # Vite configuration
├── package.json
└── app/                    # Your application code
    ├── routes.ts           # Route configuration
    ├── entry.server.ts     # (Optional) Server customization
    ├── layout.tsx          # Root layout
    └── home/
        └── page.tsx        # Home page
```

**That's it!** VeloJS automatically generates entry points (`index.html`, `client.tsx`, `server.ts`) in `.velojs/`.

### Configuration

**vite.config.ts:**

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import velojs from "velojs/vite-plugin";

export default defineConfig({
  plugins: [velojs()],
});
```

**package.json:**

```json
{
  "type": "module",
  "scripts": {
    "dev": "velo dev",
    "build": "vite build",
    "serve": "node .velojs/server.js"
  }
}
```

> **Note:** After npm publish, the `velo` CLI will be available globally. During development with local packages, use `"dev": "node ./node_modules/velojs/dist/cli.js dev"` instead.

## Core Concepts

### 1. Routes Configuration

Routes are defined in `app/routes.ts`:

```typescript
// app/routes.ts
import { route, layout } from "velojs";

export default [
  layout("./layout.tsx", {
    routes: [
      route("/", "./home/page.tsx"),

      layout("./admin/layout.tsx", {
        prefix: "/admin",
        routes: [
          route("/users", "./admin/users/page.tsx"),
          route("/settings", "./admin/settings/page.tsx"),
        ],
      }),
    ],
  }),
];
```

**Result:**
- `/` → Renders `layout.tsx` > `home/page.tsx`
- `/admin/users` → Renders `layout.tsx` > `admin/layout.tsx` > `admin/users/page.tsx`
- `/admin/settings` → Renders `layout.tsx` > `admin/layout.tsx` > `admin/settings/page.tsx`

### 2. Layouts (Nested)

Layouts wrap their child routes and can be nested infinitely:

```typescript
// app/layout.tsx
export default function RootLayout({ children }: { children: any }) {
  return (
    <html>
      <head>
        <title>My App</title>
      </head>
      <body>
        <header>
          <nav>...</nav>
        </header>
        <main>{children}</main>
        <footer>...</footer>
      </body>
    </html>
  );
}
```

```typescript
// app/admin/layout.tsx
export default function AdminLayout({ children }: { children: any }) {
  return (
    <div class="admin-wrapper">
      <aside>Admin Sidebar</aside>
      <div class="content">{children}</div>
    </div>
  );
}
```

**Key points:**
- Layouts are **always nested** (no special "root" concept)
- `prefix` is **optional** (defaults to empty string)
- Use `{children}` to render nested content

### 3. Data Loading (Loaders)

Loaders fetch data on the server before rendering:

```typescript
// app/home/page.tsx
export async function loader() {
  // This runs ONLY on the server
  const users = await db.users.findMany();

  return {
    users,
    timestamp: new Date().toISOString(),
  };
}

export default function HomePage() {
  const { value: data, loading, error } = useLoaderData<typeof loader>();

  if (loading.value) return <p>Loading...</p>;
  if (error.value) return <p>Error: {error.value.message}</p>;

  return (
    <div>
      <h1>Users</h1>
      <ul>
        {data.value?.users.map(user => (
          <li key={user.id}>{user.name}</li>
        ))}
      </ul>
    </div>
  );
}
```

**How it works:**
1. **SSR**: Loader runs on server, data is injected in HTML
2. **Client navigation**: Data fetched via `?_data=1` API
3. **Cache**: Automatically cached per route

### 4. Server Actions (Mutations)

Server Actions are functions prefixed with `action_`:

```typescript
// app/admin/users/page.tsx
import { useAction, revalidate } from "velojs/hooks";

export async function action_createUser(name: string, email: string) {
  // This runs ONLY on the server
  const user = await db.users.create({ name, email });
  return { success: true, user };
}

export async function action_deleteUser(id: number) {
  await db.users.delete({ where: { id } });
  return { success: true };
}

export default function UsersPage() {
  const [createUser, creating] = useAction(action_createUser);
  const [deleteUser, deleting] = useAction(action_deleteUser);

  const handleCreate = async () => {
    await createUser("John Doe", "john@example.com");
    revalidate(); // Reload loader data
  };

  return (
    <button onClick={handleCreate} disabled={creating.value}>
      {creating.value ? "Creating..." : "Create User"}
    </button>
  );
}
```

**Generated API routes:**
- `POST /api/admin/users/action_createUser`
- `POST /api/admin/users/action_deleteUser`

**Type-safety:**
- Arguments and return types are automatically inferred
- Full autocomplete in your IDE

### 5. Signals for State

Use Preact Signals for reactive global state:

```typescript
import { signal } from "@preact/signals";

const count = signal(0);

export default function Counter() {
  return (
    <div>
      <p>Count: {count.value}</p>
      <button onClick={() => count.value++}>Increment</button>
    </div>
  );
}
```

## Hooks

### `useLoaderData<T>()`

Access loader data with loading/error states:

```typescript
const { value, loading, error } = useLoaderData<typeof loader>();
```

**Properties:**
- `value` - Signal with the loader data
- `loading` - Signal indicating loading state
- `error` - Signal with error (if any)

### `useAction<T>(action)`

Execute server actions:

```typescript
const [execute, { value: loading, error }] = useAction(action_createUser);

// Call the action
await execute("John", "john@example.com");
```

**Returns:**
- `execute(...args)` - Function to call the action
- `loading` - Loading state signal
- `error` - Error signal (if any)

### `revalidate()`

Revalidate loader data for current route:

```typescript
import { revalidate } from "velojs/hooks";

const handleSubmit = async () => {
  await createUser(...);
  revalidate(); // Reload all loaders for current route
};
```

## Server Customization

Create `app/entry.server.ts` to customize the server:

```typescript
// app/entry.server.ts
import type { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";

/**
 * Configure server before it starts
 */
export function configureServer(app: Hono) {
  // Add global middlewares
  app.use("*", logger());
  app.use("*", cors());

  // Add custom routes
  app.get("/health", (c) => c.json({ status: "ok" }));
}

/**
 * Hook called when server starts
 */
export function onServerStart(app: Hono) {
  console.log("🚀 Server ready!");
  console.log(`📍 Routes: ${app.routes.length}`);

  // Initialize database, etc.
}
```

**Available Hooks:**
- `configureServer(app: Hono)` - Configure middlewares, add routes
- `onServerStart(app: Hono)` - Called when server starts

**Both hooks are OPTIONAL!**

## Advanced

### Route Middlewares

Add Hono middlewares to specific routes:

```typescript
// app/routes.ts
import { route, layout } from "velojs";
import { bearerAuth } from "hono/bearer-auth";

const authMiddleware = bearerAuth({ token: "secret" });

export default [
  layout("./admin/layout.tsx", {
    prefix: "/admin",
    middleware: [authMiddleware], // Applied to all admin routes
    routes: [
      route("/users", "./admin/users/page.tsx"),
    ],
  }),
];
```

### Dynamic Imports in Loaders

Use dynamic imports to avoid bundling server-only code:

```typescript
export async function loader() {
  // This import is NOT bundled in the client
  const { db } = await import("~/lib/database");
  return { users: await db.users.findMany() };
}
```

### Access Request Context in Actions

```typescript
import { getContext } from "velojs/runtime";

export async function action_updateUser(id: number, name: string) {
  const { context, request, headers } = getContext();

  // Access cookies, headers, etc.
  const userId = context.get("userId");

  return { success: true };
}
```

## Build & Deploy

### Development

```bash
npm run dev  # runs: velo dev
```

This starts the development server with HMR (Hot Module Replacement):
- Client HMR: Automatic reload for component changes
- Server HMR: Reloads server code on changes
- Routes HMR: Re-scans routes when `routes.ts` changes

Server will be available at `http://localhost:3000`.

### Production Build

```bash
npm run build
```

Generates:
- `.velojs/` - Generated server and client code
- `dist/` - Client bundle (static assets)

### Run Production Server

```bash
node .velojs/server.js
```

Or use a process manager:

```bash
pm2 start .velojs/server.js --name my-app
```

## Configuration Options

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import velojs from "velojs/vite-plugin";

export default defineConfig({
  plugins: [
    velojs({
      workDir: "./app",      // Where your app code lives (default: "./app")
      outDir: "./.velojs",   // Where generated files go (default: "./.velojs")
    })
  ],
});
```

## Examples

Check the `examples/` directory:

- `examples/basic/` - Basic CRUD with loaders and actions
- `examples/auth/` - Authentication with sessions (coming soon)
- `examples/realtime/` - WebSockets and SSE (coming soon)

## Comparison

| Feature | VeloJS | Next.js | Remix | SolidStart |
|---------|--------|---------|-------|------------|
| File-based routing | ✅ | ✅ | ✅ | ✅ |
| Server Actions | ✅ | ✅ | ✅ | ✅ |
| SSR | ✅ | ✅ | ✅ | ✅ |
| Bundle size (runtime) | ~13KB | ~90KB | ~70KB | ~20KB |
| Backend flexibility | ✅ Hono | ❌ Node.js only | ✅ Any | ✅ Any |
| Signals | ✅ Built-in | ❌ | ❌ | ✅ Built-in |
| Zero config | ✅ | ✅ | ✅ | ✅ |

## Roadmap

- [x] Core framework (Routes, Loaders, Actions)
- [x] SSR with hydration
- [x] Automatic code splitting
- [x] Server Actions API
- [x] Auto-generated entry points
- [ ] Development mode with HMR
- [ ] File-based routing with `[id]` params
- [ ] Streaming SSR
- [ ] Error boundaries
- [ ] Metadata & SEO helpers
- [ ] CLI (`create-velo`)
- [ ] Deployment adapters (Cloudflare, Vercel, etc.)

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md).

## License

MIT © VeloJS Team

## Credits

Inspired by:
- [React Router v7](https://reactrouter.com/) - Routing patterns
- [Hono](https://hono.dev/) - Backend flexibility
- [Preact](https://preactjs.com/) - Lightweight React alternative
- [Remix](https://remix.run/) - Server Actions concept
- [SolidStart](https://start.solidjs.com/) - Signals integration
