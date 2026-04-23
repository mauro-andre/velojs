import { style, keyframes } from "@vanilla-extract/css";
import { vars } from "../styles/theme.css.js";

// ── Section layout ─────────────────────────────────────────

export const section = style({
    position: "relative",
    maxWidth: "60rem",
    margin: "0 auto",
    padding: "6rem 1.5rem 5rem",
    textAlign: "center",
});

export const title = style({
    fontSize: "2.5rem",
    fontWeight: 800,
    lineHeight: 1.15,
    letterSpacing: "-0.02em",
    marginBottom: "2.5rem",
    background: `linear-gradient(135deg, ${vars.color.text} 0%, ${vars.color.textMuted} 100%)`,
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    "@media": {
        "(max-width: 40rem)": { fontSize: "1.875rem" },
    },
});

// ── Install terminal wrapper ──────────────────────────────

export const terminalWrap = style({
    maxWidth: "32rem",
    margin: "0 auto 2.5rem",
});

// ── Titlebar contents (label + copy button) ──────────────

export const tbStrip = style({
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: "0.5rem",
    paddingRight: 0,
});

export const tbLabel = style({
    fontFamily: vars.font.mono,
    fontSize: "0.75rem",
    fontWeight: 500,
    color: vars.color.textMuted,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
});

export const copyBtn = style({
    fontFamily: vars.font.mono,
    fontSize: "0.7rem",
    fontWeight: 600,
    color: vars.color.textMuted,
    background: "transparent",
    border: `0.0625rem solid ${vars.color.border}`,
    borderRadius: "0.375rem",
    padding: "0.25rem 0.625rem",
    cursor: "pointer",
    transition: "color 0.2s, border-color 0.2s, background-color 0.2s",
    ":hover": {
        color: vars.color.text,
        borderColor: vars.color.primary,
        backgroundColor: "rgba(108, 140, 255, 0.08)",
    },
});

export const copyBtnCopied = style({
    color: vars.color.primary,
    borderColor: vars.color.primary,
    backgroundColor: "rgba(108, 140, 255, 0.12)",
});

// ── Command body ───────────────────────────────────────────

export const command = style({
    display: "flex",
    alignItems: "center",
    gap: "0.625rem",
    padding: "1.25rem 1.375rem",
    fontFamily: vars.font.mono,
    fontSize: "0.95rem",
    color: vars.color.text,
    overflowX: "auto",
    whiteSpace: "nowrap",
});

export const prompt = style({
    color: vars.color.primary,
    userSelect: "none",
    fontWeight: 700,
});

// ── CTAs ───────────────────────────────────────────────────

const ctaPulse = keyframes({
    "0%, 100%": {
        boxShadow: `0 0 0 0 rgba(108, 140, 255, 0.45), 0 0.25rem 1rem rgba(108, 140, 255, 0.25)`,
    },
    "50%": {
        boxShadow: `0 0 0 0.5rem rgba(108, 140, 255, 0), 0 0.25rem 1rem rgba(108, 140, 255, 0.3)`,
    },
});

export const actions = style({
    display: "flex",
    gap: "1rem",
    justifyContent: "center",
    flexWrap: "wrap",
});

export const btnPrimary = style({
    display: "inline-block",
    padding: "0.875rem 2rem",
    borderRadius: vars.radius.md,
    backgroundColor: vars.color.primary,
    color: "#fff",
    fontSize: "1rem",
    fontWeight: 600,
    transition: "background-color 0.15s, transform 0.15s",
    animation: `${ctaPulse} 3.2s ease-in-out infinite`,
    ":hover": {
        backgroundColor: vars.color.primaryHover,
        transform: "translateY(-0.0625rem)",
    },
    "@media": {
        "(prefers-reduced-motion: reduce)": {
            animation: "none",
            boxShadow: `0 0.25rem 1rem rgba(108, 140, 255, 0.3)`,
        },
    },
});

export const btnSecondary = style({
    display: "inline-block",
    padding: "0.875rem 2rem",
    borderRadius: vars.radius.md,
    border: `0.0625rem solid ${vars.color.border}`,
    color: vars.color.textMuted,
    fontSize: "1rem",
    fontWeight: 500,
    transition: "all 0.15s",
    ":hover": {
        borderColor: vars.color.primary,
        color: vars.color.text,
    },
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
