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

export { renderPage } from "./renderPage.js";
export { getContext, setContext, hasContext } from "./getContext.js";
