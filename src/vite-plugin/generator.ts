import type { ScanResult } from "./types.js";
import { relative } from "path";

/**
 * Gera arquivos de rotas (Hono server-side e Wouter client-side)
 */
export function generateRoutes(
  scanResult: ScanResult,
  workDir: string,
  _outDir: string
): { serverCode: string; clientCode: string } {
  const serverCode = generateServerRoutes(scanResult, workDir);
  const clientCode = generateClientRoutes(scanResult, workDir);

  return { serverCode, clientCode };
}

/**
 * Gera rotas Hono (server-side)
 */
function generateServerRoutes(
  scanResult: ScanResult,
  workDir: string
): string {
  const imports: string[] = [];
  const routes: string[] = [];

  imports.push(`import { Hono } from "hono";`);
  imports.push(`import { renderPage } from "velojs/runtime";`);
  imports.push(``);
  imports.push(`const app = new Hono();`);
  imports.push(``);

  // Processa cada rota
  scanResult.routes.forEach((route, index) => {
    const routeVar = `route${index}`;

    // Import do módulo server
    const serverPath = getServerPath(route.filePath, workDir);
    imports.push(
      `import * as ${routeVar} from "./${serverPath.replace(/\.ts$/, ".js")}";`
    );

    // Import do componente client
    const clientPath = getClientPath(route.filePath, workDir);
    const componentVar = `Component${index}`;
    imports.push(
      `import ${componentVar} from "./${clientPath.replace(/\.tsx$/, ".js")}";`
    );

    // Import dos layouts (server + client)
    const layoutImports: string[] = [];
    const layoutVars: string[] = [];
    route.layoutChain?.forEach((layout, layoutIndex) => {
      const layoutVar = `layout${index}_${layoutIndex}`;
      const layoutServerPath = getServerPath(layout.filePath, workDir);
      const layoutClientPath = getClientPath(layout.filePath, workDir);

      imports.push(
        `import * as ${layoutVar}Server from "./${layoutServerPath.replace(/\.ts$/, ".js")}";`
      );
      imports.push(
        `import ${layoutVar}Component from "./${layoutClientPath.replace(/\.tsx$/, ".js")}";`
      );

      layoutImports.push(layoutVar);
      layoutVars.push(`${layoutVar}Component`);
    });

    // Gera rota SSR (primeira carga)
    routes.push(`
// Route: ${route.url}
app.get("${route.url}", async (c) => {
  // 1. Executa loaders (layouts + page)
  const data: any = {};
  ${route.layoutChain
    ?.map(
      (_, i) => `
  if (${layoutImports[i]}Server.loader) {
    data.layout${i} = await ${layoutImports[i]}Server.loader({
      context: c,
      params: c.req.param(),
      request: c.req.raw,
    });
  }`
    )
    .join("")}

  if (${routeVar}.loader) {
    data.page = await ${routeVar}.loader({
      context: c,
      params: c.req.param(),
      request: c.req.raw,
    });
  }

  // 2. Renderiza componentes nested (de dentro pra fora)
  let rendered = <${componentVar} />;
  ${layoutVars.reverse().map((layoutVar) => `rendered = <${layoutVar}>{rendered}</${layoutVar}>;`).join("\n  ")}

  // 3. Renderiza com SSR usando renderPage
  return renderPage(c, rendered, data);
});

// Data API (navegação SPA)
app.get("${route.url}", async (c) => {
  if (c.req.query("_data") !== "1") {
    return c.next();
  }

  const data: any = {};
  ${route.layoutChain
    ?.map(
      (_, i) => `
  if (${layoutImports[i]}Server.loader) {
    data.layout${i} = await ${layoutImports[i]}Server.loader({
      context: c,
      params: c.req.param(),
      request: c.req.raw,
    });
  }`
    )
    .join("")}

  if (${routeVar}.loader) {
    data.page = await ${routeVar}.loader({
      context: c,
      params: c.req.param(),
      request: c.req.raw,
    });
  }

  return c.json(data);
});
`);

    // Gera rotas POST para Server Actions
    if (route.actions && route.actions.length > 0) {
      route.actions.forEach((actionName) => {
        routes.push(`
// Action: ${route.url}/${actionName}
app.post("/api${route.url}/${actionName}", async (c) => {
  try {
    // Parse body
    const body = await c.req.json();
    const args = body.args || [];

    // Executa action
    if (!${routeVar}.${actionName}) {
      return c.json({ error: "Action not found" }, 404);
    }

    const result = await ${routeVar}.${actionName}(...args);
    return c.json({ success: true, data: result });
  } catch (error) {
    console.error("Action error:", error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error"
    }, 500);
  }
});
`);
      });
    }
  });

  // Template final
  return `${imports.join("\n")}

${routes.join("\n")}

export default app;
`;
}

/**
 * Gera rotas Wouter (client-side)
 */
function generateClientRoutes(
  scanResult: ScanResult,
  workDir: string
): string {
  const imports: string[] = [];
  const routes: string[] = [];

  imports.push(`import { Route, Switch } from "wouter-preact";`);
  imports.push(`import { lazy } from "preact/compat";`);
  imports.push(``);

  // Processa cada rota
  scanResult.routes.forEach((route, index) => {
    const componentVar = `Page${index}`;
    const clientPath = getClientPath(route.filePath, workDir);

    // Lazy import
    imports.push(
      `const ${componentVar} = lazy(() => import("./${clientPath.replace(/\.tsx$/, ".js")}"));`
    );

    // Rota Wouter
    routes.push(`      <Route path="${route.url}" component={${componentVar}} />`);
  });

  // Template final
  return `${imports.join("\n")}

export function Routes() {
  return (
    <Switch>
${routes.join("\n")}
      <Route path="*" component={() => <div>404 Not Found</div>} />
    </Switch>
  );
}
`;
}

/**
 * Calcula path relativo do arquivo server gerado
 */
function getServerPath(filePath: string, workDir: string): string {
  const rel = relative(workDir, filePath);
  return rel.replace(/\.tsx?$/, ".server.ts");
}

/**
 * Calcula path relativo do arquivo client gerado
 */
function getClientPath(filePath: string, workDir: string): string {
  const rel = relative(workDir, filePath);
  return rel.replace(/\.tsx?$/, ".client.tsx");
}
