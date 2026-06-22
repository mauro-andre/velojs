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

// Wrap a vnode in its ancestor layouts (outermost first), so a distributed
// route still renders inside the layouts that grouped it.
const applyWrappers = (
    wrappers: ComponentType<any>[],
    node: VNode
): VNode => wrappers.reduceRight((acc, Wrapper) => <Wrapper>{acc}</Wrapper>, node);

// Append a route segment to a parent path, mirroring the server's fullPath
// rule (a leading "/" on a child concatenates onto the parent; an index "/"
// inherits the parent path). Keeps the client's matching identical to SSR.
const joinPath = (parent: string, seg: string | undefined, isLeaf: boolean): string => {
    if (!seg) return parent;
    if (isLeaf && seg === "/") return parent || "/";
    return seg.startsWith("/") ? parent + seg : parent + "/" + seg;
};

const buildRoutes = (
    nodes: RouteNode[],
    // Ancestor layout components to wrap around each concrete route below.
    wrappers: ComponentType<any>[] = [],
    // Absolute path accumulated from ancestor segments.
    basePath: string = "",
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
                // Grouping node — inline its children, accumulating its segment.
                const childBase = joinPath(basePath, node.path, false);
                vnodes.push(
                    ...buildRoutes(node.children, wrappers, childBase, `${key}-`)
                );
            }
            continue;
        }

        const Component = node.module.Component;

        // Leaf node — a concrete route at its absolute full path, wrapped in all
        // accumulated ancestor layouts.
        if (!node.children) {
            const full =
                node.path === "*" ? "*" : joinPath(basePath, node.path, true);
            vnodes.push(
                <Route key={key} path={full || "/"}>
                    {applyWrappers(wrappers, <Component />)}
                </Route>
            );
            continue;
        }

        // isRoot — skip its component (the SSR shell is already hydrated) and
        // render its children inside a <Switch> at the root base.
        if (node.isRoot) {
            vnodes.push(
                <Switch key={key}>
                    {buildRoutes(node.children, [], "", `${key}-`)}
                </Switch>
            );
            continue;
        }

        // Any layout (path-less OR path-ful). We DON'T use wouter's `<Route nest>`
        // and we DON'T push the layout as a single <Switch> element:
        //   - A path-less element in a <Switch> is treated as "*" (matchRoute does
        //     `parser(route || "*")`) and shadows every later route, incl. the
        //     catch-all.
        //   - A `<Route nest>` matches by prefix, so it absorbs unmatched
        //     sub-routes (they never reach the root catch-all) and it nests the
        //     base, so a parent layout's <Link> doubles the prefix.
        // Instead we distribute: append the segment to the base, push the layout
        // onto the wrapper stack, and emit each descendant as its own absolute
        // <Route> wrapped in the layout chain — exactly mirroring SSR's plain
        // component composition (no nested base, full-path matching).
        const childBase = joinPath(basePath, node.path, false);
        vnodes.push(
            ...buildRoutes(
                node.children,
                [...wrappers, Component],
                childBase,
                `${key}-`
            )
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
