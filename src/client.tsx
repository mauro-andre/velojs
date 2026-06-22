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

// Pattern that matches a path-ful layout's whole subtree WITHOUT creating a
// wouter "nest" base (so links inside stay root-absolute, never doubled).
// "/x/*?" matches both "/x" and "/x/...", but not a sibling like "/xy".
const subtreePattern = (prefix: string): string =>
    prefix === "" ? "*" : `${prefix}/*?`;

// The catch-all component (path: "*"), rendered as each Switch's fallback so an
// unmatched location shows the 404 in the nearest shell (and standalone at root).
const findCatchAll = (nodes: RouteNode[]): ComponentType<any> | null => {
    for (const node of nodes) {
        if (node.path === "*" && node.module) return node.module.Component;
        if (node.children) {
            const found = findCatchAll(node.children);
            if (found) return found;
        }
    }
    return null;
};

// Appends the catch-all as a default (path-less) <Route> at the end of a Switch.
const withDefault = (
    routes: VNode[],
    NotFound: ComponentType<any> | null
): VNode[] =>
    NotFound ? [...routes, <Route key="__notfound"><NotFound /></Route>] : routes;

const buildRoutes = (
    nodes: RouteNode[],
    // Ancestor path-less layout components to wrap around each route below.
    wrappers: ComponentType<any>[],
    // Absolute path accumulated from ancestor segments.
    basePath: string,
    // Catch-all component injected as each Switch's fallback (or null).
    NotFound: ComponentType<any> | null,
    // Unique key prefix — distributed children are flattened into the parent
    // array, so plain indices would collide.
    keyPrefix: string
): VNode[] => {
    const vnodes: VNode[] = [];
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]!;
        const key = `${keyPrefix}${i}`;

        // The catch-all is represented by each Switch's injected default route
        // (see withDefault), not as a normal entry.
        if (node.path === "*") continue;

        // Skip endpoint-only nodes — they belong to the server, never to wouter.
        // (In production the plugin's removeEndpointRoutes already strips these
        // from the client bundle; the runtime skip is defensive for dev and for
        // routes arrays that bypass the plugin, e.g. tests.)
        if (!node.module) {
            if (node.children) {
                // Grouping node — inline its children, accumulating its segment.
                const childBase = joinPath(basePath, node.path, false);
                vnodes.push(
                    ...buildRoutes(node.children, wrappers, childBase, NotFound, `${key}-`)
                );
            }
            continue;
        }

        const Component = node.module.Component;

        // Leaf node — a concrete route at its absolute full path, wrapped in all
        // accumulated path-less ancestor layouts.
        if (!node.children) {
            const full = joinPath(basePath, node.path, true) || "/";
            vnodes.push(
                <Route key={key} path={full}>
                    {applyWrappers(wrappers, <Component />)}
                </Route>
            );
            continue;
        }

        // isRoot — skip its component (the SSR shell is already hydrated) and
        // render its children inside the root <Switch>.
        if (node.isRoot) {
            vnodes.push(
                <Switch key={key}>
                    {withDefault(
                        buildRoutes(node.children, [], "", NotFound, `${key}-`),
                        NotFound
                    )}
                </Switch>
            );
            continue;
        }

        const prefix = joinPath(basePath, node.path, false);

        // Path-less group layout — distribute it over each descendant's own
        // <Route> (push onto the wrapper stack). A path-less element can't be a
        // <Switch> entry (wouter treats a missing `path` as "*", shadowing the
        // catch-all), and distributing lets an unmatched URL fall through to the
        // root catch-all (standalone) instead of this layout's shell.
        if (!node.path) {
            vnodes.push(
                ...buildRoutes(node.children, [...wrappers, Component], prefix, NotFound, `${key}-`)
            );
            continue;
        }

        // Path-ful layout — render ONCE, wrapping an inner <Switch> of its
        // children, matched by a non-nest splat. The layout persists across
        // sibling navigations (same <Route> stays mounted, only the inner switch
        // swaps) and inner links stay root-absolute (no nested base). An
        // unmatched sub-route falls to the in-shell 404.
        vnodes.push(
            <Route key={key} path={subtreePattern(prefix)}>
                {applyWrappers(
                    wrappers,
                    <Component>
                        <Switch>
                            {withDefault(
                                buildRoutes(node.children, [], prefix, NotFound, `${key}-`),
                                NotFound
                            )}
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
    const NotFound = findCatchAll(routes);
    const routeTree = buildRoutes(routes, [], "", NotFound, "");
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
