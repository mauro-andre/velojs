import type { Plugin, PluginOption, UserConfig } from "vite";
import path from "node:path";
import fs from "node:fs";
import type { VeloConfig } from "./config.js";

// External plugins
import preact from "@preact/preset-vite";
import devServer from "@hono/vite-dev-server";

// Babel imports
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";
import * as t from "@babel/types";

// Workaround para ESM — handle both CJS-wrapped and direct ESM exports
const traverse = typeof _traverse === "function"
    ? _traverse
    : (_traverse as unknown as { default: typeof _traverse }).default;
const generate = typeof _generate === "function"
    ? _generate
    : (_generate as unknown as { default: typeof _generate }).default;

// ============================================
// TRANSFORMAÇÃO 1: Injetar metadata (moduleId + fullPath)
// ============================================

export function injectMetadata(
    code: string,
    moduleId: string,
    fullPath?: string,
    path?: string
): string {
    const ast = parse(code, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
    });

    let metadataFound = false;

    traverse(ast, {
        // Procura: export const metadata = { ... }
        ExportNamedDeclaration(nodePath) {
            const declaration = nodePath.node.declaration;

            if (
                t.isVariableDeclaration(declaration) &&
                declaration.declarations.length === 1
            ) {
                const declarator = declaration.declarations[0];

                if (
                    declarator &&
                    t.isIdentifier(declarator.id, { name: "metadata" }) &&
                    t.isObjectExpression(declarator.init)
                ) {
                    metadataFound = true;
                    const properties = declarator.init.properties;

                    // Remove moduleId, fullPath e path existentes se houver
                    const filteredProps = properties.filter((prop) => {
                        if (
                            t.isObjectProperty(prop) &&
                            t.isIdentifier(prop.key)
                        ) {
                            return (
                                prop.key.name !== "moduleId" &&
                                prop.key.name !== "fullPath" &&
                                prop.key.name !== "path"
                            );
                        }
                        return true;
                    });

                    // Adiciona moduleId
                    const newProps: t.ObjectProperty[] = [
                        t.objectProperty(
                            t.identifier("moduleId"),
                            t.stringLiteral(moduleId)
                        ),
                    ];

                    // Adiciona fullPath se disponível
                    if (fullPath !== undefined) {
                        newProps.push(
                            t.objectProperty(
                                t.identifier("fullPath"),
                                t.stringLiteral(fullPath)
                            )
                        );
                    }

                    // Adiciona path se disponível
                    if (path !== undefined) {
                        newProps.push(
                            t.objectProperty(
                                t.identifier("path"),
                                t.stringLiteral(path)
                            )
                        );
                    }

                    declarator.init.properties = [...newProps, ...filteredProps];
                }
            }
        },
    });

    // Se não encontrou metadata, adiciona no início
    if (!metadataFound) {
        const props: t.ObjectProperty[] = [
            t.objectProperty(
                t.identifier("moduleId"),
                t.stringLiteral(moduleId)
            ),
        ];

        if (fullPath !== undefined) {
            props.push(
                t.objectProperty(
                    t.identifier("fullPath"),
                    t.stringLiteral(fullPath)
                )
            );
        }

        if (path !== undefined) {
            props.push(
                t.objectProperty(
                    t.identifier("path"),
                    t.stringLiteral(path)
                )
            );
        }

        const metadataExport = t.exportNamedDeclaration(
            t.variableDeclaration("const", [
                t.variableDeclarator(
                    t.identifier("metadata"),
                    t.objectExpression(props)
                ),
            ])
        );

        ast.program.body.unshift(metadataExport);
    }

    const output = generate(ast, { retainLines: true });
    return output.code;
}

// ============================================
// TRANSFORMAÇÃO 2: Injetar moduleId no Loader e useLoader
// ============================================

export function transformLoaderFunctions(code: string, moduleId: string): string {
    const ast = parse(code, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
    });

    traverse(ast, {
        CallExpression(nodePath) {
            const callee = nodePath.node.callee;

            // Verifica se é chamada de Loader ou useLoader (com ou sem type params)
            const isLoader =
                t.isIdentifier(callee, { name: "Loader" }) ||
                (t.isTSInstantiationExpression(callee) &&
                    t.isIdentifier(callee.expression, { name: "Loader" }));

            const isUseLoader =
                t.isIdentifier(callee, { name: "useLoader" }) ||
                (t.isTSInstantiationExpression(callee) &&
                    t.isIdentifier(callee.expression, { name: "useLoader" }));

            if (!isLoader && !isUseLoader) return;

            const args = nodePath.node.arguments;
            const moduleIdArg = t.stringLiteral(moduleId);

            // Se já tem moduleId (string com "/" como primeiro arg), não faz nada
            const firstArg = args[0];
            if (t.isStringLiteral(firstArg) && firstArg.value.includes("/")) {
                return;
            }

            // Prepende moduleId como primeiro argumento, mantendo os existentes
            // useLoader() → useLoader("moduleId")
            // useLoader([deps]) → useLoader("moduleId", [deps])
            nodePath.node.arguments = [moduleIdArg, ...args];
        },
    });

    const output = generate(ast, { retainLines: true });
    return output.code;
}

// ============================================
// TRANSFORMAÇÃO 3: Actions → Fetch stubs (client only)
// ============================================

export function transformActionsForClient(code: string, moduleId: string): string {
    const ast = parse(code, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
    });

    traverse(ast, {
        ExportNamedDeclaration(nodePath) {
            const declaration = nodePath.node.declaration;

            // Procura: export const action_xxx = async (...) => { ... }
            if (!t.isVariableDeclaration(declaration)) return;

            const declarator = declaration.declarations[0];
            if (!declarator || !t.isIdentifier(declarator.id)) return;

            const name = declarator.id.name;
            if (!name.startsWith("action_")) return;

            const actionName = name.replace("action_", "");

            // Verifica se é arrow function async
            const init = declarator.init;
            if (!t.isArrowFunctionExpression(init) || !init.async) return;

            const params = init.params;

            // Cria o corpo do fetch stub
            const fetchCall = createFetchStub(moduleId, actionName, params);

            // Substitui o corpo da função
            init.body = t.blockStatement([t.returnStatement(fetchCall)]);

            // Ajusta os parâmetros para o client
            adjustParamsForClient(init, params);
        },
    });

    const output = generate(ast, { retainLines: true });
    return output.code;
}

/**
 * Cria a expressão fetch para o stub
 */
function createFetchStub(
    moduleId: string,
    actionName: string,
    params: t.ArrowFunctionExpression["params"]
): t.Expression {
    const url = `/_action/${moduleId}/${actionName}`;

    // Se não tem parâmetros, fetch simples sem body
    if (params.length === 0) {
        return t.callExpression(
            t.memberExpression(
                t.callExpression(t.identifier("fetch"), [
                    t.stringLiteral(url),
                    t.objectExpression([
                        t.objectProperty(
                            t.identifier("method"),
                            t.stringLiteral("POST")
                        ),
                    ]),
                ]),
                t.identifier("then")
            ),
            [
                t.arrowFunctionExpression(
                    [t.identifier("r")],
                    t.callExpression(
                        t.memberExpression(
                            t.identifier("r"),
                            t.identifier("json")
                        ),
                        []
                    )
                ),
            ]
        );
    }

    // Com parâmetros - precisa enviar body
    return t.callExpression(
        t.memberExpression(
            t.callExpression(t.identifier("fetch"), [
                t.stringLiteral(url),
                t.objectExpression([
                    t.objectProperty(
                        t.identifier("method"),
                        t.stringLiteral("POST")
                    ),
                    t.objectProperty(
                        t.identifier("headers"),
                        t.objectExpression([
                            t.objectProperty(
                                t.stringLiteral("Content-Type"),
                                t.stringLiteral("application/json")
                            ),
                        ])
                    ),
                    t.objectProperty(
                        t.identifier("body"),
                        t.callExpression(
                            t.memberExpression(
                                t.identifier("JSON"),
                                t.identifier("stringify")
                            ),
                            [t.identifier("body")]
                        )
                    ),
                ]),
            ]),
            t.identifier("then")
        ),
        [
            t.arrowFunctionExpression(
                [t.identifier("r")],
                t.callExpression(
                    t.memberExpression(t.identifier("r"), t.identifier("json")),
                    []
                )
            ),
        ]
    );
}

/**
 * Ajusta os parâmetros da action para o client
 * Ex: ({ body, c }: ActionArgs<LoginBody>) → ({ body }: { body: LoginBody })
 */
function adjustParamsForClient(
    fn: t.ArrowFunctionExpression,
    params: t.ArrowFunctionExpression["params"]
): void {
    if (params.length === 0) return;

    const firstParam = params[0];

    // Se é ObjectPattern (desestruturação), mantém só { body }
    if (t.isObjectPattern(firstParam)) {
        // Extrai o tipo do body se tiver ActionArgs<T>
        let bodyType: t.TSType | null = null;

        if (
            t.isTSTypeAnnotation(firstParam.typeAnnotation) &&
            t.isTSTypeReference(firstParam.typeAnnotation.typeAnnotation)
        ) {
            const typeRef = firstParam.typeAnnotation.typeAnnotation;

            // Verifica se é ActionArgs<T>
            if (
                t.isIdentifier(typeRef.typeName, { name: "ActionArgs" }) &&
                typeRef.typeParameters?.params[0]
            ) {
                bodyType = typeRef.typeParameters.params[0];
            }
        }

        // Cria novo parâmetro: { body }: { body: T }
        const bodyProp = t.objectProperty(
            t.identifier("body"),
            t.identifier("body"),
            false,
            true // shorthand
        );

        const newParam = t.objectPattern([bodyProp]);

        if (bodyType) {
            newParam.typeAnnotation = t.tsTypeAnnotation(
                t.tsTypeLiteral([
                    t.tsPropertySignature(
                        t.identifier("body"),
                        t.tsTypeAnnotation(bodyType)
                    ),
                ])
            );
        }

        fn.params = [newParam];
    }
}

// ============================================
// TRANSFORMAÇÃO 3.5: Streams → Client stub (client only)
// ============================================

/**
 * Transforma `export const stream_xxx = createEventStream({...})` no client em
 * um stub com apenas { __isVeloEventStream: true, __path: "/_event/{moduleId}/{name}" }.
 *
 * O body do `createEventStream` é descartado — listeners, snapshot, channel funcs etc.
 * só rodam no server. O client precisa apenas do path para abrir o EventSource.
 */
export function transformStreamsForClient(code: string, moduleId: string): string {
    const ast = parse(code, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
    });

    traverse(ast, {
        ExportNamedDeclaration(nodePath) {
            const declaration = nodePath.node.declaration;
            if (!t.isVariableDeclaration(declaration)) return;

            const declarator = declaration.declarations[0];
            if (!declarator || !t.isIdentifier(declarator.id)) return;

            const name = declarator.id.name;
            if (!name.startsWith("stream_")) return;

            const streamName = name.replace("stream_", "");
            const path = `/_event/${moduleId}/${streamName}`;

            // Substitui a init expression por um objeto stub
            declarator.init = t.objectExpression([
                t.objectProperty(
                    t.identifier("__isVeloEventStream"),
                    t.booleanLiteral(true)
                ),
                t.objectProperty(
                    t.identifier("__path"),
                    t.stringLiteral(path)
                ),
            ]);

            // Remove anotação de tipo do declarador (se houver), já que o stub
            // tem outra forma. O tipo original vai sobreviver via inferência do
            // import do `EventStream` no caller.
            declarator.id.typeAnnotation = null;
        },
    });

    const output = generate(ast, { retainLines: true });
    return output.code;
}

// ============================================
// TRANSFORMAÇÃO 4: Remover loaders (client only)
// ============================================

export function removeLoaders(code: string): string {
    const ast = parse(code, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
    });

    traverse(ast, {
        ExportNamedDeclaration(nodePath) {
            const declaration = nodePath.node.declaration;

            // Procura: export const loader = ...
            if (!t.isVariableDeclaration(declaration)) return;

            const declarator = declaration.declarations[0];
            if (!declarator || !t.isIdentifier(declarator.id)) return;

            if (declarator.id.name === "loader") {
                // Remove o export inteiro
                nodePath.remove();
            }
        },
    });

    const output = generate(ast, { retainLines: true });
    return output.code;
}

// ============================================
// TRANSFORMAÇÃO 5: Remover middlewares e imports (client only)
// ============================================

export function removeMiddlewares(code: string): string {
    const ast = parse(code, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
    });

    // Fase 1: Coleta identificadores usados em middlewares: [...]
    const middlewareIdentifiers = new Set<string>();

    traverse(ast, {
        ObjectProperty(nodePath) {
            // Procura: middlewares: [...]
            if (
                t.isIdentifier(nodePath.node.key, { name: "middlewares" }) &&
                t.isArrayExpression(nodePath.node.value)
            ) {
                // Coleta todos os identificadores no array
                for (const element of nodePath.node.value.elements) {
                    if (t.isIdentifier(element)) {
                        middlewareIdentifiers.add(element.name);
                    }
                }

                // Remove a propriedade middlewares
                nodePath.remove();
            }
        },
    });

    // Se não encontrou middlewares, retorna código original
    if (middlewareIdentifiers.size === 0) {
        return code;
    }

    // Fase 2: Remove imports dos identificadores de middleware
    traverse(ast, {
        ImportDeclaration(nodePath) {
            const specifiers = nodePath.node.specifiers;

            // Filtra os specifiers, removendo os que são middlewares
            const remainingSpecifiers = specifiers.filter((specifier) => {
                if (t.isImportSpecifier(specifier)) {
                    const localName = specifier.local.name;
                    return !middlewareIdentifiers.has(localName);
                }
                // Mantém default imports e namespace imports
                return true;
            });

            if (remainingSpecifiers.length === 0) {
                // Remove o import inteiro se não sobrou nenhum specifier
                nodePath.remove();
            } else if (remainingSpecifiers.length !== specifiers.length) {
                // Atualiza os specifiers se alguns foram removidos
                nodePath.node.specifiers = remainingSpecifiers;
            }
        },
    });

    const output = generate(ast, { retainLines: true });
    return output.code;
}

// ============================================
// TRANSFORMAÇÃO 5.5: Remover EndpointRoutes do routes.tsx (client only)
// ============================================

/**
 * Collects all Identifier names referenced anywhere inside `node` (and its
 * subtree). Skips the *keys* of non-computed ObjectProperty and the
 * *property* side of non-computed MemberExpression, since those are symbolic
 * and not references to a binding.
 */
function collectReferencedIdentifiers(node: unknown, into: Set<string>): void {
    const walk = (n: any): void => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) {
            for (const item of n) walk(item);
            return;
        }
        if (n.type === "Identifier") {
            into.add(n.name);
            return;
        }
        if (n.type === "MemberExpression") {
            walk(n.object);
            if (n.computed) walk(n.property);
            return;
        }
        if ((n.type === "ObjectProperty" || n.type === "ObjectMethod") && !n.computed) {
            // Skip the key (symbolic), walk value/body
            if (n.type === "ObjectProperty") walk(n.value);
            else walk(n.body);
            return;
        }
        if (n.type === "ImportSpecifier" || n.type === "ImportDefaultSpecifier" || n.type === "ImportNamespaceSpecifier") {
            // Imports are sources, not references — don't count
            return;
        }
        for (const key of Object.keys(n)) {
            if (key === "loc" || key === "start" || key === "end" ||
                key === "leadingComments" || key === "trailingComments" ||
                key === "innerComments") continue;
            walk(n[key]);
        }
    };
    walk(node);
}

/** Returns true if `obj` is an EndpointRoute ObjectExpression (has a `handler` property). */
function isEndpointObjectExpression(obj: t.ObjectExpression): boolean {
    for (const prop of obj.properties) {
        if (t.isObjectProperty(prop) && t.isIdentifier(prop.key) && prop.key.name === "handler") {
            return true;
        }
    }
    return false;
}

/** Returns the inner `children` ArrayExpression if present on a PageRoute-like object. */
function findChildrenArray(obj: t.ObjectExpression): t.ArrayExpression | null {
    for (const prop of obj.properties) {
        if (t.isObjectProperty(prop) &&
            t.isIdentifier(prop.key) &&
            prop.key.name === "children" &&
            t.isArrayExpression(prop.value)) {
            return prop.value;
        }
    }
    return null;
}

/**
 * On client builds, strip EndpointRoute objects from the default-export array
 * of `routes.tsx` so server-only handler code (and its imports) don't ship to
 * the browser. Mirrors the pattern used by `removeMiddlewares`.
 *
 * Detection: any ObjectExpression that has a `handler` property is treated as
 * an endpoint and removed from its containing array. Imports referenced only
 * by removed endpoints are dropped afterwards.
 */
export function removeEndpointRoutes(code: string): string {
    const ast = parse(code, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
    });

    const removedEndpoints: t.ObjectExpression[] = [];

    // Phase 1: walk the default-export routes array recursively, removing
    // ObjectExpressions with a `handler` property.
    const walkArray = (arr: t.ArrayExpression): void => {
        for (let i = arr.elements.length - 1; i >= 0; i--) {
            const el = arr.elements[i];
            if (!t.isObjectExpression(el)) continue;
            if (isEndpointObjectExpression(el)) {
                removedEndpoints.push(el);
                arr.elements.splice(i, 1);
                continue;
            }
            const children = findChildrenArray(el);
            if (children) walkArray(children);
        }
    };

    traverse(ast, {
        ExportDefaultDeclaration(nodePath) {
            const decl = nodePath.node.declaration;
            let arr: t.ArrayExpression | null = null;
            if (t.isArrayExpression(decl)) {
                arr = decl;
            } else if (t.isTSSatisfiesExpression(decl) && t.isArrayExpression(decl.expression)) {
                arr = decl.expression;
            } else if (t.isTSAsExpression(decl) && t.isArrayExpression(decl.expression)) {
                arr = decl.expression;
            }
            if (arr) walkArray(arr);
        },
    });

    if (removedEndpoints.length === 0) return code;

    // Phase 2: collect identifiers used *inside* removed endpoints.
    const usedInRemoved = new Set<string>();
    for (const ep of removedEndpoints) {
        collectReferencedIdentifiers(ep, usedInRemoved);
    }

    // Phase 3: collect identifiers still referenced in the AST *after* removal
    // (excluding ImportSpecifier locals, which are the binding sites).
    const stillUsed = new Set<string>();
    collectReferencedIdentifiers(ast.program, stillUsed);

    // Phase 4: the identifiers safe to strip = used only by removed endpoints.
    const toStrip = new Set<string>();
    for (const name of usedInRemoved) {
        if (!stillUsed.has(name)) toStrip.add(name);
    }

    if (toStrip.size > 0) {
        traverse(ast, {
            ImportDeclaration(nodePath) {
                const specifiers = nodePath.node.specifiers;
                const kept = specifiers.filter((spec) => !toStrip.has(spec.local.name));
                if (kept.length === 0) {
                    nodePath.remove();
                } else if (kept.length !== specifiers.length) {
                    nodePath.node.specifiers = kept;
                }
            },
        });
    }

    const output = generate(ast, { retainLines: true });
    return output.code;
}

// ============================================
// TRANSFORMAÇÃO 6: Extrair e injetar fullPaths
// ============================================

export interface PathInfo {
    fullPath: string;
    path: string;
}

/**
 * Parseia routes.tsx e retorna Map de moduleId → { fullPath, path }
 * moduleId aqui é derivado do import source (ex: "./auth/Login.js" → "auth/Login")
 */
export function buildFullPathMap(code: string): Map<string, PathInfo> {
    const ast = parse(code, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
    });

    // Fase 1: Coletar imports - localName → source
    const imports = new Map<string, string>();

    traverse(ast, {
        ImportDeclaration(nodePath) {
            const source = nodePath.node.source.value;

            for (const specifier of nodePath.node.specifiers) {
                if (t.isImportNamespaceSpecifier(specifier)) {
                    // import * as Name from "./path"
                    imports.set(specifier.local.name, source);
                }
            }
        },
    });

    // Fase 2: Percorrer rotas e coletar moduleName → { fullPath, path }
    const moduleNameToPaths = new Map<string, PathInfo>();

    traverse(ast, {
        ExportDefaultDeclaration(nodePath) {
            const declaration = nodePath.node.declaration;

            let arrayNode: t.ArrayExpression | null = null;

            if (t.isArrayExpression(declaration)) {
                arrayNode = declaration;
            } else if (
                t.isTSSatisfiesExpression(declaration) &&
                t.isArrayExpression(declaration.expression)
            ) {
                arrayNode = declaration.expression;
            }

            if (arrayNode) {
                collectFullPaths(arrayNode.elements, "", moduleNameToPaths);
            }
        },
    });

    // Fase 3: Converter moduleName → moduleId baseado no import source
    const result = new Map<string, PathInfo>();

    for (const [moduleName, pathInfo] of moduleNameToPaths) {
        const source = imports.get(moduleName);
        if (source) {
            // "./auth/Login.js" → "auth/Login"
            const moduleId = source
                .replace(/^\.\//, "")
                .replace(/\.(tsx?|jsx?|js)$/, "");
            result.set(moduleId, pathInfo);
        }
    }

    return result;
}

/**
 * Percorre recursivamente a árvore de rotas e coleta moduleName → { fullPath, path }
 */
export function collectFullPaths(
    elements: (t.Expression | t.SpreadElement | null)[],
    parentPath: string,
    result: Map<string, PathInfo>
): void {
    for (const element of elements) {
        if (!t.isObjectExpression(element)) continue;

        let nodePath = "";
        let currentPath = parentPath;
        let moduleName: string | null = null;
        let childrenNode: t.ArrayExpression | null = null;

        for (const prop of element.properties) {
            if (!t.isObjectProperty(prop)) continue;

            const key = prop.key;
            const keyName = t.isIdentifier(key) ? key.name : null;

            if (keyName === "path" && t.isStringLiteral(prop.value)) {
                nodePath = prop.value.value;
                // Adiciona / entre parentPath e nodePath se necessário
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
        }

        // Adiciona o módulo com seu fullPath e path
        if (moduleName) {
            // Se é folha (sem children) e path é "/", fullPath = parentPath (sem trailing slash)
            // Isso permite que wouter use "/" para index routes, mas servidor registra sem trailing slash
            const isLeafWithSlash = !childrenNode && nodePath === "/";
            const effectiveFullPath = isLeafWithSlash ? (parentPath || "/") : currentPath;

            result.set(moduleName, {
                fullPath: effectiveFullPath,
                path: nodePath,
            });
        }

        // Recursivamente processa os filhos
        if (childrenNode) {
            collectFullPaths(childrenNode.elements, currentPath, result);
        }
    }
}

// ============================================
// VIRTUAL MODULE IDs
// ============================================

const VIRTUAL_SERVER_ENTRY = "virtual:velo/server-entry";
const VIRTUAL_CLIENT_ENTRY = "virtual:velo/client-entry";
const RESOLVED_VIRTUAL_SERVER = "\0" + VIRTUAL_SERVER_ENTRY;
const RESOLVED_VIRTUAL_CLIENT = "\0" + VIRTUAL_CLIENT_ENTRY;

// ============================================
// VITE PLUGIN - TRANSFORM (internal)
// ============================================

function veloTransformPlugin(veloConfig: VeloConfig, appDirectory: string): Plugin {
    // Initialize with cwd as fallback, will be updated in configResolved
    let appDir: string = path.resolve(process.cwd(), appDirectory);
    const routesFile = veloConfig.routesFile ?? "routes.tsx";

    // Map de moduleId → { fullPath, path } (populado no buildStart)
    const pathInfoMap = new Map<string, PathInfo>();

    return {
        name: "velo:transform",
        enforce: "pre",

        configResolved(resolvedConfig) {
            appDir = path.resolve(resolvedConfig.root, appDirectory);
        },

        buildStart() {
            // Lê routes.tsx e popula o Map de paths
            const routesFilePath = path.join(appDir, routesFile);
            if (fs.existsSync(routesFilePath)) {
                const routesCode = fs.readFileSync(routesFilePath, "utf-8");
                const paths = buildFullPathMap(routesCode);
                pathInfoMap.clear();
                for (const [moduleId, pathInfo] of paths) {
                    pathInfoMap.set(moduleId, pathInfo);
                }
            }
        },

        handleHotUpdate({ file, server }) {
            // Reconstrói o Map quando routes.tsx muda
            const routesFilePath = path.join(appDir, routesFile);
            if (file === routesFilePath) {
                const routesCode = fs.readFileSync(routesFilePath, "utf-8");
                const paths = buildFullPathMap(routesCode);
                pathInfoMap.clear();
                for (const [moduleId, pathInfo] of paths) {
                    pathInfoMap.set(moduleId, pathInfo);
                }
                // Força reload completo para aplicar novas rotas
                server.ws.send({ type: "full-reload" });
                return [];
            }
        },

        resolveId(id) {
            // Handle server entry (with or without project root prefix)
            if (id === VIRTUAL_SERVER_ENTRY || id.endsWith(VIRTUAL_SERVER_ENTRY)) {
                return RESOLVED_VIRTUAL_SERVER;
            }
            // Handle client entry (with or without project root prefix)
            if (
                id === VIRTUAL_CLIENT_ENTRY ||
                id.endsWith(VIRTUAL_CLIENT_ENTRY) ||
                id === "/__velo_client.js"
            ) {
                return RESOLVED_VIRTUAL_CLIENT;
            }
            return null;
        },

        load(id) {
            const routesFile = veloConfig.routesFile ?? "routes.tsx";
            const serverInit = veloConfig.serverInit ?? "server.tsx";
            const clientInit = veloConfig.clientInit ?? "client.tsx";

            // Paths relativos ao appDir
            const routesPath = path.join(appDir, routesFile).replace(/\.tsx?$/, ".js");
            const serverInitPath = path.join(appDir, serverInit).replace(/\.tsx?$/, ".js");
            const clientInitPath = path.join(appDir, clientInit).replace(/\.tsx?$/, ".js");

            if (id === RESOLVED_VIRTUAL_SERVER) {
                return `
globalThis.__veloBuildHash = __VELO_BUILD_HASH__;
globalThis.__veloClientJs = __VELO_CLIENT_JS__;
globalThis.__veloClientCss = __VELO_CLIENT_CSS__;
import "${serverInitPath}";
import routes from "${routesPath}";
import { startServer } from "@mauroandre/velojs/server";

export { routes };
export default await startServer({ routes });
`;
            }

            if (id === RESOLVED_VIRTUAL_CLIENT) {
                return `
import "${clientInitPath}";
import routes from "${routesPath}";
import { startClient } from "@mauroandre/velojs/client";

startClient({ routes });
`;
            }

            return null;
        },

        transform(code, id, transformOptions) {
            const isSSR = transformOptions?.ssr === true;

            // Ignora virtual modules
            if (id.startsWith("\0")) return null;

            // Ignora arquivos dentro de .velojs/
            if (id.includes("/.velojs/")) return null;

            // Ignora arquivos que não são tsx/ts
            if (!id.endsWith(".tsx") && !id.endsWith(".ts")) return null;

            // Ignora arquivos fora do diretório da aplicação
            if (!id.startsWith(appDir)) return null;

            let transformedCode = code;
            let hasTransformations = false;

            // Verifica padrões no código
            const hasMiddlewares = /middlewares:\s*\[/.test(code);
            const hasComponent = /export\s+(const|function)\s+Component/.test(
                code
            );
            const hasLoader = /export\s+(const|function)\s+loader/.test(code);
            const hasAction = /export\s+const\s+action_\w+/.test(code);
            const hasStream = /export\s+const\s+stream_\w+/.test(code);
            const hasLoaderCall = /\bLoader\s*</.test(code) || /\bLoader\s*\(/.test(code);
            const hasUseLoaderCall = /\buseLoader\s*</.test(code) || /\buseLoader\s*\(/.test(code);
            const hasEndpointHandler = /\bhandler\s*:/.test(code);

            // Routes file path (used to scope the endpoint strip)
            const routesFilePath = path.join(appDir, routesFile);

            // 5. Remover middlewares e imports (client only)
            if (!isSSR && hasMiddlewares) {
                transformedCode = removeMiddlewares(transformedCode);
                hasTransformations = true;
            }

            // 5.5. Remover EndpointRoutes do routes.tsx (client only)
            // Scoped to routes.tsx because that's where endpoints are declared
            // — stripping `handler:` anywhere else would be wrong.
            if (!isSSR && hasEndpointHandler && id === routesFilePath) {
                transformedCode = removeEndpointRoutes(transformedCode);
                hasTransformations = true;
            }

            // Se tem Component, loader, action, stream, ou chamadas de Loader/useLoader, aplica transformações
            if (hasComponent || hasLoader || hasAction || hasStream || hasLoaderCall || hasUseLoaderCall) {
                const moduleId = path
                    .relative(appDir, id)
                    .replace(/\.(tsx?|jsx?)$/, "")
                    .replace(/\\/g, "/");

                // Busca pathInfo no Map
                const pathInfo = pathInfoMap.get(moduleId);

                // 1. Injeta metadata.moduleId, metadata.fullPath e metadata.path
                transformedCode = injectMetadata(transformedCode, moduleId, pathInfo?.fullPath, pathInfo?.path);

                // 2. Transformar Loader e useLoader
                transformedCode = transformLoaderFunctions(transformedCode, moduleId);

                // 3. Transformar actions em fetch stubs (client only)
                if (!isSSR) {
                    transformedCode = transformActionsForClient(
                        transformedCode,
                        moduleId
                    );
                }

                // 3.5. Transformar streams em stubs (client only)
                if (!isSSR && hasStream) {
                    transformedCode = transformStreamsForClient(
                        transformedCode,
                        moduleId
                    );
                }

                // 4. Remover loaders (client only)
                if (!isSSR) {
                    transformedCode = removeLoaders(transformedCode);
                }

                hasTransformations = true;
            }

            if (!hasTransformations) return null;

            return {
                code: transformedCode,
                map: null,
            };
        },
    };
}

// ============================================
// VITE PLUGIN - CONFIG (internal)
// ============================================

function veloConfigPlugin(): Plugin {
    return {
        name: "velo:config",

        config(userConfig, { mode }) {
            const isServer = mode === "server";
            const isDev = mode === "development";

            const isStatic = !!process.env.VELO_STATIC;

            // In server build, read the client manifest to get hashed asset filenames
            let clientJs = "client.js";
            let clientCss = "client.css";
            if (isServer) {
                try {
                    const manifestPath = path.resolve(process.cwd(), "dist/client/.vite/manifest.json");
                    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
                    const entry = manifest[VIRTUAL_CLIENT_ENTRY];
                    if (entry) {
                        clientJs = entry.file || clientJs;
                        if (entry.css?.[0]) clientCss = entry.css[0];
                    }
                } catch {}
            }

            const config: UserConfig = {
                define: {
                    "process.env.NODE_ENV": JSON.stringify(isDev ? "development" : "production"),
                    "process.env.STATIC_BASE_URL": JSON.stringify(process.env.STATIC_BASE_URL || (isStatic ? "/client" : "")),
                    "__VELO_STATIC__": JSON.stringify(isStatic),
                    "__VELO_BUILD_HASH__": JSON.stringify(process.env.VELO_BUILD_HASH || Date.now().toString(36)),
                    "__VELO_CLIENT_JS__": JSON.stringify(clientJs),
                    "__VELO_CLIENT_CSS__": JSON.stringify(clientCss),
                },
                resolve: {
                    alias: {
                        react: "preact/compat",
                        "react-dom": "preact/compat",
                    },
                },
            };

            if (isServer) {
                config.build = {
                    ssr: VIRTUAL_SERVER_ENTRY,
                    outDir: "dist",
                    emptyOutDir: false,
                    copyPublicDir: false,
                    rollupOptions: {
                        output: {
                            entryFileNames: "server.js",
                        },
                    },
                };
            } else if (!isDev) {
                // Client production build
                config.build = {
                    manifest: true,
                    outDir: "dist/client",
                    rollupOptions: {
                        input: VIRTUAL_CLIENT_ENTRY,
                        output: {
                            entryFileNames: "client.[hash].js",
                            assetFileNames: (assetInfo) => {
                                if (assetInfo.names?.[0]?.endsWith(".css")) {
                                    return "client.[hash].css";
                                }
                                return "[name].[hash][extname]";
                            },
                        },
                    },
                };
            }

            return config;
        },
    };
}

// ============================================
// VITE PLUGIN - STATIC URL REWRITE (internal)
// ============================================

/**
 * Rewrites root-relative url() paths in CSS at build time.
 * url(/img/foo.png) → url(STATIC_BASE_URL/img/foo.png)
 *
 * This allows users to write normal CSS paths and have them
 * automatically point to a bucket/CDN when STATIC_BASE_URL is set.
 * Only runs during build — in dev, paths stay as-is.
 */
function veloStaticUrlPlugin(): Plugin {
    return {
        name: "velo:static-url",
        apply: "build",
        enforce: "post",

        generateBundle(_, bundle) {
            const staticBase = process.env.STATIC_BASE_URL || "";
            if (!staticBase) return;

            for (const chunk of Object.values(bundle)) {
                if (
                    chunk.type === "asset" &&
                    typeof chunk.source === "string" &&
                    chunk.fileName.endsWith(".css")
                ) {
                    // Rewrite url(/...) but not url(//...) (protocol-relative)
                    chunk.source = chunk.source.replace(
                        /url\(\s*(['"]?)\/(?!\/)/g,
                        `url($1${staticBase}/`
                    );
                }
            }
        },
    };
}

// ============================================
// MAIN EXPORT
// ============================================

export function veloPlugin(config?: VeloConfig): PluginOption[] {
    const veloConfig: VeloConfig = config ?? {};
    const appDirectory = veloConfig.appDirectory ?? "./app";

    return [
        veloConfigPlugin(),
        veloTransformPlugin(veloConfig, appDirectory),
        veloStaticUrlPlugin(),
        preact(),
        devServer({
            entry: VIRTUAL_SERVER_ENTRY,
        }),
        veloWsBridgePlugin(),
    ];
}

/**
 * Exposes Vite's HTTP server via globalThis so the app can attach
 * WebSocket upgrade handlers in dev mode.
 */
function veloWsBridgePlugin(): Plugin {
    return {
        name: "velo:ws-bridge",
        configureServer(viteServer) {
            (globalThis as any).__veloDevServer = viteServer.httpServer;
        },
    };
}
