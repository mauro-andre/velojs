import { style, keyframes, globalStyle } from "@vanilla-extract/css";
import { vars } from "../styles/theme.css.js";

// Organic drift — translate + slight rotate gives blobs a "breathing" feel.
// Different ranges per blob so they never sync into a pattern.
const drift1 = keyframes({
    "0%, 100%": { transform: "translate(0, 0) rotate(0deg)" },
    "33%": { transform: "translate(8vw, 4vh) rotate(12deg)" },
    "66%": { transform: "translate(-4vw, 6vh) rotate(-8deg)" },
});

const drift2 = keyframes({
    "0%, 100%": { transform: "translate(0, 0) rotate(0deg)" },
    "40%": { transform: "translate(-10vw, -3vh) rotate(-15deg)" },
    "80%": { transform: "translate(5vw, -8vh) rotate(10deg)" },
});

const drift3 = keyframes({
    "0%, 100%": { transform: "translate(0, 0) rotate(0deg)" },
    "50%": { transform: "translate(6vw, -5vh) rotate(20deg)" },
});

// ── Root ──────────────────────────────────────────────────

export const ambient = style({
    position: "fixed",
    inset: 0,
    zIndex: -1,
    pointerEvents: "none",
    overflow: "hidden",
});

// ── Dot grid ──────────────────────────────────────────────
// A radial-gradient repeating pattern at ~4% opacity, softly masked near the
// edges so it doesn't feel rigid.

export const dotGrid = style({
    position: "absolute",
    inset: 0,
    backgroundImage:
        "radial-gradient(circle, rgba(255, 255, 255, 0.06) 0.0625rem, transparent 0.0625rem)",
    backgroundSize: "2rem 2rem",
    backgroundPosition: "0 0",
    // Fade toward edges for a vignette feel
    WebkitMaskImage:
        "radial-gradient(ellipse at center, rgba(0,0,0,1) 40%, rgba(0,0,0,0) 85%)",
    maskImage:
        "radial-gradient(ellipse at center, rgba(0,0,0,1) 40%, rgba(0,0,0,0) 85%)",
});

// ── Blobs ────────────────────────────────────────────────
// Huge, heavily blurred, low-opacity — they add mood without drawing the eye.

const blobBase = {
    position: "absolute",
    width: "40rem",
    height: "40rem",
    borderRadius: "50%",
    filter: "blur(6rem)",
    willChange: "transform",
} as const;

export const blob1 = style({
    ...blobBase,
    top: "-10rem",
    left: "-8rem",
    background: vars.color.primary,
    opacity: 0.18,
    animation: `${drift1} 55s ease-in-out infinite`,
});

export const blob2 = style({
    ...blobBase,
    bottom: "-12rem",
    right: "-10rem",
    background: vars.color.accent,
    opacity: 0.14,
    animation: `${drift2} 70s ease-in-out infinite`,
});

export const blob3 = style({
    ...blobBase,
    top: "40%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    width: "32rem",
    height: "32rem",
    background: vars.color.primary,
    opacity: 0.06,
    animation: `${drift3} 90s ease-in-out infinite`,
});

// Respect reduced-motion preference — disable the drift for accessibility
globalStyle(
    `${blob1}, ${blob2}, ${blob3}`,
    {
        "@media": {
            "(prefers-reduced-motion: reduce)": {
                animation: "none",
            },
        },
    }
);
