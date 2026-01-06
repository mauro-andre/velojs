import { parseSync, type Module, type ModuleItem } from "@swc/core";
import { readFileSync } from "fs";

/**
 * Resultado do code splitting
 */
export interface SplitResult {
  /**
   * Código do servidor (loader + actions)
   */
  serverCode: string;

  /**
   * Código do cliente (component + imports)
   */
  clientCode: string;

  /**
   * Metadata
   */
  metadata: {
    hasLoader: boolean;
    actions: string[];
    hasDefaultExport: boolean;
  };
}

/**
 * Separa código de um arquivo page.tsx/layout.tsx em server e client
 *
 * @param filePath - Path absoluto do arquivo
 * @param outDir - Diretório de saída (.velojs)
 * @returns Código separado
 */
export function splitCode(filePath: string, outDir?: string): SplitResult {
  // 1. Lê arquivo
  const sourceCode = readFileSync(filePath, "utf-8");

  // 2. Parseia AST
  const ast = parseSync(sourceCode, {
    syntax: "typescript",
    tsx: true,
  });

  // 3. Extrai elementos
  const extracted = extractElements(ast);

  // 4. Gera código server (re-export)
  const serverCode = generateServerCode(extracted, filePath, outDir);

  // 5. Gera código client (re-export)
  const clientCode = generateClientCode(extracted, filePath, outDir);

  return {
    serverCode,
    clientCode,
    metadata: {
      hasLoader: extracted.loader !== null,
      actions: extracted.actions.map((a) => a.name),
      hasDefaultExport: extracted.defaultExport !== null,
    },
  };
}

/**
 * Elementos extraídos do código
 */
interface ExtractedElements {
  loader: FunctionInfo | null;
  actions: FunctionInfo[];
  defaultExport: ExportInfo | null;
  imports: ImportInfo[];
}

/**
 * Informação sobre função
 */
interface FunctionInfo {
  name: string;
  start: number;
  end: number;
  code: string;
}

/**
 * Informação sobre export
 */
interface ExportInfo {
  start: number;
  end: number;
  code: string;
}

/**
 * Informação sobre import
 */
interface ImportInfo {
  start: number;
  end: number;
  code: string;
}

/**
 * Extrai loader, actions, default export e imports do AST
 */
function extractElements(ast: Module): ExtractedElements {
  const elements: ExtractedElements = {
    loader: null,
    actions: [],
    defaultExport: null,
    imports: [],
  };

  ast.body.forEach((item: ModuleItem) => {
    // Import declarations
    if (item.type === "ImportDeclaration") {
      elements.imports.push({
        start: item.span.start,
        end: item.span.end,
        code: "", // Será extraído depois
      });
    }

    // Export declarations
    if (item.type === "ExportDeclaration") {
      const declaration = item.declaration;

      // Function declaration
      if (declaration.type === "FunctionDeclaration") {
        const funcName = declaration.identifier.value;

        // Loader
        if (funcName === "loader") {
          elements.loader = {
            name: funcName,
            start: item.span.start,
            end: item.span.end,
            code: "",
          };
        }

        // Actions (action_*)
        if (funcName.startsWith("action_")) {
          elements.actions.push({
            name: funcName,
            start: item.span.start,
            end: item.span.end,
            code: "",
          });
        }
      }
    }

    // Default export
    if (item.type === "ExportDefaultDeclaration") {
      elements.defaultExport = {
        start: item.span.start,
        end: item.span.end,
        code: "",
      };
    }
  });

  return elements;
}

/**
 * Gera código do servidor (loader + actions) - usa re-exports
 */
function generateServerCode(
  extracted: ExtractedElements,
  _filePath: string,
  _outDir?: string
): string {
  // Se não tem nada, retorna export vazio
  if (!extracted.loader && extracted.actions.length === 0) {
    return "// No server-side code\n";
  }

  // Monta lista de exports
  const exports: string[] = [];
  if (extracted.loader) {
    exports.push("loader");
  }
  extracted.actions.forEach((action) => {
    exports.push(action.name);
  });

  // Re-export tudo do arquivo original
  // Como os arquivos server ficam em .velojs/ e os originais em app/
  // Exemplo: .velojs/home/page.server.ts -> ../../app/home/page.tsx
  //          .velojs/admin/users/page.server.ts -> ../../../app/admin/users/page.tsx
  const appRelativePath = _filePath.split("/app/")[1];
  const depth = appRelativePath.split("/").length;
  const upLevels = "../".repeat(depth);
  const relativePath = `${upLevels}app/${appRelativePath}`;
  return `export * from "${relativePath}";\n`;
}

/**
 * Gera código do cliente (component) - usa re-export
 */
function generateClientCode(
  extracted: ExtractedElements,
  _filePath: string,
  _outDir?: string
): string {
  // Se não tem component, retorna export vazio
  if (!extracted.defaultExport) {
    return "// No client-side component\n";
  }

  // Re-export apenas o default do arquivo original
  const appRelativePath = _filePath.split("/app/")[1];
  const depth = appRelativePath.split("/").length;
  const upLevels = "../".repeat(depth);
  const relativePath = `${upLevels}app/${appRelativePath}`;
  return `export { default } from "${relativePath}";\n`;
}
