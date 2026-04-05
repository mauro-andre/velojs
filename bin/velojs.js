#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, "../src/cli.ts");

const result = spawnSync("npx", ["tsx", cliPath, ...process.argv.slice(2)], {
    stdio: "inherit",
    cwd: process.cwd(),
});

process.exit(result.status ?? 0);
