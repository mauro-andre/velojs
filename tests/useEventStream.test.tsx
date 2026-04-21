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
