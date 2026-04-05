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

export default [
    {
        module: Root,
        isRoot: true,
        children: [
            { path: "/", module: Home },
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
};

export async function runInit(dirName?: string): Promise<void> {
    const targetDir = dirName
        ? path.resolve(process.cwd(), dirName)
        : process.cwd();

    const dirBaseName = path.basename(targetDir);

    // Check if directory exists and is non-empty
    if (fs.existsSync(targetDir)) {
        const entries = fs.readdirSync(targetDir).filter(
            (e) => !e.startsWith(".") && e !== "node_modules"
        );
        if (entries.length > 0) {
            console.error(
                `Error: Directory "${dirBaseName}" is not empty. Use an empty directory.`
            );
            process.exit(1);
        }
    } else {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    // Write all template files
    for (const [filePath, content] of Object.entries(templates)) {
        const fullPath = path.join(targetDir, filePath);
        const dir = path.dirname(fullPath);

        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
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
