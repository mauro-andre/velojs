import * as css from "./ComponentAnatomy.css.js";
import { useInView } from "./useInView.js";

/**
 * §2 — Anatomy of a VeloJS component.
 *
 * A zero-code visual telling the core story: one file holds `loader`, `action_*`,
 * and the `Component`; the plugin splits server from client at build time; the
 * CLI picks SSR or SSG. Three "why" cards anchor the takeaways.
 */
export function ComponentAnatomy() {
    const [ref, visible] = useInView<HTMLDivElement>(0.25);

    return (
        <section class={css.section}>
            <div class={css.header}>
                <h2 class={css.title}>One component. SSR or SSG, same code.</h2>
                <p class={css.subtitle}>
                    Loader, action, and UI live in the same file. The plugin splits
                    server from client at build time; the CLI picks SSR or SSG.
                    Business logic travels with the UI that uses it.
                </p>
            </div>

            <div
                ref={ref}
                class={visible ? css.diagramVisible : css.diagramHidden}
            >
                {/* File card — the component */}
                <div class={css.fileCard}>
                    <div class={css.fileCardHeader}>
                        <span class={css.fileCardDot} />
                        <span class={css.fileCardName}>Dashboard.tsx</span>
                    </div>
                    <div class={css.blockList}>
                        <div class={css.block}>
                            <div class={css.blockText}>
                                <span class={css.blockLabel}>loader</span>
                                <span class={css.blockDesc}>
                                    Loads data from the server before the UI renders
                                </span>
                            </div>
                            <div class={css.badges}>
                                <span class={css.badgeSSR}>SSR</span>
                                <span class={css.badgeSSG}>SSG</span>
                            </div>
                        </div>
                        <div class={css.block}>
                            <div class={css.blockText}>
                                <span class={css.blockLabel}>action_*</span>
                                <span class={css.blockDesc}>
                                    Call server code from the UI like a local function
                                </span>
                            </div>
                            <div class={css.badges}>
                                <span class={css.badgeSSR}>SSR</span>
                            </div>
                        </div>
                        <div class={css.block}>
                            <div class={css.blockText}>
                                <span class={css.blockLabel}>Component</span>
                                <span class={css.blockDesc}>
                                    Your UI — rendered on the server, hydrated on the client
                                </span>
                                <div class={css.hookPills}>
                                    <span class={css.hookPill}>useLoader()</span>
                                    <span class={css.hookPill}>action_*()</span>
                                </div>
                            </div>
                            <div class={css.badges}>
                                <span class={css.badgeSSR}>SSR</span>
                                <span class={css.badgeSSG}>SSG</span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Flow connectors — each line breathes in its own color */}
                <svg
                    class={css.connectors}
                    viewBox="0 0 100 40"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                >
                    <path
                        class={css.pulseServer}
                        d="M 50 0 C 50 22, 25 18, 25 40"
                        vector-effect="non-scaling-stroke"
                    />
                    <path
                        class={css.pulseClient}
                        d="M 50 0 C 50 22, 75 18, 75 40"
                        vector-effect="non-scaling-stroke"
                    />
                </svg>

                {/* Bundles — destinations */}
                <div class={css.bundles}>
                    <div class={css.bundleServer}>server bundle</div>
                    <div class={css.bundleClient}>client bundle</div>
                </div>
            </div>

            <div class={visible ? css.whyGridVisible : css.whyGridHidden}>
                <div class={css.whyGrid}>
                    <div class={css.whyCard}>
                        <h3 class={css.whyTitle}>
                            Same component, same business rules
                        </h3>
                        <p class={css.whyDesc}>
                            Data fetching, mutations, and UI live side by side in the
                            same file. Business rules stay where they belong — next
                            to the UI that uses them.
                        </p>
                    </div>
                    <div class={css.whyCard}>
                        <h3 class={css.whyTitle}>Zero path mapping</h3>
                        <p class={css.whyDesc}>
                            Routes are generated automatically. Export a function, the
                            framework registers it. No path mapping, no handler
                            plumbing, nothing to wire by hand.
                        </p>
                    </div>
                    <div class={css.whyCard}>
                        <h3 class={css.whyTitle}>SSR or SSG, same code</h3>
                        <p class={css.whyDesc}>
                            Ship dynamic or pre-rendered with one flag. Same
                            component, same loader, same TypeScript — the build mode
                            doesn't change what you write.
                        </p>
                    </div>
                </div>
            </div>
        </section>
    );
}
