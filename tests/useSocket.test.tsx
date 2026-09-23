// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/preact";
import { useSocket } from "../src/hooks.js";

// Mock WebSocket — jsdom's is not usable for driving open/message/close by hand
class MockWebSocket {
    static instances: MockWebSocket[] = [];
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    url: string;
    readyState: number = MockWebSocket.CONNECTING;
    binaryType: string = "blob";
    sent: string[] = [];
    listeners: Map<string, Array<(e: any) => void>> = new Map();

    constructor(url: string) {
        this.url = url;
        MockWebSocket.instances.push(this);
    }

    addEventListener(event: string, handler: (e: any) => void) {
        if (!this.listeners.has(event)) this.listeners.set(event, []);
        this.listeners.get(event)!.push(handler);
    }

    send(data: any) {
        this.sent.push(data);
    }

    close(code?: number, reason?: string) {
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        this.emit("close", { code: code ?? 1000, reason: reason ?? "" });
    }

    // --- test helpers ---

    emit(event: string, evt: any) {
        for (const fn of this.listeners.get(event) ?? []) fn(evt);
    }

    open() {
        this.readyState = MockWebSocket.OPEN;
        this.emit("open", {});
    }

    /** Test helper: server (or network) pushes a text frame. */
    message(data: string) {
        this.emit("message", { data });
    }

    /** Test helper: server closes the socket. */
    serverClose(code = 1000, reason = "") {
        this.readyState = MockWebSocket.CLOSED;
        this.emit("close", { code, reason });
    }

    fail(err: any = {}) {
        this.emit("error", err);
    }
}

beforeEach(() => {
    MockWebSocket.instances = [];
    (globalThis as any).WebSocket = MockWebSocket;
});

afterEach(() => {
    cleanup();
});

describe("useSocket", () => {
    it("opens a WebSocket at the stub's __path", () => {
        const stub = { __path: "/_socket/test/terminal" };

        function TestComponent() {
            useSocket(stub);
            return <div>test</div>;
        }
        render(<TestComponent />);

        expect(MockWebSocket.instances.length).toBe(1);
        expect(MockWebSocket.instances[0]!.url).toBe(
            `ws://${window.location.host}/_socket/test/terminal`
        );
    });

    it("appends ?channel=X to the URL when channel is provided", () => {
        const stub = { __path: "/_socket/test/chan" };

        function TestComponent() {
            useSocket(stub, { channel: "worker 1" });
            return <div>test</div>;
        }
        render(<TestComponent />);

        expect(MockWebSocket.instances[0]!.url).toBe(
            `ws://${window.location.host}/_socket/test/chan?channel=worker%201`
        );
    });

    it("does not open a connection when enabled is false", () => {
        const stub = { __path: "/_socket/test/disabled" };

        let result: any;
        function TestComponent() {
            result = useSocket(stub, { enabled: false });
            return <div>test</div>;
        }
        render(<TestComponent />);

        expect(MockWebSocket.instances.length).toBe(0);
        expect(result.status.value).toBe("connecting");
        expect(result.lastMessage.value).toBeNull();
    });

    it("goes connecting → open and records incoming frames", () => {
        const stub = { __path: "/_socket/test/msg" };
        const onMessage = vi.fn();

        let result: any;
        function TestComponent() {
            result = useSocket(stub, { onMessage });
            return <div>test</div>;
        }
        render(<TestComponent />);

        expect(result.status.value).toBe("connecting");

        const ws = MockWebSocket.instances[0]!;
        act(() => {
            ws.open();
        });
        expect(result.status.value).toBe("open");

        act(() => {
            ws.message("hello");
        });
        expect(result.lastMessage.value).toBe("hello");
        expect(onMessage).toHaveBeenCalledWith("hello");
    });

    it("keeps lastMessage when the channel changes until the new socket emits", () => {
        const stub = { __path: "/_socket/test/rechan" };

        let result: any;
        function TestComponent({ channel }: { channel: string }) {
            result = useSocket(stub, { channel });
            return <div>{channel}</div>;
        }

        const { rerender } = render(<TestComponent channel="a" />);
        const first = MockWebSocket.instances[0]!;
        expect(first.url).toContain("channel=a");

        act(() => {
            first.open();
            first.message("from-a");
        });
        expect(result.status.value).toBe("open");
        expect(result.lastMessage.value).toBe("from-a");

        act(() => {
            rerender(<TestComponent channel="b" />);
        });

        // Old socket closed, new one opened against channel b
        expect(MockWebSocket.instances.length).toBe(2);
        const second = MockWebSocket.instances[1]!;
        expect(second.url).toContain("channel=b");

        // A fresh attempt resets status, but the message survives — no null paint
        expect(result.status.value).toBe("connecting");
        expect(result.lastMessage.value).toBe("from-a");

        act(() => {
            second.open();
        });
        expect(result.status.value).toBe("open");
        expect(result.lastMessage.value).toBe("from-a");

        act(() => {
            second.message("from-b");
        });
        expect(result.lastMessage.value).toBe("from-b");
    });

    it("keeps lastMessage across a disabled window and on re-enable", () => {
        const stub = { __path: "/_socket/test/reenable" };

        let result: any;
        function TestComponent({ enabled }: { enabled: boolean }) {
            result = useSocket(stub, { channel: "a", enabled });
            return <div>test</div>;
        }

        const { rerender } = render(<TestComponent enabled={true} />);
        act(() => {
            MockWebSocket.instances[0]!.open();
            MockWebSocket.instances[0]!.message("a-1");
        });
        expect(result.lastMessage.value).toBe("a-1");

        act(() => {
            rerender(<TestComponent enabled={false} />);
        });
        expect(result.status.value).toBe("closed");
        expect(result.lastMessage.value).toBe("a-1");

        act(() => {
            rerender(<TestComponent enabled={true} />);
        });
        expect(MockWebSocket.instances.length).toBe(2);
        expect(result.status.value).toBe("connecting");
        expect(result.lastMessage.value).toBe("a-1");

        act(() => {
            MockWebSocket.instances[1]!.open();
            MockWebSocket.instances[1]!.message("a-2");
        });
        expect(result.lastMessage.value).toBe("a-2");
    });

    it("does not reconnect when the stub object is swapped but __path is the same", () => {
        let result: any;
        function TestComponent({ stub }: { stub: { __path: string } }) {
            result = useSocket(stub);
            return <div>test</div>;
        }

        const { rerender } = render(<TestComponent stub={{ __path: "/_socket/test/same" }} />);
        act(() => {
            MockWebSocket.instances[0]!.open();
            MockWebSocket.instances[0]!.message("kept");
        });

        act(() => {
            rerender(<TestComponent stub={{ __path: "/_socket/test/same" }} />);
        });

        // The effect key is stub.__path — a new object with the same path is a no-op
        expect(MockWebSocket.instances.length).toBe(1);
        expect(result.status.value).toBe("open");
        expect(result.lastMessage.value).toBe("kept");
    });

    it("waits for a loader-resolved channel before connecting (enabled: channel != null)", () => {
        const stub = { __path: "/_socket/test/gate" };

        let result: any;
        function TestComponent({ channel }: { channel?: string }) {
            // the pattern the docs recommend for a channel derived from loader data
            result = useSocket(stub, {
                ...(channel != null && { channel }),
                enabled: channel != null,
            });
            return <div>{channel ?? "loading"}</div>;
        }

        const { rerender } = render(<TestComponent />);

        // No channel yet (loader is post-mount): no socket opened against the
        // wrong URL — the guard the docs recommend for guarded sockets
        expect(MockWebSocket.instances.length).toBe(0);

        act(() => {
            rerender(<TestComponent channel="worker-7" />);
        });

        expect(MockWebSocket.instances.length).toBe(1);
        expect(MockWebSocket.instances[0]!.url).toBe(
            `ws://${window.location.host}/_socket/test/gate?channel=worker-7`
        );

        act(() => {
            MockWebSocket.instances[0]!.open();
        });
        expect(result.status.value).toBe("open");
    });

    it("sets status=closed when the server closes the socket", () => {
        const stub = { __path: "/_socket/test/serverclose" };

        let result: any;
        function TestComponent() {
            result = useSocket(stub);
            return <div>test</div>;
        }
        render(<TestComponent />);

        const ws = MockWebSocket.instances[0]!;
        act(() => {
            ws.open();
            ws.serverClose();
        });

        expect(result.status.value).toBe("closed");
    });

    it("closes the socket on unmount", () => {
        const stub = { __path: "/_socket/test/unmount" };

        function TestComponent() {
            useSocket(stub);
            return <div>test</div>;
        }
        const { unmount } = render(<TestComponent />);

        const ws = MockWebSocket.instances[0]!;
        act(() => {
            ws.open();
        });
        expect(ws.readyState).toBe(MockWebSocket.OPEN);

        unmount();
        expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    });

    it("warns and does nothing when the stub has no __path", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        function TestComponent() {
            useSocket({} as any);
            return <div>test</div>;
        }
        render(<TestComponent />);

        expect(MockWebSocket.instances.length).toBe(0);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("useSocket"));
        warn.mockRestore();
    });
});