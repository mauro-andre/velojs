import { CodeWindow } from "./CodeWindow.js";
import { useInView } from "./useInView.js";
import * as css from "./WritingShowcase.css.js";

export interface WritingShowcaseProps {
    /** Pre-highlighted HTML for the Stats.tsx code block. */
    codeHtml: string;
}

/**
 * §3 — Real code for the first time.
 *
 * After §2 teaches the concept, this section shows what writing a real VeloJS
 * component actually looks like: one file with `loader`, `action_*`, and
 * `Component` co-located. Three short takeaway cards anchor the payoff.
 */
export function WritingShowcase({ codeHtml }: WritingShowcaseProps) {
    const [codeRef, codeVisible] = useInView<HTMLDivElement>(0.2);
    const [takeawaysRef, takeawaysVisible] = useInView<HTMLDivElement>(0.2);

    return (
        <section class={css.section}>
            <div class={css.header}>
                <h2 class={css.title}>What writing VeloJS feels like</h2>
                <p class={css.subtitle}>
                    A real component. The loader fetches, the action mutates, the
                    Component renders — all in the same file, all in TypeScript.
                </p>
            </div>

            <div
                ref={codeRef}
                class={`${css.codeWrap} ${codeVisible ? css.codeVisible : css.codeHidden}`}
            >
                <CodeWindow filename="app/Products.tsx" html={codeHtml} />
            </div>

            <div
                ref={takeawaysRef}
                class={takeawaysVisible ? css.takeawaysVisible : css.takeawaysHidden}
            >
                <div class={css.takeaways}>
                    <div class={css.takeaway}>
                        <span class={css.takeawayDot} />
                        <div class={css.takeawayText}>
                            <h3 class={css.takeawayTitle}>No fetch, no endpoints</h3>
                            <p class={css.takeawayDesc}>
                                The button calls <code>action_toggleActiveProduct</code>{" "}
                                directly. The plugin wires the server call for you.
                            </p>
                        </div>
                    </div>
                    <div class={css.takeaway}>
                        <span class={css.takeawayDot} />
                        <div class={css.takeawayText}>
                            <h3 class={css.takeawayTitle}>No duplicated types</h3>
                            <p class={css.takeawayDesc}>
                                The loader returns data. The Component consumes it. Same
                                TypeScript, both sides.
                            </p>
                        </div>
                    </div>
                    <div class={css.takeaway}>
                        <span class={css.takeawayDot} />
                        <div class={css.takeawayText}>
                            <h3 class={css.takeawayTitle}>No glue code</h3>
                            <p class={css.takeawayDesc}>
                                No request handlers, no zod schemas, no React Query. You
                                write logic; velojs does the plumbing.
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}
