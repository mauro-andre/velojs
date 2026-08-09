import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import fs from "node:fs";

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

const runBuild = (isStatic: boolean) => {
    // Generate build hash once so client and server share the same value
    const buildHash = Date.now().toString(36);

    const env = {
        ...process.env,
        VELO_BUILD_HASH: buildHash,
        ...(isStatic ? { VELO_STATIC: "1" } : {}),
    };

    console.log("Building client...");
    const clientResult = spawnSync("npx", ["vite", "build"], {
        stdio: "inherit",
        cwd: process.cwd(),
        env,
    });
    // Abort if the client build failed. Otherwise we'd proceed to build the
    // server, print "Build complete!", and ship a dist/ with no dist/client/
    // (static assets never served in prod) — a silent, false success.
    if (clientResult.status !== 0) {
        console.error("Client build failed. Aborting.");
        process.exit(clientResult.status ?? 1);
    }

    console.log("Building server...");
    const serverResult = spawnSync("npx", ["vite", "build", "--mode", "server"], {
        stdio: "inherit",
        cwd: process.cwd(),
        env,
    });
    if (serverResult.status !== 0) {
        console.error("Server build failed. Aborting.");
        process.exit(serverResult.status ?? 1);
    }

    console.log("Build complete!");

    if (isStatic) {
        runStaticGeneration();
    }
};

const runStaticGeneration = async () => {
    process.env.NODE_ENV = "production";
    process.env.VELO_STATIC = "1";

    const serverPath = resolve(process.cwd(), "dist/server.js");
    const serverModule = await import(serverPath);

    const app = serverModule.default;
    const routes = serverModule.routes;

    if (!app || !routes) {
        console.error("Failed to load app or routes from dist/server.js");
        process.exit(1);
    }

    const { generateStatic } = await import("./static.js");
    await generateStatic(app, routes);
};

const runStart = () => {
    process.env.NODE_ENV = "production";
    const serverPath = resolve(process.cwd(), "dist/server.js");
    runCommand("node", [serverPath]);
};

const showHelp = () => {
    console.log(`
VeloJS CLI

Usage:
  velojs <command>

Commands:
  init             Create a new VeloJS project
  dev              Start development server
  build            Build for production (client + server)
  build --static   Build as static site (HTML + JSON)
  start            Start production server
  graph [app-dir]   Generate .velojs/graph.json (route tree + dependency graph)

Examples:
  velojs init my-app
  velojs dev
  velojs build
  velojs build --static
  velojs start
  velojs graph
  velojs graph src/app
`);
};

switch (command) {
    case "init": {
        const { runInit } = await import("./init.js");
        await runInit(args[1]);
        break;
    }
    case "dev":
        runVite();
        break;
    case "build": {
        const isStatic = args.includes("--static");
        runBuild(isStatic);
        break;
    }
    case "start":
        runStart();
        break;
    case "graph": {
        const { buildGraph } = await import("./graph.js");
        const rootDir = process.cwd();
        const appDirFlag = args[1] && !args[1].startsWith("-") ? args[1] : null;
        const appDir = join(rootDir, appDirFlag ?? "app");
        const graph = buildGraph(appDir);
        const outDir = join(rootDir, ".velojs");
        fs.mkdirSync(outDir, { recursive: true });
        const outFile = join(outDir, "graph.json");
        fs.writeFileSync(outFile, JSON.stringify(graph, null, 2));
        console.log(`Graph written to .velojs/graph.json`);
        break;
    }
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
