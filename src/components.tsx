/**
 * VeloJS Components
 * Components that can be used in the app for script/style injection
 */

import { Link as WouterLink, useRouter } from "wouter-preact";
import type { ComponentChildren } from "preact";
import { __veloUpdatePending } from "./hooks.js";

declare const __VELO_CLIENT_JS__: string;
declare const __VELO_CLIENT_CSS__: string;

// ============================================
// SCRIPTS COMPONENT
// ============================================

interface ScriptsProps {
    /**
     * Base path for static assets in production
     * @default ""
     */
    basePath?: string;

    /**
     * Path to the favicon file relative to the public directory
     * Set to false to disable favicon injection
     * @default "/favicon.ico"
     */
    favicon?: string | false;
}

/**
 * Injects the necessary scripts and styles for VeloJS.
 * In dev mode: injects Vite HMR client and velo client script
 * In production: injects compiled CSS and JS
 *
 * @example
 * ```tsx
 * <head>
 *     <Scripts />
 * </head>
 * ```
 */
export function Scripts({ basePath, favicon = "/favicon.ico" }: ScriptsProps = {}) {
    const isDev = process.env.NODE_ENV !== "production";
    basePath = basePath || process.env.STATIC_BASE_URL || (process.env.VELO_STATIC ? "/client" : "");

    // Deriva o MIME type da extensão — um favicon SVG com type="image/x-icon"
    // é recusado por alguns browsers (não renderiza). ico/png/svg cobrem os casos.
    const faviconType = favicon === false
        ? undefined
        : favicon.endsWith(".svg") ? "image/svg+xml"
        : favicon.endsWith(".png") ? "image/png"
        : "image/x-icon";
    const faviconTag = favicon !== false && (
        <link rel="icon" href={`${basePath}${favicon}`} type={faviconType} />
    );

    if (isDev) {
        return (
            <>
                {faviconTag}
                <script type="module" src="/@vite/client"></script>
                <script type="module" src="/__velo_client.js"></script>
            </>
        );
    }

    const jsFile = (globalThis as any).__veloClientJs || (typeof __VELO_CLIENT_JS__ !== "undefined" ? __VELO_CLIENT_JS__ : "client.js");
    const cssFile = (globalThis as any).__veloClientCss || (typeof __VELO_CLIENT_CSS__ !== "undefined" ? __VELO_CLIENT_CSS__ : "client.css");

    return (
        <>
            {faviconTag}
            <link rel="stylesheet" href={`${basePath}/${cssFile}`} />
            <script type="module" src={`${basePath}/${jsFile}`}></script>
        </>
    );
}

// ============================================
// LINK COMPONENT
// ============================================

import type { ComponentProps } from "preact";
import type { RouteModule } from "./types.js";

// Props do Link do wouter, mas com "to" estendido
type WouterLinkProps = ComponentProps<typeof WouterLink>;
type LinkProps = Omit<WouterLinkProps, "to" | "href"> & {
    /**
     * Destination - can be a string path or a module with metadata
     */
    to: string | RouteModule;

    /**
     * URL parameters to substitute in the path
     * e.g., { id: "123" } replaces :id with 123
     */
    params?: Record<string, string>;

    /**
     * Query string parameters appended to the URL
     * e.g., { company: "abc" } appends ?company=abc
     */
    search?: Record<string, string> | undefined;

    /**
     * When true, ignores current URL params and uses fullPath as-is
     * By default, params are extracted from current URL and substituted
     * @default false
     */
    absolute?: boolean;
};

/**
 * Substitutes :param placeholders in a path with actual values
 */
export function substituteParams(
    path: string,
    params: Record<string, string>
): string {
    let result = path;
    for (const [key, value] of Object.entries(params)) {
        result = result.replace(`:${key}`, value);
    }
    return result;
}

/**
 * Link component for navigation.
 * Accepts either a string path or a route module.
 *
 * @example
 * ```tsx
 * // With string path
 * <Link to="/login">Login</Link>
 *
 * // With route module (relative - uses path, works with nest)
 * <Link to={McpPage}>MCP</Link>
 *
 * // With route module (absolute - uses fullPath)
 * <Link to={LoginPage} absolute>Login</Link>
 *
 * // With explicit params
 * <Link to={UserPage} params={{ id: "123" }}>View User</Link>
 * ```
 */
export function Link({ to, params, search, absolute, ...rest }: LinkProps) {
    const isModule = typeof to !== "string";
    const router = useRouter();

    // Default: path (relative), absolute: fullPath
    const basePath = isModule
        ? (absolute ? to.metadata?.fullPath : to.metadata?.path) ?? "/"
        : to;

    // Substitute params if provided
    const finalPath = params ? substituteParams(basePath, params) : basePath;

    // Absolute module paths: prefix with ~ for wouter absolute navigation
    const routePath = isModule && absolute ? `~${finalPath}` : finalPath;

    // Append query string if search params provided
    const queryString = search
        ? `?${new URLSearchParams(search).toString()}`
        : "";

    const href = `${routePath}${queryString}`;

    // If a newer build was deployed, do a full page navigation instead of SPA
    if (typeof window !== "undefined" && __veloUpdatePending.value) {
        let fullHref: string;

        if (isModule) {
            // Module: always use fullPath (already absolute)
            const absPath = to.metadata?.fullPath ?? basePath;
            fullHref = `${params ? substituteParams(absPath, params) : absPath}${queryString}`;
        } else {
            // String: resolve with wouter's base for nest context
            const path = finalPath.replace(/^~/, "");
            const needsBase = !finalPath.startsWith("~") && router.base;
            fullHref = `${needsBase ? router.base : ""}${path}${queryString}`;
        }

        const { onClick, ...anchorRest } = rest as any;
        return (
            <a
                href={fullHref}
                onClick={(e: MouseEvent) => {
                    if (onClick) onClick(e);
                    if (!e.defaultPrevented) {
                        e.preventDefault();
                        window.location.href = fullHref;
                    }
                }}
                {...anchorRest}
            />
        );
    }

    return <WouterLink to={href} {...rest} />;
}
