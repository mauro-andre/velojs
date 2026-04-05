import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import { docsPlugin } from "./plugins/vite-docs.js";

export default defineConfig({
    plugins: [preact(), vanillaExtractPlugin(), docsPlugin()],
    build: {
        outDir: "dist",
    },
});
