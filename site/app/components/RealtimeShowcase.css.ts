import { style, globalStyle } from "@vanilla-extract/css";
import { vars } from "../styles/theme.css.js";

// ── Section layout ─────────────────────────────────────────

export const section = style({
    position: "relative",
    maxWidth: "72rem",
    margin: "0 auto",
    padding: "4rem 1.5rem 3rem",
});

export const header = style({
    textAlign: "center",
    maxWidth: "42rem",
    margin: "0 auto 2.5rem",
});

export const title = style({
    fontSize: "2.25rem",
    fontWeight: 800,
    lineHeight: 1.15,
    letterSpacing: "-0.02em",
    marginBottom: "1rem",
    background: `linear-gradient(135deg, ${vars.color.text} 0%, ${vars.color.textMuted} 100%)`,
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    "@media": {
        "(max-width: 40rem)": { fontSize: "1.75rem" },
    },
});

export const subtitle = style({
    fontSize: "1rem",
    color: vars.color.textMuted,
    lineHeight: 1.65,
});

// ── CodeWindow wrapper (centered, narrower than §3/§4) ────

export const codeWrap = style({
    maxWidth: "42rem",
    margin: "0 auto",
});

// ── Entry animation ─────────────────────────────────────────

const entryTransition = {
    transition:
        "opacity 0.7s cubic-bezier(0.2, 0.8, 0.2, 1), transform 0.7s cubic-bezier(0.2, 0.8, 0.2, 1)",
} as const;

export const fadeHidden = style({
    ...entryTransition,
    opacity: 0,
    transform: "translateY(1.5rem)",
});

export const fadeVisible = style({
    ...entryTransition,
    opacity: 1,
    transform: "translateY(0)",
});

export const takeawaysFadeHidden = style({
    ...entryTransition,
    transitionDelay: "0.2s",
    opacity: 0,
    transform: "translateY(1rem)",
});

export const takeawaysFadeVisible = style({
    ...entryTransition,
    transitionDelay: "0.2s",
    opacity: 1,
    transform: "translateY(0)",
});

// ── Tab strip (sits inside the CodeWindow titlebar) ───────

export const tabStrip = style({
    flex: 1,
    display: "flex",
    justifyContent: "center",
    alignItems: "stretch",
    gap: "0.25rem",
    // Balance the dots on the left so tabs appear centered
    paddingRight: "3.1875rem",
});

export const tab = style({
    position: "relative",
    fontFamily: vars.font.mono,
    fontSize: "0.8rem",
    fontWeight: 500,
    color: vars.color.textMuted,
    background: "transparent",
    border: "none",
    padding: "0.375rem 0.875rem",
    borderRadius: vars.radius.sm,
    cursor: "pointer",
    transition: "color 0.2s",
    ":hover": {
        color: vars.color.text,
    },
});

export const tabActive = style({
    color: vars.color.text,
    selectors: {
        // Animated underline via pseudo-element — gradient matches brand
        "&::after": {
            content: '""',
            position: "absolute",
            left: "0.5rem",
            right: "0.5rem",
            bottom: "-0.5rem",
            height: "0.125rem",
            borderRadius: "999px",
            background: `linear-gradient(90deg, ${vars.color.primary}, ${vars.color.accent})`,
            boxShadow: `0 0 0.375rem rgba(108, 140, 255, 0.5)`,
        },
    },
});

// ── Body slots — both snippets stacked, crossfade by opacity ──
// Using CSS Grid with both slots on `grid-area: 1 / 1 / 2 / 2` makes them
// occupy the same cell. The cell sizes to the TALLER slot, so switching tabs
// never changes the container height — no jump.

export const bodySlot = style({
    display: "grid",
});

export const slot = style({
    gridArea: "1 / 1 / 2 / 2",
    minWidth: 0, // grid items default to min-content; allow shrinking
    opacity: 0,
    visibility: "hidden",
    transition: "opacity 0.22s ease, visibility 0s 0.22s",
    pointerEvents: "none",
});

export const slotActive = style({
    opacity: 1,
    visibility: "visible",
    pointerEvents: "auto",
    transition: "opacity 0.22s ease",
});

// Reset shiki's inline styles so they match our theme
globalStyle(`${slot} pre`, {
    margin: 0,
    padding: "1.25rem 1.375rem",
    background: "transparent !important",
    fontFamily: vars.font.mono,
    fontSize: "0.85rem",
    lineHeight: 1.6,
    overflowX: "auto",
});

// ── Takeaways ──────────────────────────────────────────────

export const takeaways = style({
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: "1rem",
    maxWidth: "60rem",
    margin: "2.5rem auto 0",
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

export const takeawayDot = style({
    width: "0.5rem",
    height: "0.5rem",
    borderRadius: "50%",
    flexShrink: 0,
    marginTop: "0.5rem",
    background: `linear-gradient(135deg, ${vars.color.primary}, ${vars.color.accent})`,
    boxShadow: `0 0 0.5rem rgba(108, 140, 255, 0.4)`,
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
