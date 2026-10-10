/**
 * Server->client leak diagnostic — the light, never the hand.
 *
 * A "server module" is a module that touches a Node builtin in its own code —
 * static import, re-export or `await import()`, by any import path — or that
 * matches a `serverOnly` glob pattern declared in the Velo config. A "leak" is
 * a server module the client entry can reach: what the browser loads ends up
 * pulling server-only code into the bundle, where Node builtins are stubbed
 * and only explode when actually called.
 *
 * The analysis reads the code AFTER the client transforms — exactly the same
 * transform pipeline `velo:transform` applies to what ships (loaders, actions,
 * streams, sockets, middlewares and endpoints stripped, orphaned imports
 * pruned) — so the normal VeloJS shape (a `loader` importing server code) is
 * silent by construction. It is strictly read-only: no import is rewritten,
 * pruned, stubbed or moved; `await import()` is followed, never rewritten.
 *
 * Each leak lists the full import chain from the client entry to the leaked
 * module (file and line per link) and highlights the entry point — the import
 * that pulls the first server module on the chain, which is exactly where the
 * cut happens. Two chains to the same module are two items: every cut point
 * shows up.
 */
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";

import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import * as t from "@babel/types";

import { transformModuleCode, buildFullPathMap, type PathInfo } from "./vite.js";

// Workaround para ESM — handle both CJS-wrapped and direct ESM exports
const traverse =
    typeof _traverse === "function"
        ? _traverse
        : (_traverse as unknown as { default: typeof _traverse }).default;

// ============================================
// TYPES
// ============================================

/** One import in the chain: `from` imports `to` at `line` (`null` = generated). */
export interface LeakLink {
    from: string;
    line: number | null;
    to: string;
}

export interface LeakItem {
    /** Display path of the leaked server module. */
    target: string;
    /** Why it qualifies as a server module (English). */
    qualifiers: string[];
    /** Full import chain, client entry -> target, one link per import. */
    chain: LeakLink[];
    /** Index in `chain` of the entry-point link — the cut. */
    entryIndex: number;
}

export interface LeakReport {
    leaks: LeakItem[];
    /** True when the enumeration stopped at its safety budget. */
    truncated: boolean;
    /** Stable fingerprint of what ships to the client (dev re-emit trigger). */
    signature: string;
    /** How many modules the walk visited (informational). */
    moduleCount: number;
}

export type ResolveFn = (spec: string, importer: string) => string | null;

export interface ModuleInfo {
    file: string;
    display: string;
    edges: RawEdge[];
    builtins: string[];
    patterns: string[];
}

export interface CachedModule {
    mtimeMs: number;
    info: ModuleInfo;
}

export interface LeakAnalyzerOptions {
    /** Project root — display paths and `serverOnly` matching are relative to it. */
    rootDir: string;
    /** Absolute app directory (velo:transform's scope). */
    appDir: string;
    /** Routes file name inside appDir (default "routes.tsx"). */
    routesFile?: string | undefined;
    /** The client entry's import specifiers (the virtual entry's imports). */
    entrySpecs: string[];
    /** Glob patterns declaring server-only modules (VeloConfig.serverOnly). */
    serverOnly?: readonly string[] | undefined;
    /** Import resolver: (specifier, importer file) -> absolute file or null. */
    resolve?: ResolveFn | undefined;
    /** Optional parse cache shared across runs (dev). */
    cache?: Map<string, CachedModule> | undefined;
}

// ============================================
// INTERNAL TYPES
// ============================================

interface RawEdge {
    spec: string;
    line: number;
    kind: "static" | "dynamic";
    locals: string[];
}

interface ResolvedEdge extends RawEdge {
    /** Absolute file target, "builtin:<spec>" or null (external/unresolved). */
    target: string | null;
}

interface GraphNode {
    file: string | null; // null = the synthetic client entry
    display: string;
    edges: ResolvedEdge[];
    builtins: string[];
    patterns: string[];
}

/** Chain link plus its semantic: does this link pull a server module? */
interface ChainLink extends LeakLink {
    server: boolean;
    targetNode: GraphNode;
}

// ============================================
// BUILTIN DETECTION
// ============================================

const BUILTIN_SET = new Set(builtinModules);

/** True when the specifier names a Node builtin (with or without the `node:` prefix). */
export function isBuiltinSpec(spec: string): boolean {
    if (spec.startsWith("node:")) return true;
    if (BUILTIN_SET.has(spec)) return true;
    // Subpath builtins ("fs/promises", "stream/web") are listed verbatim, but
    // fall back to the package root so odd spellings still match.
    const slash = spec.indexOf("/");
    if (slash > 0 && BUILTIN_SET.has(spec.slice(0, slash))) return true;
    return false;
}

// ============================================
// serverOnly GLOBS
// ============================================

/**
 * Compiles a glob (`*` = within a segment, `**` across segments, `?` = one
 * char) into a full-match regex over the module path relative to the project
 * root, always with `/` separators.
 */
export function globToRegex(glob: string): RegExp {
    let out = "";
    for (let i = 0; i < glob.length; i++) {
        const ch = glob[i]!;
        if (ch === "*") {
            if (glob[i + 1] === "*") {
                out += ".*";
                i++;
            } else {
                out += "[^/]*";
            }
        } else if (ch === "?") {
            out += "[^/]";
        } else {
            out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        }
    }
    return new RegExp(`^${out}$`);
}

// ============================================
// DEFAULT RESOLUTION (Node-ish, client conditions)
// ============================================

const WALKABLE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

function probeFile(base: string): string | null {
    const candidates = [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.js`,
        `${base}.jsx`,
        `${base}.mjs`,
        // TS-style extension completion: "./x.js" can stand for "./x.ts".
        base.replace(/\.js$/, ".ts"),
        base.replace(/\.js$/, ".tsx"),
        base.replace(/\.jsx$/, ".tsx"),
        ...["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs"].map(
            (f) => path.join(base, f)
        ),
    ];
    for (const candidate of candidates) {
        if (candidate.endsWith(".d.ts")) continue;
        try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                return candidate;
            }
        } catch {
            // unreadable candidate — try the next one
        }
    }
    return null;
}

/** Reads `exports`/`main`/`module` of a package dir for a subpath ("." or "./x"). */
function resolvePackageEntry(pkgDir: string, subpath: string): string | null {
    let pkg: Record<string, unknown> = {};
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8"));
    } catch {
        pkg = {};
    }

    const pick = (value: unknown): string | null => {
        if (typeof value === "string") return value;
        if (value && typeof value === "object") {
            const map = value as Record<string, unknown>;
            // Client-shipping order: browser/import before require/node.
            for (const key of ["browser", "import", "module", "default", "require", "node"]) {
                const hit = pick(map[key]);
                if (hit) return hit;
            }
        }
        return null;
    };

    const exportsField = pkg.exports;
    if (typeof exportsField === "string") {
        if (subpath === ".") return exportsField;
    } else if (exportsField && typeof exportsField === "object") {
        const table = exportsField as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(table, subpath)) {
            return pick(table[subpath]);
        }
        // Wildcard keys ("./*": "./dist/*.js").
        for (const key of Object.keys(table)) {
            const star = key.indexOf("*");
            if (star < 0) continue;
            const head = key.slice(0, star);
            const tail = key.slice(star + 1);
            if (subpath.startsWith(head) && subpath.endsWith(tail)) {
                const wildcard = subpath.slice(head.length, subpath.length - tail.length);
                const target = pick(table[key]);
                if (target) return target.replace("*", wildcard);
            }
        }
        return null;
    }

    if (subpath === ".") {
        for (const field of ["module", "main"]) {
            const value = pkg[field];
            if (typeof value === "string") return value;
        }
    }
    return null;
}

/**
 * Resolution mirroring what the client build follows: relative specifiers with
 * TS extension completion, bare specifiers through `node_modules` with the
 * package's browser/import `exports` conditions. Returns null for anything
 * that does not resolve to a file (external, virtual or unresolvable).
 */
export function defaultResolve(spec: string, importer: string): string | null {
    const clean = spec.split("?")[0]!;
    if (!clean || clean.startsWith("\0") || clean.startsWith("virtual:")) return null;
    if (clean.startsWith("data:") || clean.startsWith("http:") || clean.startsWith("https:")) {
        return null;
    }

    if (clean.startsWith(".") || path.isAbsolute(clean)) {
        return probeFile(path.resolve(path.dirname(importer), clean));
    }

    // Bare specifier: node_modules walk from the importer upwards.
    const segments = clean.startsWith("@")
        ? clean.split("/").slice(0, 2)
        : clean.split("/").slice(0, 1);
    const pkgName = segments.join("/");
    const subpath = clean.length > pkgName.length ? `.${clean.slice(pkgName.length)}` : ".";

    let dir = path.dirname(importer);
    for (;;) {
        const candidate = path.join(dir, "node_modules", pkgName);
        if (fs.existsSync(path.join(candidate, "package.json"))) {
            const entry = resolvePackageEntry(candidate, subpath);
            if (entry) {
                const resolved = probeFile(path.resolve(candidate, entry));
                if (resolved) return resolved;
            }
            return probeFile(
                path.resolve(candidate, subpath === "." ? "index" : subpath.slice(2))
            );
        }
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

// ============================================
// MODULE PARSING — the client transform, then the surviving imports
// ============================================

function parseModule(code: string): t.File {
    return parse(code, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
    });
}

/** All import/re-export/dynamic-import edges of a module, with source lines. */
function collectRawEdges(ast: t.File): RawEdge[] {
    const edges: RawEdge[] = [];

    const addEdge = (
        source: string,
        node: t.Node,
        kind: "static" | "dynamic",
        specifiers: readonly t.Node[]
    ) => {
        const locals: string[] = [];
        for (const spec of specifiers) {
            if (
                t.isImportSpecifier(spec) ||
                t.isImportDefaultSpecifier(spec) ||
                t.isImportNamespaceSpecifier(spec) ||
                t.isExportSpecifier(spec)
            ) {
                locals.push(spec.local.name);
            }
        }
        edges.push({
            spec: source,
            line: node.loc?.start.line ?? 0,
            kind,
            locals,
        });
    };

    traverse(ast, {
        ImportDeclaration(p) {
            // Type-only imports are erased before anything ships — not an edge.
            if (p.node.importKind === "type") return;
            addEdge(p.node.source.value, p.node, "static", p.node.specifiers);
        },
        ExportNamedDeclaration(p) {
            if (!p.node.source) return;
            if (p.node.exportKind === "type") return;
            addEdge(p.node.source.value, p.node, "static", p.node.specifiers);
        },
        ExportAllDeclaration(p) {
            if (p.node.exportKind === "type") return;
            addEdge(p.node.source.value, p.node, "static", []);
        },
        CallExpression(p) {
            // `await import("./x")` — Babel shape: CallExpression with an
            // Import callee. Never rewritten, always followed.
            if (!t.isImport(p.node.callee)) return;
            const arg = p.node.arguments[0];
            if (!t.isStringLiteral(arg)) return;
            addEdge(arg.value, p.node, "dynamic", []);
        },
        ImportExpression(p) {
            const source = p.node.source;
            if (!t.isStringLiteral(source)) return;
            addEdge(source.value, p.node, "dynamic", []);
        },
    });

    return edges;
}

/**
 * The edge locations always come from the SOURCE the developer edits. The
 * client transform regenerates code (retainLines), so instead of trusting
 * generated positions each surviving edge is matched back to the original
 * import statement by (specifier, form, locals) — the reported line is the
 * real one.
 */
function mapToOriginalEdges(transformed: RawEdge[], original: RawEdge[]): RawEdge[] {
    const used = new Set<number>();
    const out: RawEdge[] = [];
    for (const edge of transformed) {
        let match = -1;
        for (let i = 0; i < original.length; i++) {
            if (used.has(i)) continue;
            const candidate = original[i]!;
            if (candidate.spec !== edge.spec) continue;
            if (candidate.kind !== edge.kind) continue;
            if (edge.locals.length > 0 && candidate.locals.length > 0) {
                const overlap = edge.locals.some((name) => candidate.locals.includes(name));
                if (!overlap) continue;
            }
            match = i;
            break;
        }
        out.push(match >= 0 ? original[match]! : edge);
        if (match >= 0) used.add(match);
    }
    return out.sort((a, b) => a.line - b.line);
}

function moduleIdFor(appDir: string, file: string): string {
    return path
        .relative(appDir, file)
        .replace(/\.(tsx?|jsx?)$/, "")
        .replace(/\\/g, "/");
}

function loadModuleInfo(
    file: string,
    options: LeakAnalyzerOptions,
    pathInfoMap: Map<string, PathInfo>,
    matchers: Array<{ glob: string; regex: RegExp }>,
    cache: Map<string, CachedModule>
): ModuleInfo {
    const { rootDir, appDir } = options;
    const display = path.relative(rootDir, file).split(path.sep).join("/") || file;

    let mtimeMs = 0;
    try {
        mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
        // unreadable file — treated as empty below
    }
    const cached = cache.get(file);
    if (cached && cached.info && cached.mtimeMs === mtimeMs) return cached.info;

    const patterns = matchers
        .filter((matcher) => matcher.regex.test(display))
        .map((matcher) => matcher.glob);

    // Non-JS targets (css, json, assets) travel as leaves: nothing to parse,
    // nothing they import.
    const ext = path.extname(file);
    if (!WALKABLE_EXT.has(ext)) {
        const info: ModuleInfo = { file, display, edges: [], builtins: [], patterns };
        cache.set(file, { mtimeMs, info });
        return info;
    }

    let source = "";
    try {
        source = fs.readFileSync(file, "utf-8");
    } catch {
        source = "";
    }

    let originalEdges: RawEdge[] = [];
    try {
        originalEdges = collectRawEdges(parseModule(source));
    } catch {
        originalEdges = [];
    }

    // The same client transform the build applies — never a reprint.
    const transformed = transformModuleCode(source, {
        id: file,
        appDir,
        isSSR: false,
        routesFile: options.routesFile,
        pathInfo: pathInfoMap.get(moduleIdFor(appDir, file)),
    });
    const traveling = transformed ? transformed.code : source;

    let travelingEdges: RawEdge[];
    try {
        travelingEdges = collectRawEdges(parseModule(traveling));
    } catch {
        travelingEdges = originalEdges;
    }
    const edges = mapToOriginalEdges(travelingEdges, originalEdges);

    const builtins = [
        ...new Set(edges.filter((e) => isBuiltinSpec(e.spec)).map((e) => e.spec)),
    ].sort();

    const info: ModuleInfo = { file, display, edges, builtins, patterns };
    cache.set(file, { mtimeMs, info });
    return info;
}

// ============================================
// GRAPH WALK + CHAIN ENUMERATION
// ============================================

const MAX_CHAINS_PER_TARGET = 8;
const MAX_LEAKS = 100;
const WALK_BUDGET = 20000;

export function analyzeClientLeaks(options: LeakAnalyzerOptions): LeakReport {
    const { rootDir, entrySpecs } = options;
    const resolve = options.resolve ?? defaultResolve;
    const cache = options.cache ?? new Map<string, CachedModule>();
    const matchers = (options.serverOnly ?? []).map((glob) => ({
        glob,
        regex: globToRegex(glob),
    }));

    // Route path info — the same metadata injection the build does.
    const pathInfoMap = new Map<string, PathInfo>();
    const routesPath = path.join(options.appDir, options.routesFile ?? "routes.tsx");
    try {
        const routesCode = fs.readFileSync(routesPath, "utf-8");
        for (const [moduleId, info] of buildFullPathMap(routesCode)) {
            pathInfoMap.set(moduleId, info);
        }
    } catch {
        // no routes file — the walk still covers whatever the entry reaches
    }

    const nodes = new Map<string, GraphNode>();
    const entryLabel = "virtual:velo/client-entry";
    const entryImporter = path.join(options.appDir, "__velo_client_entry__.js");

    const resolveTarget = (spec: string, importer: string): string | null => {
        if (isBuiltinSpec(spec)) return `builtin:${spec}`;
        try {
            return resolve(spec, importer);
        } catch {
            return null;
        }
    };

    const nodeFor = (file: string): GraphNode => {
        const existing = nodes.get(file);
        if (existing) return existing;
        const info = loadModuleInfo(file, options, pathInfoMap, matchers, cache);
        const node: GraphNode = {
            file,
            display: info.display,
            edges: [],
            builtins: info.builtins,
            patterns: info.patterns,
        };
        nodes.set(file, node);
        for (const edge of info.edges) {
            node.edges.push({ ...edge, target: resolveTarget(edge.spec, file) });
        }
        return node;
    };

    // The synthetic client entry: its imports are the client entry's imports.
    const entry: GraphNode = {
        file: null,
        display: entryLabel,
        edges: [],
        builtins: [],
        patterns: [],
    };
    for (const spec of entrySpecs) {
        entry.edges.push({
            spec,
            line: 0,
            kind: "static",
            locals: [],
            target: resolveTarget(spec, entryImporter),
        });
    }

    const isQualifier = (node: GraphNode): boolean =>
        node.builtins.length > 0 || node.patterns.length > 0;

    const qualifierText = (node: GraphNode): string[] => {
        const out: string[] = [];
        if (node.builtins.length > 0) {
            const list = node.builtins.map((b) => `"${b}"`).join(", ");
            out.push(
                node.builtins.length === 1
                    ? `imports Node builtin ${list}`
                    : `imports Node builtins ${list}`
            );
        }
        if (node.patterns.length > 0) {
            const list = node.patterns.map((p) => `"${p}"`).join(", ");
            out.push(
                node.patterns.length === 1
                    ? `matches serverOnly pattern ${list}`
                    : `matches serverOnly patterns ${list}`
            );
        }
        return out;
    };

    const makeItem = (targetNode: GraphNode, links: ChainLink[]): LeakItem => {
        // The entry point is the first link that pulls a server module — the
        // first server module on the chain. The target is one by definition,
        // so the last link is always a safe fallback.
        let entryIndex = links.findIndex((link) => link.server);
        if (entryIndex < 0) entryIndex = links.length - 1;
        return {
            target: targetNode.display,
            qualifiers: qualifierText(targetNode),
            chain: links.map((link) => ({ from: link.from, line: link.line, to: link.to })),
            entryIndex,
        };
    };

    // DFS over simple paths (a module never repeats on one chain). Each chain
    // reaching a server module is one leak item — every cut point shows up —
    // bounded per target and globally so dense graphs stay report-sized.
    const leaks: LeakItem[] = [];
    const chainsPerTarget = new Map<string, number>();
    let truncated = false;
    let budget = WALK_BUDGET;

    const chain: ChainLink[] = [];
    const onPath = new Set<string>();

    const record = (targetNode: GraphNode, links: ChainLink[]) => {
        const count = chainsPerTarget.get(targetNode.display) ?? 0;
        if (count >= MAX_CHAINS_PER_TARGET || leaks.length >= MAX_LEAKS) {
            truncated = true;
            return;
        }
        chainsPerTarget.set(targetNode.display, count + 1);
        leaks.push(makeItem(targetNode, links));
    };

    const walk = (node: GraphNode) => {
        for (const edge of node.edges) {
            if (budget-- <= 0) {
                truncated = true;
                return;
            }
            if (!edge.target || edge.target.startsWith("builtin:")) continue;

            const targetNode = nodeFor(edge.target);
            const link: ChainLink = {
                from: node.display,
                line: node.file === null ? null : edge.line,
                to: targetNode.display,
                server: isQualifier(targetNode),
                targetNode,
            };

            if (link.server) {
                record(targetNode, [...chain, link]);
            }

            if (!onPath.has(edge.target)) {
                onPath.add(edge.target);
                chain.push(link);
                walk(targetNode);
                chain.pop();
                onPath.delete(edge.target);
            }
        }
    };

    walk(entry);

    // Stable fingerprint of what ships to the client: the walked modules and
    // their surviving imports. A file change that shifts this re-emits the
    // report in dev; a change that doesn't, doesn't.
    const edgeKeys: string[] = [];
    for (const node of nodes.values()) {
        for (const edge of node.edges) {
            edgeKeys.push(
                `${node.display}|${edge.line}|${edge.kind}|${edge.spec}|${edge.target ?? ""}`
            );
        }
    }
    edgeKeys.sort();
    const signature = JSON.stringify({
        modules: [...nodes.values()].map((n) => n.display).sort(),
        edges: edgeKeys,
    });

    return {
        leaks,
        truncated,
        signature,
        moduleCount: nodes.size + 1,
    };
}

// ============================================
// REPORT — English terminal output, stable order
// ============================================

export function formatLeakReport(report: LeakReport): string {
    const lines: string[] = [];

    if (report.leaks.length === 0) {
        lines.push(
            "[velojs] server->client leak analysis: 0 leaks — what ships to the client is clean."
        );
        return lines.join("\n");
    }

    lines.push(
        `[velojs] server->client leak analysis: ${report.leaks.length} leak(s) in what ships to the client.`
    );

    report.leaks.forEach((leak, index) => {
        lines.push("");
        lines.push(`${index + 1}) ${leak.target}`);
        lines.push(`   server because: ${leak.qualifiers.join("; ")}`);
        lines.push("   import chain from the client entry:");
        leak.chain.forEach((link, position) => {
            const where =
                link.line === null ? `${link.from} (generated)` : `${link.from}:${link.line}`;
            const cut = position === leak.entryIndex ? "  <- entry point (cut here)" : "";
            lines.push(`     ${where} -> ${link.to}${cut}`);
        });
    });

    if (report.truncated) {
        lines.push("");
        lines.push("... report truncated at its safety budget — more paths exist.");
    }

    lines.push("");
    lines.push("The report is read-only: nothing is blocked or rewritten; the cut is yours.");

    return lines.join("\n");
}
