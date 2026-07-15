import type { Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";
import { Marked } from "marked";
import { createHighlighter, type Highlighter } from "shiki";
import { readDocs } from "../../scripts/docs-frontmatter.js";

export interface DocEntry {
    slug: string;
    title: string;
    order: number;
    filename: string;
    /**
     * From the doc's frontmatter. Exposed on the manifest for page metadata —
     * it must never reach the rendered content, the emitted .md, or the zip.
     */
    description?: string;
}

interface DocData extends DocEntry {
    html: string;
    rawMd: string;
}

const VIRTUAL_MANIFEST = "virtual:docs-manifest";
const VIRTUAL_CONTENT = "virtual:docs-content";
const RESOLVED_MANIFEST = "\0" + VIRTUAL_MANIFEST;
const RESOLVED_CONTENT = "\0" + VIRTUAL_CONTENT;

export function docsPlugin(): Plugin {
    let docs: DocData[] = [];
    let docsDir: string;
    let highlighter: Highlighter;

    async function loadDocs() {
        if (!highlighter) {
            highlighter = await createHighlighter({
                themes: ["one-dark-pro"],
                langs: ["typescript", "tsx", "bash", "json", "dockerfile", "html", "css"],
            });
        }

        const marked = new Marked();
        marked.use({
            renderer: {
                code({ text, lang }) {
                    const language = lang || "text";
                    try {
                        return highlighter.codeToHtml(text, {
                            lang: language,
                            theme: "one-dark-pro",
                        });
                    } catch {
                        return `<pre><code>${text}</code></pre>`;
                    }
                },
                heading({ tokens, depth }) {
                    const text = tokens.map((t: any) => t.raw || t.text || "").join("");
                    const id = text
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, "-")
                        .replace(/(^-|-$)/g, "");
                    return `<h${depth} id="${id}">${text}</h${depth}>`;
                },
            },
        });

        docsDir = path.resolve(process.cwd(), "docs");

        docs = [];

        // The frontmatter is split off here, once. Everything downstream — the
        // rendered HTML, the virtual content module, the emitted .md, the zip —
        // sees only `body`, so the YAML exists nowhere but the source file and
        // the generated SKILL.md. Only the manifest carries `description`.
        for (const doc of readDocs(docsDir)) {
            // Title from the first # heading, of the body — reading it off the
            // raw file would let a `#` inside the frontmatter win.
            const titleMatch = doc.body.match(/^#\s+(.+)$/m);
            const title = titleMatch ? titleMatch[1]! : doc.slug;

            const html = await marked.parse(doc.body);

            docs.push({
                slug: doc.slug,
                title,
                order: doc.order,
                filename: doc.filename,
                html,
                rawMd: doc.body,
                ...(doc.frontmatter.description !== undefined && {
                    description: doc.frontmatter.description,
                }),
            });
        }
    }

    return {
        name: "velo-docs",

        async buildStart() {
            await loadDocs();
        },

        configureServer(server) {
            // Reload docs on change in dev
            server.watcher.add(path.resolve(process.cwd(), "docs"));
            server.watcher.on("change", async (file) => {
                if (file.includes("/docs/") && file.endsWith(".md")) {
                    await loadDocs();
                    const mod = server.moduleGraph.getModuleById(RESOLVED_MANIFEST);
                    if (mod) server.moduleGraph.invalidateModule(mod);
                    const contentMod = server.moduleGraph.getModuleById(RESOLVED_CONTENT);
                    if (contentMod) server.moduleGraph.invalidateModule(contentMod);
                    server.ws.send({ type: "full-reload" });
                }
            });
        },

        resolveId(id) {
            if (id === VIRTUAL_MANIFEST) return RESOLVED_MANIFEST;
            if (id === VIRTUAL_CONTENT) return RESOLVED_CONTENT;
            return null;
        },

        async load(id) {
            if (docs.length === 0) await loadDocs();

            if (id === RESOLVED_MANIFEST) {
                const manifest: DocEntry[] = docs.map(
                    ({ slug, title, order, filename, description }) => ({
                        slug,
                        title,
                        order,
                        filename,
                        ...(description !== undefined && { description }),
                    }),
                );
                return `export default ${JSON.stringify(manifest)};`;
            }

            if (id === RESOLVED_CONTENT) {
                const content: Record<string, { html: string; rawMd: string }> = {};
                for (const doc of docs) {
                    content[doc.slug] = { html: doc.html, rawMd: doc.rawMd };
                }
                return `export default ${JSON.stringify(content)};`;
            }

            return null;
        },

        generateBundle() {
            // Emit individual .md files as downloadable assets
            for (const doc of docs) {
                this.emitFile({
                    type: "asset",
                    fileName: `docs/${doc.filename}`,
                    source: doc.rawMd,
                });
            }
        },

        async closeBundle() {
            // Generate ZIP of all docs
            const outDir = path.resolve(process.cwd(), "dist/docs");
            if (!fs.existsSync(outDir)) {
                fs.mkdirSync(outDir, { recursive: true });
            }

            const archiver = (await import("archiver")).default;
            const zipPath = path.join(outDir, "velojs-docs.zip");
            const output = fs.createWriteStream(zipPath);
            const archive = archiver("zip", { zlib: { level: 9 } });

            archive.pipe(output);

            for (const doc of docs) {
                archive.append(doc.rawMd, { name: doc.filename });
            }

            await archive.finalize();
        },
    };
}
