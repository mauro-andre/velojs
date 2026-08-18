import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@mauroandre/velojs";

function getPackageVersion(): string {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(__dirname, "../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return pkg.version;
}

const templates: Record<string, string> = {
    ".gitignore": `# Dependencies
node_modules/

# Build output
dist/

# Project graph
.velojs/
`,
    "package.json": `{
    "name": "my-velojs-app",
    "version": "0.1.0",
    "type": "module",
    "scripts": {
        "dev": "velojs dev",
        "build": "velojs build",
        "start": "velojs start"
    },
    "dependencies": {
        "${PACKAGE_NAME}": "^${getPackageVersion()}"
    },
    "devDependencies": {
        "@types/node": "latest",
        "typescript": "latest"
    }
}
`,

    "vite.config.ts": `import { veloPlugin } from "${PACKAGE_NAME}/vite";

export default { plugins: [veloPlugin()] };
`,

    "tsconfig.json": `{
    "compilerOptions": {
        "module": "esnext",
        "moduleResolution": "bundler",
        "target": "esnext",
        "lib": ["esnext", "dom"],
        "types": ["node", "vite/client"],
        "strict": true,
        "noUncheckedIndexedAccess": true,
        "verbatimModuleSyntax": true,
        "isolatedModules": true,
        "skipLibCheck": true,
        "esModuleInterop": true,
        "noEmit": true,
        "jsx": "react-jsx",
        "jsxImportSource": "preact"
    },
    "include": ["app/**/*"],
    "exclude": ["node_modules", "dist"]
}
`,

    "app/routes.tsx": `import type { AppRoutes } from "${PACKAGE_NAME}";

import * as Root from "./client-root.js";
import * as Home from "./pages/Home.js";
import * as NotFound from "./pages/NotFound.js";

export default [
    {
        module: Root,
        isRoot: true,
        children: [
            { path: "/", module: Home },
            // Catch-all 404 — keep last. Served via notFound (SSR) / 404.html (SSG).
            { path: "*", module: NotFound, statusCode: 404 },
        ],
    },
] satisfies AppRoutes;
`,

    "app/server.tsx": `// Server initialization
// Use this file to set up server-side logic:
//   import { addRoutes, onServer } from "${PACKAGE_NAME}/server";
`,

    "app/client.tsx": `import "./styles/global.css";
`,

    "app/client-root.tsx": `import { Scripts } from "${PACKAGE_NAME}";

interface RootProps {
    children: preact.ComponentChildren;
}

export const Component = ({ children }: RootProps) => {
    return (
        <html lang="en">
            <head>
                <meta charSet="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <title>VeloJS App</title>
                <Scripts />
            </head>
            <body>{children}</body>
        </html>
    );
};
`,

    "app/styles/global.css": `*,
*::before,
*::after {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
}

body {
    font-family: system-ui, -apple-system, sans-serif;
    line-height: 1.6;
    color: #1a1a1a;
    background: #fafafa;
}

a {
    color: #0066cc;
    text-decoration: none;
}

a:hover {
    text-decoration: underline;
}
`,

    "app/pages/Home.tsx": `export const Component = () => {
    return (
        <main style={{ maxWidth: 640, margin: "80px auto", padding: "0 20px" }}>
            <h1>Welcome to VeloJS</h1>
            <p>Edit <code>app/pages/Home.tsx</code> to get started.</p>
        </main>
    );
};
`,

    "app/pages/NotFound.tsx": `export const Component = () => {
    return (
        <main style={{ maxWidth: 640, margin: "80px auto", padding: "0 20px" }}>
            <h1>404</h1>
            <p>Page not found.</p>
            <a href="/">Go home</a>
        </main>
    );
};
`,
};

export async function runInit(dirName?: string, opts?: { force?: boolean }): Promise<void> {
    const targetDir = dirName
        ? path.resolve(process.cwd(), dirName)
        : process.cwd();

    const dirBaseName = path.basename(targetDir);

    // The old rule — "directory must be empty" — blocked unrelated files the
    // template never touches. The real danger is overwriting files the
    // template WOULD write, so only those count as conflicts. `.gitignore`
    // never conflicts: its entries are appended to an existing file.
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    const conflicts = Object.keys(templates).filter(
        (f) => f !== ".gitignore" && fs.existsSync(path.join(targetDir, f))
    );
    if (conflicts.length > 0 && !opts?.force) {
        throw new Error(
            `Cannot init in "${dirBaseName}": these files already exist and would be overwritten:\n` +
            conflicts.map((c) => `  ${c}`).join("\n") +
            `\nMove them away, or run \`velojs init --force\` to overwrite.`
        );
    }

    // Write all template files
    for (const [filePath, content] of Object.entries(templates)) {
        const fullPath = path.join(targetDir, filePath);
        const dir = path.dirname(fullPath);

        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // .gitignore merges instead of overwriting — any git repo already has one
        if (filePath === ".gitignore" && fs.existsSync(fullPath)) {
            const existing = fs.readFileSync(fullPath, "utf-8");
            const missing = content
                .split("\n")
                .filter((line) => line && !line.startsWith("#") && !existing.includes(line));
            if (missing.length > 0) {
                fs.appendFileSync(fullPath, `\n# VeloJS\n${missing.join("\n")}\n`);
            }
            continue;
        }

        // Replace app name in package.json
        const finalContent = filePath === "package.json"
            ? content.replace("my-velojs-app", dirBaseName)
            : content;

        fs.writeFileSync(fullPath, finalContent);
    }

    console.log(`\nProject created in ${dirName ? dirBaseName : "current directory"}!\n`);
    console.log("Next steps:\n");
    if (dirName) {
        console.log(`  cd ${dirBaseName}`);
    }
    console.log("  npm install");
    console.log("  npx velojs dev\n");
}
