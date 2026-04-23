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
    maxWidth: "44rem",
    margin: "0 auto 3.5rem",
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

// ── Top row (Code | Tree) ─────────────────────────────────

export const topRow = style({
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "1.5rem",
    alignItems: "stretch",
    "@media": {
        "(max-width: 56rem)": {
            gridTemplateColumns: "1fr",
        },
    },
});

// Wraps each panel so they align even with different content heights
export const panel = style({
    minWidth: 0, // lets the content (esp. CodeWindow) shrink properly in grid
});

export const panelLabel = style({
    fontFamily: vars.font.mono,
    fontSize: "0.7rem",
    fontWeight: 600,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: vars.color.textMuted,
    marginBottom: "0.625rem",
    paddingLeft: "0.25rem",
});

// ── Tree panel ─────────────────────────────────────────────

export const treeCard = style({
    padding: "1.5rem",
    borderRadius: vars.radius.lg,
    backgroundColor: vars.color.bgCard,
    border: `0.0625rem solid ${vars.color.border}`,
    fontFamily: vars.font.mono,
    fontSize: "0.85rem",
    height: "100%",
    overflowX: "auto",
});

// Recursive list — vertical line via ::before, horizontal lines via item ::before
export const treeRoot = style({
    listStyle: "none",
    padding: 0,
    margin: 0,
});

export const treeChildren = style({
    listStyle: "none",
    padding: 0,
    margin: "0.5rem 0 0 0.875rem",
    paddingLeft: "1.25rem",
    position: "relative",
    selectors: {
        // vertical line behind children
        "&::before": {
            content: '""',
            position: "absolute",
            left: 0,
            top: 0,
            bottom: "0.875em",
            width: "0.0625rem",
            background: vars.color.border,
        },
    },
});

export const treeItem = style({
    position: "relative",
    paddingTop: "0.375rem",
    paddingBottom: "0.375rem",
    selectors: {
        // horizontal connector to vertical line
        "&::before": {
            content: '""',
            position: "absolute",
            left: "-1.25rem",
            top: "1.05em",
            width: "1rem",
            height: "0.0625rem",
            background: vars.color.border,
        },
    },
});

// Top-level item has no horizontal connector (no parent line)
export const treeItemRoot = style({
    paddingTop: "0.375rem",
    paddingBottom: "0.375rem",
});

export const treeNode = style({
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    flexWrap: "wrap",
    padding: "0.375rem 0.625rem",
    borderRadius: vars.radius.sm,
    transition: "background-color 0.2s",
    ":hover": {
        backgroundColor: "rgba(108, 140, 255, 0.06)",
    },
});

export const treeDot = style({
    width: "0.5rem",
    height: "0.5rem",
    borderRadius: "50%",
    flexShrink: 0,
});

// Color variants for node dots
export const treeDotLayout = style({
    background: `linear-gradient(135deg, ${vars.color.primary}, ${vars.color.accent})`,
});
export const treeDotPage = style({
    background: vars.color.primary,
});
export const treeDotEndpoint = style({
    background: "#f59e0b", // warm amber for endpoints
});

export const treePath = style({
    color: vars.color.text,
    fontWeight: 600,
});

export const treeModule = style({
    color: vars.color.textMuted,
    fontSize: "0.78rem",
});

// ── Badges (kind + middleware) ────────────────────────────

const badgeBase = {
    fontFamily: vars.font.mono,
    fontSize: "0.62rem",
    fontWeight: 700,
    letterSpacing: "0.06em",
    padding: "0.1875rem 0.4375rem",
    borderRadius: "999px",
    border: "0.0625rem solid",
    textTransform: "uppercase" as const,
} as const;

export const treeKindLayout = style({
    ...badgeBase,
    color: vars.color.accent,
    borderColor: "rgba(167, 139, 250, 0.35)",
    background: "rgba(167, 139, 250, 0.06)",
});
export const treeKindPage = style({
    ...badgeBase,
    color: vars.color.primary,
    borderColor: "rgba(108, 140, 255, 0.35)",
    background: "rgba(108, 140, 255, 0.06)",
});
export const treeKindEndpoint = style({
    ...badgeBase,
    color: "#f59e0b",
    borderColor: "rgba(245, 158, 11, 0.35)",
    background: "rgba(245, 158, 11, 0.06)",
});

// Middleware shield pill — yellow/amber tint to read as "guarded"
export const mwBadge = style({
    ...badgeBase,
    color: "#fbbf24",
    borderColor: "rgba(251, 191, 36, 0.35)",
    background: "rgba(251, 191, 36, 0.06)",
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
});

// Inherited middleware — same pill but faded; reader infers "from a parent"
export const mwBadgeInherited = style({
    ...badgeBase,
    color: "rgba(251, 191, 36, 0.55)",
    borderColor: "rgba(251, 191, 36, 0.18)",
    background: "rgba(251, 191, 36, 0.03)",
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    fontStyle: "italic",
});

// One-time pulse drawing attention to the auth badge on /app
const mwPulse = keyframes({
    "0%, 100%": {
        boxShadow: "0 0 0 0 rgba(251, 191, 36, 0)",
    },
    "50%": {
        boxShadow: "0 0 0 0.25rem rgba(251, 191, 36, 0.25)",
    },
});

export const mwBadgePulse = style({
    animation: `${mwPulse} 2s ease-in-out 0.8s 2`,
    "@media": {
        "(prefers-reduced-motion: reduce)": {
            animation: "none",
        },
    },
});

// ── "Resolves to" separator ────────────────────────────────

export const resolvesTo = style({
    textAlign: "center",
    margin: "2.5rem auto 1.25rem",
    fontFamily: vars.font.mono,
    fontSize: "0.75rem",
    fontWeight: 600,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: vars.color.textMuted,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.75rem",
});

export const resolvesArrow = style({
    fontSize: "1rem",
    color: vars.color.primary,
});

// ── Table ──────────────────────────────────────────────────

export const tableCard = style({
    padding: "1rem",
    borderRadius: vars.radius.lg,
    backgroundColor: vars.color.bgCard,
    border: `0.0625rem solid ${vars.color.border}`,
    overflowX: "auto",
});

export const table = style({
    width: "100%",
    borderCollapse: "separate",
    borderSpacing: 0,
    fontFamily: vars.font.mono,
    fontSize: "0.85rem",
});

export const tableRow = style({
    transition: "background-color 0.2s",
    ":hover": {
        backgroundColor: "rgba(108, 140, 255, 0.04)",
    },
});

export const tableCell = style({
    padding: "0.625rem 0.875rem",
    verticalAlign: "middle",
    borderBottom: `0.0625rem solid ${vars.color.border}`,
});

// remove last-row border
globalStyle(`${tableRow}:last-child ${tableCell}`, {
    borderBottom: "none",
});

export const cellMethod = style({
    width: "0",
    whiteSpace: "nowrap",
});

export const cellPath = style({
    color: vars.color.text,
});

export const cellArrow = style({
    width: "0",
    color: vars.color.textMuted,
    padding: "0 0.5rem",
});

export const cellModule = style({
    color: vars.color.text,
    fontWeight: 600,
});

export const cellMw = style({
    width: "0",
    whiteSpace: "nowrap",
    textAlign: "right",
});

// Method badges — color by HTTP verb
const methodBadge = {
    fontFamily: vars.font.mono,
    fontSize: "0.7rem",
    fontWeight: 700,
    letterSpacing: "0.06em",
    padding: "0.25rem 0.5rem",
    borderRadius: vars.radius.sm,
    border: "0.0625rem solid",
    display: "inline-block",
} as const;

export const methodGet = style({
    ...methodBadge,
    color: vars.color.primary,
    borderColor: "rgba(108, 140, 255, 0.35)",
    background: "rgba(108, 140, 255, 0.08)",
});

export const methodPost = style({
    ...methodBadge,
    color: vars.color.accent,
    borderColor: "rgba(167, 139, 250, 0.35)",
    background: "rgba(167, 139, 250, 0.08)",
});

// ── Entry animation states ────────────────────────────────

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

// Table rows cascade individually
const rowFadeUp = keyframes({
    "0%": { opacity: 0, transform: "translateY(0.5rem)" },
    "100%": { opacity: 1, transform: "translateY(0)" },
});

export const rowAnimated = style({
    opacity: 0,
    animationName: rowFadeUp,
    animationDuration: "0.5s",
    animationFillMode: "forwards",
    animationTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    "@media": {
        "(prefers-reduced-motion: reduce)": {
            opacity: 1,
            animation: "none",
        },
    },
});

// ── Takeaways (3 cards below) ─────────────────────────────

export const takeaways = style({
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: "1rem",
    maxWidth: "60rem",
    margin: "3.5rem auto 0",
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
