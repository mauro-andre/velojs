---
description: "Scaffold a new VeloJS project and its file layout: `velojs init`, `vite.config.ts`, `app/routes.tsx`, the root HTML shell, dev server. Use when starting a project from scratch or wiring up the toolchain."
---

# Getting Started

VeloJS is a fullstack web framework that combines Hono (server), Preact (UI), and Vite (build) into a single, cohesive experience. You write your pages, loaders, and server actions in one place — VeloJS handles the rest.

## Create a new project

The fastest way to start is with the CLI:

```bash
npx @mauroandre/velojs init my-app
cd my-app
npm install
npx velojs dev
```

This creates a ready-to-run project. Open `http://localhost:3000` and you should see your app.

## Project structure

Every VeloJS project follows this layout:

```
my-app/
├── app/
│   ├── routes.tsx        # Where you define all your routes
│   ├── server.tsx        # Server-only init (databases, APIs, etc)
│   ├── client.tsx        # Client-only init (global CSS, etc)
│   ├── client-root.tsx   # The HTML shell (<html>, <head>, <body>)
│   └── pages/            # Your pages, layouts, and modules
├── vite.config.ts        # Vite configuration (just one plugin)
├── tsconfig.json
└── package.json
```

Let's walk through each file.

## vite.config.ts

VeloJS works through a single Vite plugin that handles everything — SSR, route scanning, code transforms, and the dev server:

```typescript
import { defineConfig } from "vite";
import { veloPlugin } from "@mauroandre/velojs/vite";

export default defineConfig({
    plugins: [veloPlugin()],
});
```

That's it. No extra plugins needed.

## package.json scripts

Your project needs three scripts:

```json
{
    "scripts": {
        "dev": "velojs dev",
        "build": "velojs build",
        "start": "velojs start"
    }
}
```

- `dev` — starts the development server with hot reload
- `build` — compiles the client bundle and server entry for production
- `start` — runs the production server (automatically sets `NODE_ENV=production`)

## app/client-root.tsx — The HTML shell

This is the outermost component of your app. It renders the `<html>`, `<head>`, and `<body>` tags. Every page in your app will be rendered inside this shell.

The `<Scripts />` component is required — it injects the CSS and JavaScript that your app needs (Vite HMR in dev, compiled assets in production).

```tsx
import type { ComponentChildren } from "preact";
import { Scripts } from "@mauroandre/velojs";

export const Component = ({ children }: { children?: ComponentChildren }) => (
    <html lang="en">
        <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>My App</title>
            <Scripts />
        </head>
        <body>{children}</body>
    </html>
);
```

## app/client.tsx — Client entry

This file runs only on the client (browser). Use it to import global CSS or initialize client-side libraries:

```typescript
import "./styles/global.css";
```

## app/server.tsx — Server entry

This file runs only on the server. Use it to connect to databases, register custom API routes, or start background jobs:

```typescript
import { addRoutes } from "@mauroandre/velojs/server";
import type { Hono } from "hono";

// Register custom API routes
addRoutes((app: Hono) => {
    app.get("/api/health", (c) => c.json({ ok: true }));
});
```

## app/routes.tsx — Route definitions

Routes are defined as a tree. Each node has a `module` (the page or layout component) and optionally `path`, `children`, and `middlewares`:

```typescript
import type { AppRoutes } from "@mauroandre/velojs";
import * as Root from "./client-root.js";
import * as Home from "./pages/Home.js";

export default [
    {
        module: Root,
        isRoot: true,
        children: [
            { path: "/", module: Home },
        ],
    },
] satisfies AppRoutes;
```

Page and layout modules **must** be imported with `import * as Name from "./x.js"`. This isn't style: when the plugin resolves each module's URL it only reads namespace imports, so a default or named import silently drops the route — the server logs `Module … has no fullPath` at startup and the page 404s. Use `./`-relative paths inside `appDirectory` too; a `../` path or a tsconfig alias produces a key the plugin can't match, with the same result.

## Your first page

A page in VeloJS can export three things:

- `Component` — the Preact component that renders the UI
- `loader` — a server-side function that fetches data
- `action_*` — server-side functions callable from the client

Here's a simple page with a loader:

```typescript
import type { LoaderArgs } from "@mauroandre/velojs";
import { useLoader } from "@mauroandre/velojs/hooks";

// This runs on the server. It fetches data for the page.
export const loader = async ({ c }: LoaderArgs) => {
    return { message: "Hello, VeloJS!" };
};

// This runs on both server (SSR) and client (hydration).
export const Component = () => {
    const { data } = useLoader<{ message: string }>();
    return <h1>{data.value?.message}</h1>;
};
```

The loader runs on the server, and the data is automatically available in the component through `useLoader()`. On the first page load (SSR), the data is injected into the HTML. On client-side navigation, it's fetched via an API call — all automatically.

## Run the dev server

```bash
npm run dev
```

Open `http://localhost:3000` in your browser. Changes to your code will hot-reload instantly.

## Configuration

The `veloPlugin()` accepts optional configuration:

```typescript
veloPlugin({
    appDirectory: "./app",      // where your app files live (default: "./app")
    routesFile: "routes.tsx",   // your routes file (default: "routes.tsx")
    serverInit: "server.tsx",   // server init file (default: "server.tsx")
    clientInit: "client.tsx",   // client init file (default: "client.tsx")
});
```

Most projects don't need to change these defaults.
