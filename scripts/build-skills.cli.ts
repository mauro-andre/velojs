/**
 * Entry point for `npm run build:agent`.
 *
 * Separate from `build-skills.ts` on purpose: that module is imported by the
 * tests, so it must have no side effects. Guarding on `process.argv[1]` instead
 * would depend on the runner — under vite-node argv[1] is the vite-node binary,
 * so the guard silently never fires and nothing gets written.
 */
import { writeSkills, DOCS_DIR, SKILLS_DIR } from "./build-skills.js";

const skills = writeSkills(DOCS_DIR, SKILLS_DIR);

// stderr, never stdout: this runs from `prepack`, and `npm pack`'s stdout is a
// data channel — it prints the tarball filename, which callers parse. Anything
// this script logs there corrupts that value.
console.error(`agent/skills: wrote ${skills.length} skills from site/docs`);
