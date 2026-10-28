#!/usr/bin/env bash
#
# Cut a release from this checkout: quality gates, staged publish on npm, then
# tag + release on GitHub — and that is where this script ends.
#
# The version is always the one in package.json — a single source, never derived
# from a tag. Before acting the script reconciles the npm registry against the
# GitHub releases and continues from whatever phase is still missing, so a run
# that failed at the release call can be finished by running it again.
#
# npm no longer accepts a token that bypasses 2FA for a direct publish, so the
# tarball goes up with `npm stage publish` (the token only forwards it). The
# promotion to public is a human step OUTSIDE this script: the maintainer
# approves the staged version on npmjs.com or with
# `npm stage approve <stage-id> --otp <code>`. This script never reads an OTP
# and never approves anything — when it exits successfully the version is
# staged, not public.
#
# Credentials come from the gitignored .env at the repo root (see .env.example):
#   NPM_TOKEN    granular token, "Read and write (stage only)" on the package
#   GITHUB_TOKEN fine-grained token, Contents: Read and write on the repo
# A value already exported in the process environment wins over the file.
#
# Usage: scripts/new-release.sh   (from anywhere inside the repo)
#
set -euo pipefail

readonly GITHUB_API="https://api.github.com"
readonly NPM_REGISTRY_HOST="registry.npmjs.org"

log() { printf '%s\n' "$*"; }
phase() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Scratch space: the private npm credentials file and the API response body.
# Nothing is created before the guards pass.
# ---------------------------------------------------------------------------

WORK_DIR=""
NPMRC_FILE=""
RESPONSE_FILE=""
GH_STATUS=""

cleanup() {
    if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
        rm -rf "$WORK_DIR"
    fi
}
trap cleanup EXIT

ensure_work_dir() {
    if [ -z "$WORK_DIR" ]; then
        WORK_DIR="$(mktemp -d)" || die "could not create a temporary directory."
        RESPONSE_FILE="$WORK_DIR/response.json"
    fi
}

# npm reads the token from a private temp userconfig (mode 600, removed on exit)
# so it never lands in argv, in a log line or in the repository.
ensure_npmrc() {
    if [ -z "$NPMRC_FILE" ]; then
        ensure_work_dir
        NPMRC_FILE="$(mktemp "$WORK_DIR/npmrc.XXXXXX")" \
            || die "could not create the temporary npm credentials file."
        printf '//%s/:_authToken=%s\n' "$NPM_REGISTRY_HOST" "$NPM_TOKEN" > "$NPMRC_FILE" \
            || die "could not write the temporary npm credentials file."
    fi
}

# ---------------------------------------------------------------------------
# Package identity and .env parsing
# ---------------------------------------------------------------------------

# name, version and GitHub slug ("owner/repo"), one per line, from package.json.
package_meta() {
    node -e '
        const fs = require("node:fs");
        const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
        const url = String((pkg.repository && (pkg.repository.url || pkg.repository)) || "");
        const slug = url
            .replace(/^git\+/, "")
            .replace(/^https?:\/\/github\.com\//, "")
            .replace(/\.git$/, "");
        process.stdout.write([pkg.name, pkg.version, slug].join("\n"));
    ' || die "could not read name, version and repository from package.json."
}

# First `KEY=value` of a .env-style file, unquoted. Empty output when absent.
env_value() {
    local file="$1" key="$2" line
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line%$'\r'}"
        line="${line#"${line%%[![:space:]]*}"}"
        case "$line" in
            "$key="*)
                line="${line#*=}"
                case "$line" in
                    \"*\") line="${line#\"}"; line="${line%\"}" ;;
                    \'*\') line="${line#\'}"; line="${line%\'}" ;;
                esac
                printf '%s' "$line"
                return 0
                ;;
        esac
    done < "$file"
    return 1
}

# ---------------------------------------------------------------------------
# GitHub API
# ---------------------------------------------------------------------------

github_get() {
    ensure_work_dir
    GH_STATUS="$(curl \
        --silent --show-error \
        --output "$RESPONSE_FILE" \
        --write-out '%{http_code}' \
        --header "Authorization: Bearer $GITHUB_TOKEN" \
        --header "Accept: application/vnd.github+json" \
        "$GITHUB_API$1")" || die "GitHub API request failed: GET $1"
}

github_post() {
    ensure_work_dir
    GH_STATUS="$(curl \
        --silent --show-error \
        --output "$RESPONSE_FILE" \
        --write-out '%{http_code}' \
        --request POST \
        --header "Authorization: Bearer $GITHUB_TOKEN" \
        --header "Accept: application/vnd.github+json" \
        --header "Content-Type: application/json" \
        --data "$2" \
        "$GITHUB_API$1")" || die "GitHub API request failed: POST $1"
}

# ---------------------------------------------------------------------------
# Phases
# ---------------------------------------------------------------------------

# The same gates as the CI workflow, in the same order. `npm run build` is what
# makes the tarball ship a fresh dist/ — `npm publish` alone would pack whatever
# build was already on disk.
quality_gates() {
    phase "[2/4] Quality gates (the same order as the CI workflow)"
    run_gate npm ci
    run_gate npm run typecheck
    run_gate npm test
    run_gate npm run build
}

run_gate() {
    log "\$ $*"
    "$@" || die "the quality gate '$*' failed — nothing was sent to the registry."
}

# `npm stage publish` runs the prepack hook (regenerating agent/skills/) and
# uploads the tarball as a staged version: visible to maintainers, not public.
stage_version() {
    phase "[3/4] Stage the tarball on the npm registry"
    ensure_npmrc
    log "\$ npm stage publish --access public"
    npm stage publish --access public --userconfig="$NPMRC_FILE" \
        || die "npm stage publish failed — nothing was published."
    log "The tarball is staged, not public yet."
}

# stage ids are UUIDs; the staged version in question is identified by version,
# never by parsing npm's output.
staged_id_for_version() {
    local listing
    ensure_npmrc
    listing="$(npm stage list "$PKG_NAME" --json --userconfig="$NPMRC_FILE")" \
        || die "could not list the staged versions of $PKG_NAME."
    printf '%s' "$listing" | node -e '
        let raw = "";
        process.stdin.on("data", (chunk) => (raw += chunk));
        process.stdin.on("end", () => {
            const items = JSON.parse(raw);
            const match = items.find((item) => item.version === process.argv[1]);
            process.stdout.write(match ? match.id : "");
        });
    ' "$VERSION" || die "could not parse the staged versions returned by npm."
}

# The releases API creates the tag itself at target_commitish — no local tag and
# no push of branch or tag. The body is the version alone: release notes are a
# decision for later.
create_github_release() {
    local sha payload url
    phase "[4/4] Tag and release on GitHub"
    sha="$(git rev-parse HEAD)"
    payload="$(node -e '
        process.stdout.write(JSON.stringify({
            tag_name: process.argv[1],
            target_commitish: process.argv[2],
            name: process.argv[1],
            body: process.argv[1],
        }));
    ' "$VERSION" "$sha")" || die "could not build the release payload."
    github_post "/repos/$REPO_SLUG/releases" "$payload"
    case "$GH_STATUS" in
        2*) ;;
        *) die "GitHub replied HTTP $GH_STATUS when creating release $VERSION:"$'\n'"$(cat "$RESPONSE_FILE")" ;;
    esac
    url="$(node -e '
        try {
            const body = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
            process.stdout.write(body.html_url || "");
        } catch {
            process.stdout.write("");
        }
    ' "$RESPONSE_FILE" 2>/dev/null || true)"
    log "Created tag $VERSION at $(git rev-parse --short HEAD) and release $VERSION."
    if [ -n "$url" ]; then
        log "Release: $url"
    fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" \
    || die "not inside a git repository — run this script from the repo."
cd "$REPO_ROOT"

meta="$(package_meta)"
{ IFS= read -r PKG_NAME; IFS= read -r VERSION; IFS= read -r REPO_SLUG; } <<< "$meta"
if [ -z "$REPO_SLUG" ]; then
    die "could not derive the GitHub repository from package.json (repository.url)."
fi

phase "[1/4] Guards"

# --- credentials -----------------------------------------------------------
ENV_FILE="$REPO_ROOT/.env"
if [ ! -f "$ENV_FILE" ]; then
    die ".env not found at the repo root — copy .env.example to .env and fill in NPM_TOKEN and GITHUB_TOKEN."
fi
if [ -z "${NPM_TOKEN:-}" ]; then
    NPM_TOKEN="$(env_value "$ENV_FILE" NPM_TOKEN || true)"
fi
if [ -z "${GITHUB_TOKEN:-}" ]; then
    GITHUB_TOKEN="$(env_value "$ENV_FILE" GITHUB_TOKEN || true)"
fi
export NPM_TOKEN GITHUB_TOKEN
if [ -z "$NPM_TOKEN" ]; then
    die "NPM_TOKEN is missing — set it in .env (see .env.example: a granular token with \"Read and write (stage only)\" on the package)."
fi
if [ -z "$GITHUB_TOKEN" ]; then
    die "GITHUB_TOKEN is missing — set it in .env (see .env.example: a fine-grained token with Contents: Read and write on the repo)."
fi

# --- working tree, branch and sync ----------------------------------------
tree_status="$(git status --porcelain)"
if [ -n "$tree_status" ]; then
    printf '%s\n' "$tree_status" >&2
    die "the working tree is dirty — commit or stash everything before releasing."
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "dev" ]; then
    die "current branch is '$BRANCH' — releases are cut from 'dev'."
fi

# origin/dev is refreshed first: "behind" can only be seen against the remote's
# current state, not against a stale remote-tracking ref.
git fetch --quiet --force origin "+refs/heads/dev:refs/remotes/origin/dev" \
    || die "could not fetch origin/dev — check the network and the 'origin' remote."
if ! git rev-parse --verify --quiet refs/remotes/origin/dev > /dev/null; then
    die "origin/dev does not exist — 'origin' must point at $REPO_SLUG."
fi
ahead="$(git rev-list --count "origin/dev..dev")"
behind="$(git rev-list --count "dev..origin/dev")"
if [ "$ahead" != "0" ] || [ "$behind" != "0" ]; then
    die "dev is not in sync with origin/dev ($ahead to push, $behind to pull) — push or pull before releasing."
fi

# --- version ---------------------------------------------------------------
case "$VERSION" in
    *-*)
        die "package.json version $VERSION is a pre-release — pre-release publishing is not supported yet."
        ;;
esac

log "Releasing $PKG_NAME@$VERSION from $REPO_SLUG (branch $BRANCH, commit $(git rev-parse --short HEAD))."

# --- state: registry x GitHub ---------------------------------------------
# The state decides where the run starts; it is read-only, so a published
# version never aborts — it only redirects the run.
view_output=""
if view_output="$(npm view "$PKG_NAME@$VERSION" version --prefer-online 2>&1)"; then
    PUBLISHED=1
elif [[ "$view_output" == *E404* ]]; then
    PUBLISHED=0
else
    die "could not check whether $PKG_NAME@$VERSION is published:"$'\n'"$view_output"
fi

github_get "/repos/$REPO_SLUG/releases/tags/$VERSION"
case "$GH_STATUS" in
    200) RELEASE_EXISTS=1 ;;
    404) RELEASE_EXISTS=0 ;;
    *) die "GitHub replied HTTP $GH_STATUS looking up release $VERSION:"$'\n'"$(cat "$RESPONSE_FILE")" ;;
esac

if [ "$PUBLISHED" = 1 ]; then
    log "npm:    $PKG_NAME@$VERSION is published."
else
    log "npm:    $PKG_NAME@$VERSION is not published yet."
fi
if [ "$RELEASE_EXISTS" = 1 ]; then
    log "github: release $VERSION exists."
else
    log "github: release $VERSION does not exist yet."
fi

if [ "$PUBLISHED" = 1 ] && [ "$RELEASE_EXISTS" = 1 ]; then
    log ""
    log "Nothing to do: $PKG_NAME@$VERSION is published on npm and release $VERSION already exists on GitHub."
    exit 0
fi

STAGE_ID=""
if [ "$PUBLISHED" = 0 ]; then
    STAGE_ID="$(staged_id_for_version)"
    if [ -n "$STAGE_ID" ]; then
        log "npm:    stage $STAGE_ID is pending for $VERSION."
    fi
fi

# Staged: skip the gates and the packing — never pack a second time. Only a
# version that is neither published nor staged gets the full run.
if [ "$PUBLISHED" = 0 ] && [ -z "$STAGE_ID" ]; then
    quality_gates
    stage_version
    STAGE_ID="$(staged_id_for_version)"
    if [ -z "$STAGE_ID" ]; then
        die "the staged version $VERSION did not show up in 'npm stage list' — check the registry state by hand."
    fi
fi

# The GitHub release is the last automated step: it points at the commit even
# while the npm version is still staged. Never remade when it already exists.
if [ "$RELEASE_EXISTS" = 0 ]; then
    create_github_release
fi

# ---------------------------------------------------------------------------
# Ending
# ---------------------------------------------------------------------------

if [ "$PUBLISHED" = 1 ]; then
    log ""
    log "Done: $PKG_NAME@$VERSION is public on npm and released on GitHub."
    exit 0
fi

# The staged ending: everything this script can do is done — making the version
# public is the maintainer's move, on the npm platform or with the CLI.
log ""
log "Done for this script: $PKG_NAME@$VERSION is staged (stage id $STAGE_ID) and released on GitHub — it is NOT public yet."
log ""
log "Promote it by hand — the approval is the only step that makes the version public:"
log "    npm stage approve $STAGE_ID --otp <code>"
log "or review and approve the staged version on npmjs.com:"
log "    https://www.npmjs.com/package/$PKG_NAME"
log ""
log "To find the stage id again:  npm stage list $PKG_NAME"
log "To discard the stage instead: npm stage reject $STAGE_ID"
