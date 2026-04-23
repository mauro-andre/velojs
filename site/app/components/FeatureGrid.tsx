import type { ComponentType, JSX } from "preact";
import { useInView } from "./useInView.js";
import * as css from "./FeatureGrid.css.js";

export interface Feature {
    Icon: ComponentType<{ size?: number; class?: string }>;
    title: string;
    desc: string;
}

export interface FeatureGridProps {
    features: Feature[];
    title?: string;
    subtitle?: string;
}

/**
 * §6 — Feature grid with mouse-follow spotlight per card.
 *
 * Each card carries CSS custom properties `--mouse-x`/`--mouse-y` updated on
 * mousemove; a `::before` pseudo paints a radial gradient at that position so
 * the highlight tracks the cursor. Cards stagger-fade-in when the section
 * enters the viewport.
 */
export function FeatureGrid({
    features,
    title = "Everything else, included.",
    subtitle = "No plugins to add, no escape hatches. The platform under the framework is already production-ready.",
}: FeatureGridProps) {
    const [ref, visible] = useInView<HTMLDivElement>(0.15);

    const handleMove: JSX.MouseEventHandler<HTMLDivElement> = (e) => {
        const card = e.currentTarget;
        const rect = card.getBoundingClientRect();
        card.style.setProperty("--mouse-x", `${e.clientX - rect.left}px`);
        card.style.setProperty("--mouse-y", `${e.clientY - rect.top}px`);
    };

    return (
        <section class={css.section}>
            <div class={css.header}>
                <h2 class={css.title}>{title}</h2>
                <p class={css.subtitle}>{subtitle}</p>
            </div>
            <div ref={ref} class={css.grid}>
                {features.map((f, i) => (
                    <div
                        key={f.title}
                        class={`${css.card} ${visible ? css.cardVisible : ""}`}
                        style={{ transitionDelay: `${i * 0.06}s` }}
                        onMouseMove={handleMove}
                    >
                        <f.Icon class={css.cardIcon} size={28} />
                        <h3 class={css.cardTitle}>{f.title}</h3>
                        <p class={css.cardDesc}>{f.desc}</p>
                    </div>
                ))}
            </div>
        </section>
    );
}
