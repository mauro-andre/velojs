#!/usr/bin/env node

import { startDevServer } from "./dev-server.js";

const command = process.argv[2];

switch (command) {
  case "dev":
    startDevServer();
    break;

  case "build":
    console.log("🚧 Build command coming soon!");
    console.log("For now, use: vite build");
    break;

  default:
    console.log(`
VeloJS CLI

Usage:
  velo dev        Start development server with HMR
  velo build      Build for production (coming soon)

For more info: https://github.com/mauro-andre/velojs
    `);
}
