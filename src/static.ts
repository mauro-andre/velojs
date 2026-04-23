import type { Hono } from "hono";
import type { RouteNode, AppRoutes } from "./types.js";
import fs from "node:fs";
import path from "node:path";

interface StaticRoute {
    fullPath: string;
    module: any;
}

/**
 * Collects all concrete paths from the route tree.
 * For routes with :params, checks for staticPaths export.
 */
async function collectStaticRoutes(
    nodes: RouteNode[],
    parentPath: string = "",
): Promise<StaticRoute[]> {
    const routes: StaticRoute[] = [];

    for (const node of nodes) {
        const nodePath = node.module?.metadata?.fullPath ?? "";

        if (node.children) {
            const childRoutes = await collectStaticRoutes(node.children, nodePath);
            routes.push(...childRoutes);
        } else if (!node.module) {
            // Endpoint-only or grouping leaf — not renderable as static page
            continue;
        } else {
            // Leaf node — this is a page
            const fullPath = node.module.metadata?.fullPath;
            if (!fullPath) continue;

            // Warn about actions in static mode
            const actionKeys = Object.keys(node.module).filter((k) => k.startsWith("action_"));
            if (actionKeys.length > 0) {
                console.warn(
                    `⚠ Route ${fullPath} has actions (${actionKeys.join(", ")}) — they won't work in static mode`
                );
            }

            if (fullPath.includes(":")) {
                // Dynamic route — needs staticPaths
                const staticPaths = node.module.staticPaths;
                if (typeof staticPaths === "function") {
                    const paramSets = await staticPaths();
                    for (const params of paramSets) {
                        let concretePath = fullPath;
                        for (const [key, value] of Object.entries(params as Record<string, string>)) {
                            concretePath = concretePath.replace(`:${key}`, value);
                        }
                        routes.push({ fullPath: concretePath, module: node.module });
                    }
                } else {
                    console.warn(
                        `Skipping ${fullPath} — dynamic route without staticPaths export`
                    );
                }
            } else {
                routes.push({ fullPath, module: node.module });
            }
        }
    }

    return routes;
}

/**
 * Generates a static HTML + JSON file for a single route.
 */
async function generateRoute(
    app: Hono,
    fullPath: string,
    outDir: string,
): Promise<void> {
    const baseUrl = "http://localhost";

    // Fetch HTML
    const htmlResponse = await app.fetch(new Request(`${baseUrl}${fullPath}`));
    if (htmlResponse.status !== 200) {
        console.warn(`Skipping ${fullPath} — got status ${htmlResponse.status}`);
        return;
    }
    const html = await htmlResponse.text();

    // Fetch JSON data
    const jsonResponse = await app.fetch(
        new Request(`${baseUrl}${fullPath}?_data=1`)
    );
    const jsonData = await jsonResponse.text();

    // Determine output directory
    const routeDir = fullPath === "/"
        ? outDir
        : path.join(outDir, fullPath);

    fs.mkdirSync(routeDir, { recursive: true });
    fs.writeFileSync(path.join(routeDir, "index.html"), html);
    fs.writeFileSync(path.join(routeDir, "index.json"), jsonData);
}

/**
 * Copies public/ folder contents to the output directory root.
 * In static mode, HTML references assets like /logos/file.svg,
 * but Vite copies public/ into dist/client/. We need them at dist/ too.
 */
function copyPublicDir(outDir: string): void {
    const publicDir = path.resolve(process.cwd(), "public");
    if (!fs.existsSync(publicDir)) return;

    const copyRecursive = (src: string, dest: string) => {
        const stat = fs.statSync(src);
        if (stat.isDirectory()) {
            fs.mkdirSync(dest, { recursive: true });
            for (const entry of fs.readdirSync(src)) {
                copyRecursive(path.join(src, entry), path.join(dest, entry));
            }
        } else {
            fs.copyFileSync(src, dest);
        }
    };

    copyRecursive(publicDir, outDir);
}

/**
 * Generates a fully static site from a VeloJS app.
 * Called by `velojs build --static` after the normal build.
 */
export async function generateStatic(
    app: Hono,
    routes: AppRoutes,
): Promise<void> {
    const outDir = path.resolve(process.cwd(), "dist");

    console.log("Generating static pages...");

    const staticRoutes = await collectStaticRoutes(routes);

    if (staticRoutes.length === 0) {
        console.warn("No routes found for static generation.");
        return;
    }

    for (const route of staticRoutes) {
        await generateRoute(app, route.fullPath, outDir);
        console.log(`  ✓ ${route.fullPath}`);
    }

    // Copy public/ assets to dist/ root so HTML references like /logos/file.svg work
    copyPublicDir(outDir);

    console.log(`\nGenerated ${staticRoutes.length} static pages.`);
}
