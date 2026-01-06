import { defineConfig } from "vite";
import { resolve } from "path";
import dts from "vite-plugin-dts";

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.ts"),
        "vite-plugin/index": resolve(__dirname, "src/vite-plugin/index.ts"),
        "hooks/index": resolve(__dirname, "src/hooks/index.ts"),
        "runtime/index": resolve(__dirname, "src/runtime/index.ts"),
        "dev-server": resolve(__dirname, "src/dev-server.ts"),
        "cli": resolve(__dirname, "src/cli.ts"),
      },
      formats: ["es"],
      fileName: (format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: [
        "hono",
        "@hono/node-server",
        "preact",
        "@preact/signals",
        "preact-render-to-string",
        "wouter-preact",
        "vite",
        "@swc/core",
        // Node.js built-ins
        "path",
        "fs",
        "url",
        "http",
        "module",
        "async_hooks",
      ],
    },
  },
  plugins: [
    dts({
      include: ["src/**/*"],
      outDir: "dist",
    }),
  ],
});
