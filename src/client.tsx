import { hydrate } from "preact";
import { Router, Route, Switch, useLocation } from "wouter-preact";
import { useEffect } from "preact/hooks";
import type { VNode, ComponentType } from "preact";
import type { RouteNode, AppRoutes } from "./types.js";
import { registerRoutePatterns, syncLocation } from "./loader-store.js";

// ============================================
// CLIENT OPTIONS
// ============================================

export interface StartClientOptions {
    routes: AppRoutes;
}

// ============================================
// BUILD ROUTES - Gera rotas do wouter recursivamente
// ============================================

// Append a route segment to a parent path, mirroring the server's fullPath
// rule (a leading "/" on a child concatenates onto the parent; an index "/"
// inherits the parent path). Keeps the client's matching identical to SSR.
const joinPath = (parent: string, seg: string | undefined, isLeaf: boolean): string => {
    if (!seg) return parent;
    if (isLeaf && seg === "/") return parent || "/";
    return seg.startsWith("/") ? parent + seg : parent + "/" + seg;
};

// Splat pattern for a PATH-FUL layout: matches its prefix and everything under
// it WITHOUT creating a wouter "nest" base (so links stay root-absolute) while
// preserving named params for the layout. "/x/*?" matches "/x" and "/x/...".
const subtreePattern = (prefix: string): string =>
    prefix === "" ? "*" : `${prefix}/*?`;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Convert one generated wouter path pattern into a RegExp source (a leading
// `:param` becomes a single-segment match; a trailing "/*?" becomes "and
// anything under it").
const patternSource = (pattern: string): string => {
    let subtree = false;
    if (pattern.endsWith("/*?")) {
        pattern = pattern.slice(0, -3);
        subtree = true;
    }
    const body = pattern
        .split("/")
        .map((seg) => (seg.startsWith(":") ? "[^/]+" : escapeRe(seg)))
        .join("/");
    return subtree ? `${body}(?:/.*)?` : body;
};

// The wouter path patterns covering a node's whole subtree.
const coverage = (node: RouteNode, basePath: string): string[] => {
    if (node.path === "*") return []; // catch-all is a Switch default, not coverage
    if (!node.module) {
        const base = joinPath(basePath, node.path, false);
        return (node.children ?? []).flatMap((c) => coverage(c, base));
    }
    if (!node.children) {
        return [joinPath(basePath, node.path, true) || "/"];
    }
    if (node.path) {
        // path-ful layout — its splat covers the whole subtree
        return [`${joinPath(basePath, node.path, false)}/*?`];
    }
    // path-less layout — union of its children
    const base = joinPath(basePath, node.path, false);
    return (node.children ?? []).flatMap((c) => coverage(c, base));
};

// Matches a PATH-LESS layout against exactly its descendant routes, so it
// persists across them but never shadows a sibling nor swallows an unrelated
// URL (which falls through to the standalone catch-all).
const subtreeRegex = (node: RouteNode, basePath: string): RegExp => {
    const sources = coverage(node, basePath);
    return new RegExp(`^(?:${sources.map(patternSource).join("|")})$`);
};

// The catch-all component (path: "*"), rendered as each Switch's fallback.
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
    // Absolute path accumulated from ancestor segments.
    basePath: string,
    // Catch-all component injected as each Switch's fallback (or null).
    NotFound: ComponentType<any> | null,
    keyPrefix: string
): VNode[] => {
    const vnodes: VNode[] = [];
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]!;
        const key = `${keyPrefix}${i}`;

        // The catch-all is represented by each Switch's injected default route.
        if (node.path === "*") continue;

        // Skip endpoint-only nodes — they belong to the server, never to wouter.
        // (In production the plugin's removeEndpointRoutes already strips these
        // from the client bundle; the runtime skip is defensive for dev and for
        // routes arrays that bypass the plugin, e.g. tests.)
        if (!node.module) {
            if (node.children) {
                const childBase = joinPath(basePath, node.path, false);
                vnodes.push(...buildRoutes(node.children, childBase, NotFound, `${key}-`));
            }
            continue;
        }

        const Component = node.module.Component;

        // Leaf — a concrete route at its absolute full path.
        if (!node.children) {
            const full = joinPath(basePath, node.path, true) || "/";
            vnodes.push(
                <Route key={key} path={full}>
                    <Component />
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
                        buildRoutes(node.children, "", NotFound, `${key}-`),
                        NotFound
                    )}
                </Switch>
            );
            continue;
        }

        // Any layout (path-ful OR path-less) — rendered ONCE, wrapping an inner
        // <Switch> of its children. It stays mounted while navigating between
        // those children (only the inner switch swaps), so a sibling navigation
        // never re-mounts anything above it. Matching follows the declared tree:
        //   - path-ful → a non-nest splat (keeps named params, no nested base);
        //   - path-less → a RegExp matching exactly its descendants, so it
        //     persists across them without shadowing a sibling or swallowing an
        //     unrelated URL (that falls through to the standalone catch-all).
        const prefix = joinPath(basePath, node.path, false);
        const layoutPath: string | RegExp = node.path
            ? subtreePattern(prefix)
            : subtreeRegex(node, basePath);
        vnodes.push(
            <Route key={key} path={layoutPath as any}>
                <Component>
                    <Switch>
                        {withDefault(
                            buildRoutes(node.children, prefix, NotFound, `${key}-`),
                            NotFound
                        )}
                    </Switch>
                </Component>
            </Route>
        );
    }
    return vnodes;
};

// ============================================
// CLIENT ROUTES - Componente de rotas
// ============================================

// Tells the loader store when the URL changed, so it can refresh exactly the
// entries whose declared path params moved. Renders nothing; it exists to turn
// wouter's location into a plain call, since the store is not a component.
const LoaderSync = () => {
    const [location] = useLocation();
    useEffect(() => {
        syncLocation(window.location.pathname);
    }, [location]);
    return null;
};

export const ClientRoutes = ({ routes }: { routes: AppRoutes }) => {
    // Idempotent: records each module's route pattern, which is what the store
    // reads to decide whose data a navigation invalidates.
    registerRoutePatterns(routes);
    const NotFound = findCatchAll(routes);
    const routeTree = buildRoutes(routes, "", NotFound, "");
    return (
        <Router>
            <LoaderSync />
            {routeTree}
        </Router>
    );
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
