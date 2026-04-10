import type { AppRoutes } from "../../src/types.js";

import * as Root from "./client-root.js";
import * as Landing from "./Landing.js";
import * as DocsLayout from "./docs/Layout.js";
import * as DocPage from "./docs/DocPage.js";

export default [
    {
        module: Root,
        isRoot: true,
        children: [
            { path: "/", module: Landing },
            {
                path: "/docs",
                module: DocsLayout,
                children: [
                    { path: "/:slug", module: DocPage },
                ],
            },
        ],
    },
] satisfies AppRoutes;
