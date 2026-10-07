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
import { inspectChannels, registerChannelRoute } from "./channels.js";
import {
    jsonBytes,
    responseBytes,
    trace,
    byteLength,
    type TelemetryTrace,
} from "./telemetry.js";
import { initNodeTelemetry } from "./telemetry-node.js";

// The live loader's server API: `emit` signals a channel's partition changed —
// by name (the runtime re-executes the loader) or by module with a typed slice
// (the value travels as-is) — and both modes throw immediately on a channel with
// no entry in `app/channels.ts` (never a silent no-op). `registerChannels`
// takes the coalescing window, the emit log, the idle timeout and the
// heartbeat. `inspectChannels` reports the live state (groups, connections,
// last deliveries, open windows) — the incident lens, exposed how the app
// judges.
export { emit, inspectChannels, registerChannels } from "./channels.js";
export type {
    ChannelDefinition,
    ChannelMap,
    ChannelScopeContext,
    ChannelGroupOpenContext,
    ChannelGroupCloseContext,
    ChannelScopeResult,
    ChannelRegistryOptions,
    ChannelEmitModule,
    ChannelEmitKind,
    ChannelSlice,
    ChannelInspectGroup,
    ChannelInspectChannel,
    ChannelInspectWindow,
    ChannelInspectReport,
} from "./channels.js";

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

/**
 * Points the global `activeServer` at `server` and drains the callbacks
 * registered in the current context. Exported for the testing toolkit, which
 * serves a TestApp over TCP and must hand the real server to `onServer()`
 * callbacks (same flush as `startServer`).
 */
export function flushServerCallbacks(server: import("http").Server): void {
    activeServer = server;
    const ctx = getAppContext();
    for (const fn of ctx.serverCallbacks) fn(server);
    ctx.serverCallbacks.length = 0;
}

/**
 * Drops the global `activeServer` when it still points at `server`. A closed
 * server must stop answering `onServer()`: a late registrant would receive a
 * dead instance (address() === null) instead of queueing for the next one.
 * `startServer` does the same through `server.once("close", …)`; the testing
 * toolkit has no such event to lean on because it closes the server itself.
 */
export function clearActiveServer(server: import("http").Server): void {
    if (activeServer === server) activeServer = null;
}

// ============================================
// SERVER OPTIONS
// ============================================

export interface StartServerOptions {
    routes: AppRoutes;
    port?: number;
    /**
     * Hostname/interface to bind. Precedence: HOST env > this option > Node
     * default (all interfaces — the ecosystem norm for containers/proxies).
     * Local/sensitive apps should bind "127.0.0.1".
     */
    hostname?: string;
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

/**
 * Serializa dados para injeção num <script> inline. JSON não escapa `<`, então
 * uma string com `</script>` nos dados fecharia a tag no meio — o resto do
 * payload transborda pro documento como HTML e a hidratação quebra (observado
 * em produção com conteúdo de modelo contendo pseudo-tags). `<` é escape
 * JSON/JS válido e decodifica transparente no cliente. Também escapa `>`
 * (defesa para `<!--`) e U+2028/U+2029 (válidos em JSON, quebras de linha em
 * JS antigo).
 */
export const jsonForScript = (value: unknown): string =>
    JSON.stringify(value)
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");

const renderPage = (
    c: Context,
    Component: VNode,
    data: unknown,
    statusCode: number | undefined,
    t: TelemetryTrace
): { response: Response; bytes: number | undefined } => {
    // Status explícito da rota (default 200). Setado via preset do Hono para
    // valer tanto no HTML SSR quanto no JSON do _data=1 abaixo. Um status
    // setado por um loader (c.status) é preservado quando statusCode é undefined.
    if (statusCode && statusCode !== 200) {
        c.status(statusCode as Parameters<typeof c.status>[0]);
    }

    // Navegação SPA - retorna apenas JSON. Não há render: o trace de `data`
    // carrega só os loaders.
    if (c.req.query("_data") === "1") {
        const buildHash = (globalThis as any).__veloBuildHash || undefined;
        const json = data ? { ...(data as Record<string, unknown>), __buildHash: buildHash } : { __buildHash: buildHash };
        // Byte sizes are only computed when a destination is active — the
        // disabled path pays nothing.
        return { response: c.json(json), bytes: t.enabled ? jsonBytes(json) : undefined };
    }

    // SSR - renderiza HTML completo dentro do contexto isolado. O span do
    // render fecha o interior da página ao lado dos spans dos loaders: a
    // diferença para o total é o buraco do middleware (fora desta fatia).
    const renderSpan = t.span("render");
    try {
        const path = c.req.path;
        let html = serverDataStorage.run(
            (data as Record<string, unknown>) ?? {},
            () => {
                return preactRender(<Router ssrPath={path}>{Component}</Router>);
            }
        );

        // HTML should not be cached by the browser — assets use content hashes instead
        c.header("Cache-Control", "no-cache");

        // Com dados - injeta window.__PAGE_DATA__ no <head> (antes dos scripts do app)
        if (data) {
            const script = `<script>window.__PAGE_DATA__=${jsonForScript(data)}</script>`;
            // O substituto PRECISA ser função: com string, o replace interpreta
            // $& $' $` $1 $$ dentro do payload (dados do loader) — $' injetaria o
            // resto do documento no meio do JSON, reabrindo o vetor de quebra.
            html = html.replace("</head>", () => `${script}</head>`);
        }

        renderSpan.end("ok");
        return { response: c.html(html), bytes: t.enabled ? byteLength(html) : undefined };
    } catch (err) {
        renderSpan.end("error");
        throw err;
    }
};

// ============================================
// LOAD PAGE - Executa loaders e coleta componentes
// ============================================

const loadPage = async (modules: RouteModule[], c: Context, t: TelemetryTrace) => {
    const params = c.req.param();
    const query = c.req.query();
    const loaderArgs: LoaderArgs = { params, query, c };

    // Executa todos os loaders em paralelo — cada um é um span filho do trace
    // da página, nomeado pelo módulo que o declarou.
    const results = await Promise.all(
        modules.map(async (module) => {
            if (!module.loader) return null;
            const moduleId = module.metadata?.moduleId;
            const span = t.span(`loader:${moduleId ?? "anonymous"}`);
            try {
                const loaderData = await module.loader(loaderArgs);
                span.end("ok");
                return moduleId ? { moduleId, loaderData } : null;
            } catch (err) {
                span.end("error");
                throw err;
            }
        })
    );

    // Um loader pode devolver um Response para interromper a renderização —
    // redirect (c.redirect) é o caso comum (auth gate no loader). O primeiro
    // Response na ordem dos módulos vence.
    let shortCircuit: Response | undefined;
    for (const result of results) {
        if (result && result.loaderData instanceof Response) {
            shortCircuit = result.loaderData;
            break;
        }
    }

    // Monta objeto com moduleId como chave + params/query/pathname para hooks
    const data: Record<string, unknown> = {
        __params: params,
        __query: query,
        __pathname: c.req.path,
    };
    for (const result of results) {
        if (result && !(result.loaderData instanceof Response)) {
            data[result.moduleId] = result.loaderData;
        }
    }

    return {
        components: modules.map((m) => m.Component),
        data,
        shortCircuit,
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
            // Folha. Bare catch-all → página 404 (default 404); demais rotas
            // usam o status declarado (ou 200 implícito) e registram por fullPath.
            const isCatchAll = node.path === "*";
            const statusCode = node.statusCode ?? (isCatchAll ? 404 : undefined);

            const fullPath = node.module.metadata?.fullPath;
            // O catch-all não usa fullPath (vai via notFound), então só exigimos
            // fullPath para rotas normais.
            if (!fullPath && !isCatchAll) {
                console.warn(
                    `Module ${node.module.metadata?.moduleId} has no fullPath`
                );
                continue;
            }

            const handler = async (c: Context) => {
                // Um request de página nasce um trace (tipo `data` no refetch
                // JSON `?_data=1`, `page` no SSR), endereçado pelo path pattern
                // da rota — nunca pela URL materializada, que inviabilizaria a
                // agregação. O módulo é a folha da hierarquia (a página).
                const isData = c.req.query("_data") === "1";
                const leaf = currentModules[currentModules.length - 1];
                const t = trace(isData ? "data" : "page", {
                    route: fullPath ?? leaf?.metadata?.fullPath,
                    module: leaf?.metadata?.moduleId,
                });
                try {
                    const { components, data, shortCircuit } = await loadPage(currentModules, c, t);
                    if (shortCircuit) {
                        // Navegação SPA: o fetch do cliente seguiria um 302 para o
                        // HTML de destino e quebraria no r.json(). O endpoint de
                        // dados devolve o alvo e deixa o cliente navegar.
                        const location = shortCircuit.headers.get("Location");
                        if (
                            isData &&
                            location &&
                            shortCircuit.status >= 300 &&
                            shortCircuit.status < 400
                        ) {
                            t.end({
                                status: "ok",
                                bytes: t.enabled ? jsonBytes({ __redirect: location }) : undefined,
                            });
                            return c.json({ __redirect: location });
                        }
                        t.end({
                            status: "ok",
                            bytes: t.enabled ? await responseBytes(shortCircuit) : undefined,
                        });
                        return shortCircuit;
                    }
                    const nested = nestComponents(components);
                    const { response, bytes } = renderPage(c, nested, data, statusCode, t);
                    t.end({ status: "ok", bytes });
                    return response;
                } catch (err) {
                    t.end({ status: "error" });
                    throw err;
                }
            };

            if (isCatchAll) {
                // Não registra como GET normal: um "*" na tabela de rotas
                // capturaria qualquer caminho não casado. Com o estático de
                // produção montado antes das rotas, assets já estão a salvo — e
                // o 404 do app segue sendo o último recurso: o notFound do Hono
                // só dispara quando nem rota nem arquivo responderam.
                app.notFound(handler);
            } else if (currentMiddlewares.length > 0) {
                app.on(["GET"], [fullPath!], ...currentMiddlewares, handler);
            } else {
                app.on(["GET"], [fullPath!], handler);
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
                        // A action é identificada por módulo E nome; o status vira
                        // `error` quando ela lança (o 500 é consequência, não causa).
                        const t = trace("action", {
                            route: node.module?.metadata?.fullPath,
                            module: moduleId,
                            name: actionName,
                        });
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
                            const payload = result ?? { ok: true };
                            t.end({ status: "ok", bytes: t.enabled ? jsonBytes(payload) : undefined });
                            return c.json(payload);
                        } catch (error) {
                            const message =
                                error instanceof Error
                                    ? error.message
                                    : "Action failed";
                            t.end({ status: "error" });
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
                            currentMiddlewares as any,
                            { moduleId, name: streamName }
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
// REGISTER CHANNEL ROUTES - Live loader (channels) por módulo
// ============================================

const registerChannelRoutes = (
    app: Hono,
    nodes: RouteNode[],
    parentMiddlewares: MiddlewareHandler[] = []
) => {
    for (const node of nodes) {
        const moduleId = node.module?.metadata?.moduleId;
        // Acumula middlewares: pai → filho (mesma herança das páginas/actions)
        const currentMiddlewares = [
            ...parentMiddlewares,
            ...(node.middlewares || []),
        ];

        if (node.module && moduleId) {
            const channels = node.module.channels;
            if (Array.isArray(channels)) {
                for (const channel of channels) {
                    registerChannelRoute(
                        app,
                        `/_channel/${moduleId}/${channel}`,
                        channel,
                        node.module,
                        moduleId,
                        currentMiddlewares
                    );
                }
            }
        }

        if (node.children) {
            registerChannelRoutes(app, node.children, currentMiddlewares);
        }
    }
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
                // Pages are registered before endpoints and their handler never
                // calls next(), so the page answers and this endpoint is dead.
                // That order is deliberate: the page GET also serves `?_data=1`,
                // the JSON every SPA navigation fetches.
                console.warn(
                    `[velojs] path "${fullPath}" has both a page GET and an endpoint GET; the page wins and the endpoint is unreachable. Consider renaming one.`
                );
            }

            const handlerFn = node.handler!;
            const wrapped = async (c: Context) => {
                // Endpoint declarativo: método + rota é a identidade; bytes
                // quando a resposta tem corpo medível.
                const t = trace("endpoint", { route: fullPath, method });
                try {
                    const response = await handlerFn({
                        c,
                        params: c.req.param(),
                        query: c.req.query(),
                    });
                    t.end({
                        status: "ok",
                        bytes:
                            t.enabled && response instanceof Response
                                ? await responseBytes(response)
                                : undefined,
                    });
                    return response;
                } catch (err) {
                    t.end({ status: "error" });
                    throw err;
                }
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
// CLIENT ASSETS - dist/client é público e vem antes das rotas
// ============================================

/**
 * Monta o estático de `dist/client` ANTES da tabela de rotas do app. Assets
 * têm hash de conteúdo e são públicos por desenho: rota dinâmica de topo
 * (`/:mes`) ou middleware de auth de rota nunca veem um caminho de asset — o
 * arquivo responde direto. O gating é o mesmo da montagem antiga (tardia): só
 * em produção, sem SSG (`VELO_STATIC`) e sem prefixo externo em
 * `STATIC_BASE_URL`; um miss chama `next()`, então rotas, actions, streams,
 * sockets, endpoints e o catch-all (`notFound`) continuam respondendo tudo que
 * não é arquivo.
 */
const mountClientStatic = async (app: Hono): Promise<void> => {
    if (process.env.NODE_ENV !== "production" || process.env.VELO_STATIC) return;

    // CDN/bucket: os assets são servidos fora do processo — nada local.
    const staticUrl = process.env.STATIC_BASE_URL || "";
    if (staticUrl.startsWith("http")) return;

    const { serveStatic } = await import("@hono/node-server/serve-static");
    const { join } = await import("node:path");
    app.use("/*", serveStatic({ root: join(process.cwd(), "dist/client") }));
};

// ============================================
// CREATE APP - Cria app Hono com rotas
// ============================================

export const createApp = async (routes: AppRoutes): Promise<Hono> => {
    const app = new Hono();

    // Native telemetry: the app is booting, so the boot record is written
    // first — the file's first line, the sink's first POST. Env-driven: without
    // a destination this is a no-op and nothing exists (dev included).
    await initNodeTelemetry();

    app.use(trimTrailingSlash());

    if (process.env.NODE_ENV !== "production") {
        app.use("*", logger());
    }

    // Assets do cliente: entram DEPOIS dos middlewares de infraestrutura acima
    // (normalização de barra final e logger) e ANTES de qualquer rota do app.
    await mountClientStatic(app);

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

    // Channel routes (live loader, SSE) — convenção channels por módulo
    registerChannelRoutes(app, routes);

    // Dev-only inspector: the map of live channels and partitions is internal
    // information — it never ships in a production build. An app that wants
    // something similar in production exposes `inspectChannels()` itself,
    // with whatever guard it judges.
    if (process.env.NODE_ENV !== "production") {
        app.get("/_channel-inspect", (c) => c.json(inspectChannels()));
    }

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
    // Same precedence for the interface: HOST env > defineConfig hostname >
    // Node default (binds all interfaces — what containers/cloud expect).
    const hostname = process.env.HOST || options.hostname || undefined;
    const app = await createApp(routes);

    // Production: start the HTTP server. Static assets are already mounted in
    // createApp — ahead of the app routes, behind the infra middlewares.
    if (process.env.NODE_ENV === "production" && !process.env.VELO_STATIC) {
        const { serve } = await import("@hono/node-server");

        const server = serve({ fetch: app.fetch, port, ...(hostname ? { hostname } : {}) });
        // serve() returns before listen() completes — address() is null (or
        // racy) synchronously. Wait for 'listening' so the log shows the REAL
        // bind and onServer callbacks can read server.address() — that is
        // what loopback fail-fast guards in sensitive apps depend on.
        if (!server.listening) {
            await new Promise<void>((resolve) => server.once("listening", resolve));
        }
        const addr = server.address();
        if (addr && typeof addr === "object") {
            const wildcard = addr.address === "::" || addr.address === "0.0.0.0";
            const display = wildcard ? "0.0.0.0 (all interfaces)" : addr.address;
            console.log(`Server running on ${display}:${addr.port}`);
        } else {
            console.log(`Server running on port ${port}`);
        }
        // Inject the WebSocket adapter so upgrade requests are routed.
        await injectWebSocketServer(app, server);
        flushServerCallbacks(server as unknown as import("http").Server);
        // A closed server must stop answering onServer: a late registrant
        // would receive a dead instance (address() === null) instead of
        // queueing for the next one.
        server.once("close", () => {
            clearActiveServer(server as unknown as import("http").Server);
        });
    }

    return app;
};

// Export createApp for Vite dev server
export default createApp;
