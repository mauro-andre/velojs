import type { RouteDefinition } from "../types.js";
import type { MiddlewareHandler } from "hono";

/**
 * Helper para criar rotas de forma type-safe
 *
 * @param path - Caminho da URL (ex: "/users", "/users/:id")
 * @param file - Caminho do arquivo relativo ao workDir
 * @param options - Opções adicionais
 * @returns Definição da rota
 *
 * @example
 * ```ts
 * route("/users", "./admin/users/page.tsx")
 * route("/users/:id", "./admin/users/detail/page.tsx", {
 *   middleware: [requirePermission("users.view")]
 * })
 * ```
 */
export function route(
  path: string,
  file: string,
  options?: { middleware?: MiddlewareHandler[] }
): RouteDefinition {
  return {
    path,
    file,
    middleware: options?.middleware,
  };
}
