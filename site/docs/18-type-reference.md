# Type Reference

This page lists all the TypeScript types and interfaces exported by VeloJS, organized by import path.

## Subpath exports

| Import | What you get |
|--------|-------------|
| `@mauroandre/velojs` | Types (`AppRoutes`, `RouteNode`, `RouteModule`, `ActionArgs`, `LoaderArgs`, `Metadata`, `HTTPMethod`, `EndpointHandler`, `EndpointHandlerArgs`, `VeloConfig`), `Scripts`, `Link`, `defineConfig`, `createEventStream`, `poll` |
| `@mauroandre/velojs/server` | `startServer`, `createApp`, `addRoutes`, `onServer`, `serverDataStorage` |
| `@mauroandre/velojs/client` | `startClient` |
| `@mauroandre/velojs/hooks` | `Loader`, `useLoader`, `useParams`, `useQuery`, `useNavigate`, `usePathname`, `touch`, `useEventStream`, `useSocket` |
| `@mauroandre/velojs/events` | `createEventStream`, `poll` |
| `@mauroandre/velojs/sockets` | `parseJson` |
| `@mauroandre/velojs/testing` | `createTestApp`, `TestApp`, `TestResponse`, `TestSubscription`, `TestSocketSession` |
| `@mauroandre/velojs/cookie` | `getCookie`, `setCookie`, `deleteCookie`, `getSignedCookie`, `setSignedCookie` |
| `@mauroandre/velojs/factory` | `createMiddleware`, `createFactory` |
| `@mauroandre/velojs/vite` | `veloPlugin` |
| `@mauroandre/velojs/config` | `defineConfig`, `VeloConfig` |

## Interfaces

### LoaderArgs

Passed to every `loader` function. Contains the URL parameters, query string, and Hono context:

```typescript
interface LoaderArgs {
    params: Record<string, string>;  // URL params like :id
    query: Record<string, string>;   // Query string like ?page=2
    c: Context;                      // Hono request context
}
```

### ActionArgs

Passed to every `action_*` function. The generic type `TBody` defines the shape of the data sent from the client:

```typescript
interface ActionArgs<TBody = unknown> {
    body: TBody;                          // Data from the client
    params?: Record<string, string>;      // URL params (server only)
    query?: Record<string, string>;       // Query string (server only)
    c?: Context;                          // Hono context (server only)
}
```

### Metadata

Automatically injected into each module by the Vite plugin. Contains the module identifier and resolved paths:

```typescript
interface Metadata {
    moduleId: string;         // e.g., "admin/Users"
    fullPath?: string;        // e.g., "/admin/users"
    path?: string;            // e.g., "/users"
    [key: string]: unknown;   // your own metadata (title, etc)
}
```

### RouteModule

The shape of a route module (what `import * as Module` gives you):

```typescript
interface RouteModule {
    Component: ComponentType<any>;
    loader?: (args: LoaderArgs) => Promise<any>;
    /** Dynamic routes to prerender with `velojs build --static`. */
    staticPaths?: () => Promise<Record<string, string>[]>;
    metadata?: Metadata;
    [key: `action_${string}`]: (args: ActionArgs<any>) => Promise<any>;
}
```

### RouteNode

A single node in the route tree defined in `routes.tsx`:

```typescript
interface RouteNode {
    path?: string;
    /** Optional: endpoint-only and grouping nodes have no module. */
    module?: RouteModule;
    /** Endpoint nodes — see the Endpoints doc. */
    method?: HTTPMethod;
    handler?: EndpointHandler;
    children?: RouteNode[];
    middlewares?: MiddlewareHandler[];
    isRoot?: boolean;
    /** HTTP status for the page (default 200). A bare `path: "*"` catch-all
     *  defaults to 404 and is served via Hono's notFound hook. */
    statusCode?: number;
}
```

### HTTPMethod

```typescript
type HTTPMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
```

### EndpointHandlerArgs / EndpointHandler

Passed to an endpoint node's `handler`. Unlike a loader, it returns a `Response`:

```typescript
interface EndpointHandlerArgs {
    c: Context;
    params: Record<string, string>;
    query: Record<string, string>;
}

type EndpointHandler = (args: EndpointHandlerArgs) => Response | Promise<Response>;
```

### AppRoutes

The type of the default export from `routes.tsx`:

```typescript
type AppRoutes = RouteNode[];
```

### VeloConfig

Configuration options for `veloPlugin()`:

```typescript
interface VeloConfig {
    appDirectory?: string;   // default: "./app"
    routesFile?: string;     // default: "routes.tsx"
    serverInit?: string;     // default: "server.tsx"
    clientInit?: string;     // default: "client.tsx"
    port?: number;           // default: 3000 (the PORT env always wins)
}
```
