import type { ComponentType } from "preact";
import type { Context, MiddlewareHandler } from "hono";

export interface LoaderArgs {
    params: Record<string, string>;
    query: Record<string, string>;
    c: Context;
}

export interface ActionArgs<TBody = unknown> {
    body: TBody;
    params?: Record<string, string>;
    query?: Record<string, string>;
    c?: Context;
}

export interface Metadata {
    moduleId: string;
    fullPath?: string;
    path?: string;
    [key: string]: unknown;
}

export interface RouteModule {
    Component: ComponentType<any>;
    loader?: (args: LoaderArgs) => Promise<any>;
    staticPaths?: () => Promise<Record<string, string>[]>;
    metadata?: Metadata;
    [key: `action_${string}`]: (args: ActionArgs<any>) => Promise<any>;
}

export type HTTPMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface EndpointHandlerArgs {
    c: Context;
    params: Record<string, string>;
    query: Record<string, string>;
}

export type EndpointHandler = (
    args: EndpointHandlerArgs
) => Response | Promise<Response>;

export interface RouteNode {
    path?: string;
    module?: RouteModule;
    method?: HTTPMethod;
    handler?: EndpointHandler;
    children?: RouteNode[];
    middlewares?: MiddlewareHandler[];
    isRoot?: boolean;
    /**
     * HTTP status code for the rendered page (default 200). Lets a route
     * respond with e.g. 404/410/503. The bare catch-all (`path: "*"`) defaults
     * to 404 and is served via Hono's notFound hook. For conditional status
     * (resource missing inside a valid route), call `c.status()` in the loader.
     */
    statusCode?: number;
}

export type AppRoutes = RouteNode[];
