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
// BOOT COMPONENT
// ============================================

interface BootProps {
    /**
     * localStorage keys to load before the first paint. The value of each
     * key found is exposed on `window.__VELO_BOOT__` and mirrored as a
     * sanitized `data-*` attribute on `<html>` — CSS reacting to the
     * attribute is what makes the first paint flicker-free.
     */
    localStorage?: string[];

    /**
     * Cookie names to load before the first paint (same exposure/mirroring
     * as localStorage keys). Declare storages separately: one Boot per
     * storage keeps each script minimal.
     */
    cookies?: string[];
}

/**
 * Generates the pre-paint boot script. Pure and isomorphic — Boot must
 * render the SAME string on server and client so hydration matches.
 * Exported for tests.
 */
export function bootScript({ localStorage: lsKeys, cookies: ckKeys }: BootProps = {}): string {
    if ((!lsKeys || lsKeys.length === 0) && (!ckKeys || ckKeys.length === 0)) return "";

    // Embedding keys as JSON with `<` escaped: the keys live in app source,
    // but a `</script>` inside one must not break out of the inline script.
    const embed = (keys: string[]): string =>
        JSON.stringify(keys).replace(/</g, "\\u003c");

    const ls = lsKeys && lsKeys.length > 0
        ? `var L=${embed(lsKeys)};for(var i=0;i<L.length;i++){var v=localStorage.getItem(L[i]);if(v!==null)b[L[i]]=v;}`
        : "";
    const ck = ckKeys && ckKeys.length > 0
        ? `var C=${embed(ckKeys)};var s=document.cookie?document.cookie.split("; "):[];var m={};for(var j=0;j<s.length;j++){var p=s[j].indexOf("=");if(p>0){m[s[j].slice(0,p)]=decodeURIComponent(s[j].slice(p+1));}}for(var k=0;k<C.length;k++){if(C[k]in m)b[C[k]]=m[C[k]];}`
        : "";

    return `(function(){var b={};try{${ls}}catch(e){}try{${ck}}catch(e){}if(Object.keys(b).length){window.__VELO_BOOT__=Object.assign(window.__VELO_BOOT__||{},b);var d=document.documentElement;for(var q in b){d.setAttribute("data-"+String(q).replace(/[^a-zA-Z0-9-]/g,"-"),b[q]);}}})();`;
}

/**
 * Declares client state to load BEFORE the first paint. Place it in the
 * `<head>` of client-root — a synchronous inline script is the only code
 * that runs between the head being parsed and the body being painted, so
 * values it mirrors as data-attributes produce a single, correct paint.
 *
 * Reading: `useBoot()` destructures by the declared names.
 * Writing/persisting stays with the app (signals + storage in its gestures).
 *
 * @example
 * ```tsx
 * <head>
 *     <Boot localStorage={["theme", "sidebarHidden"]} />
 *     <Boot cookies={["org"]} />
 * </head>
 * ```
 */
export function Boot(props: BootProps) {
    const script = bootScript(props);
    if (!script) return null;
    return <script dangerouslySetInnerHTML={{ __html: script }} />;
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
     * @deprecated No-op. Module refs always resolve to their fullPath now.
     * Kept for backward compatibility.
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
 * // With string path (root-absolute; a leading "~/" is also accepted)
 * <Link to="/login">Login</Link>
 *
 * // With route module (navigates to its fullPath)
 * <Link to={McpPage}>MCP</Link>
 *
 * // With explicit params
 * <Link to={UserPage} params={{ id: "123" }}>View User</Link>
 * ```
 */
export function Link({ to, params, search, absolute, ...rest }: LinkProps) {
    const isModule = typeof to !== "string";
    const router = useRouter();

    // Module refs always resolve to their absolute `fullPath`. The client router
    // no longer uses wouter's nested base — it matches by full path, mirroring
    // SSR — so there is no relative-to-layout context to resolve against. The
    // `absolute` prop is kept for backward compatibility but is now a no-op
    // (module links already resolved to fullPath on SSR/first paint).
    void absolute;
    const basePath = isModule ? (to.metadata?.fullPath ?? "/") : to;

    // Substitute params if provided. A leading "~/" on a string `to` is still
    // honored by wouter (it strips the "~"), resolving to a root-absolute path.
    const finalPath = params ? substituteParams(basePath, params) : basePath;

    // Append query string if search params provided
    const queryString = search
        ? `?${new URLSearchParams(search).toString()}`
        : "";

    const href = `${finalPath}${queryString}`;

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
