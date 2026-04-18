import { describe, it, expect } from "vitest";
import {
    injectMetadata,
    transformLoaderFunctions,
    transformActionsForClient,
    transformStreamsForClient,
    removeLoaders,
    removeMiddlewares,
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
