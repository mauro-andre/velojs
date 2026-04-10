import { useLoader, useParams } from "../../../src/hooks.js";
import type { LoaderArgs } from "../../../src/types.js";
import { Link } from "../../../src/components.js";
import manifest from "virtual:docs-manifest";
import content from "virtual:docs-content";
import * as css from "./Layout.css.js";

interface DocPageData {
    html: string;
    title: string;
    filename: string;
    prevSlug: string | null;
    prevTitle: string | null;
    nextSlug: string | null;
    nextTitle: string | null;
}

export const staticPaths = async () => {
    return manifest.map((entry) => ({ slug: entry.slug }));
};

export const loader = async ({ params }: LoaderArgs) => {
    const slug = params.slug;
    const doc = content[slug];
    const entry = manifest.find((m) => m.slug === slug);
    const index = manifest.findIndex((m) => m.slug === slug);

    const prev = index > 0 ? manifest[index - 1] : null;
    const next = index < manifest.length - 1 ? manifest[index + 1] : null;

    return {
        html: doc?.html ?? "",
        title: entry?.title ?? slug,
        filename: entry?.filename ?? "",
        prevSlug: prev?.slug ?? null,
        prevTitle: prev?.title ?? null,
        nextSlug: next?.slug ?? null,
        nextTitle: next?.title ?? null,
    };
};

export const Component = () => {
    const params = useParams<{ slug: string }>();
    const { data } = useLoader<DocPageData>([params.slug]);

    if (!data.value) return null;

    const { html, title, filename, prevSlug, prevTitle, nextSlug, nextTitle } = data.value;

    return (
        <>
            <div class={css.contentHeader}>
                <h1 class={css.contentTitle}>{title}</h1>
                {filename && (
                    <a
                        href={`/docs/${filename}`}
                        download
                        class={css.downloadMdBtn}
                    >
                        ↓ Download .md
                    </a>
                )}
            </div>

            <div
                class={css.prose}
                dangerouslySetInnerHTML={{ __html: html }}
            />

            {/* Prev / Next */}
            <div class={css.prevNext}>
                <div>
                    {prevSlug && (
                        <Link to={`/${prevSlug}`} class={css.prevNextLink}>
                            <span class={css.prevNextLabel}>← Previous</span>
                            <span class={css.prevNextTitle}>{prevTitle}</span>
                        </Link>
                    )}
                </div>
                <div>
                    {nextSlug && (
                        <Link to={`/${nextSlug}`} class={css.prevNextLink} style={{ textAlign: "right" }}>
                            <span class={css.prevNextLabel}>Next →</span>
                            <span class={css.prevNextTitle}>{nextTitle}</span>
                        </Link>
                    )}
                </div>
            </div>
        </>
    );
};
