import type { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";

/**
 * Configura middlewares globais e customizações do servidor
 * Esta função é chamada antes do servidor iniciar
 */
export function configureServer(app: Hono) {
  // Adiciona logger
  app.use("*", logger());

  // Configura CORS
  app.use("*", cors());

  console.log("✨ Server configured with custom middlewares");
}

/**
 * Hook executado quando o servidor inicia
 * Útil para inicializar conexões de banco, etc.
 */
export function onServerStart(app: Hono) {
  console.log("🎯 Custom server initialization complete");
  console.log(`   Routes registered: ${app.routes.length}`);
}
