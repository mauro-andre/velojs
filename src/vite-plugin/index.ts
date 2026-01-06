import type { Plugin } from "vite";
import type { VeloConfig } from "../types.js";

/**
 * VeloJS Vite Plugin
 *
 * Transforma código do desenvolvedor em rotas executáveis:
 * 1. Escaneia routes.ts
 * 2. Separa código server/client
 * 3. Gera arquivos em .velojs/
 *
 * @param config - Configuração do VeloJS
 * @returns Plugin Vite
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { defineConfig } from "vite";
 * import velojs from "velojs/vite-plugin";
 *
 * export default defineConfig({
 *   plugins: [velojs()],
 * });
 * ```
 */
export default function velojs(config?: VeloConfig): Plugin {
  const workDir = config?.workDir || "./app";
  const outDir = config?.outDir || "./.velojs";

  return {
    name: "velojs",

    async buildStart() {
      console.log("🚀 VeloJS: Starting build...");
      console.log(`   workDir: ${workDir}`);
      console.log(`   outDir: ${outDir}`);

      // TODO: Implementar scanner, code-splitter e generator
    },
  };
}
