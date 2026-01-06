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
 * @returns Código separado
 */
export function splitCode(filePath: string): SplitResult {
  // 1. Lê arquivo
  const sourceCode = readFileSync(filePath, "utf-8");

  // 2. Parseia AST
  const ast = parseSync(sourceCode, {
    syntax: "typescript",
    tsx: true,
  });

  // 3. Extrai elementos
  const extracted = extractElements(ast);

  // 4. Gera código server
  const serverCode = generateServerCode(extracted, sourceCode);

  // 5. Gera código client
  const clientCode = generateClientCode(extracted, sourceCode);

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
 * Gera código do servidor (loader + actions)
 */
function generateServerCode(
  extracted: ExtractedElements,
  sourceCode: string
): string {
  const parts: string[] = [];

  // Loader
  if (extracted.loader) {
    const code = sourceCode.slice(
      extracted.loader.start,
      extracted.loader.end
    );
    parts.push(code);
  }

  // Actions
  extracted.actions.forEach((action) => {
    const code = sourceCode.slice(action.start, action.end);
    parts.push(code);
  });

  // Se não tem nada, retorna export vazio
  if (parts.length === 0) {
    return "// No server-side code\n";
  }

  return parts.join("\n\n");
}

/**
 * Gera código do cliente (imports + component)
 */
function generateClientCode(
  extracted: ExtractedElements,
  sourceCode: string
): string {
  const parts: string[] = [];

  // Imports
  extracted.imports.forEach((imp) => {
    const code = sourceCode.slice(imp.start, imp.end);
    parts.push(code);
  });

  // Default export (component)
  if (extracted.defaultExport) {
    const code = sourceCode.slice(
      extracted.defaultExport.start,
      extracted.defaultExport.end
    );
    parts.push(code);
  }

  // Se não tem component, retorna export vazio
  if (!extracted.defaultExport) {
    return "// No client-side component\n";
  }

  return parts.join("\n\n");
}
