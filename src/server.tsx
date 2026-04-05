import { Hono, type Context, type MiddlewareHandler } from "hono";
import { logger } from "hono/logger";
import { trimTrailingSlash } from "hono/trailing-slash";
import { render as preactRender } from "preact-render-to-string";
import { Router } from "wouter-preact";
import type { ComponentType, VNode } from "preact";
import type { RouteNode, RouteModule, LoaderArgs, AppRoutes } from "./types.js";
import { AsyncLocalStorage } from "node:async_hooks";

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
const serverCallbacks: ServerCallback[] = [];
let activeServer: import("http").Server | null = null;

export function onServer(fn: ServerCallback): void {
    if (activeServer) { fn(activeServer); return; }
    serverCallbacks.push(fn);
}

function flushServerCallbacks(server: import("http").Server): void {
    activeServer = server;
    for (const fn of serverCallbacks) fn(server);
    serverCallbacks.length = 0;
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

const pendingRoutes: Array<(app: Hono) => void | Promise<void>> = [];

export function addRoutes(fn: (app: Hono) => void | Promise<void>): void {
    pendingRoutes.push(fn);
}

// ============================================
// RENDER PAGE - SSR ou JSON para navegação SPA
// ============================================

const renderPage = (c: Context, Component: VNode, data?: unknown) => {
    // Navegação SPA - retorna apenas JSON
    if (c.req.query("_data") === "1") {
        return c.json(data ?? null);
    }

    // SSR - renderiza HTML completo dentro do contexto isolado
    const path = c.req.path;
    const html = serverDataStorage.run(
        (data as Record<string, unknown>) ?? {},
        () => {
            return preactRender(<Router ssrPath={path}>{Component}</Router>);
        }
    );

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
        const currentModules = [...parentModules, node.module];
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
        const moduleId = node.module.metadata?.moduleId;
        // Acumula middlewares: pai → filho
        const currentMiddlewares = [
            ...parentMiddlewares,
            ...(node.middlewares || []),
        ];

        if (moduleId) {
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
// CREATE APP - Cria app Hono com rotas
// ============================================

export const createApp = async (routes: AppRoutes): Promise<Hono> => {
    const app = new Hono();

    app.use(trimTrailingSlash());

    if (process.env.NODE_ENV !== "production") {
        app.use("*", logger());
    }

    // Custom routes (registradas via addRoutes no server.tsx do app)
    for (const fn of pendingRoutes) {
        await fn(app);
    }

    // Page routes (dinâmico)
    registerRoutes(app, routes);

    // Action routes (dinâmico)
    registerActionRoutes(app, routes);

    // Dev mode: flush server callbacks using Vite's HTTP server
    if (process.env.NODE_ENV !== "production" && !activeServer) {
        const devServer = (globalThis as any).__veloDevServer;
        if (devServer) flushServerCallbacks(devServer);
    }

    return app;
};

// ============================================
// START SERVER - Entry point principal
// ============================================

export const startServer = async (options: StartServerOptions) => {
    const { routes, port = Number(process.env.SERVER_PORT) || 3000 } = options;
    const app = await createApp(routes);

    // Production: serve static files and start server
    if (process.env.NODE_ENV === "production") {
        const { serve } = await import("@hono/node-server");
        const { serveStatic } = await import("@hono/node-server/serve-static");
        const { dirname, join } = await import("node:path");
        const { fileURLToPath } = await import("node:url");

        const __dirname = dirname(fileURLToPath(import.meta.url));
        const clientDir = join(__dirname, "client");

        // Serve static files from dist/client/ if STATIC_BASE_URL is not external
        const staticUrl = process.env.STATIC_BASE_URL || "";
        if (!staticUrl.startsWith("http")) {
            app.use("/*", serveStatic({ root: clientDir }));
        }

        console.log(`Server running on http://localhost:${port}`);
        const server = serve({ fetch: app.fetch, port });
        flushServerCallbacks(server as unknown as import("http").Server);
    }

    return app;
};

// Export createApp for Vite dev server
export default createApp;
