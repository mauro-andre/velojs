/**
 * `scripts/new-release.sh` — the local release path.
 *
 * The script talks to the npm registry and to the GitHub API, so every test
 * runs it inside a scratch repository (a local bare `origin` + a checkout on
 * `dev`) with fake `npm` and `curl` on PATH: the fakes record every call and
 * answer from a scenario directory, which makes the guards, the phase order and
 * the resume states observable without ever touching a real registry. `git` is
 * wrapped too — the same recording, then the real binary.
 *
 * What the fakes cannot prove is npm's and GitHub's own behaviour; they prove
 * the script's decisions, order of operations and payloads.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "scripts/new-release.sh");
const PACKAGE_NAME = "@mauroandre/velojs";
const REPO_SLUG = "mauro-andre/velojs";
const VERSION = "1.2.3";
const STAGE_ID = "0f9a0e4e-3b3c-4c3a-9c0f-2f6d5a1b7c8d";
const RESUMED_STAGE_ID = "11111111-1111-4111-8111-111111111111";
const OTP = "654321";

const REAL_GIT = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();

// ============================================
// Scratch repository + fake toolchain
// ============================================

interface Scenario {
    /** package.json version. Defaults to VERSION. */
    version?: string;
    /** .env content; null means "no .env at all". Defaults to both tokens set. */
    env?: string | null;
    /** Modify a tracked file after the commit. */
    dirty?: boolean;
    /** Branch to leave checked out. Defaults to `dev`. */
    branch?: string;
    /** Local commits on dev that were never pushed. */
    ahead?: number;
    /** Commits pushed to origin/dev from another clone. */
    behind?: number;
    /** The version is already public on the registry. */
    published?: boolean;
    /** A staged version of the package is pending (version of the stage). */
    stagedVersion?: string | null;
    /** Validation error for the release of `version`. */
    releaseExists?: boolean;
    /** The fake npm fails this exact invocation (e.g. "run typecheck"). */
    failGate?: string;
    /** The fake npm stage approve fails, as a rejected or expired OTP does. */
    approveFails?: boolean;
    /** Extra environment variables for the run (the environment wins over .env). */
    processEnv?: Record<string, string>;
}

interface Harness {
    dir: string;
    repo: string;
    calls(): string[];
    run(input?: string): { status: number; stdout: string; stderr: string };
    head(): string;
    releasePost(): Record<string, unknown> | null;
    /** Every call that left the checkout: npm and the GitHub API. */
    remoteCalls(): string[];
}

const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Release Test",
    GIT_AUTHOR_EMAIL: "release-test@example.com",
    GIT_COMMITTER_NAME: "Release Test",
    GIT_COMMITTER_EMAIL: "release-test@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(args: string[], cwd?: string): string {
    return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
}

/** Fake `npm`: records the call and answers from the scenario state. */
const FAKE_NPM = `#!/usr/bin/env bash
printf 'npm %s\\n' "$*" >> "$CALLS_LOG"
state="$FAKE_STATE"

if [ -n "$FAKE_FAIL_GATE" ] && [ "$*" = "$FAKE_FAIL_GATE" ]; then
    printf 'fake npm: %s failed\\n' "$*" >&2
    exit 1
fi

case "$1" in
    ci|test|run)
        exit 0
        ;;
    view)
        if [ -f "$state/published" ]; then
            cat "$state/published"
            exit 0
        fi
        printf 'npm error code E404\\nnpm error 404 No match found for version %s\\n' "$FAKE_VERSION" >&2
        exit 1
        ;;
    stage)
        case "$2" in
            list)
                if [ -f "$state/stage-id" ]; then
                    printf '[{"id":"%s","packageName":"%s","version":"%s","tag":"latest"}]\\n' \\
                        "$(cat "$state/stage-id")" "$FAKE_PACKAGE" "$(cat "$state/stage-version")"
                else
                    printf '[]\\n'
                fi
                exit 0
                ;;
            publish)
                printf '%s' "$FAKE_STAGE_ID" > "$state/stage-id"
                printf '%s' "$FAKE_VERSION" > "$state/stage-version"
                printf '+ %s@%s (staged with id %s)\\n' "$FAKE_PACKAGE" "$FAKE_VERSION" "$FAKE_STAGE_ID"
                exit 0
                ;;
            approve)
                if [ -f "$state/approve-fails" ]; then
                    printf 'npm error code EOTP\\nnpm error This operation requires a one-time password\\n' >&2
                    exit 1
                fi
                printf '%s' "$FAKE_VERSION" > "$state/published"
                printf 'Staged package %s approved and published successfully.\\n' "$3"
                exit 0
                ;;
        esac
        exit 0
        ;;
esac
exit 0
`;

/** Fake `curl`: records the call; the GitHub state comes from the scenario. */
const FAKE_CURL = `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "$CALLS_LOG"
state="$FAKE_STATE"
out=""
data=""
url=""

while [ $# -gt 0 ]; do
    case "$1" in
        --output|-o) out="$2"; shift 2 ;;
        --write-out|-w) shift 2 ;;
        --request|-X) shift 2 ;;
        --data|-d|--data-binary|--data-raw) data="$2"; shift 2 ;;
        --header|-H) shift 2 ;;
        --silent|--show-error|--fail|--fail-with-body) shift ;;
        *) url="$1"; shift ;;
    esac
done

code=404
body='{"message":"Not Found","status":"404"}'

case "$url" in
    */releases/tags/*)
        if [ -f "$state/release" ]; then
            code=200
            body="$(cat "$state/release")"
        fi
        ;;
    */releases)
        code=201
        printf '%s' "$data" > "$state/release-post.json"
        body='{"html_url":"https://github.com/'"$FAKE_REPO"'/releases/tag/'"$FAKE_VERSION"'","tag_name":"'"$FAKE_VERSION"'"}'
        ;;
esac

if [ -n "$out" ]; then
    printf '%s' "$body" > "$out"
fi
printf '%s' "$code"
`;

/** Fake `git`: records the call, then hands it to the real binary. */
const FAKE_GIT = `#!/usr/bin/env bash
printf 'git %s\\n' "$*" >> "$CALLS_LOG"
exec "$REAL_GIT" "$@"
`;

function fakeWrite(file: string, content: string): void {
    fs.writeFileSync(file, content);
    fs.chmodSync(file, 0o755);
}

function createHarness(scenario: Scenario = {}): Harness {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "velojs-release-"));
    const origin = path.join(dir, "origin.git");
    const repo = path.join(dir, "repo");
    const binDir = path.join(dir, "bin");
    const stateDir = path.join(dir, "state");
    const logFile = path.join(dir, "calls.log");
    const version = scenario.version ?? VERSION;

    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(logFile, "");

    fakeWrite(path.join(binDir, "npm"), FAKE_NPM);
    fakeWrite(path.join(binDir, "curl"), FAKE_CURL);
    fakeWrite(path.join(binDir, "git"), FAKE_GIT);

    // A bare origin the checkout can be in sync (or not) with.
    git(["init", "--quiet", "--bare", origin]);
    git(["init", "--quiet", repo]);
    git(["symbolic-ref", "HEAD", "refs/heads/dev"], repo);
    git(["remote", "add", "origin", origin], repo);

    fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(repo, "scripts/new-release.sh"));
    fs.chmodSync(path.join(repo, "scripts/new-release.sh"), fs.statSync(SCRIPT).mode & 0o777);
    fs.copyFileSync(path.join(REPO_ROOT, ".gitignore"), path.join(repo, ".gitignore"));
    fs.writeFileSync(
        path.join(repo, "package.json"),
        JSON.stringify(
            {
                name: PACKAGE_NAME,
                version,
                repository: { type: "git", url: `git+https://github.com/${REPO_SLUG}.git` },
            },
            null,
            4
        )
    );
    fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n");

    const env =
        scenario.env === null
            ? null
            : (scenario.env ?? "NPM_TOKEN=fake-npm-token\nGITHUB_TOKEN=fake-github-token\n");
    if (env !== null) {
        fs.writeFileSync(path.join(repo, ".env"), env);
    }

    git(["add", "-A"], repo);
    git(["commit", "--quiet", "-m", "initial"], repo);
    git(["push", "--quiet", "-u", "origin", "dev"], repo);

    if (scenario.branch) {
        git(["checkout", "--quiet", "-b", scenario.branch], repo);
    }
    if (scenario.dirty) {
        fs.appendFileSync(path.join(repo, "README.md"), "pending change\n");
    }
    for (let i = 0; i < (scenario.ahead ?? 0); i++) {
        git(["commit", "--quiet", "--allow-empty", "-m", `local ${i}`], repo);
    }
    if (scenario.behind) {
        const other = path.join(dir, "other");
        git(["clone", "--quiet", origin, other]);
        git(["checkout", "--quiet", "dev"], other);
        for (let i = 0; i < scenario.behind; i++) {
            fs.appendFileSync(path.join(other, "README.md"), `remote ${i}\n`);
            git(["add", "-A"], other);
            git(["commit", "--quiet", "-m", `remote ${i}`], other);
        }
        git(["push", "--quiet", "origin", "dev"], other);
    }

    if (scenario.published) {
        fs.writeFileSync(path.join(stateDir, "published"), version);
    }
    if (scenario.stagedVersion) {
        fs.writeFileSync(path.join(stateDir, "stage-id"), RESUMED_STAGE_ID);
        fs.writeFileSync(path.join(stateDir, "stage-version"), scenario.stagedVersion);
    }
    if (scenario.releaseExists) {
        fs.writeFileSync(path.join(stateDir, "release"), '{"tag_name":"' + version + '"}');
    }
    if (scenario.approveFails) {
        fs.writeFileSync(path.join(stateDir, "approve-fails"), "1");
    }

    const envForRun: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HOME: dir,
        ...scenario.processEnv,
        CALLS_LOG: logFile,
        FAKE_STATE: stateDir,
        FAKE_VERSION: version,
        FAKE_PACKAGE: PACKAGE_NAME,
        FAKE_REPO: REPO_SLUG,
        FAKE_STAGE_ID: STAGE_ID,
        FAKE_FAIL_GATE: scenario.failGate ?? "",
        REAL_GIT,
    };
    // Hermetic: a token this test runner happens to carry must not leak into a
    // scenario that is about the file not defining it.
    delete envForRun.NPM_TOKEN;
    delete envForRun.GITHUB_TOKEN;
    Object.assign(envForRun, scenario.processEnv);

    const calls = () => fs.readFileSync(logFile, "utf8").split("\n").filter((line) => line !== "");

    return {
        dir,
        repo,
        calls,
        run(input = "") {
            const result = spawnSync(SCRIPT, [], {
                cwd: repo,
                env: envForRun,
                input,
                encoding: "utf8",
                timeout: 120_000,
            });
            return {
                status: result.status ?? -1,
                stdout: result.stdout ?? "",
                stderr: result.stderr ?? "",
            };
        },
        head() {
            return git(["rev-parse", "HEAD"], repo).trim();
        },
        releasePost() {
            const file = path.join(stateDir, "release-post.json");
            if (!fs.existsSync(file)) return null;
            return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
        },
        remoteCalls() {
            return calls().filter((call) => call.startsWith("npm ") || call.startsWith("curl "));
        },
    };
}

let harness: Harness | null = null;

function start(scenario: Scenario = {}): Harness {
    harness = createHarness(scenario);
    return harness;
}

beforeEach(() => {
    harness = null;
});

afterEach(() => {
    if (harness) {
        fs.rmSync(harness.dir, { recursive: true, force: true });
        harness = null;
    }
});

/** Index of the first recorded call containing `needle`, -1 when absent. */
function indexOfCall(h: Harness, needle: string): number {
    return h.calls().findIndex((call) => call.includes(needle));
}

/** Index of the last recorded call containing `needle`, -1 when absent. */
function lastIndexOfCall(h: Harness, needle: string): number {
    return h.calls().reduce((last, call, index) => (call.includes(needle) ? index : last), -1);
}

// ============================================
// Delivery — what must be in the repository
// ============================================

describe("release script delivery", () => {
    it("ships scripts/new-release.sh as an executable", () => {
        expect(fs.existsSync(SCRIPT)).toBe(true);
        expect(fs.statSync(SCRIPT).mode & 0o111).toBeGreaterThan(0);
    });

    it("drops publish.yml and leaves test.yml untouched", () => {
        expect(fs.existsSync(path.join(REPO_ROOT, ".github/workflows/publish.yml"))).toBe(false);

        const current = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/test.yml"), "utf8");
        const committed = git(["show", "HEAD:.github/workflows/test.yml"], REPO_ROOT);
        expect(current).toBe(committed);
    });

    it("documents the npm and GitHub credentials in .env.example", () => {
        const example = fs.readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8");
        expect(example).toMatch(/^NPM_TOKEN=$/m);
        expect(example).toMatch(/^GITHUB_TOKEN=$/m);
        expect(example).not.toMatch(/^(NPM_TOKEN|GITHUB_TOKEN)=.+/m);

        const ignored = fs
            .readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8")
            .split("\n")
            .map((line) => line.trim());
        expect(ignored).toContain(".env");
    });
});

// ============================================
// Guards — every abort happens before any side effect
// ============================================

describe("release script guards", () => {
    it("refuses to run without .env", () => {
        const h = start({ env: null });
        const result = h.run();

        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/\.env not found/);
        expect(h.remoteCalls()).toEqual([]);
    });

    it("refuses when .env does not define GITHUB_TOKEN", () => {
        const h = start({ env: "NPM_TOKEN=fake-npm-token\n" });
        const result = h.run();

        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/GITHUB_TOKEN is missing/);
        expect(h.remoteCalls()).toEqual([]);
    });

    it("refuses a dirty working tree", () => {
        const h = start({ dirty: true });
        const result = h.run();

        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/working tree is dirty/);
        expect(h.remoteCalls()).toEqual([]);
    });

    it("refuses a branch other than dev", () => {
        const h = start({ branch: "feature" });
        const result = h.run();

        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/current branch is 'feature'/);
        expect(h.remoteCalls()).toEqual([]);
    });

    it("refuses when dev is ahead of origin/dev", () => {
        const h = start({ ahead: 1 });
        const result = h.run();

        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/not in sync with origin\/dev \(1 to push, 0 to pull\)/);
        expect(h.remoteCalls()).toEqual([]);
    });

    it("refuses when dev is behind origin/dev", () => {
        const h = start({ behind: 1 });
        const result = h.run();

        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/not in sync with origin\/dev \(0 to push, 1 to pull\)/);
        expect(h.remoteCalls()).toEqual([]);
    });

    it("refuses a pre-release version", () => {
        const h = start({ version: "1.2.3-beta.1" });
        const result = h.run();

        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/pre-release/);
        expect(h.remoteCalls()).toEqual([]);
    });
});

// ============================================
// Full flow — gates, stage, approve, verify, release
// ============================================

describe("release script full flow", () => {
    it("runs the gates, stages, approves with the OTP and creates the release", () => {
        const h = start();
        const result = h.run(`${OTP}\n`);

        expect(result.status).toBe(0);

        // Gates in the workflow order, and the build before the tarball is sent.
        const ci = indexOfCall(h, "npm ci");
        const typecheck = indexOfCall(h, "npm run typecheck");
        const test = indexOfCall(h, "npm test");
        const build = indexOfCall(h, "npm run build");
        const stage = indexOfCall(h, "npm stage publish --access public");
        const approve = indexOfCall(h, "npm stage approve");
        expect(ci).toBeGreaterThanOrEqual(0);
        expect(ci).toBeLessThan(typecheck);
        expect(typecheck).toBeLessThan(test);
        expect(test).toBeLessThan(build);
        expect(build).toBeLessThan(stage);
        expect(stage).toBeLessThan(approve);

        // The approve carries the stage id of the version in question, and the
        // verification of the published version comes after it.
        const approveCall = h.calls().find((call) => call.includes("npm stage approve"));
        expect(approveCall).toContain(STAGE_ID);
        expect(approveCall).toContain(`--otp ${OTP}`);
        expect(lastIndexOfCall(h, "npm view")).toBeGreaterThan(approve);

        // The release is created through the API, never by a local push.
        expect(h.releasePost()).toEqual({
            tag_name: VERSION,
            target_commitish: h.head(),
            name: VERSION,
            body: VERSION,
        });
        expect(h.calls().some((call) => /^git (push|tag)\b/.test(call))).toBe(false);

        expect(result.stdout).toMatch(new RegExp(`Done: ${PACKAGE_NAME}@${VERSION}`));
    });

    it("never echoes or logs the typed OTP", () => {
        const h = start();
        const result = h.run(`${OTP}\n`);

        expect(result.status).toBe(0);
        expect(result.stdout).not.toContain(OTP);
        expect(result.stderr).not.toContain(OTP);
    });

    it("aborts before staging when a quality gate fails", () => {
        const h = start({ failGate: "run typecheck" });
        const result = h.run(`${OTP}\n`);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/quality gate 'npm run typecheck' failed/);
        expect(indexOfCall(h, "npm stage publish")).toBe(-1);
        expect(h.releasePost()).toBeNull();
    });

    it("leaves the version unpublished and prints the manual commands when the approve fails", () => {
        const h = start({ approveFails: true });
        const result = h.run(`${OTP}\n`);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/npm stage list @mauroandre\/velojs/);
        expect(result.stderr).toContain(`npm stage approve ${STAGE_ID} --otp <code>`);
        expect(result.stderr).toContain(`npm stage reject ${STAGE_ID}`);
        expect(h.releasePost()).toBeNull();
    });

    it("takes a credential from the process environment when .env omits it", () => {
        const h = start({
            env: "NPM_TOKEN=fake-npm-token\n",
            processEnv: { GITHUB_TOKEN: "fake-github-token" },
        });
        const result = h.run(`${OTP}\n`);

        expect(result.status).toBe(0);
        expect(h.releasePost()).not.toBeNull();
    });
});

// ============================================
// Resume — the registry x GitHub state decides the phase
// ============================================

describe("release script resume", () => {
    it("resumes at the approve when the version is already staged", () => {
        const h = start({ stagedVersion: VERSION });
        const result = h.run(`${OTP}\n`);

        expect(result.status).toBe(0);

        // No second packaging: neither the gates nor the staged publish run.
        expect(indexOfCall(h, "npm ci")).toBe(-1);
        expect(indexOfCall(h, "npm run build")).toBe(-1);
        expect(indexOfCall(h, "npm stage publish")).toBe(-1);

        // The pending stage is the one approved.
        const approveCall = h.calls().find((call) => call.includes("npm stage approve"));
        expect(approveCall).toContain(RESUMED_STAGE_ID);
        expect(h.releasePost()).not.toBeNull();
    });

    it("ignores a pending stage of another version and packages this one", () => {
        const h = start({ stagedVersion: "9.9.9" });
        const result = h.run(`${OTP}\n`);

        expect(result.status).toBe(0);

        // The pending stage of 9.9.9 is none of this release's business.
        expect(indexOfCall(h, "npm ci")).toBeGreaterThanOrEqual(0);
        expect(indexOfCall(h, "npm run build")).toBeGreaterThanOrEqual(0);
        expect(indexOfCall(h, "npm stage publish")).toBeGreaterThanOrEqual(0);

        const approveCall = h.calls().find((call) => call.includes("npm stage approve"));
        expect(approveCall).toContain(STAGE_ID);
        expect(approveCall).not.toContain(RESUMED_STAGE_ID);
    });

    it("creates only the release when the version is already published", () => {
        const h = start({ published: true });
        const result = h.run(`${OTP}\n`);

        expect(result.status).toBe(0);
        expect(indexOfCall(h, "npm ci")).toBe(-1);
        expect(indexOfCall(h, "npm stage")).toBe(-1);
        expect(h.releasePost()).toEqual({
            tag_name: VERSION,
            target_commitish: h.head(),
            name: VERSION,
            body: VERSION,
        });
    });

    it("does nothing when the version is published and the release exists", () => {
        const h = start({ published: true, releaseExists: true });
        const result = h.run(`${OTP}\n`);

        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(new RegExp(`Nothing to do: ${PACKAGE_NAME}@${VERSION}`));
        expect(indexOfCall(h, "npm ci")).toBe(-1);
        expect(indexOfCall(h, "npm stage")).toBe(-1);
        expect(h.calls().some((call) => call.includes("POST"))).toBe(false);
        expect(h.releasePost()).toBeNull();
    });
});