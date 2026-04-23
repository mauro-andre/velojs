import { style, keyframes, globalStyle } from "@vanilla-extract/css";
import { vars } from "../styles/theme.css.js";

// Subtle conic-gradient border sweep — only the gradient's `from` angle
// animates, so the element itself stays still. Requires @property --angle
// (registered once in client-root.tsx). 16s per cycle is slow and ambient.
const borderSweep = keyframes({
    "0%": { vars: { "--angle": "0deg" } },
    "100%": { vars: { "--angle": "360deg" } },
});

export const wrapper = style({
    position: "relative",
    borderRadius: vars.radius.lg,
    overflow: "hidden",
    background: vars.color.bgCard,
    // Soft shadow with a cool tint so the window appears to float
    boxShadow: `
        0 0.0625rem 0.125rem rgba(0, 0, 0, 0.4),
        0 0.5rem 1.5rem rgba(0, 0, 0, 0.5),
        0 1.5rem 3.75rem rgba(108, 140, 255, 0.08)
    `,
    isolation: "isolate",
});

// Animated conic-gradient border via ::before
// Key trick: only --angle animates, not the whole element, so the window
// stays still while the bright band sweeps around the border.
globalStyle(`${wrapper}::before`, {
    content: '""',
    position: "absolute",
    inset: 0,
    borderRadius: vars.radius.lg,
    padding: "0.0625rem",
    background: `conic-gradient(
        from var(--angle, 0deg),
        transparent 0%,
        ${vars.color.primary} 25%,
        transparent 50%,
        ${vars.color.accent} 75%,
        transparent 100%
    )`,
    // Mask trick to show only the border area
    WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
    WebkitMaskComposite: "xor",
    mask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
    maskComposite: "exclude",
    animation: `${borderSweep} 16s linear infinite`,
    opacity: 0.5,
    pointerEvents: "none",
    zIndex: 0,
});

// Static border fallback that's always visible (subtle)
globalStyle(`${wrapper}::after`, {
    content: '""',
    position: "absolute",
    inset: 0,
    borderRadius: vars.radius.lg,
    border: `0.0625rem solid ${vars.color.border}`,
    pointerEvents: "none",
    zIndex: 1,
});

// ── Title bar ─────────────────────────────────────────────────

export const titleBar = style({
    position: "relative",
    zIndex: 2,
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.625rem 0.875rem",
    background: "rgba(255, 255, 255, 0.03)",
    borderBottom: `0.0625rem solid ${vars.color.border}`,
});

export const dots = style({
    display: "flex",
    gap: "0.375rem",
});

const dotBase = {
    width: "0.6875rem",
    height: "0.6875rem",
    borderRadius: "50%",
    flexShrink: 0,
} as const;

export const dotRed = style({
    ...dotBase,
    background: "radial-gradient(circle at 30% 30%, #ff8072, #ff5f57)",
    boxShadow: "inset 0 0 0 0.03125rem rgba(0,0,0,0.2)",
});

export const dotYellow = style({
    ...dotBase,
    background: "radial-gradient(circle at 30% 30%, #ffd260, #febc2e)",
    boxShadow: "inset 0 0 0 0.03125rem rgba(0,0,0,0.2)",
});

export const dotGreen = style({
    ...dotBase,
    background: "radial-gradient(circle at 30% 30%, #5de072, #28c840)",
    boxShadow: "inset 0 0 0 0.03125rem rgba(0,0,0,0.2)",
});

export const filename = style({
    flex: 1,
    textAlign: "center",
    fontFamily: vars.font.mono,
    fontSize: "0.8rem",
    color: vars.color.textMuted,
    letterSpacing: "0.02em",
    // Leave space on the right equal to the dots area so the filename sits
    // visually centered despite the dots taking the left side
    paddingRight: "3.1875rem",
});

// ── Body ──────────────────────────────────────────────────────

export const body = style({
    position: "relative",
    zIndex: 2,
    fontSize: "0.85rem",
    lineHeight: 1.6,
    fontFamily: vars.font.mono,
    overflowX: "auto",
});

// Shiki wraps output in <pre class="shiki"><code>...</code></pre>.
// Strip its default background so our window chrome shows through, and add
// comfortable padding.
globalStyle(`${body} pre`, {
    margin: 0,
    padding: "1.25rem 1.375rem",
    background: "transparent !important",
    fontFamily: vars.font.mono,
    fontSize: "inherit",
    lineHeight: "inherit",
});

globalStyle(`${body} code`, {
    fontFamily: vars.font.mono,
});

// Replace the default ugly browser scrollbar with a thin, themed one.
// Applies to the body (where overflow-x: auto lives) AND to any inner <pre>
// that scrolls horizontally (used by RealtimeShowcase's tabbed slots).
globalStyle(`${body}, ${body} pre`, {
    scrollbarWidth: "thin",
    scrollbarColor: `${vars.color.border} transparent`,
});

globalStyle(
    `${body}::-webkit-scrollbar, ${body} pre::-webkit-scrollbar`,
    {
        width: "0.4rem",
        height: "0.4rem",
    }
);

globalStyle(
    `${body}::-webkit-scrollbar-track, ${body} pre::-webkit-scrollbar-track`,
    {
        background: "transparent",
    }
);

globalStyle(
    `${body}::-webkit-scrollbar-thumb, ${body} pre::-webkit-scrollbar-thumb`,
    {
        background: vars.color.border,
        borderRadius: "999px",
    }
);

globalStyle(
    `${body}::-webkit-scrollbar-thumb:hover, ${body} pre::-webkit-scrollbar-thumb:hover`,
    {
        background: vars.color.textMuted,
    }
);
