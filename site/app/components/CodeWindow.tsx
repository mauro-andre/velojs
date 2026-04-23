import type { ComponentChildren } from "preact";
import * as css from "./CodeWindow.css.js";

export interface CodeWindowProps {
    /** Text shown in the title bar. Ignored when `titlebarContent` is passed. */
    filename?: string;
    /**
     * Custom node for the title bar (e.g. tabs). When present, replaces the
     * centered filename. The three dots on the left are always rendered.
     */
    titlebarContent?: ComponentChildren;
    /** Pre-highlighted HTML (from shiki `highlight()`). */
    html?: string;
    /** Alternative: custom children (e.g. multiple slots) rendered as the body. */
    children?: ComponentChildren;
    /** Extra class on the outer wrapper. */
    class?: string;
}

/**
 * macOS-style window frame for code snippets.
 *
 * Renders three dots in the title bar, then either a centered filename or a
 * custom `titlebarContent`. The body accepts pre-highlighted shiki HTML (via
 * `html`) or arbitrary children. The wrapper has a subtle animated
 * conic-gradient border glow + floating shadow.
 */
export function CodeWindow({
    filename,
    titlebarContent,
    html,
    children,
    class: className,
}: CodeWindowProps) {
    const wrapperClass = className ? `${css.wrapper} ${className}` : css.wrapper;
    return (
        <div class={wrapperClass}>
            <div class={css.titleBar}>
                <div class={css.dots}>
                    <span class={css.dotRed} />
                    <span class={css.dotYellow} />
                    <span class={css.dotGreen} />
                </div>
                {titlebarContent ?? <span class={css.filename}>{filename ?? ""}</span>}
            </div>
            <div class={css.body}>
                {html ? <div dangerouslySetInnerHTML={{ __html: html }} /> : children}
            </div>
        </div>
    );
}
