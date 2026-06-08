import { Hono, type Context, type MiddlewareHandler } from "hono";
import { logger } from "hono/logger";
import { trimTrailingSlash } from "hono/trailing-slash";
import { render as preactRender } from "preact-render-to-string";
import { Router } from "wouter-preact";
import type { ComponentType, VNode } from "preact";
import type { RouteNode, RouteModule, LoaderArgs, AppRoutes, HTTPMethod } from "./types.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { getAppContext } from "./app-context.js";
import { flushPendingStreamRoutes, registerStreamHandler } from "./events.js";
import { registerSocketRoutes, injectWebSocketServer, abortAllSocketSessions } from "./sockets.js";

// ============================================
// ASYNC LOCAL STORAGE - Dados isolados por request
// ============================================

export const serverDataStorage = new AsyncLocalStorage<
    Record<string, unknown>
>();

// Expõe via globalThis para hooks.tsx acessar sem importar node:async_hooks
(globalThis as any).__veloServerData = serverDataStorage;

// ============================================
// ON-SERVER HOOK - Access the underlying HTTP server
// ============================================

type ServerCallback = (server: import("http").Server) => void;
let activeServer: import("http").Server | null = null;

export function onServer(fn: ServerCallback): void {
    if (activeServer) { fn(activeServer); return; }
    getAppContext().serverCallbacks.push(fn);
}

function flushServerCallbacks(server: import("http").Server): void {
    activeServer = server;
    const ctx = getAppContext();
    for (const fn of ctx.serverCallbacks) fn(server);
    ctx.serverCallbacks.length = 0;
}

// ============================================
// SERVER OPTIONS
// ============================================

export interface StartServerOptions {
    routes: AppRoutes;
    port?: number;
}

// ============================================
// ADD ROUTES - Permite registrar rotas custom
// ============================================

export function addRoutes(fn: (app: Hono) => void | Promise<void>): void {
    getAppContext().pendingRoutes.push(fn);
}

// ============================================
// RENDER PAGE - SSR ou JSON para navegação SPA
// ============================================

const renderPage = (c: Context, Component: VNode, data?: unknown) => {
    // Navegação SPA - retorna apenas JSON
    if (c.req.query("_data") === "1") {
        const buildHash = (globalThis as any).__veloBuildHash || undefined;
        const json = data ? { ...(data as Record<string, unknown>), __buildHash: buildHash } : { __buildHash: buildHash };
        return c.json(json);
    }

    // SSR - renderiza HTML completo dentro do contexto isolado
    const path = c.req.path;
    const html = serverDataStorage.run(
        (data as Record<string, unknown>) ?? {},
        () => {
            return preactRender(<Router ssrPath={path}>{Component}</Router>);
        }
    );

    // HTML should not be cached by the browser — assets use content hashes instead
    c.header("Cache-Control", "no-cache");

    // Sem dados - retorna HTML simples
    if (!data) {
        return c.html(html);
    }

    // Com dados - injeta window.__PAGE_DATA__ no <head> (antes dos scripts do app)
    const script = `<script>window.__PAGE_DATA__=${JSON.stringify(
        data
    )}</script>`;
    return c.html(html.replace("</head>", `${script}</head>`));
};

// ============================================
// LOAD PAGE - Executa loaders e coleta componentes
// ============================================

const loadPage = async (modules: RouteModule[], c: Context) => {
    const params = c.req.param();
    const query = c.req.query();
    const loaderArgs: LoaderArgs = { params, query, c };

    // Executa todos os loaders em paralelo
    const results = await Promise.all(
        modules.map(async (module) => {
            if (!module.loader) return null;
            const loaderData = await module.loader(loaderArgs);
            const moduleId = module.metadata?.moduleId;
            return moduleId ? { moduleId, loaderData } : null;
        })
    );

    // Monta objeto com moduleId como chave + params/query/pathname para hooks
    const data: Record<string, unknown> = {
        __params: params,
        __query: query,
        __pathname: c.req.path,
    };
    for (const result of results) {
        if (result) {
            data[result.moduleId] = result.loaderData;
        }
    }

    return {
        components: modules.map((m) => m.Component),
        data,
    };
};

// ============================================
// NEST COMPONENTS - Aninha Layout > Layout > Page
// ============================================

const nestComponents = (components: ComponentType<any>[]): VNode => {
    if (components.length === 0) return null as any;

    const validComponents = components.filter(Boolean);
    if (validComponents.length === 0) return null as any;

    if (validComponents.length === 1) {
        const Page = validComponents[0]!;
        return <Page />;
    }

    const Page = validComponents[validComponents.length - 1]!;
    const layouts = validComponents.slice(0, -1);

    return layouts.reduceRight((child, Layout) => {
        return <Layout>{child}</Layout>;
    }, (<Page />) as VNode);
};

// ============================================
// REGISTER ROUTES - Gera rotas do Hono dinamicamente
// ============================================

const registerRoutes = (
    app: Hono,
    nodes: RouteNode[],
    parentModules: RouteModule[] = [],
    parentMiddlewares: MiddlewareHandler[] = []
) => {
    for (const node of nodes) {
        // Pure endpoint nodes (handler without module) are handled by registerEndpointRoutes
        if (node.handler && !node.module) {
            if (node.children) {
                registerRoutes(
                    app,
                    node.children,
                    parentModules,
                    [...parentMiddlewares, ...(node.middlewares || [])]
                );
            }
            continue;
        }

        const currentModules = node.module
            ? [...parentModules, node.module]
            : parentModules;
        // Acumula middlewares: pai → filho
        const currentMiddlewares = [
            ...parentMiddlewares,
            ...(node.middlewares || []),
        ];

        if (node.children) {
            // Tem filhos - continua recursão com middlewares acumulados
            registerRoutes(
                app,
                node.children,
                currentModules,
                currentMiddlewares
            );
        } else if (!node.module) {
            // Grouping leaf (no module, no children) — nothing to render. Ignore.
            continue;
        } else {
            // Folha - registra rota usando metadata.fullPath
            const fullPath = node.module.metadata?.fullPath;
            if (!fullPath) {
                console.warn(
                    `Module ${node.module.metadata?.moduleId} has no fullPath`
                );
                continue;
            }

            const handler = async (c: Context) => {
                const { components, data } = await loadPage(currentModules, c);
                const nested = nestComponents(components);
                return renderPage(c, nested, data);
            };

            if (currentMiddlewares.length > 0) {
                app.on(["GET"], [fullPath], ...currentMiddlewares, handler);
            } else {
                app.on(["GET"], [fullPath], handler);
            }
        }
    }
};

// ============================================
// REGISTER ACTION ROUTES - Registra POST para actions
// ============================================

const registerActionRoutes = (
    app: Hono,
    nodes: RouteNode[],
    parentMiddlewares: MiddlewareHandler[] = []
) => {
    for (const node of nodes) {
        const moduleId = node.module?.metadata?.moduleId;
        // Acumula middlewares: pai → filho
        const currentMiddlewares = [
            ...parentMiddlewares,
            ...(node.middlewares || []),
        ];

        if (node.module && moduleId) {
            // Encontra todas as actions do módulo
            const actionKeys = Object.keys(node.module).filter((k) =>
                k.startsWith("action_")
            );

            for (const actionKey of actionKeys) {
                const actionName = actionKey.replace("action_", "");
                const action = (
                    node.module as unknown as Record<string, unknown>
                )[actionKey] as
                    | ((body: unknown) => Promise<unknown>)
                    | undefined;

                if (typeof action === "function") {
                    const actionPath = `/_action/${moduleId}/${actionName}`;
                    const handler = async (c: Context) => {
                        let body = {};
                        try {
                            body = await c.req.json();
                        } catch {
                            // No body - ok for actions without params
                        }
                        // Passa ActionArgs para a action
                        const actionArgs = {
                            body,
                            params: c.req.param(),
                            query: c.req.query(),
                            c,
                        };
                        try {
                            const result = await action(actionArgs);
                            return c.json(result ?? { ok: true });
                        } catch (error) {
                            const message =
                                error instanceof Error
                                    ? error.message
                                    : "Action failed";
                            return c.json({ error: message }, 500);
                        }
                    };

                    if (currentMiddlewares.length > 0) {
                        app.on(
                            ["POST"],
                            [actionPath],
                            ...currentMiddlewares,
                            handler
                        );
                    } else {
                        app.on(["POST"], [actionPath], handler);
                    }
                }
            }
        }

        // Recursivamente registra actions dos filhos com middlewares acumulados
        if (node.children) {
            registerActionRoutes(app, node.children, currentMiddlewares);
        }
    }
};

// ============================================
// REGISTER STREAM ROUTES - SSE streams (stream_*) por módulo
// ============================================

const registerStreamRoutes = async (
    app: Hono,
    nodes: RouteNode[],
    parentMiddlewares: MiddlewareHandler[] = []
) => {
    const visit = (subNodes: RouteNode[], inheritedMiddlewares: MiddlewareHandler[]) => {
        for (const node of subNodes) {
            const moduleId = node.module?.metadata?.moduleId;
            const currentMiddlewares = [
                ...inheritedMiddlewares,
                ...(node.middlewares || []),
            ];

            if (node.module && moduleId) {
                // Encontra todas as exportações stream_* no módulo
                const streamKeys = Object.keys(node.module).filter((k) =>
                    k.startsWith("stream_")
                );

                for (const streamKey of streamKeys) {
                    const streamName = streamKey.replace("stream_", "");
                    const stream = (node.module as unknown as Record<string, unknown>)[
                        streamKey
                    ] as { __isVeloEventStream?: boolean; __path?: string } | undefined;

                    if (stream?.__isVeloEventStream) {
                        const streamPath = `/_event/${moduleId}/${streamName}`;
                        // Atribui o path ao stream para que o servidor saiba onde está montado.
                        // Não é estritamente necessário do lado do servidor, mas é útil para
                        // simetria com o que o client espera.
                        stream.__path = streamPath;
                        registerStreamHandler(
                            app,
                            streamPath,
                            stream as any,
                            currentMiddlewares as any
                        );
                    }
                }
            }

            if (node.children) {
                visit(node.children, currentMiddlewares);
            }
        }
    };

    visit(nodes, parentMiddlewares);
};

// ============================================
// REGISTER ENDPOINT ROUTES - Declarative HTTP endpoints (EndpointRoute)
// ============================================

const joinPath = (parent: string, segment: string | undefined): string => {
    if (!segment) return parent || "";
    // Mirror collectFullPaths: paths concatenate with parent. Leading slash on
    // segment means "nested under parent" (velojs convention), not absolute.
    return segment.startsWith("/")
        ? parent + segment
        : parent
            ? parent + "/" + segment
            : "/" + segment;
};

const collectPageGetPaths = (nodes: RouteNode[]): Set<string> => {
    const paths = new Set<string>();
    const walk = (subNodes: RouteNode[]) => {
        for (const node of subNodes) {
            if (node.module && !node.children) {
                const fullPath = node.module.metadata?.fullPath;
                if (fullPath) paths.add(fullPath);
            }
            if (node.children) walk(node.children);
        }
    };
    walk(nodes);
    return paths;
};

const registerEndpointRoutes = (
    app: Hono,
    nodes: RouteNode[],
    pageGetPaths: Set<string>,
    parentPath: string = "",
    parentMiddlewares: MiddlewareHandler[] = []
) => {
    for (const node of nodes) {
        const fullPath = joinPath(parentPath, node.path);
        const currentMiddlewares = [
            ...parentMiddlewares,
            ...(node.middlewares || []),
        ];

        // Validation — loud warns, no throws
        const hasHandler = !!node.handler;
        const hasMethod = !!node.method;

        if (hasHandler && !hasMethod) {
            console.warn(
                `[velojs] invalid route at "${fullPath || "/"}" — "handler" set without "method"; endpoint skipped`
            );
        } else if (hasMethod && !hasHandler) {
            console.warn(
                `[velojs] invalid route at "${fullPath || "/"}" — "method" set without "handler"; endpoint skipped`
            );
        } else if (hasHandler && node.module) {
            console.warn(
                `[velojs] ambiguous route at "${fullPath || "/"}" — both "module" and "handler" set; endpoint ignored, page kept`
            );
        } else if (hasHandler && node.isRoot) {
            console.warn(
                `[velojs] "isRoot" has no effect on endpoint at "${fullPath || "/"}"; ignored`
            );
        }

        const canRegister = hasHandler && hasMethod && !node.module;
        if (canRegister) {
            const method = node.method as HTTPMethod;
            if (method === "GET" && pageGetPaths.has(fullPath)) {
                console.warn(
                    `[velojs] path "${fullPath}" has both a page GET and an endpoint GET; endpoint will win. Consider renaming one.`
                );
            }

            const handlerFn = node.handler!;
            const wrapped = async (c: Context) => {
                return await handlerFn({
                    c,
                    params: c.req.param(),
                    query: c.req.query(),
                });
            };

            if (currentMiddlewares.length > 0) {
                app.on([method], [fullPath], ...currentMiddlewares, wrapped);
            } else {
                app.on([method], [fullPath], wrapped);
            }
        }

        if (node.children) {
            registerEndpointRoutes(
                app,
                node.children,
                pageGetPaths,
                fullPath,
                currentMiddlewares
            );
        }
    }
};

// ============================================
// CREATE APP - Cria app Hono com rotas
// ============================================

export const createApp = async (routes: AppRoutes): Promise<Hono> => {
    const app = new Hono();

    app.use(trimTrailingSlash());

    if (process.env.NODE_ENV !== "production") {
        app.use("*", logger());
    }

    // Custom routes (registradas via addRoutes no server.tsx do app)
    const ctx = getAppContext();
    const pending = ctx.pendingRoutes.splice(0);
    for (const fn of pending) {
        await fn(app);
    }

    // Page routes (dinâmico)
    registerRoutes(app, routes);

    // Action routes (dinâmico)
    registerActionRoutes(app, routes);

    // Stream routes (SSE) — convenção stream_* por módulo
    await registerStreamRoutes(app, routes);

    // Endpoint routes (declarative HTTP endpoints mixed into the route tree)
    const pageGetPaths = collectPageGetPaths(routes);
    registerEndpointRoutes(app, routes, pageGetPaths);

    // Socket routes (WebSocket) — convenção socket_* por módulo
    await registerSocketRoutes(app, routes);

    // Standalone streams registrados via createEventStream({ path: ... })
    flushPendingStreamRoutes(app);

    // Dev mode: flush server callbacks using Vite's HTTP server AND
    // inject the WebSocket adapter into the same server.
    if (process.env.NODE_ENV !== "production" && !activeServer) {
        const devServer = (globalThis as any).__veloDevServer;
        if (devServer) {
            flushServerCallbacks(devServer);
            await injectWebSocketServer(app, devServer);
        }
    }

    return app;
};

// ============================================
// START SERVER - Entry point principal
// ============================================

export const startServer = async (options: StartServerOptions) => {
    const { routes } = options;
    // Precedence: PORT env (injected by most hosts) > defineConfig port > 3000.
    const port = Number(process.env.PORT) || options.port || 3000;
    const app = await createApp(routes);

    // Production: serve static files and start server
    if (process.env.NODE_ENV === "production" && !process.env.VELO_STATIC) {
        const { serve } = await import("@hono/node-server");
        const { serveStatic } = await import("@hono/node-server/serve-static");
        const { join } = await import("node:path");

        const clientDir = join(process.cwd(), "dist/client");

        // Serve static files from dist/client/ if STATIC_BASE_URL is not external
        const staticUrl = process.env.STATIC_BASE_URL || "";
        if (!staticUrl.startsWith("http")) {
            app.use("/*", serveStatic({ root: clientDir }));
        }

        console.log(`Server running on http://localhost:${port}`);
        const server = serve({ fetch: app.fetch, port });
        // Inject the WebSocket adapter so upgrade requests are routed.
        await injectWebSocketServer(app, server);
        flushServerCallbacks(server as unknown as import("http").Server);
    }

    return app;
};

// Export createApp for Vite dev server
export default createApp;
