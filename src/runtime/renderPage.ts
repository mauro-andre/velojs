import { render } from "preact-render-to-string";
import type { VNode } from "preact";
import type { Context } from "hono";

/**
 * Renderiza página com SSR
 *
 * @param c - Contexto Hono
 * @param component - Componente Preact renderizado (já nested)
 * @param data - Dados do loader (opcional)
 * @returns Response HTML
 *
 * @example
 * ```ts
 * // Renderização nested
 * const page = <UsersPage />;
 * const admin = <AdminLayout>{page}</AdminLayout>;
 * const root = <AppRoot>{admin}</AppRoot>;
 *
 * return renderPage(c, root, { users: [...] });
 * ```
 */
export function renderPage(
  c: Context,
  component: VNode,
  data?: any
): Response {
  // 1. Renderiza component para HTML
  const html = render(component);

  // 2. Injeta dados em window.__PAGE_DATA__ se existir
  const dataScript = data
    ? `<script>window.__PAGE_DATA__ = ${JSON.stringify(data)};</script>`
    : "";

  // 3. Verifica se HTML já tem <html>, <body> (layout completo)
  //    Se sim, injeta script antes de </body>
  //    Se não, usa template padrão
  let finalHtml: string;

  if (html.includes("<html") && html.includes("<body")) {
    // Layout já define HTML completo
    finalHtml = html.replace("</body>", `${dataScript}</body>`);
  } else {
    // Usa template padrão
    finalHtml = createDefaultTemplate(html, dataScript);
  }

  return c.html(finalHtml);
}

/**
 * Template HTML padrão quando layout não define <html>
 */
function createDefaultTemplate(content: string, dataScript: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>VeloJS App</title>
  </head>
  <body>
    <div id="app">${content}</div>
    ${dataScript}
  </body>
</html>`;
}
