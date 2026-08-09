/**
 * VeloJS Project Graph
 *
 * Builds a structural JSON snapshot of the project — route tree hierarchy,
 * module dependency graph, and convention exports — from source code alone.
 * No Vite, no dev server, no build. Used by `velojs graph` and by the
 * `velo:graph` Vite plugin.
 */

import fs from "node:fs";
import path from "node:path";

import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import * as t from "@babel/types";

const traverse =
    typeof _traverse === "function"
        ? _traverse
        : (_traverse as unknown as { default: typeof _traverse }).default;

// ============================================
// TYPES
// ============================================

export interface RouteTreeNode {
    moduleId: string | null;
    fullPath: string | null;
    path: string | null;
    isRoot: boolean;
    middlewares: string[];
    children: RouteTreeNode[];
}

export interface ModuleExports {
    hasComponent: boolean;
    hasLoader: boolean;
    actions: string[];
    streams: string[];
    sockets: string[];
}

export interface ModuleInfo {
    file: string;
    kind: "root" | "layout" | "page" | "unknown";
    exports: ModuleExports;
    imports: string[];
    importedBy: string[];
}

export interface GraphJson {
    routes: RouteTreeNode[];
    modules: Record<string, ModuleInfo>;
}

// ============================================
// EXPORT DETECTION — same regexes as the Vite transform plugin
// ============================================

const RE_COMPONENT = /export\s+(const|function)\s+Component/;
const RE_LOADER = /export\s+(const|function)\s+loader/;
const RE_ACTION = /export\s+const\s+action_(\w+)/g;
const RE_STREAM = /export\s+const\s+stream_(\w+)/g;
const RE_SOCKET = /export\s+const\s+socket_(\w+)/g;

export function detectExports(filePath: string): ModuleExports {
    let code: string;
    try {
        code = fs.readFileSync(filePath, "utf-8");
    } catch {
        return {
            hasComponent: false,
            hasLoader: false,
            actions: [],
            streams: [],
            sockets: [],
        };
    }

    const actions: string[] = [];
    let match: RegExpExecArray | null;
    const actionRe = new RegExp(RE_ACTION.source, "g");
    while ((match = actionRe.exec(code)) !== null) {
        actions.push(match[1]!);
    }

    const streams: string[] = [];
    const streamRe = new RegExp(RE_STREAM.source, "g");
    while ((match = streamRe.exec(code)) !== null) {
        streams.push(match[1]!);
    }

    const sockets: string[] = [];
    const socketRe = new RegExp(RE_SOCKET.source, "g");
    while ((match = socketRe.exec(code)) !== null) {
        sockets.push(match[1]!);
    }

    return {
        hasComponent: RE_COMPONENT.test(code),
        hasLoader: RE_LOADER.test(code),
        actions,
        streams,
        sockets,
    };
}

// ============================================
// ROUTE TREE — hierarchical variant of buildFullPathMap
// ============================================

function parseRouteSource(code: string): {
    imports: Map<string, string>;
    arrayNode: t.ArrayExpression | null;
} {
    const ast = parse(code, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
    });

    const imports = new Map<string, string>();

    traverse(ast, {
        ImportDeclaration(nodePath) {
            const source = nodePath.node.source.value;

            for (const specifier of nodePath.node.specifiers) {
                if (t.isImportNamespaceSpecifier(specifier)) {
                    imports.set(specifier.local.name, source);
                }
            }
        },
    });

    let arrayNode: t.ArrayExpression | null = null;

    traverse(ast, {
        ExportDefaultDeclaration(nodePath) {
            const declaration = nodePath.node.declaration;

            if (t.isArrayExpression(declaration)) {
                arrayNode = declaration;
            } else if (
                (t.isTSSatisfiesExpression(declaration) ||
                    t.isTSAsExpression(declaration)) &&
                t.isArrayExpression(declaration.expression)
            ) {
                arrayNode = declaration.expression;
            }
        },
    });

    return { imports, arrayNode };
}

function nodeToModuleId(
    moduleName: string | null,
    imports: Map<string, string>
): string | null {
    if (!moduleName) return null;
    const source = imports.get(moduleName);
    if (!source) return null;
    return source.replace(/^\.\//, "").replace(/\.(tsx?|jsx?|js)$/, "");
}

function buildRouteNodes(
    elements: (t.Expression | t.SpreadElement | null)[],
    parentPath: string,
    imports: Map<string, string>
): RouteTreeNode[] {
    const nodes: RouteTreeNode[] = [];

    for (const element of elements) {
        if (!t.isObjectExpression(element)) continue;

        let nodePath = "";
        let currentPath = parentPath;
        let moduleName: string | null = null;
        let childrenNode: t.ArrayExpression | null = null;
        let isRoot = false;
        const middlewares: string[] = [];
        const props = element.properties.filter((p): p is t.ObjectProperty =>
            t.isObjectProperty(p)
        );

        for (const prop of props) {
            const key = prop.key;
            const keyName = t.isIdentifier(key) ? key.name : null;

            if (keyName === "path" && t.isStringLiteral(prop.value)) {
                nodePath = prop.value.value;
                if (nodePath && !nodePath.startsWith("/")) {
                    currentPath = parentPath + "/" + nodePath;
                } else {
                    currentPath = parentPath + nodePath;
                }
            }

            if (keyName === "module" && t.isIdentifier(prop.value)) {
                moduleName = prop.value.name;
            }

            if (keyName === "children" && t.isArrayExpression(prop.value)) {
                childrenNode = prop.value;
            }

            if (keyName === "isRoot" && t.isBooleanLiteral(prop.value)) {
                isRoot = prop.value.value;
            }

            if (keyName === "middlewares" && t.isArrayExpression(prop.value)) {
                for (const el of prop.value.elements) {
                    if (el && t.isIdentifier(el)) {
                        middlewares.push(el.name);
                    }
                }
            }
        }

        const moduleId = nodeToModuleId(moduleName, imports);

        const isLeafWithSlash =
            !childrenNode && nodePath === "/";
        const effectiveFullPath = isLeafWithSlash
            ? parentPath || "/"
            : currentPath;

        const childNodes = childrenNode
            ? buildRouteNodes(childrenNode.elements, currentPath, imports)
            : [];

        nodes.push({
            moduleId,
            fullPath: moduleId ? effectiveFullPath : null,
            path: moduleId ? nodePath : null,
            isRoot,
            middlewares,
            children: childNodes,
        });
    }

    return nodes;
}

export function buildRouteTree(code: string): RouteTreeNode[] {
    const { imports, arrayNode } = parseRouteSource(code);
    if (!arrayNode) return [];
    return buildRouteNodes(arrayNode.elements, "", imports);
}

// ============================================
// IMPORT RESOLVER — resolve "./Foo.js" → "/abs/path/app/Foo.tsx"
// ============================================

const EXTENSION_ORDER = [".tsx", ".ts", ".jsx", ".js"];

function resolveImportSource(
    fromFile: string,
    importSource: string,
    appDir: string
): string | null {
    if (
        importSource.startsWith(".") &&
        (importSource.endsWith(".js") ||
            importSource.endsWith(".jsx") ||
            importSource.endsWith(".ts") ||
            importSource.endsWith(".tsx"))
    ) {
        const dir = path.dirname(fromFile);
        const base = path.resolve(dir, importSource);
        const baseNoExt = base.replace(/\.(tsx?|jsx?|js)$/, "");

        for (const ext of EXTENSION_ORDER) {
            const candidate = baseNoExt + ext;
            if (fs.existsSync(candidate)) return candidate;
        }

        const indexCandidates = [baseNoExt];
        for (const cand of indexCandidates) {
            if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) {
                for (const ext of EXTENSION_ORDER) {
                    const idx = path.join(cand, "index" + ext);
                    if (fs.existsSync(idx)) return idx;
                }
            }
        }

        return null;
    }

    return null;
}

function fileToModuleId(filePath: string, appDir: string): string | null {
    const relative = path.relative(appDir, filePath);
    if (relative.startsWith("..")) return null;
    return relative.replace(/\.(tsx?|jsx?|js)$/, "");
}

// ============================================
// IMPORT CRAWLER
// ============================================

function collectModuleImports(
    entryFile: string,
    appDir: string
): {
    modules: Map<string, { file: string; imports: string[] }>;
} {
    const modules = new Map<
        string,
        { file: string; imports: string[] }
    >();
    const visited = new Set<string>();

    function crawl(filePath: string): void {
        if (visited.has(filePath)) return;
        visited.add(filePath);

        const moduleId = fileToModuleId(filePath, appDir);
        if (!moduleId) return;

        let code: string;
        try {
            code = fs.readFileSync(filePath, "utf-8");
        } catch {
            return;
        }

        const importIds: string[] = [];

        const ast = parse(code, {
            sourceType: "module",
            plugins: ["typescript", "jsx"],
        });

        traverse(ast, {
            ImportDeclaration(nodePath) {
                const source = nodePath.node.source.value;

                if (source.startsWith(".")) {
                    const resolved = resolveImportSource(
                        filePath,
                        source,
                        appDir
                    );
                    if (resolved) {
                        const importedId = fileToModuleId(
                            resolved,
                            appDir
                        );
                        if (importedId) {
                            importIds.push(importedId);
                            crawl(resolved);
                        }
                    }
                } else {
                    importIds.push(source);
                }
            },
        });

        modules.set(moduleId, { file: filePath, imports: [...new Set(importIds)] });
    }

    crawl(entryFile);
    return { modules };
}

// ============================================
// MAIN — buildGraph
// ============================================

export function buildGraph(appDir: string): GraphJson {
    const routesFilePath = path.join(appDir, "routes.tsx");
    let routesCode: string;
    try {
        routesCode = fs.readFileSync(routesFilePath, "utf-8");
    } catch {
        return { routes: [], modules: {} };
    }

    const routes = buildRouteTree(routesCode);

    const { modules: rawModules } = collectModuleImports(
        routesFilePath,
        appDir
    );

    const modules: Record<string, ModuleInfo> = {};
    const importedBy = new Map<string, string[]>();

    for (const [moduleId, mod] of rawModules) {
        let kind: ModuleInfo["kind"] = "unknown";

        const findInTree = (
            nodes: RouteTreeNode[]
        ): ModuleInfo["kind"] | null => {
            for (const node of nodes) {
                if (node.moduleId === moduleId) {
                    if (node.isRoot) return "root";
                    if (node.children.length > 0) return "layout";
                    return "page";
                }
                const child = findInTree(node.children);
                if (child) return child;
            }
            return null;
        };

        const treeKind = findInTree(routes);
        if (treeKind) kind = treeKind;

        const filePath = mod.file;
        const exports = detectExports(filePath);

        for (const impId of mod.imports) {
            if (!importedBy.has(impId)) {
                importedBy.set(impId, []);
            }
            const list = importedBy.get(impId)!;
            if (!list.includes(moduleId)) {
                list.push(moduleId);
            }
        }

        modules[moduleId] = {
            file: path.relative(process.cwd(), filePath),
            kind,
            exports,
            imports: mod.imports,
            importedBy: [],
        };
    }

    for (const [moduleId, info] of Object.entries(modules)) {
        info.importedBy = importedBy.get(moduleId) ?? [];
    }

    return { routes, modules };
}
