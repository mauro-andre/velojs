# Endpoints

Endpoints are **declarative HTTP routes** you add to `routes.tsx` alongside your pages. Use them for things a page wouldn't make sense for: webhooks, verification links clicked from email, redirects, health checks, OAuth callbacks.

They are registered on the server only — never on the client (wouter). The Vite plugin strips them from the client bundle so server-only handler imports never ship to the browser.

## When to use an endpoint (and when not to)

- **Use an endpoint** for: webhooks (GitHub, Stripe, banks), email verification links, OAuth redirect callbacks, health checks, short redirects, and any URL not meant to be rendered by a page.
- **Use a page** (`module: SomePage`) when the URL is visited by a human and the server returns HTML.
- **Use an action** (`action_*` inside a page module) when logic belongs to a page — form submits, mutations triggered by UI.

Rule of thumb: if the URL is part of the UI flow, it's a page or action. If it's an HTTP endpoint hit by something that isn't your frontend, it's an endpoint.

## Declaring an endpoint

Endpoints live in `routes.tsx` as objects with `path`, `method`, and `handler`:

```tsx
import type { AppRoutes } from "@mauroandre/velojs";
import * as Home from "./pages/Home.js";
import { githubWebhook } from "./webhooks/github.handler.js";

export default [
    { path: "/", module: Home },
    { path: "/api/github/webhook", method: "POST", handler: githubWebhook },
] satisfies AppRoutes;
```

That's it. The endpoint is now registered on the server.

## The handler signature

```ts
import type { EndpointHandler } from "@mauroandre/velojs";

export const githubWebhook: EndpointHandler = async ({ c, params, query }) => {
    const body = await c.req.json();
    // ...your logic...
    return c.json({ ok: true });
};
```

`EndpointHandlerArgs`:

- `c` — the Hono `Context`. Use `c.req.json()` / `c.req.formData()` / `c.req.text()` / `c.req.header(...)` to read the request. Use `c.json(...)`, `c.text(...)`, `c.redirect(...)`, `c.html(...)` to respond.
- `params` — URL params (`/api/verify/:token` → `params.token`).
- `query` — query-string values.

Handlers must return a `Response` (or a `Promise<Response>`). Hono helpers like `c.json`, `c.redirect`, `c.text` return `Response` directly. Unlike `action_*`, endpoints do **not** auto-serialize return values — HTTP endpoints need full control over status, headers, and body format (a GitHub webhook, for example, needs the raw body to verify the HMAC signature).

## Supported HTTP methods

`GET`, `POST`, `PUT`, `PATCH`, `DELETE`. One method per entry. If you need both GET and POST on the same path, declare two entries.

## Inline vs module-only handlers

Both forms work. The Vite plugin strips either one from the client bundle.

```tsx
// OK inline — handler is trivial and doesn't import anything server-only
{ path: "/health", method: "GET", handler: ({ c }) => c.text("ok") },

// PREFER module — handler imports server-only libraries
import { githubWebhook } from "./webhooks/github.handler.js";
{ path: "/api/github/webhook", method: "POST", handler: githubWebhook },
```

**Recommendation:** when the handler imports anything server-only (`node:crypto`, DB client, SDK that doesn't bundle for the browser), put it in a separate module file. The plugin strips references on the client, so the handler module is tree-shaken away — but putting it in its own file makes the intent obvious to other readers and avoids edge cases where the client bundle tries to resolve server-only imports.

## Grouping and middleware inheritance

Endpoints inherit middlewares from parent nodes, just like pages:

```tsx
import { rateLimitMiddleware } from "./middlewares/rate-limit.js";
import { verifyGithubSignature } from "./middlewares/github-sig.js";
import { githubWebhook } from "./webhooks/github.handler.js";
import { pixWebhook } from "./webhooks/pix.handler.js";

export default [
    {
        path: "/api",
        middlewares: [rateLimitMiddleware],
        children: [
            {
                path: "/github/webhook",
                method: "POST",
                middlewares: [verifyGithubSignature],
                handler: githubWebhook,
            },
            {
                path: "/pix",
                method: "POST",
                handler: pixWebhook,
            },
        ],
    },
];
```

- `/api/github/webhook` runs `[rateLimitMiddleware, verifyGithubSignature]` before the handler.
- `/api/pix` runs `[rateLimitMiddleware]`.

A node can be a **pure group** — only `path`, `children`, and `middlewares`, no `module` and no `handler`. The children inherit the path prefix and middlewares.

## Redirects from email links

A common use case:

```tsx
import { verifyEmail } from "./auth/verify.handler.js";

// routes.tsx
{ path: "/verify/:token", method: "GET", handler: verifyEmail }
```

```ts
// auth/verify.handler.ts
import type { EndpointHandler } from "@mauroandre/velojs";
import { consumeVerifyToken } from "../services/auth.js";

export const verifyEmail: EndpointHandler = async ({ c, params }) => {
    const ok = await consumeVerifyToken(params.token);
    if (!ok) return c.redirect("/login?verified=0", 302);
    return c.redirect("/stacks?verified=1", 302);
};
```

Because the endpoint lives in `routes.tsx`, it's also visible to the testing toolkit — you can test the whole flow end-to-end (see below).

## Path conflicts with pages

An endpoint and a page on the same path with the **same method** (both `GET`) conflict. VeloJS registers pages first, endpoints second, so the endpoint wins — but you'll see a loud warning at startup telling you to rename one.

Different methods on the same path (page `GET` + endpoint `POST`) don't conflict. They're both registered and each is routed according to the request method.

## Validation warnings

The server logs a warning and skips the entry when you declare an invalid combination:

| Problem | Warning |
|---|---|
| `handler` without `method` | `"handler" set without "method"; endpoint skipped` |
| `method` without `handler` | `"method" set without "handler"; endpoint skipped` |
| Both `module` and `handler` on the same node | `both "module" and "handler" set; endpoint ignored, page kept` |
| `isRoot: true` on an endpoint | `"isRoot" has no effect on endpoint` |

None of these throw — the server still boots. This keeps dev fast; you just see the problem in the console.

## Testing endpoints

Because endpoints live in `routes.tsx`, `createTestApp` picks them up automatically. No bootstrap required for simple webhooks:

```ts
import { createTestApp } from "@mauroandre/velojs/testing";
import { routes } from "../app/routes.js";

const app = await createTestApp({ routes });

const res = await app.post("/api/github/webhook", {
    headers: { "x-hub-signature-256": signature },
    body: { action: "push", ref: "refs/heads/main" },
});
expect(res.status).toBe(200);

const verify = await app.get("/verify/abc123");
expect(verify.status).toBe(302);
expect(verify.headers.location).toBe("/stacks?verified=1");
```

See [16-testing.md](./16-testing.md) for the full testing API.

## Related

- [Routes](./02-routes.md) — page routing and layouts
- [Loaders](./04-loaders.md) — page data fetching
- [Actions](./05-actions.md) — mutations from pages
- [Middlewares](./09-middlewares.md) — authentication, logging, rate limiting
- [Testing](./16-testing.md) — the backend testing toolkit
