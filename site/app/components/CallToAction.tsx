import { useSignal } from "@preact/signals";
import { Link } from "../../../src/components.js";
import { CodeWindow } from "./CodeWindow.js";
import { useInView } from "./useInView.js";
import * as css from "./CallToAction.css.js";

const INSTALL_COMMAND = "npx @mauroandre/velojs init my-app";

/**
 * §7 — Closing call to action.
 *
 * A short headline, a Mac-styled terminal showing the install command with
 * copy-on-click, and primary/secondary CTAs. Lives at the bottom of the
 * landing as the final conversion moment.
 */
export function CallToAction() {
    const [ref, visible] = useInView<HTMLDivElement>(0.2);
    const copied = useSignal(false);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(INSTALL_COMMAND);
            copied.value = true;
            setTimeout(() => {
                copied.value = false;
            }, 1500);
        } catch {
            // Clipboard not available — silently no-op
        }
    };

    const titlebar = (
        <div class={css.tbStrip}>
            <span class={css.tbLabel}>bash</span>
            <button
                type="button"
                class={`${css.copyBtn} ${copied.value ? css.copyBtnCopied : ""}`}
                onClick={handleCopy}
                aria-label="Copy install command"
            >
                {copied.value ? "Copied" : "Copy"}
            </button>
        </div>
    );

    return (
        <section class={css.section}>
            <div ref={ref} class={visible ? css.fadeVisible : css.fadeHidden}>
                <h2 class={css.title}>Get from zero to running in seconds.</h2>

                <div class={css.terminalWrap}>
                    <CodeWindow titlebarContent={titlebar}>
                        <div class={css.command}>
                            <span class={css.prompt}>$</span>
                            <span>{INSTALL_COMMAND}</span>
                        </div>
                    </CodeWindow>
                </div>

                <div class={css.actions}>
                    <Link to="/docs/getting-started" class={css.btnPrimary}>
                        Read the docs
                    </Link>
                    <a
                        href="https://github.com/mauro-andre/velojs"
                        target="_blank"
                        class={css.btnSecondary}
                    >
                        View on GitHub
                    </a>
                </div>
            </div>
        </section>
    );
}
