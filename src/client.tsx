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
    return nodes.map((node, index) => {
        const Component = node.module.Component;

        // Leaf node - rota final
        if (!node.children) {
            return (
                <Route key={index} path={node.path || ""}>
                    <Component />
                </Route>
            );
        }

        // Node com children - os children são sempre relativos com nest
        const childRoutes = buildRoutes(node.children, !!node.path);

        // isRoot - pula o componente, renderiza só os children
        if (node.isRoot) {
            return <Switch key={index}>{childRoutes}</Switch>;
        }

        // Sem path - wrapper puro (sem Route)
        if (!node.path) {
            return (
                <Component key={index}>
                    <Switch>{childRoutes}</Switch>
                </Component>
            );
        }

        // Layout com path + nest
        return (
            <Route key={index} path={node.path} nest>
                <Component>
                    <Switch>{childRoutes}</Switch>
                </Component>
            </Route>
        );
    });
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
