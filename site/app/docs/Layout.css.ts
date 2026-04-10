import { style, globalStyle } from "@vanilla-extract/css";
import { vars } from "../styles/theme.css.js";

// ── Layout ──────────────────────────────────────────────────

export const layout = style({
    display: "flex",
    minHeight: "100vh",
});

// ── Sidebar ─────────────────────────────────────────────────

export const sidebar = style({
    width: "280px",
    flexShrink: 0,
    position: "fixed",
    top: 0,
    left: 0,
    bottom: 0,
    backgroundColor: vars.color.bgCard,
    borderRight: `1px solid ${vars.color.border}`,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    zIndex: 50,
    "@media": {
        "(max-width: 768px)": {
            display: "none",
        },
    },
});

export const sidebarVisible = style({
    "@media": {
        "(max-width: 768px)": {
            display: "flex",
        },
    },
});

export const sidebarHeader = style({
    padding: "20px 24px",
    borderBottom: `1px solid ${vars.color.border}`,
});

export const sidebarLogo = style({
    fontSize: "1.2rem",
    fontWeight: 800,
    background: `linear-gradient(135deg, ${vars.color.primary}, ${vars.color.accent})`,
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    cursor: "pointer",
});

export const sidebarNav = style({
    flex: 1,
    padding: "12px 0",
    display: "flex",
    flexDirection: "column",
});

export const sidebarLink = style({
    display: "block",
    padding: "8px 24px",
    fontSize: "0.88rem",
    color: vars.color.textMuted,
    transition: "all 0.15s",
    borderLeft: "2px solid transparent",
    ":hover": {
        color: vars.color.text,
        backgroundColor: vars.color.bgCardHover,
    },
});

export const sidebarLinkActive = style({
    color: vars.color.primary,
    borderLeftColor: vars.color.primary,
    backgroundColor: "rgba(108, 140, 255, 0.06)",
});

export const sidebarFooter = style({
    padding: "16px 24px",
    borderTop: `1px solid ${vars.color.border}`,
    display: "flex",
    flexDirection: "column",
    gap: "8px",
});

export const downloadBtn = style({
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "10px 16px",
    borderRadius: vars.radius.md,
    backgroundColor: vars.color.bg,
    border: `1px solid ${vars.color.border}`,
    color: vars.color.textMuted,
    fontSize: "0.82rem",
    fontWeight: 500,
    cursor: "pointer",
    transition: "all 0.15s",
    textDecoration: "none",
    ":hover": {
        borderColor: vars.color.primary,
        color: vars.color.text,
    },
});

// ── Mobile Toggle ───────────────────────────────────────────

export const mobileToggle = style({
    display: "none",
    position: "fixed",
    top: "12px",
    left: "12px",
    zIndex: 60,
    width: "40px",
    height: "40px",
    borderRadius: vars.radius.sm,
    backgroundColor: vars.color.bgCard,
    border: `1px solid ${vars.color.border}`,
    color: vars.color.text,
    fontSize: "1.2rem",
    cursor: "pointer",
    alignItems: "center",
    justifyContent: "center",
    "@media": {
        "(max-width: 768px)": {
            display: "flex",
        },
    },
});

// ── Content ─────────────────────────────────────────────────

export const content = style({
    flex: 1,
    marginLeft: "280px",
    padding: "40px 48px 80px",
    maxWidth: "900px",
    "@media": {
        "(max-width: 768px)": {
            marginLeft: 0,
            padding: "60px 20px 80px",
        },
    },
});

export const contentHeader = style({
    marginBottom: "32px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: "12px",
});

export const contentTitle = style({
    fontSize: "2rem",
    fontWeight: 800,
});

export const downloadMdBtn = style({
    padding: "6px 14px",
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.border}`,
    color: vars.color.textMuted,
    fontSize: "0.8rem",
    fontWeight: 500,
    cursor: "pointer",
    transition: "all 0.15s",
    textDecoration: "none",
    ":hover": {
        borderColor: vars.color.primary,
        color: vars.color.text,
    },
});

// ── Prev/Next ───────────────────────────────────────────────

export const prevNext = style({
    display: "flex",
    justifyContent: "space-between",
    marginTop: "64px",
    paddingTop: "24px",
    borderTop: `1px solid ${vars.color.border}`,
});

export const prevNextLink = style({
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    color: vars.color.textMuted,
    fontSize: "0.85rem",
    transition: "color 0.15s",
    ":hover": {
        color: vars.color.primary,
    },
});

export const prevNextLabel = style({
    fontSize: "0.75rem",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
});

export const prevNextTitle = style({
    fontWeight: 600,
    color: vars.color.text,
});

// ── Prose (rendered markdown) ───────────────────────────────

export const prose = style({
    lineHeight: 1.8,
});

globalStyle(`${prose} h1`, {
    fontSize: "2rem",
    fontWeight: 800,
    marginTop: "48px",
    marginBottom: "16px",
});

globalStyle(`${prose} h2`, {
    fontSize: "1.5rem",
    fontWeight: 700,
    marginTop: "48px",
    marginBottom: "12px",
    paddingBottom: "8px",
    borderBottom: `1px solid ${vars.color.border}`,
});

globalStyle(`${prose} h3`, {
    fontSize: "1.2rem",
    fontWeight: 600,
    marginTop: "32px",
    marginBottom: "8px",
});

globalStyle(`${prose} p`, {
    marginBottom: "16px",
    color: vars.color.textMuted,
});

globalStyle(`${prose} strong`, {
    color: vars.color.text,
    fontWeight: 600,
});

globalStyle(`${prose} a`, {
    color: vars.color.primary,
    textDecoration: "none",
});

globalStyle(`${prose} a:hover`, {
    textDecoration: "underline",
});

globalStyle(`${prose} code`, {
    backgroundColor: vars.color.bgCard,
    border: `1px solid ${vars.color.border}`,
    borderRadius: "4px",
    padding: "2px 6px",
    fontSize: "0.88em",
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
});

globalStyle(`${prose} pre`, {
    marginBottom: "16px",
    borderRadius: vars.radius.md,
    border: `1px solid ${vars.color.border}`,
    overflow: "hidden",
});

globalStyle(`${prose} pre code`, {
    backgroundColor: "transparent",
    border: "none",
    padding: 0,
    borderRadius: 0,
    fontSize: "0.85rem",
    lineHeight: 1.7,
});

// Shiki generates pre > code with inline styles
globalStyle(`${prose} .shiki`, {
    padding: "16px 20px",
    margin: 0,
    overflow: "auto",
    borderRadius: vars.radius.md,
});

globalStyle(`${prose} table`, {
    width: "100%",
    borderCollapse: "collapse",
    marginBottom: "16px",
    fontSize: "0.9rem",
});

globalStyle(`${prose} th`, {
    textAlign: "left",
    padding: "10px 12px",
    borderBottom: `2px solid ${vars.color.border}`,
    fontWeight: 600,
    color: vars.color.text,
});

globalStyle(`${prose} td`, {
    padding: "10px 12px",
    borderBottom: `1px solid ${vars.color.border}`,
    color: vars.color.textMuted,
});

globalStyle(`${prose} ul, ${prose} ol`, {
    marginBottom: "16px",
    paddingLeft: "24px",
    color: vars.color.textMuted,
});

globalStyle(`${prose} li`, {
    marginBottom: "6px",
});

globalStyle(`${prose} blockquote`, {
    borderLeft: `3px solid ${vars.color.primary}`,
    paddingLeft: "16px",
    marginBottom: "16px",
    color: vars.color.textMuted,
    fontStyle: "italic",
});

globalStyle(`${prose} hr`, {
    border: "none",
    borderTop: `1px solid ${vars.color.border}`,
    margin: "32px 0",
});

// Hide the first h1 (we show it in the content header)
globalStyle(`${prose} > h1:first-child`, {
    display: "none",
});
