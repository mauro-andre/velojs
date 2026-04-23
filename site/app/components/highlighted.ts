/**
 * Shiki-powered syntax highlighter shared across landing snippets.
 *
 * Uses top-level await so all exported snippets are pre-highlighted before the
 * Preact tree renders. On the server (SSR) and during SSG this runs once at
 * module load; the bundled HTML strings travel to the client as static markup.
 */

import { createHighlighter, type Highlighter } from "shiki";

let highlighterPromise: Promise<Highlighter> | null = null;

async function getHighlighter(): Promise<Highlighter> {
    if (!highlighterPromise) {
        highlighterPromise = createHighlighter({
            themes: ["one-dark-pro"],
            langs: ["tsx", "typescript", "bash", "json"],
        });
    }
    return highlighterPromise;
}

export async function highlight(
    code: string,
    lang: "tsx" | "typescript" | "bash" | "json" = "tsx"
): Promise<string> {
    const h = await getHighlighter();
    return h.codeToHtml(code.trim(), { lang, theme: "one-dark-pro" });
}
