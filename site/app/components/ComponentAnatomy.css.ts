import { style, keyframes, globalStyle } from "@vanilla-extract/css";
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
    margin: "0 auto 4rem",
});

export const title = style({
    fontSize: "2.75rem",
    fontWeight: 800,
    lineHeight: 1.1,
    letterSpacing: "-0.02em",
    marginBottom: "1.25rem",
    background: `linear-gradient(135deg, ${vars.color.text} 0%, ${vars.color.textMuted} 100%)`,
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    "@media": {
        "(max-width: 40rem)": { fontSize: "2rem" },
    },
});

export const subtitle = style({
    fontSize: "1.1rem",
    color: vars.color.textMuted,
    lineHeight: 1.65,
});

// ── Entry animation ─────────────────────────────────────────

const entryTransition = {
    transition:
        "opacity 0.7s cubic-bezier(0.2, 0.8, 0.2, 1), transform 0.7s cubic-bezier(0.2, 0.8, 0.2, 1)",
} as const;

export const diagramHidden = style({
    ...entryTransition,
    opacity: 0,
    transform: "translateY(2rem)",
});

export const diagramVisible = style({
    ...entryTransition,
    opacity: 1,
    transform: "translateY(0)",
});

export const whyGridHidden = style({
    ...entryTransition,
    transitionDelay: "0.25s",
    opacity: 0,
    transform: "translateY(1.5rem)",
});

export const whyGridVisible = style({
    ...entryTransition,
    transitionDelay: "0.25s",
    opacity: 1,
    transform: "translateY(0)",
});

// ── File card ──────────────────────────────────────────────

const cardGlowPulse = keyframes({
    "0%, 100%": {
        boxShadow: `
            0 0.5rem 1.5rem rgba(0, 0, 0, 0.3),
            0 0 2rem rgba(108, 140, 255, 0.06),
            0 0 4rem rgba(167, 139, 250, 0.04)
        `,
    },
    "50%": {
        boxShadow: `
            0 0.5rem 1.5rem rgba(0, 0, 0, 0.3),
            0 0 3rem rgba(108, 140, 255, 0.14),
            0 0 6rem rgba(167, 139, 250, 0.08)
        `,
    },
});

export const fileCard = style({
    position: "relative",
    maxWidth: "32rem",
    margin: "0 auto",
    padding: "1.5rem",
    borderRadius: vars.radius.lg,
    backgroundColor: vars.color.bgCard,
    border: `0.0625rem solid ${vars.color.border}`,
    animation: `${cardGlowPulse} 4s ease-in-out infinite`,
    "@media": {
        "(prefers-reduced-motion: reduce)": {
            animation: "none",
            boxShadow: `0 0.5rem 1.5rem rgba(0, 0, 0, 0.3)`,
        },
    },
});

export const fileCardHeader = style({
    display: "flex",
    alignItems: "center",
    gap: "0.625rem",
    marginBottom: "1.25rem",
    paddingBottom: "0.875rem",
    borderBottom: `0.0625rem solid ${vars.color.border}`,
});

export const fileCardDot = style({
    width: "0.5rem",
    height: "0.5rem",
    borderRadius: "50%",
    background: `linear-gradient(135deg, ${vars.color.primary}, ${vars.color.accent})`,
    boxShadow: `0 0 0.5rem rgba(108, 140, 255, 0.6)`,
});

export const fileCardName = style({
    fontFamily: vars.font.mono,
    fontSize: "0.9rem",
    fontWeight: 500,
    color: vars.color.text,
});

// ── Inner blocks ───────────────────────────────────────────

export const blockList = style({
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
});

export const block = style({
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    padding: "0.875rem 1rem",
    borderRadius: vars.radius.md,
    backgroundColor: "rgba(255, 255, 255, 0.02)",
    border: `0.0625rem solid ${vars.color.border}`,
    transition:
        "border-color 0.2s, transform 0.2s, background-color 0.2s",
    ":hover": {
        borderColor: vars.color.primary,
        backgroundColor: "rgba(108, 140, 255, 0.04)",
        transform: "translateY(-0.0625rem)",
    },
});

// Left column: name on top, short description below.
export const blockText = style({
    display: "flex",
    flexDirection: "column",
    gap: "0.125rem",
    minWidth: 0, // lets the description wrap cleanly
});

export const blockLabel = style({
    fontFamily: vars.font.mono,
    fontSize: "1rem",
    fontWeight: 500,
    color: vars.color.text,
    lineHeight: 1.2,
});

export const blockDesc = style({
    fontSize: "0.78rem",
    color: vars.color.textMuted,
    lineHeight: 1.4,
});

// Small chips inside the Component block showing the APIs the UI consumes
// (useLoader and action_*). Visually links Component ↓ loader/action_* above.
export const hookPills = style({
    display: "flex",
    flexWrap: "wrap",
    gap: "0.375rem",
    marginTop: "0.5rem",
});

export const hookPill = style({
    fontFamily: vars.font.mono,
    fontSize: "0.68rem",
    fontWeight: 500,
    color: vars.color.text,
    padding: "0.1875rem 0.5rem",
    borderRadius: "0.375rem",
    border: `0.0625rem solid ${vars.color.border}`,
    background: "rgba(255, 255, 255, 0.03)",
    letterSpacing: "0.01em",
});

// ── Badges (SSR / SSG) ─────────────────────────────────────

export const badges = style({
    display: "flex",
    gap: "0.375rem",
    flexShrink: 0,
});

const badgeBase = {
    fontFamily: vars.font.mono,
    fontSize: "0.65rem",
    fontWeight: 700,
    letterSpacing: "0.08em",
    padding: "0.25rem 0.5rem",
    borderRadius: "999px",
    border: "0.0625rem solid",
} as const;

export const badgeSSR = style({
    ...badgeBase,
    color: vars.color.primary,
    borderColor: "rgba(108, 140, 255, 0.35)",
    background: "rgba(108, 140, 255, 0.08)",
});

export const badgeSSG = style({
    ...badgeBase,
    color: vars.color.accent,
    borderColor: "rgba(167, 139, 250, 0.35)",
    background: "rgba(167, 139, 250, 0.08)",
});

// ── Connectors SVG ─────────────────────────────────────────

export const connectors = style({
    display: "block",
    width: "100%",
    maxWidth: "36rem",
    height: "6rem",
    margin: "0 auto",
});

// ── Bundles ────────────────────────────────────────────────

export const bundles = style({
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "3rem",
    maxWidth: "36rem",
    margin: "0 auto",
    "@media": {
        "(max-width: 30rem)": {
            gap: "1rem",
        },
    },
});

const bundleBase = {
    padding: "1rem 1.25rem",
    borderRadius: vars.radius.md,
    textAlign: "center",
    border: "0.0625rem solid",
    fontFamily: vars.font.mono,
    fontSize: "0.85rem",
    fontWeight: 500,
    letterSpacing: "0.02em",
} as const;

export const bundleServer = style({
    ...bundleBase,
    color: vars.color.accent,
    borderColor: "rgba(167, 139, 250, 0.35)",
    background: "rgba(167, 139, 250, 0.05)",
});

export const bundleClient = style({
    ...bundleBase,
    color: vars.color.primary,
    borderColor: "rgba(108, 140, 255, 0.35)",
    background: "rgba(108, 140, 255, 0.05)",
});

// ── Why cards ──────────────────────────────────────────────

export const whyGrid = style({
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: "1.25rem",
    maxWidth: "60rem",
    margin: "5rem auto 0",
    "@media": {
        "(max-width: 48rem)": {
            gridTemplateColumns: "1fr",
        },
    },
});

export const whyCard = style({
    padding: "1.75rem",
    borderRadius: vars.radius.lg,
    backgroundColor: vars.color.bgCard,
    border: `0.0625rem solid ${vars.color.border}`,
    transition: "border-color 0.25s, transform 0.25s, background-color 0.25s",
    ":hover": {
        borderColor: vars.color.primary,
        backgroundColor: vars.color.bgCardHover,
        transform: "translateY(-0.125rem)",
    },
});

export const whyTitle = style({
    fontSize: "1.05rem",
    fontWeight: 700,
    marginBottom: "0.75rem",
    color: vars.color.text,
    letterSpacing: "-0.01em",
});

export const whyDesc = style({
    fontSize: "0.9rem",
    color: vars.color.textMuted,
    lineHeight: 1.65,
});

// ── SVG path styling ───────────────────────────────────────
// Each line breathes in its own color — opacity + glow oscillate slowly
// so the wires feel alive without implying a "data flow" direction.

const linePulse = keyframes({
    "0%, 100%": {
        opacity: 0.45,
        filter: `drop-shadow(0 0 0.125rem rgba(108, 140, 255, 0.3))`,
    },
    "50%": {
        opacity: 1,
        filter: `drop-shadow(0 0 0.5rem currentColor)`,
    },
});

const pulseBase = {
    fill: "none",
    strokeWidth: "1.5",
    strokeLinecap: "round" as const,
    animationName: linePulse,
    animationDuration: "3s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
} as const;

export const pulseServer = style({
    ...pulseBase,
    stroke: vars.color.accent,
    color: vars.color.accent,
    "@media": {
        "(prefers-reduced-motion: reduce)": {
            animation: "none",
            opacity: 0.5,
            filter: "none",
        },
    },
});

export const pulseClient = style({
    ...pulseBase,
    stroke: vars.color.primary,
    color: vars.color.primary,
    // Offset so the two wires breathe out of phase — never both at peak/trough
    animationDelay: "1.5s",
    "@media": {
        "(prefers-reduced-motion: reduce)": {
            animation: "none",
            opacity: 0.5,
            filter: "none",
        },
    },
});
