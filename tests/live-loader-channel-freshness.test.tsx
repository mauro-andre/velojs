// @vitest-environment jsdom
/**
 * Live loader — per-channel freshness and the silence detector (slice 3).
 *
 * The FakeEventSource lets the test dispatch exactly what the server sends;
 * the silence clock runs under fake timers with the runtime constant as the
 * explicit window. jsdom has no EventSource of its own.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, cleanup } from "@testing-library/preact";
import { useLoader, Loader } from "../src/hooks.js";
import { ChannelBoundary, CHANNEL_SILENCE_MS, __resetLiveLoader } from "../src/live-loader.js";
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

    emit(type: string, data?: string): void {
        for (const fn of this.listeners.get(type) ?? []) fn({ data });
    }
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
    vi.useRealTimers();
    cleanup();
    delete (globalThis as any).EventSource;
    window.history.pushState({}, "", "/");
});

function twoChannelPage(handleRef: { current: any }) {
    function Page() {
        handleRef.current = useLoader<{ n: number }>("a/Page");
        return null;
    }
    return render(
        <ChannelBoundary moduleId="a/Page" channels={["um", "dois"]}>
            <Page />
        </ChannelBoundary>,
    );
}

// ============================================
// freshnessByChannel (CA7)
// ============================================

describe("live loader — freshnessByChannel", () => {
    it("fills with the module's channels as the connections open", () => {
        const handleRef: { current: any } = { current: null };
        const { unmount } = twoChannelPage(handleRef);

        // The boundary's effect runs at mount: one connection per declared
        // channel, each key live from the moment its connection opens.
        expect(handleRef.current.freshnessByChannel.value).toEqual({
            um: "live",
            dois: "live",
        });

        const [um, dois] = FakeEventSource.instances;
        act(() => um!.emit("snapshot", JSON.stringify({ n: 1 })));
        act(() => dois!.emit("snapshot", JSON.stringify({ n: 1 })));
        expect(handleRef.current.freshnessByChannel.value).toEqual({
            um: "live",
            dois: "live",
        });
        unmount();
    });

    it("a fallen channel and a following one show distinct states; the aggregate stays live", () => {
        const handleRef: { current: any } = { current: null };
        const { unmount } = twoChannelPage(handleRef);
        const [um, dois] = FakeEventSource.instances;
        act(() => um!.emit("snapshot", "{}"));
        act(() => dois!.emit("snapshot", "{}"));

        // One channel is deliberately closed by the server; the other follows.
        act(() => um!.emit("close"));
        expect(handleRef.current.freshnessByChannel.value).toEqual({
            um: "stale",
            dois: "live",
        });
        expect(handleRef.current.freshness.value).toBe("live");

        // A failed re-execution errors only its channel — and the aggregate.
        act(() => dois!.emit("error", JSON.stringify({ message: "boom" })));
        expect(handleRef.current.freshnessByChannel.value).toEqual({
            um: "stale",
            dois: "error",
        });
        expect(handleRef.current.freshness.value).toBe("error");

        unmount();
    });

    it("every channel closed marks each of them stale and the aggregate stale", () => {
        const handleRef: { current: any } = { current: null };
        const { unmount } = twoChannelPage(handleRef);
        const [um, dois] = FakeEventSource.instances;
        act(() => um!.emit("snapshot", "{}"));
        act(() => dois!.emit("snapshot", "{}"));

        act(() => um!.emit("close"));
        act(() => dois!.emit("close"));
        expect(handleRef.current.freshnessByChannel.value).toEqual({
            um: "stale",
            dois: "stale",
        });
        expect(handleRef.current.freshness.value).toBe("stale");

        unmount();
    });

    it("without channels the record is empty and the aggregate is constant live", () => {
        let handle: any;
        function Page() {
            handle = useLoader("sem/Canais");
            return null;
        }
        render(<Page />);
        expect(handle.freshnessByChannel.value).toEqual({});
        expect(handle.freshness.value).toBe("live");
    });

    it("Loader() exposes the same per-channel record of the module", () => {
        const handleRef: { current: any } = { current: null };
        function Page() {
            handleRef.current = useLoader("a/Page");
            return null;
        }
        render(
            <ChannelBoundary moduleId="a/Page" channels={["um"]}>
                <Page />
            </ChannelBoundary>,
        );
        const [um] = FakeEventSource.instances;
        act(() => um!.emit("snapshot", "{}"));

        const loaderHandle = Loader("a/Page");
        expect(loaderHandle.freshnessByChannel.value).toEqual({ um: "live" });

        act(() => um!.emit("close"));
        expect(loaderHandle.freshnessByChannel.value).toEqual({ um: "stale" });
    });
});

// ============================================
// Silence detector (CA8)
// ============================================

describe("live loader — stale by silence", () => {
    it("an open connection silent past 60s goes stale; a delivery brings it back", () => {
        vi.useFakeTimers();
        const handleRef: { current: any } = { current: null };
        const { unmount } = twoChannelPage(handleRef);
        const [um, dois] = FakeEventSource.instances;
        act(() => um!.emit("snapshot", JSON.stringify({ n: 1 })));
        act(() => dois!.emit("snapshot", JSON.stringify({ n: 1 })));
        expect(handleRef.current.freshness.value).toBe("live");

        // 59s of silence: still live. The last second marks it.
        vi.advanceTimersByTime(CHANNEL_SILENCE_MS - 1);
        expect(handleRef.current.freshnessByChannel.value).toEqual({
            um: "live",
            dois: "live",
        });
        vi.advanceTimersByTime(1);
        expect(handleRef.current.freshnessByChannel.value).toEqual({
            um: "stale",
            dois: "stale",
        });
        // The aggregate folds the silence: both channels not-open.
        expect(handleRef.current.freshness.value).toBe("stale");

        // A slice is a delivery: the channel is live again.
        act(() => um!.emit("slice", JSON.stringify({ n: 2 })));
        expect(handleRef.current.freshnessByChannel.value).toEqual({
            um: "live",
            dois: "stale",
        });
        expect(handleRef.current.freshness.value).toBe("live");

        unmount();
    });

    it("a reconnect with snapshot restores live after the silence", () => {
        vi.useFakeTimers();
        const handleRef: { current: any } = { current: null };
        const { unmount } = twoChannelPage(handleRef);
        const [um, dois] = FakeEventSource.instances;
        act(() => um!.emit("snapshot", "{}"));
        act(() => dois!.emit("snapshot", "{}"));

        vi.advanceTimersByTime(CHANNEL_SILENCE_MS);
        expect(handleRef.current.freshnessByChannel.value).toEqual({
            um: "stale",
            dois: "stale",
        });

        // The server's heartbeat comment generates NO client event — it cannot
        // reset the clock; only a delivery does. The snapshot of the reconnect
        // brings the channel back.
        act(() => um!.emit("snapshot", JSON.stringify({ n: 9 })));
        expect(handleRef.current.freshnessByChannel.value).toEqual({
            um: "live",
            dois: "stale",
        });
        expect(handleRef.current.freshness.value).toBe("live");
        expect(handleRef.current.data.value).toEqual({ n: 9 });

        unmount();
    });

    it("unmounting stops the silence clock — no ghost state after the page is gone", () => {
        vi.useFakeTimers();
        const handleRef: { current: any } = { current: null };
        const { unmount } = twoChannelPage(handleRef);
        const [um] = FakeEventSource.instances;
        act(() => um!.emit("snapshot", "{}"));

        unmount();
        vi.advanceTimersByTime(CHANNEL_SILENCE_MS * 3);
        expect(handleRef.current.freshnessByChannel.value).toEqual({});
        expect(handleRef.current.freshness.value).toBe("live");
    });
});