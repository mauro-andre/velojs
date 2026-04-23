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

export const codeHidden = style({
    ...entryTransition,
    opacity: 0,
    transform: "translateY(2rem)",
});

export const codeVisible = style({
    ...entryTransition,
    opacity: 1,
    transform: "translateY(0)",
});

export const takeawaysHidden = style({
    ...entryTransition,
    transitionDelay: "0.2s",
    opacity: 0,
    transform: "translateY(1.5rem)",
});

export const takeawaysVisible = style({
    ...entryTransition,
    transitionDelay: "0.2s",
    opacity: 1,
    transform: "translateY(0)",
});

// ── CodeWindow wrapper ──────────────────────────────────────

export const codeWrap = style({
    maxWidth: "40rem",
    margin: "0 auto",
});

// ── Takeaways ──────────────────────────────────────────────

export const takeaways = style({
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: "1rem",
    maxWidth: "60rem",
    margin: "3rem auto 0",
    "@media": {
        "(max-width: 48rem)": {
            gridTemplateColumns: "1fr",
        },
    },
});

export const takeaway = style({
    padding: "1.25rem",
    borderRadius: vars.radius.lg,
    backgroundColor: vars.color.bgCard,
    border: `0.0625rem solid ${vars.color.border}`,
    display: "flex",
    gap: "0.75rem",
    alignItems: "flex-start",
    transition: "border-color 0.25s, background-color 0.25s",
    ":hover": {
        borderColor: vars.color.primary,
        backgroundColor: vars.color.bgCardHover,
    },
});

// Small colored bullet on the left to anchor the card
export const takeawayDot = style({
    width: "0.5rem",
    height: "0.5rem",
    borderRadius: "50%",
    flexShrink: 0,
    marginTop: "0.5rem",
    background: `linear-gradient(135deg, ${vars.color.primary}, ${vars.color.accent})`,
    boxShadow: `0 0 0.5rem rgba(108, 140, 255, 0.4)`,
});

export const takeawayText = style({
    minWidth: 0,
});

export const takeawayTitle = style({
    fontSize: "0.95rem",
    fontWeight: 700,
    color: vars.color.text,
    marginBottom: "0.375rem",
    letterSpacing: "-0.01em",
});

export const takeawayDesc = style({
    fontSize: "0.85rem",
    color: vars.color.textMuted,
    lineHeight: 1.55,
});
