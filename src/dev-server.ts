import { createServer as createViteServer } from "vite";
import type { ViteDevServer } from "vite";
import { Hono } from "hono";
import { watch } from "fs";
import { resolve } from "path";
import { createServer } from "http";

/**
 * VeloJS Development Server
 *
 * Integra Vite dev server com Hono para HMR completo:
 * - Client HMR (Vite automático)
 * - Server HMR (recarrega modules)
 * - Routes HMR (re-escaneia quando routes.ts muda)
 */
export async function startDevServer(options?: {
  port?: number;
  workDir?: string;
}) {
  const port = options?.port || 3000;
  const workDir = options?.workDir || "./app";

  console.log("🚀 VeloJS Dev Server starting...");

  // 1. Cria Vite dev server
  const vite: ViteDevServer = await createViteServer({
    server: { middlewareMode: true },
    appType: "custom",
  });

  // 2. Carrega o Hono app gerado (com HMR)
  let app: Hono = new Hono();

  const loadApp = async () => {
    const serverRoutesPath = resolve(process.cwd(), ".velojs/server-routes.tsx");

    try {
      // Invalida cache do módulo para forçar reload
      const timestamp = Date.now();
      const module = await vite.ssrLoadModule(
        `${serverRoutesPath}?t=${timestamp}`
      );
      app = module.default;
      console.log("✅ Server routes reloaded");
    } catch (error) {
      console.error("❌ Error loading server routes:", error);
      // Cria app vazio em caso de erro
      app = new Hono();
    }
  };

  await loadApp();

  // 3. Watch routes.ts para re-gerar quando mudar
  const routesPath = resolve(process.cwd(), workDir, "routes.ts");
  watch(routesPath, async (eventType) => {
    if (eventType === "change") {
      console.log("📝 routes.ts changed, regenerating...");
      // Trigger rebuild do plugin
      await vite.restart();
    }
  });

  // 4. Watch arquivos server (loaders/actions) para reload
  const watchPaths = [
    resolve(process.cwd(), ".velojs/server-routes.tsx"),
    resolve(process.cwd(), workDir),
  ];

  watchPaths.forEach((path) => {
    watch(path, { recursive: true }, async (_eventType, filename) => {
      if (
        filename?.endsWith(".ts") ||
        filename?.endsWith(".tsx")
      ) {
        console.log(`🔄 ${filename} changed, reloading...`);
        await loadApp();
      }
    });
  });

  // 5. Cria servidor HTTP
  const httpServer = createServer(async (req, res) => {
    try {
      // Se for requisição do Vite (/@vite, /@fs, assets, etc)
      if (
        req.url?.startsWith("/@") ||
        req.url?.startsWith("/node_modules") ||
        req.url?.endsWith(".tsx") ||
        req.url?.endsWith(".ts") ||
        req.url?.endsWith(".jsx") ||
        req.url?.endsWith(".js")
      ) {
        // Deixa Vite cuidar
        vite.middlewares(req, res);
        return;
      }

      // Converte Node.js request para Web Request
      const protocol = req.headers["x-forwarded-proto"] || "http";
      const host = req.headers.host || `localhost:${port}`;
      const url = `${protocol}://${host}${req.url}`;

      const webRequest = new Request(url, {
        method: req.method,
        headers: req.headers as HeadersInit,
      });

      // Passa para o Hono app
      const response = await app.fetch(webRequest);

      // Converte Response para Node.js response
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });

      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }

      res.end();
    } catch (error) {
      console.error("Server error:", error);
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  });

  // 6. Inicia servidor
  httpServer.listen(port, () => {
    console.log("\n✨ VeloJS Dev Server ready!");
    console.log(`🌐 http://localhost:${port}`);
    console.log(`🔥 HMR enabled\n`);
  });
}

/**
 * CLI para rodar o dev server
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  startDevServer();
}
