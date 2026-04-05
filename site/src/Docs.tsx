import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import manifest from "virtual:docs-manifest";
import content from "virtual:docs-content";
import { hash } from "./App.js";
import * as css from "./Docs.css.js";

function getSlugFromHash(h: string): string {
    const match = h.match(/^#\/docs\/(.+)$/);
    return match ? match[1] : manifest[0]?.slug ?? "";
}

export function Docs() {
    const sidebarOpen = useSignal(false);
    const currentSlug = getSlugFromHash(hash.value);

    // Close sidebar on navigation (mobile)
    useEffect(() => {
        sidebarOpen.value = false;
    }, [currentSlug]);

    const doc = content[currentSlug];
    const currentEntry = manifest.find((m) => m.slug === currentSlug);
    const currentIndex = manifest.findIndex((m) => m.slug === currentSlug);
    const prevEntry = currentIndex > 0 ? manifest[currentIndex - 1] : null;
    const nextEntry = currentIndex < manifest.length - 1 ? manifest[currentIndex + 1] : null;

    // Redirect to first doc if no slug
    if (!currentSlug || !doc) {
        window.location.hash = `#/docs/${manifest[0]?.slug ?? ""}`;
        return null;
    }

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
                    <a href="#/" class={css.sidebarLogo}>VeloJS</a>
                </div>

                <nav class={css.sidebarNav}>
                    {manifest.map((entry) => (
                        <a
                            key={entry.slug}
                            href={`#/docs/${entry.slug}`}
                            class={`${css.sidebarLink} ${entry.slug === currentSlug ? css.sidebarLinkActive : ""}`}
                        >
                            {entry.title}
                        </a>
                    ))}
                </nav>

                <div class={css.sidebarFooter}>
                    <a href="docs/velojs-docs.zip" download class={css.downloadBtn}>
                        ↓ Download all docs (.zip)
                    </a>
                </div>
            </aside>

            {/* Content */}
            <main class={css.content}>
                <div class={css.contentHeader}>
                    <h1 class={css.contentTitle}>{currentEntry?.title}</h1>
                    {currentEntry && (
                        <a
                            href={`docs/${currentEntry.filename}`}
                            download
                            class={css.downloadMdBtn}
                        >
                            ↓ Download .md
                        </a>
                    )}
                </div>

                <div
                    class={css.prose}
                    dangerouslySetInnerHTML={{ __html: doc.html }}
                />

                {/* Prev / Next */}
                <div class={css.prevNext}>
                    <div>
                        {prevEntry && (
                            <a href={`#/docs/${prevEntry.slug}`} class={css.prevNextLink}>
                                <span class={css.prevNextLabel}>← Previous</span>
                                <span class={css.prevNextTitle}>{prevEntry.title}</span>
                            </a>
                        )}
                    </div>
                    <div>
                        {nextEntry && (
                            <a href={`#/docs/${nextEntry.slug}`} class={css.prevNextLink} style={{ textAlign: "right" }}>
                                <span class={css.prevNextLabel}>Next →</span>
                                <span class={css.prevNextTitle}>{nextEntry.title}</span>
                            </a>
                        )}
                    </div>
                </div>
            </main>
        </div>
    );
}
