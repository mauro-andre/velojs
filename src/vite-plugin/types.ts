import type { MiddlewareHandler } from "hono";

/**
 * Rota processada pelo scanner (flat)
 */
export interface ProcessedRoute {
  /**
   * Tipo: "layout" ou "route"
   */
  type: "layout" | "route";

  /**
   * URL final (após concatenar todos os prefixes)
   * Ex: "/admin/users"
   */
  url: string;

  /**
   * Caminho absoluto do arquivo
   * Ex: "/projeto/app/admin/users/page.tsx"
   */
  filePath: string;

  /**
   * Middlewares acumulados (do layout pai + próprio)
   */
  middlewares: MiddlewareHandler[];

  /**
   * Se for layout, guarda os componentes da árvore de renderização
   */
  layoutChain?: ProcessedRoute[];

  /**
   * Params dinâmicos da URL
   * Ex: "/users/:id" → ["id"]
   */
  params: string[];

  /**
   * Server actions disponíveis nesta rota
   * Ex: ["action_createUser", "action_deleteUser"]
   */
  actions?: string[];
}

/**
 * Resultado do scanner
 */
export interface ScanResult {
  /**
   * Todas as rotas processadas (flat)
   */
  routes: ProcessedRoute[];

  /**
   * Layouts encontrados (para renderização nested)
   */
  layouts: Map<string, ProcessedRoute>;

  /**
   * Metadados para debug
   */
  metadata: {
    totalRoutes: number;
    totalLayouts: number;
    workDir: string;
  };
}
