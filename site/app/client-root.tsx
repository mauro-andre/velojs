import { Scripts } from "../../src/index.js";
import { usePathname } from "../../src/hooks.js";
import manifest from "virtual:docs-manifest";

interface RootProps {
    children: preact.ComponentChildren;
}

const SITE_DESCRIPTION =
    "Fullstack web framework built on Hono + Preact with Vite-powered AST transforms. SSR, hydration, RPC actions, file-based routing — zero config.";

// Per-doc <meta name="description">, from each doc's frontmatter.
// It has to live here rather than in DocPage: only the root renders <head>, and
// a <meta> emitted by a leaf would land in the <body>. The manifest is imported
// statically because <head> is rendered synchronously — a dynamic import, as
// the loaders use, resolves too late.
const descriptionFor = (pathname: string): string => {
    const prefix = "/docs/";
    if (!pathname.startsWith(prefix)) return SITE_DESCRIPTION;
    const slug = pathname.slice(prefix.length);
    return manifest.find((d) => d.slug === slug)?.description ?? SITE_DESCRIPTION;
};

export const Component = ({ children }: RootProps) => {
    const description = descriptionFor(usePathname());

    return (
        <html lang="en">
            <head>
                <meta charSet="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <title>VeloJS — Fullstack Web Framework</title>
                <meta name="description" content={description} />
                <link rel="preconnect" href="https://fonts.googleapis.com" />
                <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
                <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
                {/* Register @property --angle so conic-gradient animations can sweep
                    the gradient origin without rotating the whole element. */}
                <style dangerouslySetInnerHTML={{ __html: `@property --angle { syntax: "<angle>"; initial-value: 0deg; inherits: false; }` }} />
                <Scripts />
            </head>
            <body>{children}</body>
        </html>
    );
};
