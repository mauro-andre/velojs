import type { JSX } from "preact";
import { CodeWindow } from "./CodeWindow.js";
import { useInView } from "./useInView.js";
import * as css from "./RoutesShowcase.css.js";

export interface RoutesShowcaseProps {
    /** Pre-highlighted HTML for the routes.tsx snippet. */
    codeHtml: string;
}

// ── Route data spec — single source for both the tree and the table ───

interface RouteSpec {
    path?: string;
    module: string;
    kind: "layout" | "page" | "endpoint";
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    middlewares?: string[];
    children?: RouteSpec[];
    /** Render hint: pulse the middleware badge once when entering view. */
    pulseMw?: boolean;
}

const ROUTES: RouteSpec = {
    module: "Root",
    kind: "layout",
    children: [
        { path: "/", module: "Home", kind: "page" },
        {
            path: "/app",
            module: "AdminLayout",
            kind: "layout",
            middlewares: ["auth"],
            pulseMw: true,
            children: [
                { path: "/dashboard", module: "Dashboard", kind: "page" },
                { path: "/products", module: "Products", kind: "page" },
            ],
        },
        {
            path: "/api/github",
            module: "githubWebhook",
            kind: "endpoint",
            method: "POST",
        },
    ],
};

// ── Tree → flat table rows (resolves paths + inherited middleware) ────

interface ResolvedRoute {
    method: string;
    path: string;
    module: string;
    middlewares: string[];
}

function flatten(
    node: RouteSpec,
    parentPath = "",
    parentMw: string[] = []
): ResolvedRoute[] {
    const myPath = parentPath + (node.path ?? "");
    const myMw = [...parentMw, ...(node.middlewares ?? [])];

    if (!node.children) {
        return [
            {
                method: node.method ?? "GET",
                path: myPath || "/",
                module: node.module,
                middlewares: myMw,
            },
        ];
    }
    return node.children.flatMap((child) => flatten(child, myPath, myMw));
}

// ── Sub-components ────────────────────────────────────────

function dotClass(kind: RouteSpec["kind"]): string {
    if (kind === "layout") return css.treeDotLayout;
    if (kind === "page") return css.treeDotPage;
    return css.treeDotEndpoint;
}

function kindBadgeClass(kind: RouteSpec["kind"]): string {
    if (kind === "layout") return css.treeKindLayout;
    if (kind === "page") return css.treeKindPage;
    return css.treeKindEndpoint;
}

function kindLabel(kind: RouteSpec["kind"], method?: string): string {
    if (kind === "endpoint") return `${method ?? "GET"} · endpoint`;
    return kind;
}

function TreeNode({
    node,
    inheritedMw,
    isRoot = false,
}: {
    node: RouteSpec;
    inheritedMw: string[];
    isRoot?: boolean;
}): JSX.Element {
    const myMw = [...inheritedMw, ...(node.middlewares ?? [])];
    return (
        <li class={isRoot ? css.treeItemRoot : css.treeItem}>
            <div class={css.treeNode}>
                <span class={`${css.treeDot} ${dotClass(node.kind)}`} />
                {node.path && <span class={css.treePath}>{node.path}</span>}
                <span class={css.treeModule}>{node.module}</span>
                {/* Own middlewares — solid pill */}
                {node.middlewares?.map((mw) => (
                    <span
                        key={mw}
                        class={`${css.mwBadge} ${node.pulseMw ? css.mwBadgePulse : ""}`}
                    >
                        🛡 {mw}
                    </span>
                ))}
                {/* Inherited middlewares — faded pill, only on leaves */}
                {!node.children &&
                    inheritedMw.map((mw) => (
                        <span key={`i-${mw}`} class={css.mwBadgeInherited}>
                            🛡 {mw}
                        </span>
                    ))}
                <span class={kindBadgeClass(node.kind)}>
                    {kindLabel(node.kind, node.method)}
                </span>
            </div>
            {node.children && (
                <ul class={css.treeChildren}>
                    {node.children.map((c) => (
                        <TreeNode key={c.module} node={c} inheritedMw={myMw} />
                    ))}
                </ul>
            )}
        </li>
    );
}

function MethodBadge({ method }: { method: string }): JSX.Element {
    const className =
        method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE"
            ? css.methodPost
            : css.methodGet;
    return <span class={className}>{method}</span>;
}

// ── Main section ──────────────────────────────────────────

export function RoutesShowcase({ codeHtml }: RoutesShowcaseProps) {
    const [topRef, topVisible] = useInView<HTMLDivElement>(0.15);
    const [tableRef, tableVisible] = useInView<HTMLDivElement>(0.15);
    const [takeawaysRef, takeawaysVisible] = useInView<HTMLDivElement>(0.2);

    const rows = flatten(ROUTES);

    return (
        <section class={css.section}>
            <div class={css.header}>
                <h2 class={css.title}>One routes.tsx. Every URL.</h2>
                <p class={css.subtitle}>
                    Pages, APIs, webhooks — all declared in a single tree.
                    Middleware flows down; paths resolve automatically.
                </p>
            </div>

            <div
                ref={topRef}
                class={`${css.topRow} ${topVisible ? css.fadeVisible : css.fadeHidden}`}
            >
                <div class={css.panel}>
                    <CodeWindow filename="app/routes.tsx" html={codeHtml} />
                </div>
                <div class={css.panel}>
                    <div class={css.treeCard}>
                        <ul class={css.treeRoot}>
                            <TreeNode node={ROUTES} inheritedMw={[]} isRoot />
                        </ul>
                    </div>
                </div>
            </div>

            <div class={css.resolvesTo}>
                resolves to
                <span class={css.resolvesArrow}>↓</span>
            </div>

            <div
                ref={tableRef}
                class={tableVisible ? css.fadeVisible : css.fadeHidden}
            >
                <div class={css.tableCard}>
                    <table class={css.table}>
                        <tbody>
                            {rows.map((r, i) => (
                                <tr
                                    key={`${r.method}-${r.path}`}
                                    class={`${css.tableRow} ${tableVisible ? css.rowAnimated : ""}`}
                                    style={{ animationDelay: `${0.08 * i}s` }}
                                >
                                    <td class={`${css.tableCell} ${css.cellMethod}`}>
                                        <MethodBadge method={r.method} />
                                    </td>
                                    <td class={`${css.tableCell} ${css.cellPath}`}>
                                        {r.path}
                                    </td>
                                    <td class={`${css.tableCell} ${css.cellArrow}`}>→</td>
                                    <td class={`${css.tableCell} ${css.cellModule}`}>
                                        {r.module}
                                    </td>
                                    <td class={`${css.tableCell} ${css.cellMw}`}>
                                        {r.middlewares.map((mw) => (
                                            <span key={mw} class={css.mwBadge}>
                                                🛡 {mw}
                                            </span>
                                        ))}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            <div
                ref={takeawaysRef}
                class={takeawaysVisible ? css.fadeVisible : css.fadeHidden}
            >
                <div class={css.takeaways}>
                    <div class={css.takeaway}>
                        <span class={css.takeawayDot} />
                        <div>
                            <h3 class={css.takeawayTitle}>Paths compose automatically</h3>
                            <p class={css.takeawayDesc}>
                                Nested <code>path</code> segments stack up. <code>/app</code>{" "}
                                + <code>/dashboard</code> becomes <code>/app/dashboard</code>.
                            </p>
                        </div>
                    </div>
                    <div class={css.takeaway}>
                        <span class={css.takeawayDot} />
                        <div>
                            <h3 class={css.takeawayTitle}>
                                Middleware flows down the branches
                            </h3>
                            <p class={css.takeawayDesc}>
                                Set on a parent node, inherited by every descendant. Auth
                                on <code>/app</code> protects every route under it.
                            </p>
                        </div>
                    </div>
                    <div class={css.takeaway}>
                        <span class={css.takeawayDot} />
                        <div>
                            <h3 class={css.takeawayTitle}>One tree, all HTTP surfaces</h3>
                            <p class={css.takeawayDesc}>
                                Pages, APIs, webhooks — declared side by side. The
                                framework discovers them by shape.
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}
