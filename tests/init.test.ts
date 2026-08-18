import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runInit } from "../src/init.js";

let workDir: string;
let prevCwd: string;

beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "velojs-init-"));
    prevCwd = process.cwd();
    process.chdir(workDir);
});

afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(workDir, { recursive: true, force: true });
});

describe("velojs init", () => {
    it("creates a project in an empty directory", async () => {
        await runInit("my-app");

        expect(fs.existsSync(path.join(workDir, "my-app", "package.json"))).toBe(true);
        expect(fs.existsSync(path.join(workDir, "my-app", "app", "routes.tsx"))).toBe(true);
        const pkg = JSON.parse(
            fs.readFileSync(path.join(workDir, "my-app", "package.json"), "utf-8")
        );
        expect(pkg.name).toBe("my-app");
    });

    it("allows a directory with unrelated files — nothing is touched", async () => {
        fs.mkdirSync(path.join(workDir, "docs"));
        fs.writeFileSync(path.join(workDir, "docs", "notes.md"), "keep me");
        fs.writeFileSync(path.join(workDir, "data.csv"), "1,2,3");

        await runInit();

        expect(fs.readFileSync(path.join(workDir, "docs", "notes.md"), "utf-8")).toBe("keep me");
        expect(fs.readFileSync(path.join(workDir, "data.csv"), "utf-8")).toBe("1,2,3");
        expect(fs.existsSync(path.join(workDir, "package.json"))).toBe(true);
        expect(fs.existsSync(path.join(workDir, "app", "routes.tsx"))).toBe(true);
    });

    it("refuses to overwrite a conflicting file and leaves it intact", async () => {
        fs.writeFileSync(path.join(workDir, "package.json"), '{"name":"existing"}');

        await expect(runInit()).rejects.toThrow(/already exist/);

        expect(fs.readFileSync(path.join(workDir, "package.json"), "utf-8")).toBe('{"name":"existing"}');
        // And nothing else was written
        expect(fs.existsSync(path.join(workDir, "app"))).toBe(false);
    });

    it("--force overwrites conflicting files", async () => {
        fs.writeFileSync(path.join(workDir, "package.json"), '{"name":"existing"}');

        await runInit(undefined, { force: true });

        const pkg = JSON.parse(fs.readFileSync(path.join(workDir, "package.json"), "utf-8"));
        expect(pkg.name).not.toBe("existing");
        expect(fs.existsSync(path.join(workDir, "app", "routes.tsx"))).toBe(true);
    });

    it("merges .gitignore instead of overwriting or conflicting", async () => {
        fs.writeFileSync(path.join(workDir, ".gitignore"), "my-secret-folder/\n");

        await runInit();

        const gitignore = fs.readFileSync(path.join(workDir, ".gitignore"), "utf-8");
        expect(gitignore).toContain("my-secret-folder/");
        expect(gitignore).toContain("node_modules/");
        expect(gitignore).toContain("dist/");
        expect(gitignore).toContain(".velojs/");
    });

    it("does not duplicate .gitignore entries already present", async () => {
        fs.writeFileSync(path.join(workDir, ".gitignore"), "node_modules/\ndist/\n.velojs/\n");

        await runInit();

        const gitignore = fs.readFileSync(path.join(workDir, ".gitignore"), "utf-8");
        expect(gitignore.match(/node_modules\//g)).toHaveLength(1);
    });
});
