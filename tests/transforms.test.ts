import { describe, it, expect } from "vitest";
import {
    injectMetadata,
    transformLoaderFunctions,
    transformActionsForClient,
    transformStreamsForClient,
    transformSocketsForClient,
    removeLoaders,
    removeMiddlewares,
    removeEndpointRoutes,
    pruneClientOnlyImports,
} from "../src/vite.js";

// ============================================
// injectMetadata
// ============================================

describe("injectMetadata", () => {
    it("injects moduleId into existing metadata", () => {
        const input = `export const metadata = { title: "Home" };`;
        const output = injectMetadata(input, "pages/Home");
        expect(output).toContain('moduleId: "pages/Home"');
        expect(output).toContain('title: "Home"');
    });

    it("creates metadata export when none exists", () => {
        const input = `export const Component = () => <div>Hello</div>;`;
        const output = injectMetadata(input, "pages/Home");
        expect(output).toContain("export const metadata");
        expect(output).toContain('moduleId: "pages/Home"');
    });

    it("injects fullPath and path when provided", () => {
        const input = `export const metadata = { title: "User" };`;
        const output = injectMetadata(input, "pages/User", "/users/:id", "/:id");
        expect(output).toContain('moduleId: "pages/User"');
        expect(output).toContain('fullPath: "/users/:id"');
        expect(output).toContain('path: "/:id"');
    });

    it("replaces existing moduleId/fullPath/path", () => {
        const input = `export const metadata = { moduleId: "old", fullPath: "/old", title: "X" };`;
        const output = injectMetadata(input, "pages/New", "/new", "/new");
        expect(output).toContain('moduleId: "pages/New"');
        expect(output).toContain('fullPath: "/new"');
        expect(output).not.toContain('"old"');
    });

    it("creates metadata with only moduleId when no fullPath/path", () => {
        const input = `export const Component = () => null;`;
        const output = injectMetadata(input, "layouts/Root");
        expect(output).toContain('moduleId: "layouts/Root"');
        expect(output).not.toContain("fullPath");
        expect(output).not.toContain("path:");
    });
});

// ============================================
// transformLoaderFunctions
// ============================================

describe("transformLoaderFunctions", () => {
    it("prepends moduleId to Loader() call", () => {
        const input = `const { data } = Loader();`;
        const output = transformLoaderFunctions(input, "pages/Home");
        expect(output).toContain('Loader("pages/Home")');
    });

    it("prepends moduleId to useLoader() call", () => {
        const input = `const { data } = useLoader();`;
        const output = transformLoaderFunctions(input, "pages/Home");
        expect(output).toContain('useLoader("pages/Home")');
    });

    it("prepends moduleId to Loader<Type>() with type params", () => {
        const input = `const { data } = Loader<UserData>();`;
        const output = transformLoaderFunctions(input, "pages/User");
        expect(output).toContain('"pages/User"');
    });

    it("prepends moduleId to useLoader with deps", () => {
        const input = `const { data } = useLoader([params.id]);`;
        const output = transformLoaderFunctions(input, "pages/User");
        expect(output).toContain('useLoader("pages/User", [params.id])');
    });

    it("does not double-prepend if moduleId already present", () => {
        const input = `const { data } = useLoader("pages/Home");`;
        const output = transformLoaderFunctions(input, "pages/Home");
        // Should still have exactly one moduleId string
        const matches = output.match(/"pages\/Home"/g);
        expect(matches?.length).toBe(1);
    });

    it("does not transform unrelated function calls", () => {
        const input = `const result = someFunction();`;
        const output = transformLoaderFunctions(input, "pages/Home");
        expect(output).not.toContain("pages/Home");
    });
});

// ============================================
// transformActionsForClient
// ============================================

describe("transformActionsForClient", () => {
    it("transforms action with body into fetch stub", () => {
        const input = `export const action_login = async ({ body, c }: ActionArgs<LoginBody>) => {
    const token = await generateToken(body.email);
    return { token };
};`;
        const output = transformActionsForClient(input, "auth/Login");
        expect(output).toContain("fetch(");
        expect(output).toContain("/_action/auth/Login/login");
        expect(output).toContain('"POST"');
        expect(output).toContain("JSON.stringify(body)");
    });

    it("transforms action without params into simple fetch", () => {
        const input = `export const action_logout = async () => {
    await clearSession();
    return { ok: true };
};`;
        const output = transformActionsForClient(input, "auth/Logout");
        expect(output).toContain("/_action/auth/Logout/logout");
        expect(output).not.toContain("JSON.stringify");
    });

    it("preserves non-action exports", () => {
        const input = `export const Component = () => <div />;
export const action_save = async ({ body }: ActionArgs<Data>) => { return body; };`;
        const output = transformActionsForClient(input, "pages/Edit");
        expect(output).toContain("export const Component");
        expect(output).toContain("/_action/pages/Edit/save");
    });

    it("does not transform non-async functions", () => {
        const input = `export const action_helper = (x: number) => x * 2;`;
        const output = transformActionsForClient(input, "pages/Test");
        // Non-async arrow functions are not transformed
        expect(output).not.toContain("fetch(");
    });
});

// ============================================
// removeLoaders
// ============================================

describe("removeLoaders", () => {
    it("removes export const loader declaration", () => {
        const input = `export const loader = async ({ c }: LoaderArgs) => {
    return { data: "test" };
};
export const Component = () => <div />;`;
        const output = removeLoaders(input);
        expect(output).not.toContain("export const loader");
        expect(output).toContain("export const Component");
    });

    it("preserves other exports", () => {
        const input = `export const metadata = { title: "Test" };
export const loader = async () => ({});
export const Component = () => null;`;
        const output = removeLoaders(input);
        expect(output).toContain("export const metadata");
        expect(output).toContain("export const Component");
        expect(output).not.toContain("export const loader");
    });

    it("no-op when no loader present", () => {
        const input = `export const Component = () => <div />;`;
        const output = removeLoaders(input);
        expect(output).toContain("export const Component");
    });
});

// ============================================
// removeMiddlewares
// ============================================

describe("removeMiddlewares", () => {
    it("removes middlewares property and related imports", () => {
        const input = `import { authMiddleware } from "./middleware.js";

const routes = {
    path: "/admin",
    module: Admin,
    middlewares: [authMiddleware],
};`;
        const output = removeMiddlewares(input);
        expect(output).not.toContain("middlewares");
        expect(output).not.toContain("authMiddleware");
    });

    it("keeps non-middleware imports from the same source", () => {
        const input = `import { authMiddleware, someHelper } from "./utils.js";

const routes = {
    middlewares: [authMiddleware],
};`;
        const output = removeMiddlewares(input);
        expect(output).not.toContain("authMiddleware");
        expect(output).toContain("someHelper");
    });

    it("returns original code when no middlewares present", () => {
        const input = `const routes = { path: "/", module: Home };`;
        const output = removeMiddlewares(input);
        expect(output).toBe(input);
    });

    it("removes multiple middleware identifiers", () => {
        const input = `import { authMw } from "./auth.js";
import { logMw } from "./log.js";

const routes = {
    middlewares: [authMw, logMw],
};`;
        const output = removeMiddlewares(input);
        expect(output).not.toContain("authMw");
        expect(output).not.toContain("logMw");
        expect(output).not.toContain("middlewares");
    });

    // The `middlewares` property is server-only config: it must never reach the
    // client bundle, whatever shape its value has. Each case below used to leak
    // because the identifier scan drove the whole transform.

    it("removes the property when the array only spreads", () => {
        const input = `import { common } from "./common.js";

const routes = {
    middlewares: [...common],
};`;
        const output = removeMiddlewares(input);
        expect(output).not.toContain("middlewares");
        expect(output).not.toContain("common");
    });

    it("removes the property when the value is a call expression", () => {
        const input = `import { getMws } from "./common.js";

const routes = {
    middlewares: getMws(),
};`;
        const output = removeMiddlewares(input);
        expect(output).not.toContain("middlewares");
        expect(output).not.toContain("getMws");
    });

    it("removes namespace-imported middlewares", () => {
        const input = `import * as mw from "./middleware.js";

const routes = {
    middlewares: [mw.auth],
};`;
        const output = removeMiddlewares(input);
        expect(output).not.toContain("middlewares");
        expect(output).not.toContain("mw");
    });

    it("removes default-imported middlewares", () => {
        const input = `import auth from "./auth.middleware.js";

const routes = {
    middlewares: [auth],
};`;
        const output = removeMiddlewares(input);
        expect(output).not.toContain("middlewares");
        expect(output).not.toContain("auth.middleware.js");
    });

    it("removes mixed identifier + spread, dropping both imports", () => {
        const input = `import { auth, common } from "./mw.js";

const routes = {
    middlewares: [auth, ...common],
};`;
        const output = removeMiddlewares(input);
        expect(output).not.toContain("middlewares");
        expect(output).not.toContain("auth");
        expect(output).not.toContain("common");
    });

    it("keeps a middleware import that is still referenced elsewhere", () => {
        // Stripping unconditionally would leave `auth` referenced but unbound.
        const input = `import { auth } from "./auth.js";

const routes = {
    middlewares: [auth],
};

export const stillUsed = auth;`;
        const output = removeMiddlewares(input);
        expect(output).not.toContain("middlewares");
        expect(output).toContain(`import { auth } from "./auth.js"`);
        expect(output).toContain("export const stillUsed = auth");
    });
});

// ============================================
// transformStreamsForClient
// ============================================

describe("transformStreamsForClient", () => {
    it("replaces createEventStream call with stub object", () => {
        const input = `
import { createEventStream } from "@mauroandre/velojs";

export const stream_progress = createEventStream({
    channel: (c) => c.req.param("id"),
});
`;
        const output = transformStreamsForClient(input, "admin/Deploy");

        expect(output).toContain("__isVeloEventStream: true");
        expect(output).toContain("__path: \"/_event/admin/Deploy/progress\"");
        // Body of createEventStream should be gone from the export expression
        expect(output).not.toMatch(/stream_progress\s*=\s*createEventStream\s*\(/);
    });

    it("transforms multiple stream_* exports in same file", () => {
        const input = `
export const stream_foo = createEventStream({});
export const stream_bar = createEventStream({});
`;
        const output = transformStreamsForClient(input, "pages/Multi");

        expect(output).toContain("__path: \"/_event/pages/Multi/foo\"");
        expect(output).toContain("__path: \"/_event/pages/Multi/bar\"");
    });

    it("ignores non-stream exports", () => {
        const input = `
export const stream_keep = createEventStream({ channel: (c) => "x" });
export const helper = () => 42;
export const SomeComponent = () => null;
`;
        const output = transformStreamsForClient(input, "x/Y");

        expect(output).toContain("__path: \"/_event/x/Y/keep\"");
        // Non-stream exports must remain
        expect(output).toContain("helper");
        expect(output).toContain("SomeComponent");
    });

    it("strips type annotations from the declarator id", () => {
        const input = `
export const stream_typed: EventStream<MyEvent> = createEventStream<MyEvent>({});
`;
        const output = transformStreamsForClient(input, "pages/Typed");

        expect(output).toContain("__path: \"/_event/pages/Typed/typed\"");
        // The result should have the stub literal
        expect(output).toContain("__isVeloEventStream: true");
    });

    it("does nothing when there are no stream_* exports", () => {
        const input = `
export const Component = () => null;
export const action_save = async () => ({ ok: true });
`;
        const output = transformStreamsForClient(input, "pages/X");
        expect(output).toContain("Component");
        expect(output).toContain("action_save");
        expect(output).not.toContain("__isVeloEventStream");
    });
});

// ============================================
// removeEndpointRoutes
// ============================================

describe("removeEndpointRoutes", () => {
    it("removes object with handler property (module-only handler)", () => {
        const input = `import { githubWebhook } from "./webhooks/github.js";
import * as Home from "./pages/Home.js";

export default [
    { path: "/", module: Home },
    { path: "/api/github", method: "POST", handler: githubWebhook },
];`;
        const output = removeEndpointRoutes(input);
        expect(output).not.toContain("githubWebhook");
        expect(output).not.toContain("/api/github");
        expect(output).not.toContain("handler");
        expect(output).toContain("Home");
    });

    it("removes inline arrow-function handler", () => {
        const input = `import * as Home from "./pages/Home.js";

export default [
    { path: "/", module: Home },
    { path: "/health", method: "GET", handler: ({ c }) => c.text("ok") },
];`;
        const output = removeEndpointRoutes(input);
        expect(output).toContain("Home");
        expect(output).not.toContain("/health");
        expect(output).not.toContain("handler");
    });

    it("cleans up import that was only used by the removed endpoint", () => {
        const input = `import { pixWebhook } from "./webhooks/pix.js";
import * as Home from "./pages/Home.js";

export default [
    { path: "/", module: Home },
    { path: "/api/pix", method: "POST", handler: pixWebhook },
];`;
        const output = removeEndpointRoutes(input);
        expect(output).not.toContain("pixWebhook");
        expect(output).not.toContain(`"./webhooks/pix.js"`);
        expect(output).toContain("Home");
    });

    it("keeps import that is still used by a page after endpoint removal", () => {
        const input = `import { shared } from "./shared.js";
import * as Home from "./pages/Home.js";

const base = shared();

export default [
    { path: "/", module: Home },
    { path: "/api/x", method: "POST", handler: shared },
];`;
        const output = removeEndpointRoutes(input);
        expect(output).toContain("shared");
        expect(output).toContain(`"./shared.js"`);
    });

    it("preserves grouping nodes (path + children only)", () => {
        const input = `import { mw } from "./mw.js";
import * as User from "./pages/User.js";

export default [
    { path: "/api", middlewares: [mw], children: [
        { path: "/user", module: User },
        { path: "/webhook", method: "POST", handler: () => new Response() },
    ]},
];`;
        const output = removeEndpointRoutes(input);
        expect(output).toContain("/api");
        expect(output).toContain("/user");
        expect(output).toContain("User");
        expect(output).not.toContain("/webhook");
        expect(output).not.toContain("handler");
    });

    it("removes endpoint nested inside children array", () => {
        const input = `import { adminWebhook } from "./admin.js";
import * as Admin from "./pages/Admin.js";

export default [
    { path: "/admin", children: [
        { path: "/", module: Admin },
        { path: "/webhook", method: "POST", handler: adminWebhook },
    ]},
];`;
        const output = removeEndpointRoutes(input);
        expect(output).not.toContain("adminWebhook");
        expect(output).not.toContain(`"./admin.js"`);
        expect(output).toContain("Admin");
    });

    it("is a no-op when routes have no endpoints", () => {
        const input = `import * as Home from "./pages/Home.js";

export default [
    { path: "/", module: Home },
];`;
        const output = removeEndpointRoutes(input);
        expect(output).toBe(input);
    });

    it("handles `satisfies AppRoutes` type annotation", () => {
        const input = `import type { AppRoutes } from "@mauroandre/velojs";
import { webhook } from "./webhook.js";
import * as Home from "./pages/Home.js";

export default [
    { path: "/", module: Home },
    { path: "/api", method: "POST", handler: webhook },
] satisfies AppRoutes;`;
        const output = removeEndpointRoutes(input);
        expect(output).not.toContain("webhook");
        expect(output).not.toContain(`"./webhook.js"`);
        expect(output).toContain("Home");
    });

    it("handles `as AppRoutes` type cast", () => {
        const input = `import type { AppRoutes } from "@mauroandre/velojs";
import { webhook } from "./webhook.js";
import * as Home from "./pages/Home.js";

export default [
    { path: "/", module: Home },
    { path: "/api", method: "POST", handler: webhook },
] as AppRoutes;`;
        const output = removeEndpointRoutes(input);
        expect(output).not.toContain("webhook");
        expect(output).toContain("Home");
    });

    it("keeps non-endpoint imports from same source", () => {
        const input = `import { webhook, helper } from "./utils.js";
import * as Home from "./pages/Home.js";

const compute = helper();

export default [
    { path: "/", module: Home },
    { path: "/api", method: "POST", handler: webhook },
];`;
        const output = removeEndpointRoutes(input);
        expect(output).not.toContain("webhook");
        expect(output).toContain("helper");
    });

    it("removes multiple endpoints at different tree levels", () => {
        const input = `import { a } from "./a.js";
import { b } from "./b.js";
import * as Home from "./pages/Home.js";

export default [
    { path: "/", module: Home },
    { path: "/api/a", method: "POST", handler: a },
    { path: "/sub", children: [
        { path: "/b", method: "GET", handler: b },
    ]},
];`;
        const output = removeEndpointRoutes(input);
        expect(output).not.toContain(`"./a.js"`);
        expect(output).not.toContain(`"./b.js"`);
        expect(output).not.toContain("/api/a");
        expect(output).not.toContain("/b");
        expect(output).toContain("Home");
        expect(output).toContain("/sub");
    });
});

// ============================================
// transformSocketsForClient
// ============================================

describe("transformSocketsForClient", () => {
    it("replaces async socket handler with a stub object", () => {
        const input = `
export const socket_terminal = async ({ incoming, send }) => {
    const session = openPtySession();
    for await (const msg of incoming) session.write(msg);
};
`;
        const output = transformSocketsForClient(input, "workers/Terminal");
        expect(output).toContain("__isVeloSocket: true");
        expect(output).toContain(`__path: "/_socket/workers/Terminal/terminal"`);
        expect(output).not.toMatch(/socket_terminal\s*=\s*async/);
        expect(output).not.toContain("openPtySession");
    });

    it("transforms multiple socket_* exports", () => {
        const input = `
export const socket_foo = async () => {};
export const socket_bar = async () => {};
`;
        const output = transformSocketsForClient(input, "pages/Multi");
        expect(output).toContain(`__path: "/_socket/pages/Multi/foo"`);
        expect(output).toContain(`__path: "/_socket/pages/Multi/bar"`);
    });

    it("ignores non-socket exports", () => {
        const input = `
export const socket_keep = async () => {};
export const helper = () => 42;
export const Component = () => null;
`;
        const output = transformSocketsForClient(input, "x/Y");
        expect(output).toContain(`__path: "/_socket/x/Y/keep"`);
        expect(output).toContain("helper");
        expect(output).toContain("Component");
    });

    it("strips type annotation from the declarator id", () => {
        const input = `
export const socket_typed: SocketHandler = async ({ send }) => {};
`;
        const output = transformSocketsForClient(input, "pages/Typed");
        expect(output).toContain(`__path: "/_socket/pages/Typed/typed"`);
        expect(output).toContain("__isVeloSocket: true");
    });
});

// ============================================
// pruneClientOnlyImports
// ============================================

describe("pruneClientOnlyImports", () => {
    it("drops an import orphaned by a stubbed stream channel resolver", () => {
        // Mirrors the real vite-8 leak: a server-only `channel` resolver is
        // imported top-level, then becomes orphan once the stream is stubbed.
        const input = `
import { ownAppChannel } from "../modules/app/app.stream.js";
import { useState } from "preact/hooks";
export const stream_backup = { __isVeloEventStream: true, __path: "/_event/x/backup" };
export const Component = () => { const [n] = useState(0); return null; };
`;
        const output = pruneClientOnlyImports(input);
        expect(output).not.toContain("app.stream");
        expect(output).not.toContain("ownAppChannel");
        // Still-used import survives.
        expect(output).toContain("useState");
    });

    it("removes only the orphaned specifiers, keeping used ones from same import", () => {
        const input = `
import { gone, kept } from "./mixed.js";
export const value = kept;
`;
        const output = pruneClientOnlyImports(input);
        expect(output).toContain("kept");
        expect(output).not.toMatch(/\bgone\b/);
        // The import line itself stays (kept is still imported).
        expect(output).toContain("./mixed.js");
    });

    it("keeps a component imported only via JSX", () => {
        const input = `
import { Card } from "./Card.js";
export const Component = () => <Card />;
`;
        const output = pruneClientOnlyImports(input);
        expect(output).toContain("Card");
        expect(output).toContain("./Card.js");
    });

    it("keeps a type imported only in a type position", () => {
        const input = `
import type { User } from "./user.types.js";
export const Component = (props: { user: User }) => null;
`;
        const output = pruneClientOnlyImports(input);
        expect(output).toContain("User");
        expect(output).toContain("./user.types.js");
    });

    it("preserves side-effect imports (no specifiers)", () => {
        const input = `
import "./styles.css";
import { gone } from "./gone.js";
export const Component = () => null;
`;
        const output = pruneClientOnlyImports(input);
        expect(output).toContain("./styles.css");
        expect(output).not.toContain("./gone.js");
    });

    it("returns code unchanged when nothing is orphaned", () => {
        const input = `import { a } from "./a.js";\nexport const x = a;\n`;
        const output = pruneClientOnlyImports(input);
        expect(output).toContain("./a.js");
        expect(output).toContain("a");
    });

    it("keeps a namespace import used via member access", () => {
        const input = `
import * as css from "./X.css.js";
export const Component = () => css.root;
`;
        const output = pruneClientOnlyImports(input);
        expect(output).toContain("./X.css.js");
        expect(output).toContain("css");
    });
});
