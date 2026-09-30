// @vitest-environment jsdom
/**
 * Live loader — client side (slice 1).
 *
 * jsdom has no `EventSource`, so the tests install a fake one that records the
 * URL and lets the test dispatch the server's events. Everything is
 * deterministic: no timers, no waiting.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/preact";
import { useLoader, Loader } from "../src/hooks.js";
import { ClientRoutes } from "../src/client.js";
import { loaderEntry, __resetLoaderStore } from "../src/loader-store.js";
import { ChannelBoundary, __resetLiveLoader } from "../src/live-loader.js";
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

    /** Dispatches a server event (a snapshot, an error, a close). */
    emit(type: string, data?: string): void {
        for (const fn of this.listeners.get(type) ?? []) fn({ data });
    }
}

const installed = new Map<string, unknown>();

beforeEach(() => {
    (window as any).__PAGE_DATA__ = {};
    (globalThis as any).__VELO_STATIC__ = false;
    FakeEventSource.instances = [];
    installed.set("EventSource", (globalThis as any).EventSource);
    (globalThis as any).EventSource = FakeEventSource;
    __resetLoaderStore();
    __resetLiveLoader();
});

afterEach(() => {
    cleanup();
    (globalThis as any).EventSource = installed.get("EventSource");
    window.history.pushState({}, "", "/");
});

function navigate(path: string) {
    window.history.pushState({}, "", path);
}

// ============================================
// The last mile: snapshot → signal → re-render
// ============================================

describe("live loader — the last mile", () => {
    it("a snapshot replaces the handle's data and re-renders the Component (CA7)", () => {
        let handle: any;
        function Page() {
            handle = useLoader<{ teamTotal: number }>("expenses/Expenses");
            return <div>{handle.data.value?.teamTotal ?? "-"}</div>;
        }

        const { container, unmount } = render(
            <ChannelBoundary moduleId="expenses/Expenses" channels={["teamExpenses"]}>
                <Page />
            </ChannelBoundary>,
        );

        // One connection per (module, channel), at the internal route.
        expect(FakeEventSource.instances).toHaveLength(1);
        const es = FakeEventSource.instances[0]!;
        expect(es.url).toBe("/_channel/expenses/Expenses/teamExpenses");

        // Snapshot on connect.
        act(() => es.emit("snapshot", JSON.stringify({ teamTotal: 5 })));
        expect(handle.data.value).toEqual({ teamTotal: 5 });
        expect(container.textContent).toBe("5");

        // Snapshot of a later emit — same signal, no code from the developer.
        act(() => es.emit("snapshot", JSON.stringify({ teamTotal: 9 })));
        expect(handle.data.value).toEqual({ teamTotal: 9 });
        expect(container.textContent).toBe("9");

        // The same entry the store exposes, and the one Loader() reads.
        expect(loaderEntry("expenses/Expenses").value).toEqual({ teamTotal: 9 });
        expect(Loader("expenses/Expenses").data.value).toEqual({ teamTotal: 9 });

        unmount();
        expect(es.closed).toBe(true);
    });

    it("a malformed snapshot keeps the previous value", () => {
        function Page() {
            useLoader<{ n: number }>("a/B");
            return null;
        }
        render(
            <ChannelBoundary moduleId="a/B" channels={["c"]}>
                <Page />
            </ChannelBoundary>,
        );
        const es = FakeEventSource.instances[0]!;
        act(() => es.emit("snapshot", JSON.stringify({ n: 1 })));
        act(() => es.emit("snapshot", "{not json"));
        expect(loaderEntry("a/B").value).toEqual({ n: 1 });
    });
});

// ============================================
// Slices — the arrival merge (CA4/CA5/CA6)
// ============================================

/**
 * The merge happens on arrival, accumulated and applied on a microtask — this
 * drains that accumulator. Never a timer, never a render.
 */
async function flushSlices(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

interface ExpensesView {
    teamTotal: number;
    lista: string[];
}

describe("live loader — slices", () => {
    function mounted() {
        let handle: any;
        function Page() {
            handle = useLoader<ExpensesView>("expenses/Expenses");
            return (
                <div>
                    {handle.data.value?.teamTotal ?? "-"}|{handle.data.value?.lista?.join(",") ?? ""}
                </div>
            );
        }
        const rendered = render(
            <ChannelBoundary moduleId="expenses/Expenses" channels={["teamExpenses"]}>
                <Page />
            </ChannelBoundary>,
        );
        return { ...rendered, es: FakeEventSource.instances[0]!, handle: () => handle };
    }

    const value = () => loaderEntry<ExpensesView>("expenses/Expenses").value;

    it("merges shallowly by key: the key sent is replaced, the others stay intact (CA4)", async () => {
        const { es, container } = mounted();
        act(() => es.emit("snapshot", JSON.stringify({ teamTotal: 5, lista: ["a", "b"] })));
        expect(container.textContent).toBe("5|a,b");

        act(() => es.emit("slice", JSON.stringify({ teamTotal: 10 })));
        await flushSlices();

        expect(value()).toEqual({ teamTotal: 10, lista: ["a", "b"] });
        expect(container.textContent).toBe("10|a,b");
    });

    it("applies every slice of the same frame — none is lost, the last of a key wins (CA4)", async () => {
        const { es } = mounted();
        act(() => es.emit("snapshot", JSON.stringify({ teamTotal: 5, lista: ["a"] })));

        // Three slices inside one frame: two distinct keys and a repeat.
        act(() => {
            es.emit("slice", JSON.stringify({ teamTotal: 1 }));
            es.emit("slice", JSON.stringify({ lista: ["z"] }));
            es.emit("slice", JSON.stringify({ teamTotal: 2 }));
        });
        await flushSlices();

        expect(value()).toEqual({ teamTotal: 2, lista: ["z"] });
    });

    it("a malformed slice keeps the previous value (CA4)", async () => {
        const { es } = mounted();
        act(() => es.emit("snapshot", JSON.stringify({ teamTotal: 5, lista: ["a"] })));

        act(() => es.emit("slice", "{not json"));
        act(() => es.emit("slice", JSON.stringify([1, 2])));
        act(() => es.emit("slice", JSON.stringify("text")));
        act(() => es.emit("slice"));
        await flushSlices();

        expect(value()).toEqual({ teamTotal: 5, lista: ["a"] });
    });

    it("a snapshot keeps replacing the whole value, in either order with a slice (CA5)", async () => {
        const { es } = mounted();
        act(() => es.emit("snapshot", JSON.stringify({ teamTotal: 1, lista: ["a", "b"] })));

        // Snapshot replaces: the key it does not carry is gone.
        act(() => es.emit("snapshot", JSON.stringify({ teamTotal: 9 })));
        expect(value()).toEqual({ teamTotal: 9 });

        // Snapshot → slice: the merge builds on the snapshot's value.
        act(() => es.emit("slice", JSON.stringify({ lista: ["c"] })));
        await flushSlices();
        expect(value()).toEqual({ teamTotal: 9, lista: ["c"] });

        // Arrival order: a slice then a snapshot — the snapshot replaces.
        act(() => {
            es.emit("slice", JSON.stringify({ teamTotal: 100 }));
            es.emit("snapshot", JSON.stringify({ teamTotal: 7 }));
        });
        await flushSlices();
        expect(value()).toEqual({ teamTotal: 7 });
    });

    it("removal is explicit: an absent key never removes, the whole new list does (CA6)", async () => {
        const { es, container } = mounted();
        act(() => es.emit("snapshot", JSON.stringify({ teamTotal: 5, lista: ["a", "b"] })));
        expect(container.textContent).toBe("5|a,b");

        // A slice that does not mention the list leaves it alone.
        act(() => es.emit("slice", JSON.stringify({ teamTotal: 6 })));
        await flushSlices();
        expect(value()!.lista).toEqual(["a", "b"]);

        // Removing an item is re-sending the key with the new whole list.
        act(() => es.emit("slice", JSON.stringify({ lista: ["a"] })));
        await flushSlices();
        expect(value()).toEqual({ teamTotal: 6, lista: ["a"] });
        expect(container.textContent).toBe("6|a");
    });

    it("a slice marks the connection live again, like a snapshot (CA4)", async () => {
        const { es } = mounted();
        es.readyState = FakeEventSource.CONNECTING;
        act(() => es.emit("error"));
        expect(Loader("expenses/Expenses").freshness.value).toBe("stale");

        act(() => es.emit("slice", JSON.stringify({ teamTotal: 3 })));
        await flushSlices();
        expect(Loader("expenses/Expenses").freshness.value).toBe("live");
    });
});

// ============================================
// Connections in the rendered hierarchy
// ============================================

describe("live loader — connections", () => {
    it("a module without channels opens no connection", () => {
        function Page() {
            useLoader("no/Channels");
            return null;
        }
        render(
            <ChannelBoundary moduleId="no/Channels">
                <Page />
            </ChannelBoundary>,
        );
        expect(FakeEventSource.instances).toHaveLength(0);
        expect(Loader("no/Channels").freshness.value).toBe("live");
    });

    it("a layout and a page declaring the same channel open one connection each", () => {
        function Layout() {
            useLoader("expenses/Layout");
            return null;
        }
        function Page() {
            useLoader("expenses/Expenses");
            return null;
        }
        render(
            <ChannelBoundary moduleId="expenses/Layout" channels={["teamExpenses"]}>
                <ChannelBoundary moduleId="expenses/Expenses" channels={["teamExpenses"]}>
                    <Layout />
                    <Page />
                </ChannelBoundary>
            </ChannelBoundary>,
        );

        // Nesting order of the effects is Preact's business; both exist.
        expect(FakeEventSource.instances.map((i) => i.url).sort()).toEqual([
            "/_channel/expenses/Expenses/teamExpenses",
            "/_channel/expenses/Layout/teamExpenses",
        ]);

        // Each connection feeds its own module's entry.
        const byUrl = (url: string) => FakeEventSource.instances.find((i) => i.url === url)!;
        act(() => byUrl("/_channel/expenses/Layout/teamExpenses").emit("snapshot", JSON.stringify({ v: "layout" })));
        act(() => byUrl("/_channel/expenses/Expenses/teamExpenses").emit("snapshot", JSON.stringify({ v: "page" })));
        expect(loaderEntry("expenses/Layout").value).toEqual({ v: "layout" });
        expect(loaderEntry("expenses/Expenses").value).toEqual({ v: "page" });
    });

    it("unmounting closes the module's connections", () => {
        function Page() {
            return null;
        }
        const { unmount } = render(
            <ChannelBoundary moduleId="a/B" channels={["one", "two"]}>
                <Page />
            </ChannelBoundary>,
        );
        expect(FakeEventSource.instances).toHaveLength(2);
        unmount();
        expect(FakeEventSource.instances.every((i) => i.closed)).toBe(true);
    });
});

// ============================================
// The route tree wires it with no code from the developer (CA2)
// ============================================

describe("live loader — rendered hierarchy", () => {
    it("ClientRoutes opens one connection per (module, channel) of the matched route (CA2)", () => {
        navigate("/expenses");

        const Shell = ({ children }: any) => <div>{children}</div>;
        const Layout = ({ children }: any) => <div>{children}</div>;
        const Page = () => null;
        const Other = () => null;

        const routes: AppRoutes = [
            {
                module: {
                    Component: Shell,
                    metadata: { moduleId: "expenses/Root", fullPath: "" },
                },
                isRoot: true,
                children: [
                    {
                        path: "/expenses",
                        module: {
                            Component: Layout,
                            metadata: { moduleId: "expenses/Layout", fullPath: "/expenses" },
                            channels: ["teamExpenses"],
                        },
                        children: [
                            {
                                path: "/",
                                module: {
                                    Component: Page,
                                    metadata: {
                                        moduleId: "expenses/Expenses",
                                        fullPath: "/expenses",
                                    },
                                    channels: ["teamExpenses"],
                                },
                            },
                        ],
                    },
                    {
                        path: "/other",
                        module: {
                            Component: Other,
                            metadata: { moduleId: "other/Other", fullPath: "/other" },
                        },
                    },
                ],
            },
        ];

        const { unmount } = render(<ClientRoutes routes={routes} />);

        expect(FakeEventSource.instances.map((i) => i.url).sort()).toEqual([
            "/_channel/expenses/Expenses/teamExpenses",
            "/_channel/expenses/Layout/teamExpenses",
        ]);

        // The module that declares nothing opens nothing.
        expect(FakeEventSource.instances.some((i) => i.url.includes("other/Other"))).toBe(false);

        // Unmounting the page closes its connections.
        unmount();
        expect(FakeEventSource.instances.every((i) => i.closed)).toBe(true);
    });
});

// ============================================
// Freshness
// ============================================

describe("live loader — freshness (CA8)", () => {
    it("is live while connected, error on a failed re-execution, stale when closed", () => {
        function Page() {
            useLoader("a/B");
            return null;
        }
        render(
            <ChannelBoundary moduleId="a/B" channels={["c"]}>
                <Page />
            </ChannelBoundary>,
        );
        const es = FakeEventSource.instances[0]!;

        const freshness = () => Loader("a/B").freshness.value;
        expect(freshness()).toBe("live");

        // The server reported a failed loader re-execution.
        act(() => es.emit("error", JSON.stringify({ message: "boom" })));
        expect(freshness()).toBe("error");

        // A later snapshot recovers.
        act(() => es.emit("snapshot", JSON.stringify({ ok: true })));
        expect(freshness()).toBe("live");

        // The connection dropped (native error, reconnecting).
        es.readyState = FakeEventSource.CONNECTING;
        act(() => es.emit("error"));
        expect(freshness()).toBe("stale");

        act(() => es.emit("snapshot", JSON.stringify({ ok: true })));
        expect(freshness()).toBe("live");

        // The server closed the connection deliberately.
        act(() => es.emit("close"));
        expect(freshness()).toBe("stale");
    });

    it("a page without channels keeps freshness constant at live", () => {
        function Page() {
            useLoader("no/Channels");
            return null;
        }
        render(
            <ChannelBoundary moduleId="no/Channels">
                <Page />
            </ChannelBoundary>,
        );
        expect(Loader("no/Channels").freshness.value).toBe("live");
    });
});

// ============================================
// Static build
// ============================================

describe("live loader — static build (CA10)", () => {
    it("opens no connection and keeps freshness live", () => {
        (globalThis as any).__VELO_STATIC__ = true;
        try {
            function Page() {
                useLoader("a/B");
                return null;
            }
            render(
                <ChannelBoundary moduleId="a/B" channels={["c"]}>
                    <Page />
                </ChannelBoundary>,
            );
            expect(FakeEventSource.instances).toHaveLength(0);
            expect(Loader("a/B").freshness.value).toBe("live");
        } finally {
            (globalThis as any).__VELO_STATIC__ = false;
        }
    });
});
