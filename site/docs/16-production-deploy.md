# Production Deploy

VeloJS apps compile to a simple structure: a `dist/` folder with a server entry and static assets. This makes deployment straightforward on any Node.js hosting.

## Build your app

```bash
npx velojs build
```

This runs two Vite builds:
1. **Client build** → `dist/client/` (JavaScript, CSS, and other static assets)
2. **Server build** → `dist/server.js` (the SSR server entry point)

## Start in production

```bash
npx velojs start
```

This automatically sets `NODE_ENV=production` and starts the server. In production mode, VeloJS serves static files from `dist/client/` and handles SSR for all page routes.

## Dockerfile

Here's a production-ready Dockerfile with multi-stage build:

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY app ./app
COPY tsconfig.json vite.config.ts ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

ENV PORT=3000
EXPOSE 3000
CMD ["npx", "velojs", "start"]
```

The multi-stage build keeps the final image small — it only includes production dependencies and the compiled output, not your source code or dev dependencies.

## Setting the port

The server reads the port from, in order of precedence:

1. The `PORT` environment variable — the convention most hosts (Railway, Render, Fly, Heroku) inject automatically.
2. The `port` field in `defineConfig` (`vite.config.ts`) — applies to both `velojs dev` and `velojs start`.
3. The default, `3000`.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { veloPlugin } from "@mauroandre/velojs/vite";

export default defineConfig({
    plugins: [veloPlugin({ port: 4000 })],
});
```

In dev, `velojs dev --port 5000` still overrides everything (it's passed straight to Vite).

## Static assets on CDN

If you want to serve static assets (JS, CSS, images) from a CDN or S3 bucket instead of the Node.js server, set the `STATIC_BASE_URL` environment variable:

```bash
STATIC_BASE_URL=https://cdn.example.com/assets npx velojs start
```

The `<Scripts />` component and CSS `url()` references will automatically use this prefix. The server will skip serving static files when `STATIC_BASE_URL` points to an external URL.

## Included dependencies

VeloJS is an opinionated framework — a single `npm install @mauroandre/velojs` brings everything you need:

- **Hono** — HTTP server and routing
- **Preact** — UI rendering (SSR + client hydration)
- **@preact/signals** — Reactive state management
- **wouter-preact** — Client-side routing
- **Vite** — Build tool and dev server
- **@preact/preset-vite** — Preact JSX support
- **@hono/vite-dev-server** — SSR dev server

You don't need to install or configure any of these separately. VeloJS controls the versions to ensure everything works together.
