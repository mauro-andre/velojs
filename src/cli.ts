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

const runBuild = (isStatic: boolean) => {
    // Generate build hash once so client and server share the same value
    const buildHash = Date.now().toString(36);

    const env = {
        ...process.env,
        VELO_BUILD_HASH: buildHash,
        ...(isStatic ? { VELO_STATIC: "1" } : {}),
    };

    console.log("Building client...");
    spawnSync("npx", ["vite", "build"], {
        stdio: "inherit",
        cwd: process.cwd(),
        env,
    });

    console.log("Building server...");
    spawnSync("npx", ["vite", "build", "--mode", "server"], {
        stdio: "inherit",
        cwd: process.cwd(),
        env,
    });

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

Examples:
  velojs init my-app
  velojs dev
  velojs build
  velojs build --static
  velojs start
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
