import { style, keyframes, globalStyle } from "@vanilla-extract/css";
import { vars } from "./styles/theme.css.js";

// ── Nav ─────────────────────────────────────────────────────

export const page = style({
    minHeight: "100vh",
});

export const nav = style({
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    backdropFilter: "blur(12px)",
    backgroundColor: "rgba(10, 10, 15, 0.8)",
    borderBottom: `1px solid ${vars.color.border}`,
});

export const navInner = style({
    maxWidth: "1100px",
    margin: "0 auto",
    padding: "12px 24px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
});

export const logo = style({
    fontSize: "1.4rem",
    fontWeight: 800,
    background: `linear-gradient(135deg, ${vars.color.primary}, ${vars.color.accent})`,
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
});

export const navLinks = style({
    display: "flex",
    alignItems: "center",
    gap: "24px",
});

export const navLink = style({
    fontSize: "0.9rem",
    color: vars.color.textMuted,
    transition: "color 0.15s",
    ":hover": {
        color: vars.color.text,
    },
});

export const navCta = style({
    fontSize: "0.85rem",
    fontWeight: 600,
    padding: "8px 20px",
    borderRadius: vars.radius.md,
    backgroundColor: vars.color.primary,
    color: "#fff",
    transition: "background-color 0.15s",
    ":hover": {
        backgroundColor: vars.color.primaryHover,
    },
});

// ── Hero ────────────────────────────────────────────────────

// Staggered fade-up for the hero elements.
// Each step starts invisible + offset, then animates to its final position
// with an increasing delay so the eye catches each layer sequentially.
const fadeUp = keyframes({
    "0%": {
        opacity: 0,
        transform: "translateY(0.75rem)",
    },
    "100%": {
        opacity: 1,
        transform: "translateY(0)",
    },
});

// Sutil pulse no glow do CTA primário — nunca move o botão.
// A escala fica em 1 (estática), só a intensidade do shadow varia.
const ctaGlowPulse = keyframes({
    "0%, 100%": {
        boxShadow: `0 0 0 0 rgba(108, 140, 255, 0.45), 0 0.25rem 1rem rgba(108, 140, 255, 0.25)`,
    },
    "50%": {
        boxShadow: `0 0 0 0.5rem rgba(108, 140, 255, 0), 0 0.25rem 1rem rgba(108, 140, 255, 0.3)`,
    },
});

export const hero = style({
    maxWidth: "50rem",
    margin: "0 auto",
    padding: "10rem 1.5rem 6rem",
    textAlign: "center",
    position: "relative",
});

// Base para os elementos do hero — começam invisíveis, esperam o delay do step.
const heroAnimBase = {
    opacity: 0,
    animationName: fadeUp,
    animationDuration: "0.7s",
    animationFillMode: "forwards",
    animationTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)",
} as const;

export const heroStep1 = style({ ...heroAnimBase, animationDelay: "0.05s" });
export const heroStep2 = style({ ...heroAnimBase, animationDelay: "0.15s" });
export const heroStep3 = style({ ...heroAnimBase, animationDelay: "0.3s" });
export const heroStep4 = style({ ...heroAnimBase, animationDelay: "0.45s" });
export const heroStep5 = style({ ...heroAnimBase, animationDelay: "0.6s" });

// Eyebrow: VeloJS pequeno, em gradiente, mono — parece um label técnico.
export const heroEyebrow = style({
    display: "inline-block",
    fontFamily: vars.font.mono,
    fontSize: "0.85rem",
    fontWeight: 600,
    letterSpacing: "0.15em",
    textTransform: "uppercase",
    background: `linear-gradient(135deg, ${vars.color.primary}, ${vars.color.accent})`,
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    marginBottom: "1.5rem",
});

// Headline: duas linhas, grande, gradient quente-frio do texto.
export const heroTitle = style({
    fontSize: "4.5rem",
    fontWeight: 800,
    lineHeight: 1.05,
    letterSpacing: "-0.02em",
    marginBottom: "1.5rem",
    "@media": {
        "(max-width: 40rem)": {
            fontSize: "2.75rem",
        },
    },
});

export const heroTitleLine = style({
    display: "block",
    background: `linear-gradient(135deg, ${vars.color.text} 0%, ${vars.color.textMuted} 100%)`,
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
});

// Segunda linha ganha o gradiente do brand (primary → accent) pra dar contraste.
globalStyle(`${heroTitleLine}:last-child`, {
    background: `linear-gradient(135deg, ${vars.color.primary}, ${vars.color.accent})`,
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
});

export const heroSubtitle = style({
    fontSize: "1.15rem",
    color: vars.color.textMuted,
    maxWidth: "38rem",
    margin: "0 auto 2.5rem",
    lineHeight: 1.65,
});

export const heroActions = style({
    display: "flex",
    gap: "1rem",
    justifyContent: "center",
    flexWrap: "wrap",
    marginBottom: "3rem",
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
    animation: `${ctaGlowPulse} 3.2s ease-in-out infinite`,
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

// Pills: scope do velojs listado em chips discretos.
// Font mono pra amarrar com o "eyebrow"; border + bg translúcido.
export const heroPills = style({
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: "0.5rem",
    listStyle: "none",
    padding: 0,
    margin: 0,
});

export const heroPill = style({
    fontFamily: vars.font.mono,
    fontSize: "0.8rem",
    fontWeight: 500,
    color: vars.color.textMuted,
    padding: "0.375rem 0.875rem",
    borderRadius: "999px",
    border: `0.0625rem solid ${vars.color.border}`,
    background: "rgba(255, 255, 255, 0.02)",
    transition: "color 0.2s, border-color 0.2s, background-color 0.2s",
    ":hover": {
        color: vars.color.text,
        borderColor: vars.color.primary,
        background: "rgba(108, 140, 255, 0.08)",
    },
});

// ── Footer ──────────────────────────────────────────────────

export const footer = style({
    borderTop: `1px solid ${vars.color.border}`,
    padding: "48px 24px",
});

export const footerInner = style({
    maxWidth: "1100px",
    margin: "0 auto",
    textAlign: "center",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    alignItems: "center",
});

export const footerLinks = style({
    display: "flex",
    gap: "24px",
});

export const footerLink = style({
    fontSize: "0.9rem",
    color: vars.color.textMuted,
    transition: "color 0.15s",
    ":hover": {
        color: vars.color.text,
    },
});

export const footerCopyright = style({
    fontSize: "0.8rem",
    color: vars.color.textMuted,
    opacity: 0.6,
});
