import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDocs, yamlQuote } from "./docs-frontmatter.js";

/**
 * Generates the agent skill payload published inside the npm package:
 *
 *   agent/
 *   ├── AGENTS.md              (hand-written)
 *   └── skills/
 *       └── velojs-<slug>/SKILL.md   (generated from site/docs/*.md)
 *
 * `agent-sync` scans `node_modules/<pkg>/agent/` without knowing which packages
 * exist, so this shape is a contract shared with every other package that ships
 * agent knowledge. Do not diverge from it.
 *
 * The skill `name` is derived from the filename rather than read from the doc,
 * which makes it structurally impossible for `name` to disagree with its
 * directory — something both harnesses require.
 */

const PACKAGE_PREFIX = "velojs";
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_DESCRIPTION = 1024;

export interface Skill {
    /** e.g. "velojs-routes" — the directory name AND the frontmatter `name`. */
    name: string;
    /** Path relative to the skills root, e.g. "velojs-routes/SKILL.md". */
    relPath: string;
    content: string;
}

/** Pure: docs in, skill files out. No I/O beyond reading the docs. */
export function buildSkills(docsDir: string): Skill[] {
    const docs = readDocs(docsDir);
    if (docs.length === 0) throw new Error(`no docs found in ${docsDir}`);

    return docs.map((doc) => {
        const name = `${PACKAGE_PREFIX}-${doc.slug}`;
        if (!NAME_RE.test(name)) {
            throw new Error(`${doc.filename}: derived skill name "${name}" is not kebab-case`);
        }

        const description = doc.frontmatter.description;
        if (!description) {
            throw new Error(
                `${doc.filename}: missing \`description\` in frontmatter. It is what makes the ` +
                    `skill loadable — without it the body never enters a model's context.`,
            );
        }
        if (description.length > MAX_DESCRIPTION) {
            throw new Error(
                `${doc.filename}: description is ${description.length} chars, max ${MAX_DESCRIPTION}`,
            );
        }

        // Only `name` and `description`: opencode drops every other field
        // without warning, so emitting more would be a lie about what ships.
        const frontmatter = `---\nname: ${name}\ndescription: ${yamlQuote(description)}\n---\n\n`;

        return { name, relPath: `${name}/SKILL.md`, content: frontmatter + doc.body };
    });
}

/** Writes the skills, removing any directory that no longer has a doc. */
export function writeSkills(docsDir: string, skillsDir: string): Skill[] {
    const skills = buildSkills(docsDir);
    const expected = new Set(skills.map((s) => s.name));

    if (fs.existsSync(skillsDir)) {
        for (const entry of fs.readdirSync(skillsDir)) {
            if (!expected.has(entry)) {
                fs.rmSync(path.join(skillsDir, entry), { recursive: true, force: true });
            }
        }
    }

    for (const skill of skills) {
        const file = path.join(skillsDir, skill.relPath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, skill.content);
    }

    return skills;
}

export const DOCS_DIR = fileURLToPath(new URL("../site/docs", import.meta.url));
export const SKILLS_DIR = fileURLToPath(new URL("../agent/skills", import.meta.url));
