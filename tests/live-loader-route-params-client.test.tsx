// @vitest-environment jsdom
/**
 * Live loader — route params on the client (slice 4), jsdom.
 *
 * jsdom has no `EventSource`, so these tests install a fake one that records the
 * URL and lets the test dispatch the server's events. Everything is
 * deterministic: no timers, no waiting.
 *
 * What the client does here is **declare** the address it is already seeing:
 * it extracts the params the module's route declares (the module's `fullPath`
 * matches the pathname as a prefix, so a layout with `:params` covers a child's
 * URL) and sends them in the connection's `?_route=`. The connection is keyed
 * by those params, never by the pathname.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/preact";
import { ClientRoutes } from "../src/client.js";
import { ChannelBoundary, channelRouteParams, __resetLiveLoader } from "../src/live-loader.js";
import { loaderEntry, __resetLoaderStore } from "../src/loader-store.js";
import type { AppRoutes } from "../src/types.js";

// ============================================
// Fake EventSource
// ============================================

type Listener = (event: { data?: string | undefined }) => void;

class FakeEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    static instances: FakeEventSource[] = [];

    url: string;
    readyState = FakeEventSource.OPEN;
    closed = false;
    private listeners = new Map<string, Set<Listener>>();

    constructor(url: string) {
        this.url = url;
        FakeEventSource.instances.push(this);
    }

    addEventListener(type: string, fn: Listener): void {
        let set = this.listeners.get(type);
        if (!set) {
            set = new Set();
            this.listeners.set(type, set);
        }
        set.add(fn);
    }

    close(): void {
        this.closed = true;
        this.readyState = FakeEventSource.CLOSED;
    }

    emit(type: string, data?: string): void {
        for (const fn of this.listeners.get(type) ?? []) fn({ data });
    }
}

/** The connection URL of a module: `?_route=` carries the declared params. */
function channelUrl(moduleId: string, channel: string, params?: Record<string, string>): string {
    const base = `/_channel/${encodeURI(moduleId)}/${encodeURIComponent(channel)}`;
    return params ? `${base}?_route=${encodeURIComponent(JSON.stringify(params))}` : base;
}

beforeEach(() => {
    (window as any).__PAGE_DATA__ = {};
    (globalThis as any).__VELO_STATIC__ = false;
    FakeEventSource.instances = [];
    (globalThis as any).EventSource = FakeEventSource;
    __resetLoaderStore();
    __resetLiveLoader();
});

afterEach(() => {
    cleanup();
    delete (globalThis as any).EventSource;
    window.history.pushState({}, "", "/");
});

function navigate(path: string) {
    window.history.pushState({}, "", path);
}

// ============================================
// Extraction — the module's fullPath as a prefix (CA13)
// ============================================

describe("live loader — params extraction", () => {
    it("extracts the params of a layout from a child's pathname — prefix match (CA13)", () => {
        expect(channelRouteParams("/projeto/:id", "/projeto/7/sala")).toEqual({ id: "7" });
        expect(channelRouteParams("/projeto/:id", "/projeto/7")).toEqual({ id: "7" });
        expect(channelRouteParams("/projeto/:id/:room", "/projeto/7/sala")).toEqual({
            id: "7",
            room: "sala",
        });
    });

    it("a catch-all declares no key — empty params, the channel travels by principal", () => {
        expect(channelRouteParams("/docs/*", "/docs/a")).toEqual({});
        expect(channelRouteParams("/docs/*", "/docs/a/b")).toEqual({});
    });

    it("a pathname outside the module's route yields no params", () => {
        expect(channelRouteParams("/projeto/:id", "/outro/7")).toEqual({});
        expect(channelRouteParams(undefined, "/projeto/7")).toEqual({});
    });

    it("a layout with params opens its connection with the prefix params, under a child URL (CA13)", () => {
        navigate("/projeto/7/sala");
        render(
            <ChannelBoundary
                moduleId="projeto/Layout"
                channels={["projetoArquivos"]}
                fullPath="/projeto/:id"
            >
                <div />
            </ChannelBoundary>,
        );

        expect(FakeEventSource.instances.map((i) => i.url)).toEqual([
            channelUrl("projeto/Layout", "projetoArquivos", { id: "7" }),
        ]);

        // The snapshot on connect is the resource the connection declared.
        act(() =>
            FakeEventSource.instances[0]!.emit(
                "snapshot",
                JSON.stringify({ id: "7", files: ["a.txt"] }),
            ),
        );
        expect(loaderEntry("projeto/Layout").value).toEqual({ id: "7", files: ["a.txt"] });
    });
});

// ============================================
// Keyed by params — not by pathname (CA7)
// ============================================

describe("live loader — the connection is keyed by the declared params", () => {
    it("moves to another resource: the old connection closes and a new one opens (CA7)", () => {
        navigate("/projeto/7");
        render(
            <ChannelBoundary
                moduleId="projeto/Projeto"
                channels={["projetoArquivos"]}
                fullPath="/projeto/:id"
            >
                <div />
            </ChannelBoundary>,
        );

        expect(FakeEventSource.instances.map((i) => i.url)).toEqual([
            channelUrl("projeto/Projeto", "projetoArquivos", { id: "7" }),
        ]);

        act(() => navigate("/projeto/9"));

        expect(FakeEventSource.instances).toHaveLength(2);
        expect(FakeEventSource.instances[0]!.closed).toBe(true);
        expect(FakeEventSource.instances[1]!.url).toBe(
            channelUrl("projeto/Projeto", "projetoArquivos", { id: "9" }),
        );

        // The new connection's snapshot is the data of the new resource.
        act(() =>
            FakeEventSource.instances[1]!.emit("snapshot", JSON.stringify({ id: "9" })),
        );
        expect(loaderEntry("projeto/Projeto").value).toEqual({ id: "9" });
    });

    it("does not reconnect between children of the same params (CA7)", () => {
        navigate("/projeto/9");
        render(
            <ChannelBoundary
                moduleId="projeto/Layout"
                channels={["projetoArquivos"]}
                fullPath="/projeto/:id"
            >
                <div />
            </ChannelBoundary>,
        );
        expect(FakeEventSource.instances).toHaveLength(1);

        act(() => navigate("/projeto/9/sala"));
        expect(FakeEventSource.instances).toHaveLength(1);
        expect(FakeEventSource.instances[0]!.closed).toBe(false);

        act(() => navigate("/projeto/9/sala/editar"));
        expect(FakeEventSource.instances).toHaveLength(1);
        expect(FakeEventSource.instances[0]!.closed).toBe(false);
    });

    it("navigating inside the same params keeps the connection alive (CA7)", () => {
        navigate("/projeto/9");
        render(
            <ChannelBoundary
                moduleId="projeto/Projeto"
                channels={["projetoArquivos"]}
                fullPath="/projeto/:id"
            >
                <div />
            </ChannelBoundary>,
        );
        const es = FakeEventSource.instances[0]!;

        act(() => navigate("/projeto/9/"));
        expect(es.closed).toBe(false);
        expect(FakeEventSource.instances).toHaveLength(1);
    });

    it("a module without :params opens its connection without `?_route=` — unchanged (CA9)", () => {
        navigate("/expenses");
        render(
            <ChannelBoundary
                moduleId="expenses/Expenses"
                channels={["teamExpenses"]}
                fullPath="/expenses"
            >
                <div />
            </ChannelBoundary>,
        );

        expect(FakeEventSource.instances.map((i) => i.url)).toEqual([
            "/_channel/expenses/Expenses/teamExpenses",
        ]);
    });

    it("a catch-all module opens without `?_route=` — no key to declare", () => {
        navigate("/docs/a");
        render(
            <ChannelBoundary moduleId="docs/Doc" channels={["principal"]} fullPath="/docs/*">
                <div />
            </ChannelBoundary>,
        );

        expect(FakeEventSource.instances.map((i) => i.url)).toEqual([
            "/_channel/docs/Doc/principal",
        ]);
    });
});

// ============================================
// The route tree wires the fullPath (CA13)
// ============================================

describe("live loader — the route tree passes the module's fullPath", () => {
    it("a layout with :params opened under a child's URL declares the prefix params (CA13)", () => {
        navigate("/projeto/7/sala");

        const Shell = ({ children }: any) => <div>{children}</div>;
        const Layout = ({ children }: any) => <div>{children}</div>;
        const Room = () => null;

        const routes: AppRoutes = [
            {
                module: {
                    Component: Shell,
                    metadata: { moduleId: "projeto/Root", fullPath: "" },
                },
                isRoot: true,
                children: [
                    {
                        path: "/projeto/:id",
                        module: {
                            Component: Layout,
                            metadata: {
                                moduleId: "projeto/Layout",
                                fullPath: "/projeto/:id",
                            },
                            channels: ["projetoArquivos"],
                        },
                        children: [
                            {
                                path: "sala",
                                module: {
                                    Component: Room,
                                    metadata: {
                                        moduleId: "projeto/Sala",
                                        fullPath: "/projeto/:id/sala",
                                    },
                                },
                            },
                        ],
                    },
                ],
            },
        ];

        render(<ClientRoutes routes={routes} />);

        expect(FakeEventSource.instances.map((i) => i.url)).toEqual([
            channelUrl("projeto/Layout", "projetoArquivos", { id: "7" }),
        ]);
    });
});