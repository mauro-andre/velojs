import { AsyncLocalStorage } from "async_hooks";
import type { Context } from "hono";
import type { ServerActionContext } from "../types.js";

/**
 * Storage global para contexto Hono
 */
const contextStorage = new AsyncLocalStorage<Context>();

/**
 * Define o contexto Hono atual (usado internamente pelo framework)
 *
 * @internal
 */
export function setContext(context: Context, callback: () => Promise<any>) {
  return contextStorage.run(context, callback);
}

/**
 * Acessa contexto Hono dentro de Server Action
 *
 * Permite acessar dados injetados por middlewares (user, session, etc)
 * dentro de server actions.
 *
 * @returns Contexto do servidor
 * @throws Error se chamado fora de um contexto válido
 *
 * @example
 * ```ts
 * export async function action_createUser(name: string) {
 *   const ctx = getContext();
 *   const user = ctx.context.get("user"); // ← De authMiddleware
 *
 *   const { saveUser } = await import("~/modules/user/repository");
 *   return await saveUser({ name, createdBy: user.id });
 * }
 * ```
 */
export function getContext(): ServerActionContext {
  const context = contextStorage.getStore();

  if (!context) {
    throw new Error(
      "[VeloJS] getContext() called outside of request context. " +
        "Make sure you're calling it inside a server action or loader."
    );
  }

  return {
    context,
    request: context.req.raw,
    headers: context.req.raw.headers,
  };
}

/**
 * Verifica se está em um contexto válido
 */
export function hasContext(): boolean {
  return contextStorage.getStore() !== undefined;
}
