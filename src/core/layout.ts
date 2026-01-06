import type { LayoutDefinition, RouteConfig } from "../types.js";
import type { MiddlewareHandler } from "hono";

/**
 * Helper para criar layouts de forma type-safe
 *
 * @param file - Caminho do arquivo de layout relativo ao workDir
 * @param options - Configurações do layout
 * @returns Definição do layout
 *
 * @example
 * ```ts
 * layout("./admin/layout.tsx", {
 *   prefix: "/admin",
 *   middleware: [authMiddleware],
 *   routes: [
 *     route("/users", "./admin/users/page.tsx"),
 *     route("/companies", "./admin/companies/page.tsx"),
 *   ]
 * })
 * ```
 */
export function layout(
  file: string,
  options: {
    prefix?: string;
    middleware?: MiddlewareHandler[];
    routes: RouteConfig[];
  }
): LayoutDefinition {
  return {
    file,
    prefix: options.prefix,
    middleware: options.middleware,
    routes: options.routes,
  };
}
