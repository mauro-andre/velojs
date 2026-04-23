import * as css from "./AmbientBackground.css.js";

/**
 * Fixed-viewport ambient background with a subtle dot grid and three slowly
 * drifting colored blobs. Zero JS — pure CSS animation that respects
 * `prefers-reduced-motion`.
 *
 * Mount once near the top of a page. Lives behind content via `z-index: -1`
 * and ignores pointer events, so it never interferes with interactions.
 */
export function AmbientBackground() {
    return (
        <div class={css.ambient} aria-hidden="true">
            <div class={css.blob1} />
            <div class={css.blob2} />
            <div class={css.blob3} />
            <div class={css.dotGrid} />
        </div>
    );
}
