#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const command = args[0];

const runCommand = (cmd: string, cmdArgs: string[] = []) => {
    const result = spawnSync(cmd, cmdArgs, {
        stdio: "inherit",
        cwd: process.cwd(),
    });
    process.exit(result.status ?? 0);
};

const runVite = () => {
    runCommand("npx", ["vite", ...args.slice(1)]);
};

const runBuild = () => {
    console.log("Building client...");
    spawnSync("npx", ["vite", "build"], { stdio: "inherit", cwd: process.cwd() });

    console.log("Building server...");
    spawnSync("npx", ["vite", "build", "--mode", "server"], { stdio: "inherit", cwd: process.cwd() });

    console.log("Build complete!");
};

const runStart = () => {
    const serverPath = resolve(process.cwd(), "dist/server.js");
    runCommand("node", [serverPath]);
};

const showHelp = () => {
    console.log(`
VeloJS CLI

Usage:
  velojs <command>

Commands:
  dev      Start development server
  build    Build for production (client + server)
  start    Start production server

Examples:
  velojs dev
  velojs build
  velojs start
`);
};

switch (command) {
    case "dev":
        runVite();
        break;
    case "build":
        runBuild();
        break;
    case "start":
        runStart();
        break;
    case "help":
    case "--help":
    case "-h":
        showHelp();
        break;
    default:
        if (command) {
            console.error(`Unknown command: ${command}`);
        }
        showHelp();
        process.exit(1);
}
