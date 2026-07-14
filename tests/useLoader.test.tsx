// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/preact";
import { signal } from "@preact/signals";
import { useLoader, __veloUpdatePending } from "../src/hooks.js";

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Declare __VELO_STATIC__ as global
(globalThis as any).__VELO_STATIC__ = false;
(globalThis as any).__VELO_BUILD_HASH__ = "test";

describe("useLoader", () => {
    beforeEach(() => {
        mockFetch.mockReset();
        // Clean __PAGE_DATA__
        (window as any).__PAGE_DATA__ = {};
        // Reset update flag
        __veloUpdatePending.value = false;
    });

    afterEach(() => {
        cleanup();
    });

    it("hydrates from __PAGE_DATA__ on first render", async () => {
        (window as any).__PAGE_DATA__ = {
            "pages/Home": { message: "Hello" },
        };

        let result: any;
        function TestComponent() {
            result = useLoader<{ message: string }>("pages/Home");
            return <div>{result.data.value?.message}</div>;
        }

        render(<TestComponent />);

        expect(result.data.value).toEqual({ message: "Hello" });
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("fetches data when no __PAGE_DATA__ available", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                "pages/Home": { message: "Fetched" },
            }),
        });

        let result: any;
        function TestComponent() {
            result = useLoader<{ message: string }>("pages/Home");
            return <div>{result.data.value?.message}</div>;
        }

        render(<TestComponent />);

        // Wait for useEffect + fetch
        await act(async () => {
            await new Promise((r) => setTimeout(r, 10));
        });

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(result.data.value).toEqual({ message: "Fetched" });
    });

    it("BUG: re-fetches when deps change after initial hydration", async () => {
        // First render: hydrate from __PAGE_DATA__
        (window as any).__PAGE_DATA__ = {
            "pages/User": { name: "Alice" },
        };

        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                "pages/User": { name: "Bob" },
            }),
        });

        const slug = signal("alice");
        let result: any;

        function TestComponent() {
            result = useLoader<{ name: string }>("pages/User", [slug.value]);
            return <div>{result.data.value?.name}</div>;
        }

        const { rerender } = render(<TestComponent />);

        // First render: should hydrate from __PAGE_DATA__, no fetch
        expect(result.data.value).toEqual({ name: "Alice" });
        expect(mockFetch).not.toHaveBeenCalled();

        // Change the dep (simulate slug change via SPA navigation)
        await act(async () => {
            slug.value = "bob";
            rerender(<TestComponent />);
        });

        // Wait for fetch promise chain to resolve
        await act(async () => {
            await new Promise((r) => setTimeout(r, 50));
        });

        // After dep change, fetch should have been called and data updated
        expect(mockFetch).toHaveBeenCalled();
        expect(result.data.value).toEqual({ name: "Bob" });
    });

    // Pins the agent/AGENTS.md row: "two components calling useLoader() for the
    // same module". Hydration is consume-once, so the second caller starts at
    // null and goes to the network. If this ever stops being true, delete that
    // row from AGENTS.md.
    it("hydration is consume-once: a second useLoader for the same module gets null", async () => {
        (window as any).__PAGE_DATA__ = {
            "pages/Home": { message: "Hello" },
        };
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ "pages/Home": { message: "Refetched" } }),
        });

        let first: any;
        let second: any;
        function First() {
            first = useLoader<{ message: string }>("pages/Home");
            return <div>{first.data.value?.message}</div>;
        }
        function Second() {
            second = useLoader<{ message: string }>("pages/Home");
            return <div>{second.data.value?.message}</div>;
        }

        render(
            <div>
                <First />
                <Second />
            </div>,
        );

        // The first consumer takes the payload and deletes it...
        expect(first.data.value).toEqual({ message: "Hello" });
        // ...leaving the second with nothing to hydrate from.
        expect(second.data.value).toBeNull();

        // And it silently goes to the network to recover.
        await act(async () => {
            await new Promise((r) => setTimeout(r, 10));
        });
        expect(mockFetch).toHaveBeenCalled();
    });

    it("sets __veloUpdatePending when server returns a different __buildHash", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                "pages/Home": { message: "Hello" },
                __buildHash: "new-deploy-hash",
            }),
        });

        function TestComponent() {
            useLoader<{ message: string }>("pages/Home");
            return <div>test</div>;
        }

        render(<TestComponent />);

        await act(async () => {
            await new Promise((r) => setTimeout(r, 10));
        });

        expect(__veloUpdatePending.value).toBe(true);
    });

    it("does NOT set __veloUpdatePending when __buildHash matches", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                "pages/Home": { message: "Hello" },
                __buildHash: "test", // same as global __VELO_BUILD_HASH__
            }),
        });

        function TestComponent() {
            useLoader<{ message: string }>("pages/Home");
            return <div>test</div>;
        }

        render(<TestComponent />);

        await act(async () => {
            await new Promise((r) => setTimeout(r, 10));
        });

        expect(__veloUpdatePending.value).toBe(false);
    });
});
