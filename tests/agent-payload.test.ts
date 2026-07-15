/**
 * The agent payload published inside the npm package:
 *
 *   agent/
 *   ├── AGENTS.md
 *   └── skills/velojs-<slug>/SKILL.md   (generated from site/docs/*.md)
 *
 * `agent/skills/` is committed, not gitignored, so `npm pack` from a clean
 * checkout is always correct and the agent-facing payload is visible in review.
 * The cost of committing derived content is drift — which is what the sync test
 * below removes. Run `npm run build:agent` after touching a doc.
 *
 * The YAML here is validated with a real parser (`yaml`), never with the repo's
 * own hand-rolled one: that parser is deliberately tolerant, so checking our
 * output with it would prove nothing about what the harnesses will accept. A
 * SKILL.md whose frontmatter does not parse does not fail loudly — the skill
 * just never loads.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { buildSkills, DOCS_DIR, SKILLS_DIR } from "../scripts/build-skills.js";
import { readDocs } from "../scripts/docs-frontmatter.js";

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The frontmatter block of a SKILL.md / doc, parsed with a real YAML reader. */
function frontmatterOf(content: string): Record<string, unknown> {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) throw new Error("no frontmatter block");
    return parseYaml(match[1]!) ?? {};
}

describe("site/docs frontmatter", () => {
    const docs = readDocs(DOCS_DIR);

    it("finds the docs", () => {
        expect(docs.length).toBeGreaterThan(0);
    });

    it("every doc declares a description — without it the skill never loads", () => {
        const missing = docs.filter((d) => !d.frontmatter.description).map((d) => d.filename);
        expect(missing).toEqual([]);
    });

    it("every doc's frontmatter is valid YAML carrying only `description`", () => {
        for (const doc of docs) {
            const raw = fs.readFileSync(path.join(DOCS_DIR, doc.filename), "utf-8");
            const fm = frontmatterOf(raw);
            expect(Object.keys(fm), doc.filename).toEqual(["description"]);
            expect(typeof fm.description, doc.filename).toBe("string");
        }
    });

    it("description fits the 1–1024 char limit both harnesses impose", () => {
        for (const doc of docs) {
            const len = doc.frontmatter.description!.length;
            expect(len, doc.filename).toBeGreaterThan(0);
            expect(len, doc.filename).toBeLessThanOrEqual(1024);
        }
    });

    it("the body no longer carries the frontmatter", () => {
        for (const doc of docs) {
            expect(doc.body.startsWith("---"), doc.filename).toBe(false);
            expect(doc.body.trimStart().startsWith("# "), doc.filename).toBe(true);
        }
    });
});

describe("agent/skills", () => {
    const skills = buildSkills(DOCS_DIR);

    it("is in sync with site/docs — run `npm run build:agent` after editing a doc", () => {
        const generated = Object.fromEntries(skills.map((s) => [s.relPath, s.content]));

        const onDisk: Record<string, string> = {};
        for (const dir of fs.existsSync(SKILLS_DIR) ? fs.readdirSync(SKILLS_DIR) : []) {
            const file = path.join(SKILLS_DIR, dir, "SKILL.md");
            if (fs.existsSync(file)) onDisk[`${dir}/SKILL.md`] = fs.readFileSync(file, "utf-8");
        }

        // Compare the file lists first: a rename shows up here as one add + one
        // delete, which reads better than a wall of content diff.
        expect(Object.keys(onDisk).sort()).toEqual(Object.keys(generated).sort());
        expect(onDisk).toEqual(generated);
    });

    it("names the directory exactly what the frontmatter declares", () => {
        for (const skill of skills) {
            const fm = frontmatterOf(skill.content);
            expect(fm.name, skill.relPath).toBe(skill.name);
            expect(skill.relPath.split("/")[0], skill.relPath).toBe(skill.name);
        }
    });

    it("uses kebab-case names prefixed with the package", () => {
        for (const skill of skills) {
            expect(NAME_RE.test(skill.name), skill.name).toBe(true);
            expect(skill.name.startsWith("velojs-"), skill.name).toBe(true);
        }
    });

    it("emits only `name` and `description` — opencode drops any other field", () => {
        for (const skill of skills) {
            const fm = frontmatterOf(skill.content);
            expect(Object.keys(fm).sort(), skill.relPath).toEqual(["description", "name"]);
        }
    });

    it("keeps the doc body intact after the frontmatter", () => {
        const docs = readDocs(DOCS_DIR);
        for (const skill of skills) {
            const doc = docs.find((d) => `velojs-${d.slug}` === skill.name)!;
            const body = skill.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n\r?\n/, "");
            expect(body, skill.relPath).toBe(doc.body);
        }
    });
});

describe("npm package", () => {
    const pkg = JSON.parse(
        fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    ) as { files: string[] };

    it("ships agent/ — agent-sync reads it from node_modules", () => {
        expect(pkg.files).toContain("agent/");
    });
});
