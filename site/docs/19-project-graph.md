---
description: "Use `.velojs/graph.json` to understand the project's route tree and module dependency graph before reading any source files. Always consult the graph first when exploring a VeloJS codebase. Generate it with `velojs graph` if missing."
---

# Project Graph

VeloJS can generate a structural snapshot of your project — the route tree hierarchy, module dependency graph, and convention exports — as a single JSON file at `.velojs/graph.json`. This file gives an AI agent (or any tool) a complete map of the codebase in a few KB, replacing dozens of exploratory file reads.

## When to use

Always. Before reading any source file in a VeloJS project, query `.velojs/graph.json` for the specific information you need. The full file can be large; use `jq` for targeted queries.

## Generating the graph

If `.velojs/graph.json` does not exist, generate it:

```bash
velojs graph
```

This runs a fast Babel-based crawl of `app/routes.tsx` and its transitive imports. No build. No Vite. Sub-second. Works even if the project does not compile.

The graph is also regenerated automatically on every `velojs build` (via the `velo:graph` plugin) and on every file change during `velojs dev`.

## Querying the graph

The graph is a compact JSON file (no whitespace). Do not read it in full — use `jq` for targeted queries:

```bash
# A single module — what it exports, what it imports, who imports it
jq '.modules["auth/Login"]' .velojs/graph.json

# The route tree (hierarchy of layouts + pages with paths and middlewares)
jq '.routes' .velojs/graph.json

# All modules that export a loader
jq '.modules | to_entries[] | select(.value.exports.hasLoader) | .key' .velojs/graph.json

# Impact analysis: what breaks if I change this service?
jq '.modules["modules/respondent/respondent.service"] | .importedBy' .velojs/graph.json

# All actions in the project (module + action name)
jq '.modules | to_entries[] | .key as $k | .value.exports.actions[] | "\($k): action_\(.)"' .velojs/graph.json

# Modules imported by a specific page
jq '.modules["admin/DepartmentDetail"].imports' .velojs/graph.json

# Which pages use a shared component?
jq -r '.modules["components/Inputs"].importedBy[]' .velojs/graph.json \
  | while read id; do jq -r ".modules[\"$id\"].kind" .velojs/graph.json; done \
  | sort | uniq -c
```

## Graph structure

```typescript
interface GraphJson {
    routes: RouteTreeNode[];
    modules: Record<string, ModuleInfo>;
}

interface RouteTreeNode {
    moduleId: string | null;   // e.g. "pages/Home", null if no module
    fullPath: string | null;   // e.g. "/admin/users/:id"
    path: string | null;       // e.g. "/users/:id"
    isRoot: boolean;           // root layout (renders <html>)
    middlewares: string[];     // middleware identifiers
    children: RouteTreeNode[];
}

interface ModuleInfo {
    file: string;              // relative path from project root
    kind: "root" | "layout" | "page" | "unknown";
    exports: {
        hasComponent: boolean;
        hasLoader: boolean;
        actions: string[];     // e.g. ["save", "delete"]
        streams: string[];     // e.g. ["progress", "logs"]
        sockets: string[];     // e.g. ["terminal"]
    };
    imports: string[];         // moduleIds this module depends on
    importedBy: string[];      // moduleIds that depend on this module
}
```

## Common queries

### "Which routes use this loader?"

1. Find the loader's module in `modules` → note its `moduleId`
2. Search `routes` recursively for nodes where `moduleId` matches
3. The matching node's ancestors are the layouts wrapping it

### "What breaks if I change this file?"

1. Find the module in `modules[moduleId]`
2. Follow `importedBy` — these modules import it
3. Transitively follow `importedBy` on those modules
4. Filter to modules where `kind` is `"page"` to see which pages are affected

### "What actions does this page expose?"

1. Find the page in `modules[moduleId]`
2. Read `exports.actions` — e.g. `["save", "delete"]`
3. These are the `action_*` exports callable from the client

### "Where is the auth middleware applied?"

1. Search `routes` recursively for nodes where `middlewares` includes the auth middleware name
2. The matching nodes and their children are protected

### "Which modules have no tests?"

Compare `modules` keys against the `tests/` directory. Modules with no corresponding test file are candidates for new tests.

## Notes

- External imports (`@mauroandre/velojs`, `preact`, `wouter-preact`) are recorded in `imports` but not crawled
- `export function action_*` is NOT detected — only `export const action_*` (matches framework behavior)
- Path-less layouts (no `path` property) have `fullPath: ""` and `path: ""`
- The graph is regenerated on every build and on file changes during dev — never stale
