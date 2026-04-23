import { useSignal } from "@preact/signals";
import { CodeWindow } from "./CodeWindow.js";
import { useInView } from "./useInView.js";
import * as css from "./RealtimeShowcase.css.js";

export interface RealtimeShowcaseProps {
    /** Pre-highlighted HTML for the stream_* snippet. */
    streamHtml: string;
    /** Pre-highlighted HTML for the socket_* snippet. */
    socketHtml: string;
}

type TabId = "stream" | "socket";

/**
 * §5 — Real-time primitives.
 *
 * A single tabbed CodeWindow presenting `stream_*` (server-to-client push)
 * and `socket_*` (bidirectional). Same shape as loader/action — declared as
 * exports of a component, auto-routed by convention.
 */
export function RealtimeShowcase({ streamHtml, socketHtml }: RealtimeShowcaseProps) {
    const activeTab = useSignal<TabId>("stream");
    const [codeRef, codeVisible] = useInView<HTMLDivElement>(0.2);
    const [takeawaysRef, takeawaysVisible] = useInView<HTMLDivElement>(0.2);

    const tabStrip = (
        <div class={css.tabStrip}>
            <button
                type="button"
                class={`${css.tab} ${activeTab.value === "stream" ? css.tabActive : ""}`}
                onClick={() => (activeTab.value = "stream")}
                aria-pressed={activeTab.value === "stream"}
            >
                stream_*
            </button>
            <button
                type="button"
                class={`${css.tab} ${activeTab.value === "socket" ? css.tabActive : ""}`}
                onClick={() => (activeTab.value = "socket")}
                aria-pressed={activeTab.value === "socket"}
            >
                socket_*
            </button>
        </div>
    );

    return (
        <section class={css.section}>
            <div class={css.header}>
                <h2 class={css.title}>Real-time, when you need it.</h2>
                <p class={css.subtitle}>
                    Push events with <code>stream_*</code>. Open a bidirectional
                    connection with <code>socket_*</code>. Same shape as loader
                    and action — declare, export, done.
                </p>
            </div>

            <div
                ref={codeRef}
                class={`${css.codeWrap} ${codeVisible ? css.fadeVisible : css.fadeHidden}`}
            >
                <CodeWindow titlebarContent={tabStrip}>
                    <div class={css.bodySlot}>
                        <div
                            class={`${css.slot} ${activeTab.value === "stream" ? css.slotActive : ""}`}
                            dangerouslySetInnerHTML={{ __html: streamHtml }}
                        />
                        <div
                            class={`${css.slot} ${activeTab.value === "socket" ? css.slotActive : ""}`}
                            dangerouslySetInnerHTML={{ __html: socketHtml }}
                        />
                    </div>
                </CodeWindow>
            </div>

            <div
                ref={takeawaysRef}
                class={takeawaysVisible ? css.takeawaysFadeVisible : css.takeawaysFadeHidden}
            >
                <div class={css.takeaways}>
                    <div class={css.takeaway}>
                        <span class={css.takeawayDot} />
                        <div>
                            <h3 class={css.takeawayTitle}>Server pushes to the client</h3>
                            <p class={css.takeawayDesc}>
                                <code>stream_*</code> broadcasts events via SSE. The
                                framework handles the transport; the browser reconnects
                                automatically.
                            </p>
                        </div>
                    </div>
                    <div class={css.takeaway}>
                        <span class={css.takeawayDot} />
                        <div>
                            <h3 class={css.takeawayTitle}>Two-way when it matters</h3>
                            <p class={css.takeawayDesc}>
                                <code>socket_*</code> opens a WebSocket. Client and server
                                speak through the same typed primitive, in the same file.
                            </p>
                        </div>
                    </div>
                    <div class={css.takeaway}>
                        <span class={css.takeawayDot} />
                        <div>
                            <h3 class={css.takeawayTitle}>Same middleware tree</h3>
                            <p class={css.takeawayDesc}>
                                Auth, rate limits — same inheritance as pages and actions.
                                Real-time doesn't break your route structure.
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}
