import { useLoader, usePathname } from "../../../src/hooks.js";
import type { LoaderArgs } from "../../../src/types.js";
import { Link } from "../../../src/components.js";
import { useSignal } from "@preact/signals";
import manifest from "virtual:docs-manifest";
import * as css from "./Layout.css.js";

interface DocsLayoutData {
    manifest: typeof manifest;
}

export const loader = async ({}: LoaderArgs) => {
    return { manifest };
};

export const Component = ({ children }: { children: any }) => {
    const sidebarOpen = useSignal(false);
    const pathname = usePathname();
    const { data } = useLoader<DocsLayoutData>();

    // Use loader data when available, fall back to static import
    const entries = data.value?.manifest ?? manifest;

    return (
        <div class={css.layout}>
            {/* Mobile toggle */}
            <button
                class={css.mobileToggle}
                onClick={() => (sidebarOpen.value = !sidebarOpen.value)}
            >
                {sidebarOpen.value ? "✕" : "☰"}
            </button>

            {/* Sidebar */}
            <aside class={`${css.sidebar} ${sidebarOpen.value ? css.sidebarVisible : ""}`}>
                <div class={css.sidebarHeader}>
                    <Link to="~/" class={css.sidebarLogo}>VeloJS</Link>
                </div>

                <nav class={css.sidebarNav}>
                    {entries.map((entry) => (
                        <Link
                            key={entry.slug}
                            to={`/${entry.slug}`}
                            class={`${css.sidebarLink} ${pathname === `/docs/${entry.slug}` ? css.sidebarLinkActive : ""}`}
                        >
                            {entry.title}
                        </Link>
                    ))}
                </nav>

                <div class={css.sidebarFooter}>
                    <a href="/docs/velojs-docs.zip" download class={css.downloadBtn}>
                        ↓ Download all docs (.zip)
                    </a>
                </div>
            </aside>

            {/* Content */}
            <main class={css.content}>
                {children}
            </main>
        </div>
    );
};
