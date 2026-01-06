import type { Context, MiddlewareHandler } from "hono";

/**
 * Configuração de uma rota individual
 */
export interface RouteDefinition {
  /**
   * Caminho da URL (ex: "/users", "/users/:id", "*")
   */
  path: string;

  /**
   * Caminho do arquivo relativo ao workDir
   * (ex: "./admin/users/page.tsx")
   */
  file: string;

  /**
   * Middlewares específicos desta rota
   */
  middleware?: MiddlewareHandler[];
}

/**
 * Configuração de um layout com rotas filhas
 */
export interface LayoutDefinition {
  /**
   * Caminho do arquivo de layout relativo ao workDir
   * (ex: "./admin/layout.tsx")
   */
  file: string;

  /**
   * Prefixo de URL para todas as rotas filhas
   * (ex: "/admin")
   */
  prefix?: string;

  /**
   * Middlewares que executam antes das rotas filhas
   */
  middleware?: MiddlewareHandler[];

  /**
   * Rotas filhas (podem ser routes ou layouts nested)
   */
  routes: RouteConfig[];
}

/**
 * Union type para route ou layout
 */
export type RouteConfig = RouteDefinition | LayoutDefinition;

/**
 * Type guard para verificar se é um layout
 */
export function isLayout(config: RouteConfig): config is LayoutDefinition {
  return "routes" in config;
}

/**
 * Argumentos passados para o loader
 */
export interface LoaderArgs {
  /**
   * Contexto do Hono (c)
   * - Acessa dados injetados por middlewares: c.get("user")
   * - Acessa request: c.req
   */
  context: Context;

  /**
   * Parâmetros da URL
   * /users/:id → { id: "123" }
   */
  params: Record<string, string>;

  /**
   * Request original
   */
  request: Request;
}

/**
 * Tipo do loader
 */
export type LoaderFunction<T = any> = (args: LoaderArgs) => Promise<T>;

/**
 * Tipo genérico de Server Action
 */
export type ServerAction<TArgs extends any[] = any[], TReturn = any> = (
  ...args: TArgs
) => Promise<TReturn>;

/**
 * Contexto disponível para Server Actions
 */
export interface ServerActionContext {
  /**
   * Request original
   */
  request: Request;

  /**
   * Contexto Hono (dados injetados por middlewares)
   */
  context: Context;

  /**
   * Headers da request
   */
  headers: Headers;
}

/**
 * Configuração do framework
 */
export interface VeloConfig {
  /**
   * Diretório de trabalho onde estão os arquivos da aplicação
   * @default "./app"
   */
  workDir?: string;

  /**
   * Diretório onde os arquivos gerados serão salvos
   * @default "./.velojs"
   */
  outDir?: string;
}
