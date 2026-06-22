import { hydrate } from "preact";
import { Router, Route, Switch } from "wouter-preact";
import type { VNode, ComponentType } from "preact";
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

// Wrap a vnode in any path-less ancestor layouts (outermost first), so a
// distributed route still renders inside the layouts that grouped it.
const applyWrappers = (
    wrappers: ComponentType<any>[],
    node: VNode
): VNode => wrappers.reduceRight((acc, Wrapper) => <Wrapper>{acc}</Wrapper>, node);

const buildRoutes = (
    nodes: RouteNode[],
    // Path-less ancestor layouts to wrap around each concrete route below.
    wrappers: ComponentType<any>[] = [],
    // Unique key prefix — distributed children are flattened into the parent
    // array, so plain indices would collide.
    keyPrefix: string = ""
): VNode[] => {
    const vnodes: VNode[] = [];
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]!;
        const key = `${keyPrefix}${i}`;

        // Skip endpoint-only nodes — they belong to the server, never to wouter.
        // (In production the plugin's removeEndpointRoutes already strips these
        // from the client bundle; the runtime skip is defensive for dev and for
        // routes arrays that bypass the plugin, e.g. tests.)
        if (!node.module) {
            if (node.children) {
                // Grouping node — inline its children, carrying the wrappers.
                vnodes.push(...buildRoutes(node.children, wrappers, `${key}-`));
            }
            continue;
        }

        const Component = node.module.Component;

        // Leaf node - rota final. Embrulha nos layouts sem path acumulados, mas
        // mantém como <Route> com path próprio.
        if (!node.children) {
            vnodes.push(
                <Route key={key} path={node.path || ""}>
                    {applyWrappers(wrappers, <Component />)}
                </Route>
            );
            continue;
        }

        // isRoot - pula o componente (a shell SSR já está hidratada) e renderiza
        // os children dentro de um <Switch>.
        if (node.isRoot) {
            vnodes.push(
                <Switch key={key}>
                    {buildRoutes(node.children, [], `${key}-`)}
                </Switch>
            );
            continue;
        }

        // Layout de grupo SEM path. Não pode entrar como elemento único no
        // <Switch> do pai: o wouter trata um elemento sem prop `path` como "*"
        // (matchRoute faz `parser(route || "*")`), engolindo toda rota seguinte
        // — inclusive o catch-all. Em vez disso, empilha esse layout nos
        // wrappers e distribui sobre os <Route> path-ful de cada filho.
        if (!node.path) {
            vnodes.push(
                ...buildRoutes(
                    node.children,
                    [...wrappers, Component],
                    `${key}-`
                )
            );
            continue;
        }

        // Layout COM path + nest. Os children ficam relativos ao segmento.
        vnodes.push(
            <Route key={key} path={node.path} nest>
                {applyWrappers(
                    wrappers,
                    <Component>
                        <Switch>
                            {buildRoutes(node.children, [], `${key}-`)}
                        </Switch>
                    </Component>
                )}
            </Route>
        );
    }
    return vnodes;
};

// ============================================
// CLIENT ROUTES - Componente de rotas
// ============================================

export const ClientRoutes = ({ routes }: { routes: AppRoutes }) => {
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
