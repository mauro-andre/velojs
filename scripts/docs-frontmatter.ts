import fs from "node:fs";
import path from "node:path";

/**
 * Frontmatter for `site/docs/*.md`, shared by the site's docs plugin and the
 * SKILL.md generator so the two can never disagree about what a doc declares.
 *
 * Deliberately a hand-rolled subset — one level, `key: "value"` — instead of a
 * YAML dependency. The only key we consume is `description`; anything richer
 * belongs in the doc body.
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export interface DocFrontmatter {
    description?: string;
}

export interface SplitDoc {
    frontmatter: DocFrontmatter;
    /** The markdown with the frontmatter block removed. */
    body: string;
}

/** Unquote a scalar. Values are emitted double-quoted, so this is the inverse. */
function unquote(raw: string): string {
    const v = raw.trim();
    if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
        return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") {
        return v.slice(1, -1).replace(/''/g, "'");
    }
    return v;
}

export function splitFrontmatter(raw: string): SplitDoc {
    const match = raw.match(FRONTMATTER_RE);
    if (!match) return { frontmatter: {}, body: raw };

    const frontmatter: DocFrontmatter = {};
    for (const line of match[1]!.split(/\r?\n/)) {
        if (!line.trim() || line.trimStart().startsWith("#")) continue;
        const sep = line.indexOf(":");
        if (sep === -1) continue;
        const key = line.slice(0, sep).trim();
        if (key === "description") frontmatter.description = unquote(line.slice(sep + 1));
    }

    // Drop the blank line(s) the block is separated by, so a consumer can
    // concatenate its own frontmatter onto the body without doubling them.
    return { frontmatter, body: raw.slice(match[0].length).replace(/^(?:\r?\n)+/, "") };
}

/**
 * Emit a value as a double-quoted YAML scalar. Descriptions contain `:` and
 * `#`, which are structural in a bare scalar — quoting is not cosmetic, it is
 * what keeps the generated SKILL.md parseable by a real YAML reader.
 */
export function yamlQuote(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface DocFile {
    /** e.g. "02-routes.md" */
    filename: string;
    /** e.g. "routes" — filename minus the order prefix and extension. */
    slug: string;
    /** e.g. 2 */
    order: number;
    frontmatter: DocFrontmatter;
    body: string;
}

/** Read every `NN-name.md` in `docsDir`, in filename order. */
export function readDocs(docsDir: string): DocFile[] {
    return fs
        .readdirSync(docsDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((filename) => {
            const raw = fs.readFileSync(path.join(docsDir, filename), "utf-8");
            const { frontmatter, body } = splitFrontmatter(raw);
            const orderMatch = filename.match(/^(\d+)-/);
            return {
                filename,
                slug: filename.replace(/^\d+-/, "").replace(/\.md$/, ""),
                order: orderMatch ? parseInt(orderMatch[1]!, 10) : 99,
                frontmatter,
                body,
            };
        });
}
