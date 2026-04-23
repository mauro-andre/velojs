/**
 * Resolve URLs from VeloJS function references (action_*, loader, stream_*).
 * Relies on metadata injected by the VeloJS Vite plugin at build time.
 */

import type { AppRoutes, RouteNode, RouteModule } from "../types.js";

interface ActionEntry {
    name: string; // "login"
    fn: Function;
    moduleId: string;
    url: string; // /_action/{moduleId}/{name}
}

interface LoaderEntry {
    fn: Function;
    moduleId: string;
    /** Multiple URL paths can share a loader if registered under different parents. */
    paths: string[];
}

export interface ConventionRegistry {
    actions: Map<Function, ActionEntry>;
    loaders: Map<Function, LoaderEntry>;
}

export function buildConventionRegistry(routes: AppRoutes): ConventionRegistry {
    const actions = new Map<Function, ActionEntry>();
    const loaders = new Map<Function, LoaderEntry>();

    function visit(nodes: RouteNode[]): void {
        for (const node of nodes) {
            const moduleId = node.module?.metadata?.moduleId;
            const fullPath = node.module?.metadata?.fullPath;

            if (node.module && moduleId) {
                // Discover actions
                for (const key of Object.keys(node.module)) {
                    if (!key.startsWith("action_")) continue;
                    const fn = (node.module as unknown as Record<string, unknown>)[key];
                    if (typeof fn !== "function") continue;
                    const name = key.replace("action_", "");
                    actions.set(fn, {
                        name,
                        fn,
                        moduleId,
                        url: `/_action/${moduleId}/${name}`,
                    });
                }

                // Discover loader
                const loader = (node.module as RouteModule).loader;
                if (typeof loader === "function" && fullPath) {
                    const existing = loaders.get(loader);
                    if (existing) {
                        existing.paths.push(fullPath);
                    } else {
                        loaders.set(loader, {
                            fn: loader,
                            moduleId,
                            paths: [fullPath],
                        });
                    }
                }
            }

            if (node.children) visit(node.children);
        }
    }

    visit(routes);
    return { actions, loaders };
}

export function resolveActionUrl(
    registry: ConventionRegistry,
    fnOrUrl: Function | string
): string {
    if (typeof fnOrUrl === "string") return fnOrUrl;
    const entry = registry.actions.get(fnOrUrl);
    if (!entry) {
        throw new Error(
            "[velojs/testing] action_* function was not found in the route tree.\n" +
            "Make sure your Vitest config loads the VeloJS Vite plugin so that " +
            "metadata is injected. See https://github.com/mauro-andre/velojs#testing"
        );
    }
    return entry.url;
}

export function resolveLoaderPath(
    registry: ConventionRegistry,
    fnOrUrl: Function | string,
    params?: Record<string, string>
): string {
    if (typeof fnOrUrl === "string") return fnOrUrl;
    const entry = registry.loaders.get(fnOrUrl);
    if (!entry) {
        throw new Error(
            "[velojs/testing] loader function was not found in the route tree.\n" +
            "Make sure your Vitest config loads the VeloJS Vite plugin so that " +
            "metadata is injected."
        );
    }
    // Use the first registered path; substitute :params
    let path = entry.paths[0]!;
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            path = path.replace(`:${k}`, encodeURIComponent(v));
        }
    }
    return path;
}
