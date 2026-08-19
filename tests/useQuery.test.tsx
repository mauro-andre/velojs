// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/preact";
import { ClientRoutes } from "../src/client.js";
import { useLoader, useQuery } from "../src/hooks.js";
import { __resetLoaderStore } from "../src/loader-store.js";
import type { AppRoutes, RouteModule } from "../src/types.js";

const mockFetch = vi.fn();
global.fetch = mockFetch as any;
(globalThis as any).__VELO_STATIC__ = false;
(globalThis as any).__VELO_BUILD_HASH__ = "test";

function makeModule(opts: {
    moduleId: string;
    fullPath: string;
    Component?: any;
}): RouteModule {
    return {
        Component: opts.Component ?? (() => null),
        metadata: { moduleId: opts.moduleId, fullPath: opts.fullPath, path: opts.fullPath },
    } as RouteModule;
}

const navigate = async (path: string) => {
    await act(async () => {
        window.history.pushState({}, "", path);
        window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
    });
};

const buildRoutes = (component: any): AppRoutes => [
    {
        module: makeModule({ moduleId: "Root", fullPath: "" }),
        isRoot: true,
        children: [
            {
                path: "/leads",
                module: makeModule({ moduleId: "Leads", fullPath: "/leads", Component: component }),
            },
        ],
    },
];

beforeEach(() => {
    mockFetch.mockReset();
    (window as any).__PAGE_DATA__ = {};
    __resetLoaderStore();
    window.history.pushState({}, "", "/leads?tab=a");
});
afterEach(() => cleanup());

describe("useQuery — client navigation", () => {
    it("reflects query-only navigation instead of staying pinned to the SSR query", async () => {
        // Bug: the client branch returned __PAGE_DATA__.__query — injected once
        // at SSR — forever. Query-only navigation never surfaced new values.
        (window as any).__PAGE_DATA__ = { __query: { tab: "a" } };

        const seen: (string | undefined)[] = [];
        const Probe = () => {
            const query = useQuery<{ tab?: string }>();
            seen.push(query.tab);
            return null;
        };

        render(<ClientRoutes routes={buildRoutes(Probe)} />);
        expect(seen[seen.length - 1]).toBe("a");

        await navigate("/leads?tab=b");
        expect(seen[seen.length - 1]).toBe("b");
    });

    it("useLoader([query.x]) refetches on query-only navigation — the pattern the skill teaches", async () => {
        // The user-visible consequence: deps driven by useQuery never changed,
        // so the loader silently never re-ran.
        (window as any).__PAGE_DATA__ = { __query: { tab: "a" }, Leads: { items: ["a"] } };
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ Leads: { items: ["b"] } }),
        });

        let loaderData: any = null;
        const Probe = () => {
            const query = useQuery<{ tab?: string }>();
            const { data } = useLoader<{ items: string[] }>("Leads", [query.tab]);
            loaderData = data;
            return null;
        };

        render(<ClientRoutes routes={buildRoutes(Probe)} />);
        mockFetch.mockClear();

        await navigate("/leads?tab=b");

        expect(mockFetch).toHaveBeenCalled();
        expect(loaderData.value).toEqual({ items: ["b"] });
    });
});
