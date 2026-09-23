// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/preact";
import { useEventStream } from "../src/hooks.js";
import { createEventStream } from "../src/events.js";

// Mock EventSource — jsdom doesn't have it
class MockEventSource {
    static instances: MockEventSource[] = [];
    static OPEN = 1;
    static CLOSED = 2;

    url: string;
    readyState: number = MockEventSource.OPEN;
    listeners: Map<string, Array<(e: any) => void>> = new Map();
    closed = false;

    constructor(url: string) {
        this.url = url;
        MockEventSource.instances.push(this);
    }

    addEventListener(event: string, handler: (e: any) => void) {
        if (!this.listeners.has(event)) this.listeners.set(event, []);
        this.listeners.get(event)!.push(handler);
    }

    close() {
        this.closed = true;
        this.readyState = MockEventSource.CLOSED;
    }

    // Test helper: simulate a server-sent event
    emit(event: string, data: any) {
        const handlers = this.listeners.get(event) ?? [];
        const evt = { data: typeof data === "string" ? data : JSON.stringify(data) };
        for (const fn of handlers) fn(evt);
    }

    // Test helper: simulate connection error / closed
    triggerClose() {
        this.readyState = MockEventSource.CLOSED;
        const handlers = this.listeners.get("error") ?? [];
        for (const fn of handlers) fn({});
    }
}

beforeEach(() => {
    MockEventSource.instances = [];
    (globalThis as any).EventSource = MockEventSource;
});

afterEach(() => {
    cleanup();
});

describe("useEventStream", () => {
    it("opens an EventSource at the stream's __path", () => {
        const stream = createEventStream<string>();
        stream.__path = "/_event/test/foo";

        function TestComponent() {
            useEventStream(stream);
            return <div>test</div>;
        }
        render(<TestComponent />);

        expect(MockEventSource.instances.length).toBe(1);
        expect(MockEventSource.instances[0]!.url).toBe("/_event/test/foo");
    });

    it("appends ?channel=X to URL when channel option is provided", () => {
        const stream = createEventStream<string>();
        stream.__path = "/_event/test/bar";

        function TestComponent() {
            useEventStream(stream, { channel: "abc-123" });
            return <div>test</div>;
        }
        render(<TestComponent />);

        expect(MockEventSource.instances[0]!.url).toBe(
            "/_event/test/bar?channel=abc-123"
        );
    });

    it("URL-encodes the channel value", () => {
        const stream = createEventStream<string>();
        stream.__path = "/_event/test/baz";

        function TestComponent() {
            useEventStream(stream, { channel: "id with spaces&stuff" });
            return <div>test</div>;
        }
        render(<TestComponent />);

        expect(MockEventSource.instances[0]!.url).toContain(
            "channel=id%20with%20spaces%26stuff"
        );
    });

    it("does not open a connection when enabled is false", () => {
        const stream = createEventStream<string>();
        stream.__path = "/_event/test/disabled";

        function TestComponent() {
            useEventStream(stream, { enabled: false });
            return <div>test</div>;
        }
        render(<TestComponent />);

        expect(MockEventSource.instances.length).toBe(0);
    });

    it("updates data signal when a 'message' event arrives", () => {
        const stream = createEventStream<{ msg: string }>();
        stream.__path = "/_event/test/msg";

        let result: any;
        function TestComponent() {
            result = useEventStream(stream);
            return <div>{result.data.value?.msg}</div>;
        }
        render(<TestComponent />);

        act(() => {
            MockEventSource.instances[0]!.emit("message", { msg: "hello" });
        });

        expect(result.data.value).toEqual({ msg: "hello" });
    });

    it("updates snapshot signal when a 'snapshot' event arrives", () => {
        const stream = createEventStream<number, { current: number }>();
        stream.__path = "/_event/test/snap";

        let result: any;
        function TestComponent() {
            result = useEventStream(stream);
            return <div>test</div>;
        }
        render(<TestComponent />);

        act(() => {
            MockEventSource.instances[0]!.emit("snapshot", { current: 42 });
        });

        expect(result.snapshot.value).toEqual({ current: 42 });
    });

    it("ignores 'heartbeat' events without setting data", () => {
        const stream = createEventStream<string>();
        stream.__path = "/_event/test/heart";

        let result: any;
        function TestComponent() {
            result = useEventStream(stream);
            return <div>test</div>;
        }
        render(<TestComponent />);

        act(() => {
            MockEventSource.instances[0]!.emit("heartbeat", "");
        });

        expect(result.data.value).toBeNull();
    });

    it("sets closed=true when EventSource transitions to CLOSED state", () => {
        const stream = createEventStream<string>();
        stream.__path = "/_event/test/close";

        let result: any;
        function TestComponent() {
            result = useEventStream(stream);
            return <div>test</div>;
        }
        render(<TestComponent />);

        act(() => {
            MockEventSource.instances[0]!.triggerClose();
        });

        expect(result.closed.value).toBe(true);
    });

    it("does NOT set closed when EventSource is just retrying (still OPEN)", () => {
        const stream = createEventStream<string>();
        stream.__path = "/_event/test/retry";

        let result: any;
        function TestComponent() {
            result = useEventStream(stream);
            return <div>test</div>;
        }
        render(<TestComponent />);

        const es = MockEventSource.instances[0]!;
        act(() => {
            // Simulate transient error — readyState stays OPEN
            const handlers = es.listeners.get("error") ?? [];
            for (const fn of handlers) fn({});
        });

        expect(result.closed.value).toBe(false);
    });

    it("captures parse errors in the error signal", () => {
        const stream = createEventStream<{ x: number }>();
        stream.__path = "/_event/test/parse";

        let result: any;
        function TestComponent() {
            result = useEventStream(stream);
            return <div>test</div>;
        }
        render(<TestComponent />);

        act(() => {
            // Send invalid JSON
            const handlers = MockEventSource.instances[0]!.listeners.get("message") ?? [];
            for (const fn of handlers) fn({ data: "not valid json {" });
        });

        expect(result.error.value).toBeInstanceOf(Error);
    });

    it("closes the connection on unmount", () => {
        const stream = createEventStream<string>();
        stream.__path = "/_event/test/unmount";

        function TestComponent() {
            useEventStream(stream);
            return <div>test</div>;
        }
        const { unmount } = render(<TestComponent />);

        const es = MockEventSource.instances[0]!;
        expect(es.closed).toBe(false);

        unmount();
        expect(es.closed).toBe(true);
    });

    it("re-opens connection when channel changes", () => {
        const stream = createEventStream<string>();
        stream.__path = "/_event/test/rechan";

        function TestComponent({ channel }: { channel: string }) {
            useEventStream(stream, { channel });
            return <div>{channel}</div>;
        }

        const { rerender } = render(<TestComponent channel="a" />);
        expect(MockEventSource.instances.length).toBe(1);
        expect(MockEventSource.instances[0]!.url).toContain("channel=a");

        act(() => {
            rerender(<TestComponent channel="b" />);
        });

        // Old EventSource closed, new one opened
        expect(MockEventSource.instances[0]!.closed).toBe(true);
        expect(MockEventSource.instances.length).toBe(2);
        expect(MockEventSource.instances[1]!.url).toContain("channel=b");
    });

    it("keeps the previous data/snapshot when the channel changes until the new connection emits", () => {
        const stream = createEventStream<{ msg: string }, { current: number }>();
        stream.__path = "/_event/test/swr";

        let result: any;
        function TestComponent({ channel }: { channel: string }) {
            result = useEventStream(stream, { channel });
            return <div>{channel}</div>;
        }

        const { rerender } = render(<TestComponent channel="a" />);
        const first = MockEventSource.instances[0]!;

        act(() => {
            first.emit("snapshot", { current: 1 });
            first.emit("message", { msg: "from-a" });
        });
        expect(result.snapshot.value).toEqual({ current: 1 });
        expect(result.data.value).toEqual({ msg: "from-a" });

        act(() => {
            rerender(<TestComponent channel="b" />);
        });

        const second = MockEventSource.instances[1]!;
        expect(second.url).toContain("channel=b");

        // Before any event of the new connection: still A's values, never null
        expect(result.data.value).toEqual({ msg: "from-a" });
        expect(result.snapshot.value).toEqual({ current: 1 });

        act(() => {
            second.emit("snapshot", { current: 2 });
        });
        expect(result.snapshot.value).toEqual({ current: 2 });
        // `data` only flips when its own event arrives
        expect(result.data.value).toEqual({ msg: "from-a" });

        act(() => {
            second.emit("message", { msg: "from-b" });
        });
        expect(result.data.value).toEqual({ msg: "from-b" });
    });

    it("still starts null on first mount (snapshot fills the value later)", () => {
        const stream = createEventStream<string>();
        stream.__path = "/_event/test/firstmount";

        let result: any;
        function TestComponent() {
            result = useEventStream(stream);
            return <div>test</div>;
        }
        render(<TestComponent />);

        expect(result.data.value).toBeNull();
        expect(result.snapshot.value).toBeNull();

        act(() => {
            MockEventSource.instances[0]!.emit("snapshot", { current: 7 });
        });
        expect(result.snapshot.value).toEqual({ current: 7 });
    });

    it("resets closed/error and opens the new channel after the stream was closed", () => {
        const stream = createEventStream<string>();
        stream.__path = "/_event/test/reclose";

        let result: any;
        function TestComponent({ channel }: { channel: string }) {
            result = useEventStream(stream, { channel });
            return <div>{channel}</div>;
        }

        const { rerender } = render(<TestComponent channel="a" />);

        act(() => {
            MockEventSource.instances[0]!.triggerClose();
        });
        expect(result.closed.value).toBe(true);

        act(() => {
            rerender(<TestComponent channel="b" />);
        });

        // The re-open is a fresh attempt: not closed anymore
        expect(result.closed.value).toBe(false);
        expect(result.error.value).toBeNull();
        expect(MockEventSource.instances.length).toBe(2);
        expect(MockEventSource.instances[1]!.url).toBe("/_event/test/reclose?channel=b");
    });

    it("keeps the previous values across a disabled window and on re-enable", () => {
        const stream = createEventStream<{ msg: string }>();
        stream.__path = "/_event/test/reenable";

        let result: any;
        function TestComponent({ enabled }: { enabled: boolean }) {
            result = useEventStream(stream, { channel: "a", enabled });
            return <div>test</div>;
        }

        const { rerender } = render(<TestComponent enabled={true} />);

        act(() => {
            MockEventSource.instances[0]!.emit("message", { msg: "a-1" });
        });
        expect(result.data.value).toEqual({ msg: "a-1" });

        act(() => {
            rerender(<TestComponent enabled={false} />);
        });
        expect(MockEventSource.instances[0]!.closed).toBe(true);
        // Disabling does not blank the UI
        expect(result.data.value).toEqual({ msg: "a-1" });

        act(() => {
            rerender(<TestComponent enabled={true} />);
        });
        expect(MockEventSource.instances.length).toBe(2);
        expect(result.data.value).toEqual({ msg: "a-1" });

        act(() => {
            MockEventSource.instances[1]!.emit("message", { msg: "a-2" });
        });
        expect(result.data.value).toEqual({ msg: "a-2" });
    });

    it("waits for a loader-resolved channel before connecting (enabled: channel != null)", () => {
        const stream = createEventStream<{ msg: string }>();
        stream.__path = "/_event/test/gate";

        let result: any;
        function TestComponent({ channel }: { channel?: string }) {
            // the pattern the docs recommend for a channel derived from loader data
            result = useEventStream(stream, {
                ...(channel != null && { channel }),
                enabled: channel != null,
            });
            return <div>{channel ?? "loading"}</div>;
        }

        const { rerender } = render(<TestComponent />);

        // First render of a SPA navigation: the loader has not resolved yet, so
        // there is no channel — no connection, and no 403 to paint `closed`
        expect(MockEventSource.instances.length).toBe(0);
        expect(result.closed.value).toBe(false);

        act(() => {
            rerender(<TestComponent channel="app-42" />);
        });

        expect(MockEventSource.instances.length).toBe(1);
        expect(MockEventSource.instances[0]!.url).toBe("/_event/test/gate?channel=app-42");
        expect(result.closed.value).toBe(false);
    });

    it("warns and does nothing when stream has no __path", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const stream = createEventStream<string>();
        // __path intentionally undefined

        function TestComponent() {
            useEventStream(stream);
            return <div>test</div>;
        }
        render(<TestComponent />);

        expect(MockEventSource.instances.length).toBe(0);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining("useEventStream")
        );
        warn.mockRestore();
    });
});
