import { globalStyle, createGlobalTheme } from "@vanilla-extract/css";

export const vars = createGlobalTheme(":root", {
    color: {
        bg: "#0a0a0f",
        bgCard: "#12121a",
        bgCardHover: "#1a1a25",
        text: "#f0f0f5",
        textMuted: "#888899",
        primary: "#6c8cff",
        primaryHover: "#5a7aee",
        accent: "#a78bfa",
        border: "#2a2a35",
    },
    font: {
        body: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        mono: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
    },
    radius: {
        sm: "6px",
        md: "10px",
        lg: "16px",
        xl: "24px",
    },
});

globalStyle("*", {
    margin: 0,
    padding: 0,
    boxSizing: "border-box",
});

globalStyle("html", {
    scrollBehavior: "smooth",
});

globalStyle("body", {
    fontFamily: vars.font.body,
    backgroundColor: vars.color.bg,
    color: vars.color.text,
    lineHeight: 1.6,
    WebkitFontSmoothing: "antialiased",
});

globalStyle("a", {
    color: "inherit",
    textDecoration: "none",
});
