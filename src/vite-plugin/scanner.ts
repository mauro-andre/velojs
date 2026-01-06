import { resolve } from "path";
import type { RouteConfig, LayoutDefinition, RouteDefinition } from "../types.js";
import { isLayout } from "../types.js";
import type { ProcessedRoute, ScanResult } from "./types.js";
import type { MiddlewareHandler } from "hono";

/**
 * Escaneia o arquivo routes.ts e processa todas as rotas
 *
 * @param routesConfig - Array de RouteConfig exportado de routes.ts
 * @param workDir - Diretório de trabalho (onde estão os arquivos da app)
 * @returns Rotas processadas
 */
export function scanRoutes(
  routesConfig: RouteConfig[],
  workDir: string
): ScanResult {
  const routes: ProcessedRoute[] = [];
  const layouts = new Map<string, ProcessedRoute>();

  // Processa cada configuração recursivamente
  routesConfig.forEach((config) => {
    processConfig(config, {
      parentPrefix: "",
      parentMiddlewares: [],
      parentLayouts: [],
      workDir,
      routes,
      layouts,
    });
  });

  return {
    routes,
    layouts,
    metadata: {
      totalRoutes: routes.filter((r) => r.type === "route").length,
      totalLayouts: layouts.size,
      workDir,
    },
  };
}

/**
 * Contexto do processamento
 */
interface ProcessContext {
  parentPrefix: string;
  parentMiddlewares: MiddlewareHandler[];
  parentLayouts: ProcessedRoute[];
  workDir: string;
  routes: ProcessedRoute[];
  layouts: Map<string, ProcessedRoute>;
}

/**
 * Processa uma configuração (layout ou route) recursivamente
 */
function processConfig(config: RouteConfig, ctx: ProcessContext): void {
  if (isLayout(config)) {
    processLayout(config, ctx);
  } else {
    processRoute(config, ctx);
  }
}

/**
 * Processa um layout
 */
function processLayout(layout: LayoutDefinition, ctx: ProcessContext): void {
  // 1. Calcula prefix acumulado
  const currentPrefix = ctx.parentPrefix + (layout.prefix || "");

  // 2. Acumula middlewares
  const currentMiddlewares = [
    ...ctx.parentMiddlewares,
    ...(layout.middleware || []),
  ];

  // 3. Resolve path do arquivo
  const filePath = resolveFilePath(layout.file, ctx.workDir);

  // 4. Cria ProcessedRoute para o layout
  const processedLayout: ProcessedRoute = {
    type: "layout",
    url: currentPrefix || "/",
    filePath,
    middlewares: currentMiddlewares,
    layoutChain: [...ctx.parentLayouts],
    params: [],
  };

  // 5. Armazena no map de layouts
  ctx.layouts.set(filePath, processedLayout);

  // 6. Processa rotas filhas
  const newContext: ProcessContext = {
    ...ctx,
    parentPrefix: currentPrefix,
    parentMiddlewares: currentMiddlewares,
    parentLayouts: [...ctx.parentLayouts, processedLayout],
  };

  layout.routes.forEach((childConfig) => {
    processConfig(childConfig, newContext);
  });
}

/**
 * Processa uma rota
 */
function processRoute(route: RouteDefinition, ctx: ProcessContext): void {
  // 1. Calcula URL final
  const url = ctx.parentPrefix + route.path;

  // 2. Acumula middlewares
  const middlewares = [
    ...ctx.parentMiddlewares,
    ...(route.middleware || []),
  ];

  // 3. Resolve path do arquivo
  const filePath = resolveFilePath(route.file, ctx.workDir);

  // 4. Extrai params dinâmicos (:id, :slug, etc)
  const params = extractParams(route.path);

  // 5. Cria ProcessedRoute
  const processedRoute: ProcessedRoute = {
    type: "route",
    url,
    filePath,
    middlewares,
    layoutChain: [...ctx.parentLayouts],
    params,
  };

  // 6. Adiciona à lista de rotas
  ctx.routes.push(processedRoute);
}

/**
 * Resolve path do arquivo relativo ao workDir
 *
 * @param file - Path relativo (ex: "./admin/users/page.tsx")
 * @param workDir - Diretório de trabalho
 * @returns Path absoluto
 */
function resolveFilePath(file: string, workDir: string): string {
  // Remove "./" do início se existir
  const cleanFile = file.startsWith("./") ? file.slice(2) : file;

  // Resolve para path absoluto
  return resolve(workDir, cleanFile);
}

/**
 * Extrai parâmetros dinâmicos de uma URL
 *
 * @param path - Path da URL (ex: "/users/:id/posts/:postId")
 * @returns Array de nomes de params (ex: ["id", "postId"])
 */
function extractParams(path: string): string[] {
  const params: string[] = [];
  const segments = path.split("/");

  segments.forEach((segment) => {
    if (segment.startsWith(":")) {
      params.push(segment.slice(1)); // Remove ":"
    }
  });

  return params;
}

/**
 * Gera route manifest JSON para debug
 */
export function generateManifest(scanResult: ScanResult): string {
  const manifest = {
    metadata: scanResult.metadata,
    routes: scanResult.routes.map((route) => ({
      type: route.type,
      url: route.url,
      file: route.filePath,
      params: route.params,
      middlewareCount: route.middlewares.length,
      layoutDepth: route.layoutChain?.length || 0,
    })),
  };

  return JSON.stringify(manifest, null, 2);
}
