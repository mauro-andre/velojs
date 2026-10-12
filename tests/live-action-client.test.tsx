// @vitest-environment jsdom
/**
 * Live actions — client side (slice 1).
 *
 * jsdom has no `EventSource`, so the tests install a fake one that records the
 * URL and lets the test dispatch the server's events. Everything is
 * deterministic: the silence detector runs under fake timers, the rest is
 * arrival-driven.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, cleanup } from "@testing-library/preact";
import { render as renderToString } from "preact-render-to-string";
import { useLiveAction, type LiveActionStub } from "../src/live-action.js";
import { loaderFreshness, __resetLiveLoader } from "../src/live-loader.js";
import { __resetLoaderStore } from "../src/loader-store.js";

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

/** The client stub of a live action, as the Vite plugin generates it. */
function stub(moduleId: string, action: string): LiveActionStub<{ id: number }, any> {
    const fn = async () => ({}) as any;
    (fn as any).__isVeloLiveAction = true;
    (fn as any).__path = `/_live/${moduleId}/${action}`;
    return fn as unknown as LiveActionStub<{ id: number }, any>;
}

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
    vi.useRealTimers();
});

// ============================================
// The handle — data, loading, freshness
// ============================================

describe("live action — the handle", () => {
    function Tab({ action, args }: { action: any; args: any }) {
        const { data, loading, freshness } = useLiveAction<{ id: number }, { nome: string; fase: string }>(action, args);
        return (
            <div class={freshness.value}>
                {loading.value ? "…" : `${data.value?.nome ?? "?"}|${data.value?.fase ?? "?"}`}
            </div>
        );
    }

    it("opens one connection at the live route with the declared args (CA12)", () => {
        render(<Tab action={stub("projeto/Projeto", "abrirFicha")} args={{ id: 7 }} />);
        expect(FakeEventSource.instances).toHaveLength(1);
        expect(FakeEventSource.instances[0]!.url).toBe(
            "/_live/projeto/Projeto/abrirFicha?_args=" + encodeURIComponent('{"id":7}'),
        );
    });

    it("loading is true until the connect snapshot; data replaces whole (CA1, CA12)", () => {
        const { container } = render(
            <Tab action={stub("projeto/Projeto", "abrirFicha")} args={{ id: 7 }} />,
        );
        expect(container.textContent).toBe("…");

        const es = FakeEventSource.instances[0]!;
        act(() => es.emit("snapshot", JSON.stringify({ nome: "Site", fase: "build" })));
        expect(container.textContent).toBe("Site|build");

        act(() => es.emit("snapshot", JSON.stringify({ nome: "Site", fase: "review" })));
        expect(container.textContent).toBe("Site|review");
    });

    it("a malformed payload keeps the previous value (CA10)", () => {
        const { container } = render(
            <Tab action={stub("projeto/Projeto", "abrirFicha")} args={{ id: 7 }} />,
        );
        const es = FakeEventSource.instances[0]!;
        act(() => es.emit("snapshot", JSON.stringify({ nome: "Site", fase: "build" })));

        act(() => es.emit("snapshot", "{not json"));
        expect(container.textContent).toBe("Site|build");
    });

    it("an error event marks freshness error and keeps the last value (CA10)", () => {
        const { container } = render(
            <Tab action={stub("projeto/Projeto", "abrirFicha")} args={{ id: 7 }} />,
        );
        const es = FakeEventSource.instances[0]!;
        act(() => es.emit("snapshot", JSON.stringify({ nome: "Site", fase: "build" })));

        act(() => es.emit("error", JSON.stringify({ message: "ficha unavailable" })));
        expect(container.firstElementChild!.className).toBe("error");
        expect(container.textContent).toBe("Site|build"); // never a blank tab

        // The next snapshot repairs the freshness — the subscription lives on.
        act(() => es.emit("snapshot", JSON.stringify({ nome: "Site", fase: "review" })));
        expect(container.firstElementChild!.className).toBe("live");
    });

    it("a close event marks the subscription stale (CA7)", () => {
        const { container } = render(
            <Tab action={stub("projeto/Projeto", "abrirFicha")} args={{ id: 7 }} />,
        );
        const es = FakeEventSource.instances[0]!;
        act(() => es.emit("snapshot", JSON.stringify({ nome: "Site", fase: "build" })));

        act(() => es.emit("close"));
        expect(container.firstElementChild!.className).toBe("stale");
    });
});

// ============================================
// Lifecycle — the mount is the subscription (CA3, CA4, CA12)
// ============================================

describe("live action — lifecycle", () => {
    function Tab({ action, args }: { action: any; args: any }) {
        const { data, loading } = useLiveAction<{ id: number }, { nome: string }>(action, args);
        return <div>{loading.value ? "…" : (data.value?.nome ?? "?")}</div>;
    }

    it("unmount closes the connection — nothing arrives afterwards (CA3)", () => {
        const { unmount } = render(
            <Tab action={stub("projeto/Projeto", "abrirFicha")} args={{ id: 7 }} />,
        );
        const es = FakeEventSource.instances[0]!;
        act(() => es.emit("snapshot", JSON.stringify({ nome: "Site" })));

        unmount();
        expect(es.closed).toBe(true);
        expect(FakeEventSource.instances).toHaveLength(1); // nothing respawned
    });

    it("remount is a new subscription with a snapshot of the current state (CA4)", () => {
        const action = stub("projeto/Projeto", "abrirFicha");
        const { unmount } = render(<Tab action={action} args={{ id: 7 }} />);
        act(() => FakeEventSource.instances[0]!.emit("snapshot", JSON.stringify({ nome: "old" })));
        unmount();

        // The server moved while nobody watched; the tab reopens (refresh
        // restored it) and the new subscription delivers the current state.
        const { container } = render(<Tab action={action} args={{ id: 7 }} />);
        expect(FakeEventSource.instances).toHaveLength(2);
        act(() => FakeEventSource.instances[1]!.emit("snapshot", JSON.stringify({ nome: "new" })));
        expect(container.textContent).toBe("new");
    });

    it("changing the args reconnects — the args are the identity (CA12)", () => {
        const action = stub("projeto/Projeto", "abrirFicha");
        const { rerender } = render(<Tab action={action} args={{ id: 7 }} />);
        const first = FakeEventSource.instances[0]!;
        act(() => first.emit("snapshot", JSON.stringify({ nome: "Site" })));

        rerender(<Tab action={action} args={{ id: 9 }} />);
        expect(first.closed).toBe(true);
        expect(FakeEventSource.instances).toHaveLength(2);
        expect(decodeURIComponent(FakeEventSource.instances[1]!.url)).toContain('{"id":9}');

        // The new subscription loads again — loading true until its snapshot.
        const second = FakeEventSource.instances[1]!;
        act(() => second.emit("snapshot", JSON.stringify({ nome: "App" })));
    });

    it("on SSR the hook does not connect: data null, loading true (CA12)", () => {
        const action = stub("projeto/Projeto", "abrirFicha");
        let seen: any = null;
        function Tab() {
            seen = useLiveAction<{ id: number }, { nome: string }>(action, { id: 7 });
            return null;
        }
        const html = renderToString(<Tab />);
        expect(html).toBe(""); // rendered no loading JSX of its own
        expect(FakeEventSource.instances).toHaveLength(0);
        expect(seen.data.value).toBeNull();
        expect(seen.loading.value).toBe(true);
    });
});

// ============================================
// Freshness — per subscription, silent at 60s (CA7, CA13)
// ============================================

describe("live action — freshness", () => {
    function Tab({ action, args }: { action: any; args: any }) {
        const { freshness } = useLiveAction(action, args);
        return <div class={freshness.value} />;
    }

    it("an open connection without deliveries for 60s is stale — a delivery brings it back (CA7)", () => {
        vi.useFakeTimers();
        const { container } = render(
            <Tab action={stub("projeto/Projeto", "abrirFicha")} args={{ id: 7 }} />,
        );
        expect(container.firstElementChild!.className).toBe("live");

        act(() => {
            vi.advanceTimersByTime(59999);
        });
        expect(container.firstElementChild!.className).toBe("live");

        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(container.firstElementChild!.className).toBe("stale");

        const es = FakeEventSource.instances[0]!;
        act(() => es.emit("snapshot", JSON.stringify({ ok: 1 })));
        expect(container.firstElementChild!.className).toBe("live");
    });

    it("the subscription's freshness never touches the page aggregate (CA13)", () => {
        vi.useFakeTimers();
        render(<Tab action={stub("projeto/Projeto", "abrirFicha")} args={{ id: 7 }} />);

        // The tab goes silent → stale; the page aggregate stays live.
        act(() => {
            vi.advanceTimersByTime(60001);
        });
        expect(loaderFreshness().value).toBe("live");

        // And the other way around: a fallen page does not touch the tab.
        act(() => FakeEventSource.instances[0]!.emit("error", JSON.stringify({ message: "x" })));
        expect(loaderFreshness().value).toBe("live");
    });
});

// ============================================
// Static build — the load really failed (CA15)
// ============================================

describe("live action — static build", () => {
    it("opens no connection and the hook reports the real failure (CA15)", () => {
        (globalThis as any).__VELO_STATIC__ = true;
        let seen: any = null;
        function Tab() {
            seen = useLiveAction<{ id: number }, { nome: string }>(stub("projeto/Projeto", "abrirFicha"), { id: 7 });
            return null;
        }
        render(<Tab />);

        expect(FakeEventSource.instances).toHaveLength(0); // no /_live connection at all
        expect(seen.data.value).toBeUndefined();
        expect(seen.loading.value).toBe(false);
        expect(seen.freshness.value).toBe("error");
    });
});

// ============================================
// Typing — preserved from the action's own signature (CA12)
// ============================================

/**
 * Compile-time only; never called. The stub the plugin generates for a live
 * action is the fetch arrow carrying the live marks — `Object.assign`-typed —
 * and the hook derives both the args and the return from it: a wrong arg is a
 * type error, and an unused `@ts-expect-error` is too.
 */
function __typeOnlyLiveActionChecks(): void {
    const action = Object.assign(
        async ({ body }: { body: { id: number } }) =>
            Promise.resolve({ nome: "Site", fase: "build" }),
        { __isVeloLiveAction: true as const, __path: "/_live/projeto/Projeto/abrirFicha" },
    );

    const handle = useLiveAction(action, { id: 7 });
    const nome: string | null | undefined = handle.data.value?.nome;
    void nome;
    void handle.freshness.value;

    // @ts-expect-error — the args are typed from the action's body
    useLiveAction(action, { outro: 1 });
}

describe("live action — typing (CA12)", () => {
    it("preserves args and return types from the action's signature", () => {
        // The assertions are the `@ts-expect-error` line above: `npm run
        // typecheck` compiles this file and would fail on an accepted wrong arg
        // (or an unused directive).
        expect(__typeOnlyLiveActionChecks).toBeTypeOf("function");
    });
});

// ============================================
// A stub without the live marks — the loud guard
// ============================================

describe("live action — guards", () => {
    it("an action without the live declaration warns and reports the failure", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            let seen: any = null;
            function Tab() {
                seen = useLiveAction(async () => ({}) as any as LiveActionStub<{ id: number }, any>, { id: 7 });
                return null;
            }
            render(<Tab />);

            expect(FakeEventSource.instances).toHaveLength(0);
            expect(seen.freshness.value).toBe("error");
            expect(seen.loading.value).toBe(false);
            expect(warn.mock.calls[0]?.[0]).toContain("liveActions");
        } finally {
            warn.mockRestore();
        }
    });
});
