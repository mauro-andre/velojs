import { resolve } from "node:path";
import { veloPlugin } from "../src/vite.js";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import { docsPlugin } from "./plugins/vite-docs.js";

const veloSrc = resolve(__dirname, "../src");

export default {
    resolve: {
        alias: {
            // VeloJS source imports — point to local source
            "@mauroandre/velojs/server": resolve(veloSrc, "server.tsx"),
            "@mauroandre/velojs/client": resolve(veloSrc, "client.tsx"),
            "@mauroandre/velojs/hooks": resolve(veloSrc, "hooks.tsx"),
            "@mauroandre/velojs/cookie": resolve(veloSrc, "cookie.ts"),
            "@mauroandre/velojs/factory": resolve(veloSrc, "factory.ts"),
            "@mauroandre/velojs/vite": resolve(veloSrc, "vite.ts"),
            "@mauroandre/velojs/config": resolve(veloSrc, "config.ts"),
            "@mauroandre/velojs": resolve(veloSrc, "index.ts"),
        },
        // Force all shared deps to resolve from site/node_modules
        // This prevents duplicate instances when importing from ../src/
        dedupe: [
            "preact",
            "preact-render-to-string",
            "wouter-preact",
            "@preact/signals",
            "hono",
            "@hono/node-server",
        ],
    },
    plugins: [
        veloPlugin({ appDirectory: "./app" }),
        vanillaExtractPlugin({ identifiers: "short" }),
        docsPlugin(),
    ],
};
