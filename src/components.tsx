/**
 * VeloJS Components
 * Components that can be used in the app for script/style injection
 */

import { Link as WouterLink } from "wouter-preact";
import type { ComponentChildren } from "preact";

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
    const isDev = import.meta.env.DEV;
    basePath = basePath || process.env.STATIC_BASE_URL || "";

    const faviconTag = favicon !== false && (
        <link rel="icon" href={`${basePath}${favicon}`} type="image/x-icon" />
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

    return (
        <>
            {faviconTag}
            <link rel="stylesheet" href={`${basePath}/client.css`} />
            <script type="module" src={`${basePath}/client.js`}></script>
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
function substituteParams(
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

    return <WouterLink to={`${routePath}${queryString}`} {...rest} />;
}
