import type { Plugin } from "vite";
import type { VeloConfig, RouteConfig } from "../types.js";
import { scanRoutes, generateManifest } from "./scanner.js";
import { splitCode } from "./code-splitter.js";
import { generateRoutes } from "./generator.js";
import { resolve, dirname, relative, extname } from "path";
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

      // 7. Code splitting - processa cada arquivo único
      console.log("\n🔀 VeloJS: Code splitting...");

      const processedFiles = new Set<string>();
      const allFiles = [
        ...scanResult.routes.map((r) => r.filePath),
        ...Array.from(scanResult.layouts.values()).map((l) => l.filePath),
      ];

      allFiles.forEach((filePath) => {
        // Evita processar o mesmo arquivo duas vezes
        if (processedFiles.has(filePath)) return;
        processedFiles.add(filePath);

        // Verifica se arquivo existe
        if (!existsSync(filePath)) {
          console.warn(`   ⚠️  File not found: ${filePath}`);
          return;
        }

        console.log(`   Processing: ${relative(absoluteWorkDir, filePath)}`);

        // Code splitting
        const splitResult = splitCode(filePath);

        // Calcula paths de output
        const relativePath = relative(absoluteWorkDir, filePath);
        const ext = extname(relativePath);
        const withoutExt = relativePath.slice(0, -ext.length);

        const serverOutputPath = resolve(
          absoluteOutDir,
          `${withoutExt}.server.ts`
        );
        const clientOutputPath = resolve(
          absoluteOutDir,
          `${withoutExt}.client.tsx`
        );

        // Cria diretórios se necessário
        mkdirSync(dirname(serverOutputPath), { recursive: true });
        mkdirSync(dirname(clientOutputPath), { recursive: true });

        // Escreve arquivos
        writeFileSync(serverOutputPath, splitResult.serverCode, "utf-8");
        writeFileSync(clientOutputPath, splitResult.clientCode, "utf-8");

        console.log(
          `     → Server: ${relative(process.cwd(), serverOutputPath)}`
        );
        console.log(
          `     → Client: ${relative(process.cwd(), clientOutputPath)}`
        );
        console.log(
          `     → Metadata: loader=${splitResult.metadata.hasLoader}, actions=[${splitResult.metadata.actions.join(", ")}]`
        );
      });

      console.log(
        `\n✅ VeloJS: Code splitting complete! Processed ${processedFiles.size} file(s)`
      );

      // 8. Gera rotas Hono e Wouter
      console.log("\n📝 VeloJS: Generating routes...");

      const { serverCode, clientCode } = generateRoutes(
        scanResult,
        absoluteWorkDir,
        absoluteOutDir
      );

      // Escreve server-routes.ts
      const serverRoutesPath = resolve(absoluteOutDir, "server-routes.ts");
      writeFileSync(serverRoutesPath, serverCode, "utf-8");
      console.log(`   Generated: ${relative(process.cwd(), serverRoutesPath)}`);

      // Escreve client-routes.tsx
      const clientRoutesPath = resolve(absoluteOutDir, "client-routes.tsx");
      writeFileSync(clientRoutesPath, clientCode, "utf-8");
      console.log(`   Generated: ${relative(process.cwd(), clientRoutesPath)}`);

      console.log("\n✅ VeloJS: Build complete! 🎉");
      console.log(`   Total routes: ${scanResult.metadata.totalRoutes}`);
      console.log(`   Total layouts: ${scanResult.metadata.totalLayouts}`);
      console.log(`   Files processed: ${processedFiles.size}`);
    },
  };
}
