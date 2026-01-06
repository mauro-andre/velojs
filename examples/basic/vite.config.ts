import { defineConfig } from "vite";
import velojs from "velojs/vite-plugin";
import { resolve } from "path";

export default defineConfig({
  plugins: [velojs()],
  build: {
    rollupOptions: {
      input: resolve(__dirname, ".velojs/index.html"),
    },
  },
});
