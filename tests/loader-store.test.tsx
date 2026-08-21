// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/preact";
import { ClientRoutes } from "../src/client.js";
import { Loader, useLoader, touch } from "../src/hooks.js";
import { __resetLoaderStore, extractParams } from "../src/loader-store.js";
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

beforeEach(() => {
    mockFetch.mockReset();
    (window as any).__PAGE_DATA__ = {};
    __resetLoaderStore();
    window.history.pushState({}, "", "/");
});
afterEach(() => cleanup());

// ============================================
// extractParams — the rule's primitive
// ============================================

describe("extractParams", () => {
    it("returns no params for a pattern that declares none", () => {
        expect(extractParams("/admin/empresas", "/admin/empresas")).toEqual({});
    });

    it("matches a layout pattern as a prefix of a deeper URL", () => {
        // /admin/empresas/:companyId is a layout — the URL goes deeper.
        expect(extractParams("/admin/empresas/:companyId", "/admin/empresas/B/info")).toEqual({
            companyId: "B",
        });
    });

    it("returns {} — not null — for a param-less pattern covering a deeper URL", () => {
        expect(extractParams("/admin/empresas", "/admin/empresas/B/info")).toEqual({});
    });

    it("returns null when the pattern does not cover the URL", () => {
        expect(extractParams("/admin/empresas/:companyId", "/admin/consultores")).toBeNull();
    });

    it("exact mode: a leaf matches its own URL but nothing deeper", () => {
        expect(extractParams("/leads", "/leads", true)).toEqual({});
        expect(extractParams("/leads", "/leads/1", true)).toBeNull();
    });

    it("exact mode: params are extracted and trailing slash is tolerated", () => {
        expect(extractParams("/leads/:id", "/leads/42", true)).toEqual({ id: "42" });
        expect(extractParams("/leads/:id", "/leads/42/", true)).toEqual({ id: "42" });
    });

    it("exact mode: the root leaf matches only `/`", () => {
        expect(extractParams("/", "/", true)).toEqual({});
        expect(extractParams("/", "/leads", true)).toBeNull();
    });

    it("covers everything for a path-less wrapper", () => {
        expect(extractParams("", "/anything/at/all")).toEqual({});
    });
});

// ============================================
// The store, driven through a real route tree
// ============================================

describe("loader store — navigation", () => {
    // /admin/empresas          → CompaniesLayout (no params: holds a filtered list)
    // /admin/empresas/:id      → CompanyDetail   (param: must refresh on id change)
    // /admin/empresas/:id/info → CompanyInfo
    const buildTree = () => {
        const layout = makeModule({
            moduleId: "CompaniesLayout",
            fullPath: "/admin/empresas",
            Component: ({ children }: any) => <div>{children}</div>,
        });
        const detail = makeModule({
            moduleId: "CompanyDetail",
            fullPath: "/admin/empresas/:companyId",
            Component: ({ children }: any) => <div>{children}</div>,
        });
        const info = makeModule({
            moduleId: "CompanyInfo",
            fullPath: "/admin/empresas/:companyId/info",
        });
        const routes: AppRoutes = [
            {
                module: makeModule({ moduleId: "Root", fullPath: "" }),
                isRoot: true,
                children: [
                    {
                        path: "/admin/empresas",
                        module: layout,
                        children: [
                            {
                                path: "/:companyId",
                                module: detail,
                                children: [{ path: "/info", module: info }],
                            },
                        ],
                    },
                ],
            },
        ];
        return routes;
    };

    it("refreshes an entry whose declared param changed", async () => {
        (window as any).__PAGE_DATA__ = {
            CompaniesLayout: { companies: ["all"] },
            CompanyDetail: { company: "A" },
        };
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ CompanyDetail: { company: "B" } }),
        });

        window.history.pushState({}, "", "/admin/empresas/A/info");
        render(<ClientRoutes routes={buildTree()} />);

        const { data: detailData } = Loader<{ company: string }>("CompanyDetail");
        expect(detailData.value).toEqual({ company: "A" });

        await navigate("/admin/empresas/B/info");

        expect(mockFetch).toHaveBeenCalled();
        expect(detailData.value).toEqual({ company: "B" });
    });

    it("leaves a param-less entry alone — client-owned state survives navigation", async () => {
        // This is the filter case: the layout's route declares no param, so a
        // navigation below it must never overwrite what the client put there.
        (window as any).__PAGE_DATA__ = {
            CompaniesLayout: { companies: ["all"] },
            CompanyDetail: { company: "A" },
        };
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                CompaniesLayout: { companies: ["all"] }, // server has no idea about the filter
                CompanyDetail: { company: "B" },
            }),
        });

        window.history.pushState({}, "", "/admin/empresas/A/info");
        render(<ClientRoutes routes={buildTree()} />);

        const { data: layoutData } = Loader<{ companies: string[] }>("CompaniesLayout");
        // The user filters — client-only state the server cannot know.
        layoutData.value = { companies: ["filtered"] };

        await navigate("/admin/empresas/B/info");

        // The response carried CompaniesLayout, but the store must not write it.
        expect(layoutData.value).toEqual({ companies: ["filtered"] });
    });

    it("does not refetch when the declared param is unchanged", async () => {
        (window as any).__PAGE_DATA__ = { CompanyDetail: { company: "A" } };
        mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

        window.history.pushState({}, "", "/admin/empresas/A/info");
        render(<ClientRoutes routes={buildTree()} />);
        mockFetch.mockClear();

        // Same company, different tab → CompanyDetail's param did not move.
        await navigate("/admin/empresas/A/outra");

        const calls = mockFetch.mock.calls.length;
        expect(calls).toBe(0);
    });

    it("refetches a param-less page that unmounted and remounted (return navigation)", async () => {
        // Report: `/` (Dashboard, no params) → `/leads` → back to `/` served the
        // SSR cache forever — no `?_data=1` was ever requested. A page that
        // remounts must revalidate, exactly like a page whose params moved.
        const routes: AppRoutes = [
            {
                module: makeModule({ moduleId: "Root", fullPath: "" }),
                isRoot: true,
                children: [
                    { path: "/", module: makeModule({ moduleId: "Dashboard", fullPath: "/" }) },
                    { path: "/leads", module: makeModule({ moduleId: "Leads", fullPath: "/leads" }) },
                ],
            },
        ];
        (window as any).__PAGE_DATA__ = { Dashboard: { count: 1 } };
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ Dashboard: { count: 2 } }),
        });

        render(<ClientRoutes routes={routes} />);
        mockFetch.mockClear();

        await navigate("/leads");
        await navigate("/");

        expect(mockFetch).toHaveBeenCalled();
        expect(Loader<any>("Dashboard").data.value).toEqual({ count: 2 });
    });

    it("refetches a param-less leaf reached from a param page (and vice versa)", async () => {
        // The report's contrast cases: `/leads/2` → `/leads` and `/leads` →
        // `/leads/1` must both refetch — the leaf on the other side remounted.
        const routes: AppRoutes = [
            {
                module: makeModule({ moduleId: "Root", fullPath: "" }),
                isRoot: true,
                children: [
                    { path: "/leads", module: makeModule({ moduleId: "Leads", fullPath: "/leads" }) },
                    {
                        path: "/leads/:id",
                        module: makeModule({
                            moduleId: "LeadDetail",
                            fullPath: "/leads/:id",
                            Component: () => { useLoader("LeadDetail"); return null; },
                        }),
                    },
                ],
            },
        ];
        (window as any).__PAGE_DATA__ = { Leads: { items: ["a"] } };
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ Leads: { items: ["b"] }, LeadDetail: { id: "1" } }),
        });

        window.history.pushState({}, "", "/leads");
        render(<ClientRoutes routes={routes} />);
        mockFetch.mockClear();

        await navigate("/leads/1");
        expect(mockFetch).toHaveBeenCalled();

        mockFetch.mockClear();
        await navigate("/leads");
        expect(mockFetch).toHaveBeenCalled();
        expect(Loader<any>("Leads").data.value).toEqual({ items: ["b"] });
    });

    it("does not refetch when navigating to the same URL (no remount, no param change)", async () => {
        const routes: AppRoutes = [
            {
                module: makeModule({ moduleId: "Root", fullPath: "" }),
                isRoot: true,
                children: [
                    { path: "/leads", module: makeModule({ moduleId: "Leads", fullPath: "/leads" }) },
                ],
            },
        ];
        (window as any).__PAGE_DATA__ = { Leads: { items: ["a"] } };
        mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

        window.history.pushState({}, "", "/leads");
        render(<ClientRoutes routes={routes} />);
        mockFetch.mockClear();

        await navigate("/leads");
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("refetches a layout that unmounted and remounted (left the subtree and came back)", async () => {
        // The remount rule applies to layouts too: staying among children keeps
        // the cache, but leaving the subtree and returning must revalidate.
        const routes: AppRoutes = [
            {
                module: makeModule({ moduleId: "Root", fullPath: "" }),
                isRoot: true,
                children: [
                    {
                        path: "/admin",
                        module: makeModule({ moduleId: "AdminLayout", fullPath: "/admin" }),
                        children: [
                            { path: "/users", module: makeModule({ moduleId: "Users", fullPath: "/admin/users" }) },
                        ],
                    },
                    { path: "/public", module: makeModule({ moduleId: "Public", fullPath: "/public" }) },
                ],
            },
        ];
        (window as any).__PAGE_DATA__ = {
            AdminLayout: { me: "v1" },
            Users: { list: [1] },
        };
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ AdminLayout: { me: "v2" }, Users: { list: [2] } }),
        });

        window.history.pushState({}, "", "/admin/users");
        render(<ClientRoutes routes={routes} />);
        mockFetch.mockClear();

        await navigate("/public");
        expect(mockFetch).not.toHaveBeenCalled(); // nothing matched-and-stale there

        await navigate("/admin/users");
        expect(mockFetch).toHaveBeenCalled();
        expect(Loader<any>("AdminLayout").data.value).toEqual({ me: "v2" });
    });

    it("keeps a layout's client-owned state while navigating among its children", async () => {
        // The remount rule must NOT fire here: the layout stays matched the
        // whole time, so its entry is never stale.
        const routes: AppRoutes = [
            {
                module: makeModule({ moduleId: "Root", fullPath: "" }),
                isRoot: true,
                children: [
                    {
                        path: "/admin",
                        module: makeModule({ moduleId: "AdminLayout", fullPath: "/admin" }),
                        children: [
                            { path: "/users", module: makeModule({ moduleId: "Users", fullPath: "/admin/users" }) },
                            { path: "/roles", module: makeModule({ moduleId: "Roles", fullPath: "/admin/roles" }) },
                        ],
                    },
                ],
            },
        ];
        (window as any).__PAGE_DATA__ = {
            AdminLayout: { me: "v1" },
            Users: { list: [1] },
        };
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ AdminLayout: { me: "server" }, Roles: { list: [] } }),
        });

        window.history.pushState({}, "", "/admin/users");
        render(<ClientRoutes routes={routes} />);

        const { data: layoutData } = Loader<any>("AdminLayout");
        layoutData.value = { me: "client-owned" };
        mockFetch.mockClear();

        await navigate("/admin/roles");

        // The response carried AdminLayout, but the store must not write it.
        expect(layoutData.value).toEqual({ me: "client-owned" });
    });

    it("hard-navigates on a __redirect answer instead of writing loader data", async () => {
        // A loader short-circuited with a redirect during SPA navigation: the
        // server answers `{ __redirect }` and the client must navigate (full
        // load — server state may have changed), never write entries.
        const routes: AppRoutes = [
            {
                module: makeModule({ moduleId: "Root", fullPath: "" }),
                isRoot: true,
                children: [
                    { path: "/", module: makeModule({ moduleId: "Home", fullPath: "/" }) },
                    {
                        path: "/login",
                        module: makeModule({
                            moduleId: "Login",
                            fullPath: "/login",
                            Component: () => { useLoader("Login"); return null; },
                        }),
                    },
                ],
            },
        ];
        (window as any).__PAGE_DATA__ = { Home: { count: 1 } };
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ __redirect: "/" }),
        });

        render(<ClientRoutes routes={routes} />);
        mockFetch.mockClear();

        await navigate("/login");

        expect(mockFetch).toHaveBeenCalled();
        // Nothing was written: the redirect supersedes any data.
        expect(Loader<any>("Login").data.value).toBeNull();
        expect(Loader<any>("Home").data.value).toEqual({ count: 1 });
        // And the loading flag settled (no spinner stuck on).
        expect(Loader<any>("Login").loading.value).toBe(false);
    });

    it("coalesces one navigation into a single request for many stale entries", async () => {
        (window as any).__PAGE_DATA__ = {
            CompanyDetail: { company: "A" },
            CompanyInfo: { tab: "A" },
        };
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ CompanyDetail: { company: "B" }, CompanyInfo: { tab: "B" } }),
        });

        window.history.pushState({}, "", "/admin/empresas/A/info");
        render(<ClientRoutes routes={buildTree()} />);
        mockFetch.mockClear();

        await navigate("/admin/empresas/B/info");

        // Two entries went stale; one request served both.
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(Loader<any>("CompanyDetail").data.value).toEqual({ company: "B" });
        expect(Loader<any>("CompanyInfo").data.value).toEqual({ tab: "B" });
    });
});

// ============================================
// The shared handle
// ============================================

describe("loader store — shared handle", () => {
    it("Loader and useLoader return the same signal for a module", async () => {
        (window as any).__PAGE_DATA__ = { Layout: { n: 1 } };

        const { data: viaLoader } = Loader<{ n: number }>("Layout");
        let viaHook: any;
        function C() {
            viaHook = useLoader<{ n: number }>("Layout");
            return null;
        }
        render(<C />);

        expect(viaHook.data).toBe(viaLoader);
        expect(viaLoader.value).toEqual({ n: 1 });
    });

    it("a child's touch on the shared handle re-renders without a fetch", async () => {
        (window as any).__PAGE_DATA__ = { Layout: { items: [{ done: false }] } };
        const { data: layoutData } = Loader<{ items: { done: boolean }[] }>("Layout");

        let renders = 0;
        function Child() {
            renders++;
            return <span>{String(layoutData.value?.items[0]?.done)}</span>;
        }
        const { container } = render(<Child />);
        expect(container.textContent).toBe("false");

        await act(async () => {
            layoutData.value!.items[0]!.done = true; // optimistic, mirrors what was saved
            touch(layoutData);
        });

        expect(container.textContent).toBe("true");
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("refetch() asks the server and writes only that module", async () => {
        (window as any).__PAGE_DATA__ = { Layout: { n: 1 }, Other: { n: 1 } };
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ Layout: { n: 2 }, Other: { n: 99 } }),
        });

        const layout = Loader<{ n: number }>("Layout");
        const other = Loader<{ n: number }>("Other");

        await act(async () => {
            layout.refetch();
            await new Promise((r) => setTimeout(r, 10));
        });

        expect(layout.data.value).toEqual({ n: 2 });
        // The response carried Other too — it must not be written.
        expect(other.data.value).toEqual({ n: 1 });
    });
});
