import { defineConfig } from "vite";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

// Collect all entry points from src/
const srcDir = resolve(__dirname, "src");
const entries: Record<string, string> = {};
for (const file of readdirSync(srcDir)) {
    if (file.endsWith(".ts") || file.endsWith(".tsx")) {
        const name = file.replace(/\.(tsx?|jsx?)$/, "");
        entries[name] = resolve(srcDir, file);
    }
}

export default defineConfig({
    build: {
        lib: {
            entry: entries,
            formats: ["es"],
        },
        outDir: "dist",
        emptyOutDir: true,
        rollupOptions: {
            // Mark all dependencies as external (don't bundle them)
            external: [
                /^@babel\//,
                /^@hono\//,
                /^@preact\//,
                /^hono/,
                /^preact/,
                /^vite/,
                /^wouter-preact/,
                /^node:/,
            ],
        },
    },
    esbuild: {
        jsx: "automatic",
        jsxImportSource: "preact",
    },
});
