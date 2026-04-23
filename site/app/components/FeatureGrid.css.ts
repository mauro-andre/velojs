import { style } from "@vanilla-extract/css";
import { vars } from "../styles/theme.css.js";

// ── Section layout ─────────────────────────────────────────

export const section = style({
    position: "relative",
    maxWidth: "72rem",
    margin: "0 auto",
    padding: "5rem 1.5rem 4rem",
});

export const header = style({
    textAlign: "center",
    maxWidth: "42rem",
    margin: "0 auto 3rem",
});

export const title = style({
    fontSize: "2.5rem",
    fontWeight: 800,
    lineHeight: 1.15,
    letterSpacing: "-0.02em",
    marginBottom: "1rem",
    background: `linear-gradient(135deg, ${vars.color.text} 0%, ${vars.color.textMuted} 100%)`,
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    "@media": {
        "(max-width: 40rem)": { fontSize: "1.875rem" },
    },
});

export const subtitle = style({
    fontSize: "1.05rem",
    color: vars.color.textMuted,
    lineHeight: 1.65,
});

// ── Grid ───────────────────────────────────────────────────

export const grid = style({
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: "1.25rem",
    maxWidth: "60rem",
    margin: "0 auto",
    "@media": {
        "(max-width: 56rem)": { gridTemplateColumns: "repeat(2, 1fr)" },
        "(max-width: 36rem)": { gridTemplateColumns: "1fr" },
    },
});

// ── Card ───────────────────────────────────────────────────
// Hidden by default. The IntersectionObserver in the parent flips on the
// `cardVisible` class, which transitions opacity + translate. `translate` is
// a separate CSS property from `transform`, so the entry's translate doesn't
// fight the hover's `transform: translateY(...)`.

export const card = style({
    position: "relative",
    padding: "1.75rem",
    borderRadius: vars.radius.lg,
    backgroundColor: vars.color.bgCard,
    border: `0.0625rem solid ${vars.color.border}`,
    overflow: "hidden",
    cursor: "default",
    // Default state: hidden + offset down (entry waits for IO)
    opacity: 0,
    translate: "0 1rem",
    transition: `
        opacity 0.6s cubic-bezier(0.2, 0.8, 0.2, 1),
        translate 0.6s cubic-bezier(0.2, 0.8, 0.2, 1),
        border-color 0.25s,
        transform 0.25s,
        background-color 0.25s
    `,
    // CSS custom props for the spotlight follow-mouse effect
    vars: {
        "--mouse-x": "50%",
        "--mouse-y": "50%",
    },
    selectors: {
        // Spotlight pseudo — radial gradient at (--mouse-x, --mouse-y)
        // Sits BEHIND children naturally (DOM order: ::before then children)
        "&::before": {
            content: '""',
            position: "absolute",
            inset: 0,
            background:
                "radial-gradient(circle 14rem at var(--mouse-x) var(--mouse-y), rgba(108, 140, 255, 0.16), transparent 65%)",
            opacity: 0,
            transition: "opacity 0.3s ease",
            pointerEvents: "none",
        },
        "&:hover": {
            borderColor: "rgba(108, 140, 255, 0.45)",
            backgroundColor: vars.color.bgCardHover,
            transform: "translateY(-0.125rem)",
        },
        "&:hover::before": {
            opacity: 1,
        },
    },
    "@media": {
        "(prefers-reduced-motion: reduce)": {
            opacity: 1,
            translate: "0 0",
            transition: "border-color 0.25s, background-color 0.25s",
        },
    },
});

export const cardVisible = style({
    opacity: 1,
    translate: "0 0",
});

// ── Card content ───────────────────────────────────────────

export const cardIcon = style({
    display: "block",
    color: vars.color.primary,
    marginBottom: "1rem",
    transition: "filter 0.25s, transform 0.25s",
    selectors: {
        // Icon glows + lifts subtly when card is hovered
        [`${card}:hover &`]: {
            filter: `drop-shadow(0 0 0.5rem rgba(108, 140, 255, 0.5))`,
            transform: "translateY(-0.0625rem)",
        },
    },
});

export const cardTitle = style({
    fontSize: "1.05rem",
    fontWeight: 700,
    color: vars.color.text,
    marginBottom: "0.5rem",
    letterSpacing: "-0.01em",
    position: "relative", // ensures it stacks above the spotlight pseudo
});

export const cardDesc = style({
    fontSize: "0.9rem",
    color: vars.color.textMuted,
    lineHeight: 1.6,
    position: "relative", // ensures it stacks above the spotlight pseudo
});
