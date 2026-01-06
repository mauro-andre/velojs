/**
 * VeloJS Runtime
 *
 * Helpers para runtime do servidor (Hono)
 *
 * @example
 * ```ts
 * import { renderPage, getContext } from "velojs/runtime";
 *
 * // SSR
 * const html = renderPage(c, <Page />, data);
 *
 * // Dentro de server action
 * const ctx = getContext();
 * const user = ctx.context.get("user");
 * ```
 */

import type { Context } from "hono";
import type { VNode } from "preact";
import type { ServerActionContext } from "../types.js";

/**
 * Renderiza página com SSR
 *
 * @param _c - Contexto Hono
 * @param _component - Componente Preact
 * @param _data - Dados do loader (opcional)
 */
export function renderPage(_c: Context, _component: VNode, _data?: any) {
  // TODO: Implementar renderPage
  throw new Error("renderPage not implemented yet");
}

/**
 * Acessa contexto Hono dentro de Server Action
 *
 * @returns Contexto do servidor
 */
export function getContext(): ServerActionContext {
  // TODO: Implementar getContext (AsyncLocalStorage)
  throw new Error("getContext not implemented yet");
}
