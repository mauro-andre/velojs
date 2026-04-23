import { style, globalStyle } from "@vanilla-extract/css";
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

export const hero = style({
    maxWidth: "800px",
    margin: "0 auto",
    padding: "160px 24px 100px",
    textAlign: "center",
});

export const heroTitle = style({
    fontSize: "4.5rem",
    fontWeight: 800,
    lineHeight: 1.1,
    marginBottom: "24px",
    background: `linear-gradient(135deg, ${vars.color.text} 0%, ${vars.color.textMuted} 100%)`,
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    "@media": {
        "(max-width: 600px)": {
            fontSize: "2.8rem",
        },
    },
});

export const heroTagline = style({
    fontSize: "1.4rem",
    fontWeight: 600,
    marginBottom: "20px",
    background: `linear-gradient(135deg, ${vars.color.primary}, ${vars.color.accent})`,
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
});

export const heroSubtitle = style({
    fontSize: "1.1rem",
    color: vars.color.textMuted,
    maxWidth: "600px",
    margin: "0 auto 40px",
    lineHeight: 1.7,
});

export const heroActions = style({
    display: "flex",
    gap: "16px",
    justifyContent: "center",
    flexWrap: "wrap",
});

export const btnPrimary = style({
    display: "inline-block",
    padding: "14px 32px",
    borderRadius: vars.radius.md,
    backgroundColor: vars.color.primary,
    color: "#fff",
    fontSize: "1rem",
    fontWeight: 600,
    transition: "background-color 0.15s, transform 0.15s",
    ":hover": {
        backgroundColor: vars.color.primaryHover,
        transform: "translateY(-1px)",
    },
});

export const btnSecondary = style({
    display: "inline-block",
    padding: "14px 32px",
    borderRadius: vars.radius.md,
    border: `1px solid ${vars.color.border}`,
    color: vars.color.textMuted,
    fontSize: "1rem",
    fontWeight: 500,
    transition: "all 0.15s",
    ":hover": {
        borderColor: vars.color.primary,
        color: vars.color.text,
    },
});

// ── Sections ────────────────────────────────────────────────

export const section = style({
    maxWidth: "1100px",
    margin: "0 auto",
    padding: "80px 24px",
});

export const sectionTitle = style({
    fontSize: "2.2rem",
    fontWeight: 800,
    textAlign: "center",
    marginBottom: "12px",
});

export const sectionSubtitle = style({
    fontSize: "1.05rem",
    color: vars.color.textMuted,
    textAlign: "center",
    maxWidth: "550px",
    margin: "0 auto 48px",
});

// ── Features ────────────────────────────────────────────────

export const featuresGrid = style({
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
    gap: "20px",
});

export const featureCard = style({
    padding: "28px",
    borderRadius: vars.radius.lg,
    backgroundColor: vars.color.bgCard,
    border: `1px solid ${vars.color.border}`,
    transition: "border-color 0.2s, transform 0.2s",
    ":hover": {
        borderColor: vars.color.primary,
        transform: "translateY(-2px)",
    },
});

export const featureIcon = style({
    display: "block",
    marginBottom: "16px",
    color: vars.color.primary,
});

export const featureTitle = style({
    fontSize: "1.1rem",
    fontWeight: 700,
    marginBottom: "8px",
});

export const featureDesc = style({
    fontSize: "0.9rem",
    color: vars.color.textMuted,
    lineHeight: 1.6,
});

// ── Code Section ────────────────────────────────────────────

export const codeGrid = style({
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(400px, 1fr))",
    gap: "20px",
    "@media": {
        "(max-width: 600px)": {
            gridTemplateColumns: "1fr",
        },
    },
});

export const codeCard = style({
    borderRadius: vars.radius.lg,
    backgroundColor: vars.color.bgCard,
    border: `1px solid ${vars.color.border}`,
    overflow: "hidden",
});

export const codeCardHeader = style({
    padding: "12px 20px",
    fontSize: "0.8rem",
    fontWeight: 600,
    color: vars.color.textMuted,
    borderBottom: `1px solid ${vars.color.border}`,
});

export const codeBlock = style({
    padding: "20px",
    fontSize: "0.85rem",
    lineHeight: 1.7,
    fontFamily: vars.font.mono,
    color: vars.color.text,
    overflowX: "auto",
});

globalStyle(`${codeBlock} .keyword`, { color: vars.color.accent });
globalStyle(`${codeBlock} .string`, { color: "#51cf66" });
globalStyle(`${codeBlock} .comment`, { color: vars.color.textMuted });
globalStyle(`${codeBlock} .type`, { color: vars.color.primary });
globalStyle(`${codeBlock} .function`, { color: "#ffd43b" });

// ── Install ─────────────────────────────────────────────────

export const installSection = style({
    maxWidth: "600px",
    margin: "0 auto",
    padding: "60px 24px 80px",
    textAlign: "center",
});

export const installCode = style({
    display: "inline-block",
    padding: "16px 32px",
    borderRadius: vars.radius.md,
    backgroundColor: vars.color.bgCard,
    border: `1px solid ${vars.color.border}`,
    fontFamily: vars.font.mono,
    fontSize: "1rem",
    color: vars.color.primary,
    marginTop: "24px",
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
