import type { Plugin } from "vite";
import type { VeloConfig, RouteConfig } from "../types.js";
import { scanRoutes, generateManifest } from "./scanner.js";
import { resolve } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";

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

      // 1. Resolve paths absolutos
      const absoluteWorkDir = resolve(process.cwd(), workDir);
      const absoluteOutDir = resolve(process.cwd(), outDir);

      console.log(`   Absolute workDir: ${absoluteWorkDir}`);
      console.log(`   Absolute outDir: ${absoluteOutDir}`);

      // 2. Carrega routes.ts
      const routesPath = resolve(process.cwd(), "routes.ts");
      console.log(`   Loading routes from: ${routesPath}`);

      if (!existsSync(routesPath)) {
        throw new Error(
          `routes.ts not found at ${routesPath}. Please create a routes.ts file in your project root.`
        );
      }

      // 3. Importa routes.ts dinamicamente
      let routesConfig: RouteConfig[];
      try {
        const routesModule = await import(routesPath);
        routesConfig = routesModule.default;

        if (!Array.isArray(routesConfig)) {
          throw new Error(
            "routes.ts must export an array of RouteConfig as default export"
          );
        }
      } catch (error) {
        throw new Error(
          `Failed to load routes.ts: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      console.log(`   Found ${routesConfig.length} top-level route(s)`);

      // 4. Escaneia e processa rotas
      const scanResult = scanRoutes(routesConfig, absoluteWorkDir);

      console.log(`   Processed ${scanResult.metadata.totalRoutes} route(s)`);
      console.log(`   Processed ${scanResult.metadata.totalLayouts} layout(s)`);

      // 5. Cria diretório de output
      if (!existsSync(absoluteOutDir)) {
        mkdirSync(absoluteOutDir, { recursive: true });
      }

      // 6. Gera route manifest (debug)
      const manifestPath = resolve(absoluteOutDir, "route-manifest.json");
      const manifestContent = generateManifest(scanResult);
      writeFileSync(manifestPath, manifestContent, "utf-8");

      console.log(`   Generated route manifest: ${manifestPath}`);
      console.log("✅ VeloJS: Scanner complete!");

      // TODO: Implementar code-splitter e generator
    },
  };
}
