import { hydrate } from "preact";
import { Router, Route, Switch } from "wouter-preact";
import type { VNode } from "preact";
import type { RouteNode, AppRoutes } from "./types.js";

// ============================================
// CLIENT OPTIONS
// ============================================

export interface StartClientOptions {
    routes: AppRoutes;
}

// ============================================
// BUILD ROUTES - Gera rotas do wouter recursivamente
// ============================================

const buildRoutes = (nodes: RouteNode[], nested: boolean = false): VNode[] => {
    const vnodes: VNode[] = [];
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]!;

        // Skip endpoint-only nodes — they belong to the server, never to wouter.
        // (In production the plugin's removeEndpointRoutes already strips these
        // from the client bundle; the runtime skip is defensive for dev and for
        // routes arrays that bypass the plugin, e.g. tests.)
        if (!node.module) {
            if (node.children) {
                // Grouping node — render its children with accumulated path prefix
                // isn't supported today (client has no notion of middleware inherit),
                // so just inline the child routes at this level.
                for (const child of buildRoutes(node.children, nested)) {
                    vnodes.push(child);
                }
            }
            continue;
        }

        const Component = node.module.Component;

        // Leaf node - rota final
        if (!node.children) {
            vnodes.push(
                <Route key={i} path={node.path || ""}>
                    <Component />
                </Route>
            );
            continue;
        }

        // Node com children - os children são sempre relativos com nest
        const childRoutes = buildRoutes(node.children, !!node.path);

        // isRoot - pula o componente, renderiza só os children
        if (node.isRoot) {
            vnodes.push(<Switch key={i}>{childRoutes}</Switch>);
            continue;
        }

        // Sem path - wrapper puro (sem Route)
        if (!node.path) {
            vnodes.push(
                <Component key={i}>
                    <Switch>{childRoutes}</Switch>
                </Component>
            );
            continue;
        }

        // Layout com path + nest
        vnodes.push(
            <Route key={i} path={node.path} nest>
                <Component>
                    <Switch>{childRoutes}</Switch>
                </Component>
            </Route>
        );
    }
    return vnodes;
};

// ============================================
// CLIENT ROUTES - Componente de rotas
// ============================================

const ClientRoutes = ({ routes }: { routes: AppRoutes }) => {
    const routeTree = buildRoutes(routes);
    return <Router>{routeTree}</Router>;
};

// ============================================
// START CLIENT - Entry point principal
// ============================================

export const startClient = (options: StartClientOptions) => {
    const { routes } = options;
    const body = document.querySelector("body");

    if (body) {
        hydrate(<ClientRoutes routes={routes} />, body);
    }
};
