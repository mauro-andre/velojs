/**
 * Client-side loader store.
 *
 * One signal per moduleId, shared by `Loader()` (import phase — the handle other
 * modules import) and `useLoader()` (render phase — the driver with deps). A
 * layout's data and a child's read of it are therefore the same instance, with
 * no module-scope mirror to keep in sync.
 *
 * Invalidation follows the route tree: an entry is stale when the params its own
 * route declares have changed — or when the module was not part of the previous
 * location's matched chain (it unmounted and is now remounting). The first rule
 * mirrors the server (a loader re-runs when a request arrives with different
 * params); the second mirrors user expectation (returning to a page shows fresh
 * data). A layout keeps its data while navigating among its children because it
 * stays matched the whole time — its client-owned state survives.
 *
 * Deliberately NOT invalidated by:
 *  - a query-string change: `routes.tsx` declares path params, never `?x=`, so
 *    there is nothing for the framework to read. Use `useLoader([query.x])`.
 *  - another module's fetch: a `?_data=1` response carries every matched
 *    module's data, but writing all of it would clobber entries the client owns
 *    locally (a filtered list, an optimistic mutation). Only the entries this
 *    store decided were stale are written.
 *
 * Server-side this module is inert: `Loader` reads AsyncLocalStorage directly.
 */
import { signal, type Signal } from "@preact/signals";
import type { AppRoutes, RouteNode } from "./types.js";

declare const __VELO_STATIC__: boolean;
declare const __VELO_BUILD_HASH__: string;

/** Set when the server reports a newer build than the one running. */
export const __veloUpdatePending = signal(false);

const entries = new Map<string, Signal<any>>();
const loadings = new Map<string, Signal<boolean>>();

/** moduleId → the route pattern declaring which path params its data depends on. */
const patterns = new Map<string, string>();

/** moduleIds whose route is a leaf (no children) — matched exactly, not as prefix. */
const exactModules = new Set<string>();

/** moduleId → serialized params in effect when its data was last written. */
const loadedParams = new Map<string, string>();

/** moduleIds whose route covered the previous location — remount detection. */
let lastMatched = new Set<string>();

/** url → in-flight request, so N entries invalidated by one navigation cost one fetch. */
const inFlight = new Map<string, Promise<Record<string, unknown>>>();

const registered = new WeakSet<object>();
let hydrated = false;

export function loaderEntry<T>(moduleId: string): Signal<T | null> {
    hydrateOnce();
    let sig = entries.get(moduleId);
    if (!sig) {
        sig = signal<T | null>(null);
        entries.set(moduleId, sig);
    }
    return sig;
}

export function loaderLoading(moduleId: string): Signal<boolean> {
    let sig = loadings.get(moduleId);
    if (!sig) {
        sig = signal(false);
        loadings.set(moduleId, sig);
    }
    return sig;
}

/**
 * Populate every entry from the SSR payload, once. Unlike the old read-and-
 * delete, this is non-destructive: any number of components may read the same
 * module's data.
 */
function hydrateOnce(): void {
    if (hydrated || typeof window === "undefined") return;
    hydrated = true;
    const pageData = (window as any).__PAGE_DATA__;
    if (!pageData) return;
    for (const key of Object.keys(pageData)) {
        if (key.startsWith("__")) continue; // __params, __query, __pathname
        let sig = entries.get(key);
        if (!sig) {
            sig = signal<any>(null);
            entries.set(key, sig);
        }
        sig.value = pageData[key];
    }
}

/** Walk the route tree once, recording each module's declared route pattern. */
export function registerRoutePatterns(routes: AppRoutes): void {
    if (registered.has(routes)) return;
    registered.add(routes);
    const walk = (nodes: RouteNode[]): void => {
        for (const node of nodes) {
            const meta = node.module?.metadata;
            if (meta?.moduleId && meta.fullPath !== undefined) {
                patterns.set(meta.moduleId, meta.fullPath);
                if (!node.children || node.children.length === 0) {
                    exactModules.add(meta.moduleId);
                }
            }
            if (node.children) walk(node.children);
        }
    };
    walk(routes);
    // The initial payload was rendered for the current URL.
    if (typeof window !== "undefined") {
        hydrateOnce();
        for (const moduleId of entries.keys()) markLoaded(moduleId, window.location.pathname);
        lastMatched = matchedAt(window.location.pathname);
    }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Extract the params a pattern declares from a pathname. Layout patterns are
 * prefixes of the URL (`/x/:id` covers `/x/1/tab`), mirroring how the client
 * router matches them, so the match is prefix-tolerant. Leaf patterns (routes
 * without children) match exactly, mirroring wouter's exact `<Route>` for them.
 *
 * Returns null when the pattern does not cover the pathname at all.
 */
export function extractParams(
    pattern: string,
    pathname: string,
    exact = false,
): Record<string, string> | null {
    const names: string[] = [];
    const source = pattern
        .split("/")
        .map((seg) => {
            if (seg.startsWith(":")) {
                names.push(seg.slice(1));
                return "([^/]+)";
            }
            return escapeRe(seg);
        })
        .join("/");
    const match = pathname.match(
        new RegExp(exact ? `^${source}/?$` : `^${source}(?:/.*)?$`)
    );
    if (!match) return null;
    const out: Record<string, string> = {};
    names.forEach((name, i) => {
        out[name] = match[i + 1]!;
    });
    return out;
}

function isMatched(moduleId: string, pathname: string): boolean {
    const pattern = patterns.get(moduleId);
    if (pattern === undefined) return false;
    return extractParams(pattern, pathname, exactModules.has(moduleId)) !== null;
}

/** Every moduleId whose route covers this pathname (leaves exact, layouts prefix). */
function matchedAt(pathname: string): Set<string> {
    const out = new Set<string>();
    for (const moduleId of patterns.keys()) {
        if (isMatched(moduleId, pathname)) out.add(moduleId);
    }
    return out;
}

function paramsKey(moduleId: string, pathname: string): string | null {
    const pattern = patterns.get(moduleId);
    if (pattern === undefined) return null;
    const params = extractParams(pattern, pathname, exactModules.has(moduleId));
    return params === null ? null : JSON.stringify(params);
}

function markLoaded(moduleId: string, pathname: string): void {
    const key = paramsKey(moduleId, pathname);
    if (key !== null) loadedParams.set(moduleId, key);
}

function dataUrl(pathname: string): string {
    const isStatic = typeof __VELO_STATIC__ !== "undefined" && __VELO_STATIC__;
    if (isStatic) return `${pathname === "/" ? "" : pathname}/index.json`;
    const search = new URLSearchParams(window.location.search);
    search.set("_data", "1");
    return `${pathname}?${search.toString()}`;
}

/**
 * Fetch `?_data=1` and write ONLY the requested modules. The response carries
 * every matched module's data, but the others may hold client-owned state.
 */
async function fetchInto(
    moduleIds: string[],
    pathname: string,
    coalesce: boolean,
): Promise<void> {
    if (typeof window === "undefined" || moduleIds.length === 0) return;
    const url = dataUrl(pathname);

    for (const id of moduleIds) loaderLoading(id).value = true;

    let request = coalesce ? inFlight.get(url) : undefined;
    if (!request) {
        request = fetch(url, { cache: "no-cache" }).then((r) => r.json());
        if (coalesce) {
            inFlight.set(url, request);
            void request.catch(() => {}).then(() => inFlight.delete(url));
        }
    }

    try {
        const json = await request;
        if (
            typeof __VELO_BUILD_HASH__ !== "undefined" &&
            json.__buildHash &&
            json.__buildHash !== __VELO_BUILD_HASH__
        ) {
            __veloUpdatePending.value = true;
        }
        for (const moduleId of moduleIds) {
            if (moduleId in json) {
                loaderEntry(moduleId).value = json[moduleId];
                markLoaded(moduleId, pathname);
            }
        }
    } catch {
        // Leave the previous value in place — a failed refresh must not blank
        // the screen.
    } finally {
        for (const id of moduleIds) loaderLoading(id).value = false;
    }
}

/**
 * Called on every client navigation. Refetches exactly the entries whose
 * declared params changed OR that were not matched at the previous location
 * (they unmounted and are remounting now), in one coalesced request.
 */
export function syncLocation(pathname: string): void {
    if (typeof window === "undefined") return;
    const stale: string[] = [];
    const nowMatched = matchedAt(pathname);
    for (const moduleId of entries.keys()) {
        if (!nowMatched.has(moduleId)) continue; // not on this route
        const key = paramsKey(moduleId, pathname)!;
        if (loadedParams.get(moduleId) === key && lastMatched.has(moduleId)) continue;
        stale.push(moduleId);
    }
    lastMatched = nowMatched;
    void fetchInto(stale, pathname, true);
}

/** Explicit refresh. Never coalesced: a caller asking after a mutation must not
 *  be handed a response that started before it. */
export function refetchModule(moduleId: string): void {
    if (typeof window === "undefined") return;
    void fetchInto([moduleId], window.location.pathname, false);
}

/** Test-only. Drops every entry, pattern and in-flight request. */
export function __resetLoaderStore(): void {
    entries.clear();
    loadings.clear();
    patterns.clear();
    exactModules.clear();
    loadedParams.clear();
    lastMatched = new Set<string>();
    inFlight.clear();
    hydrated = false;
    __veloUpdatePending.value = false;
}
