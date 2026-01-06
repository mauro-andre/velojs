import { serve } from "@hono/node-server";
import app from "./server-routes.js";
import { existsSync } from "fs";
import { resolve } from "path";

// Verifica se existe entry.server.ts customizado
const entryServerPath = resolve("/var/mnt/data/dev-projects/velojs/examples/basic/app", "entry.server.ts");
if (existsSync(entryServerPath)) {
  // Carrega configuração customizada
  import(entryServerPath).then((mod) => {
    if (mod.configureServer) {
      mod.configureServer(app);
    }
    if (mod.onServerStart) {
      mod.onServerStart(app);
    }
    startServer();
  });
} else {
  startServer();
}

function startServer() {
  const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

  console.log(`🚀 VeloJS server running at http://localhost:${port}`);

  serve({
    fetch: app.fetch,
    port,
  });
}
