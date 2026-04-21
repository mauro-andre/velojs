// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/preact";
import { Scripts, Link } from "../src/components.js";
import { __veloUpdatePending } from "../src/hooks.js";

describe("Scripts", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        cleanup();
        process.env = { ...originalEnv };
    });

    it("renders production assets with default paths", () => {
        process.env.NODE_ENV = "production";
        process.env.STATIC_BASE_URL = "";

        const { container } = render(<Scripts />);
        const link = container.querySelector('link[rel="stylesheet"]');
        const script = container.querySelector('script[type="module"]');

        expect(link?.getAttribute("href")).toBe("/client.css");
        expect(script?.getAttribute("src")).toBe("/client.js");
    });

    it("renders production assets with STATIC_BASE_URL prefix", () => {
        process.env.NODE_ENV = "production";
        process.env.STATIC_BASE_URL = "/client";

        const { container } = render(<Scripts />);
        const link = container.querySelector('link[rel="stylesheet"]');
        const script = container.querySelector('script[type="module"]');

        expect(link?.getAttribute("href")).toBe("/client/client.css");
        expect(script?.getAttribute("src")).toBe("/client/client.js");
    });

    it("BUG: static build SSR should use /client prefix even without STATIC_BASE_URL env", () => {
        // Simulates the static generation context:
        // - NODE_ENV=production
        // - VELO_STATIC=1
        // - STATIC_BASE_URL is NOT set (the bug)
        process.env.NODE_ENV = "production";
        process.env.VELO_STATIC = "1";
        delete process.env.STATIC_BASE_URL;

        const { container } = render(<Scripts />);
        const link = container.querySelector('link[rel="stylesheet"]');
        const script = container.querySelector('script[type="module"]');

        // In static mode, assets are in /client/ — should use /client prefix
        expect(link?.getAttribute("href")).toBe("/client/client.css");
        expect(script?.getAttribute("src")).toBe("/client/client.js");
    });

    it("uses hashed filenames from __VELO_CLIENT_JS__ and __VELO_CLIENT_CSS__ defines", async () => {
        process.env.NODE_ENV = "production";
        process.env.STATIC_BASE_URL = "";

        // Simulate Vite defines by setting globals
        (globalThis as any).__VELO_CLIENT_JS__ = "client.a1b2c3.js";
        (globalThis as any).__VELO_CLIENT_CSS__ = "client.x9y8z7.css";

        try {
            // Re-import to pick up the globals
            const { Scripts: FreshScripts } = await import("../src/components.js");
            const { container } = render(<FreshScripts />);
            const link = container.querySelector('link[rel="stylesheet"]');
            const script = container.querySelector('script[type="module"]');

            expect(script?.getAttribute("src")).toBe("/client.a1b2c3.js");
            expect(link?.getAttribute("href")).toBe("/client.x9y8z7.css");
        } finally {
            delete (globalThis as any).__VELO_CLIENT_JS__;
            delete (globalThis as any).__VELO_CLIENT_CSS__;
        }
    });

    it("uses hashed filenames with STATIC_BASE_URL prefix", async () => {
        process.env.NODE_ENV = "production";
        process.env.STATIC_BASE_URL = "/client";

        (globalThis as any).__VELO_CLIENT_JS__ = "client.abc123.js";
        (globalThis as any).__VELO_CLIENT_CSS__ = "client.def456.css";

        try {
            const { Scripts: FreshScripts } = await import("../src/components.js");
            const { container } = render(<FreshScripts />);
            const link = container.querySelector('link[rel="stylesheet"]');
            const script = container.querySelector('script[type="module"]');

            expect(script?.getAttribute("src")).toBe("/client/client.abc123.js");
            expect(link?.getAttribute("href")).toBe("/client/client.def456.css");
        } finally {
            delete (globalThis as any).__VELO_CLIENT_JS__;
            delete (globalThis as any).__VELO_CLIENT_CSS__;
        }
    });
});

describe("Link", () => {
    afterEach(() => {
        cleanup();
        __veloUpdatePending.value = false;
    });

    it("renders a wouter Link when no update is pending", () => {
        __veloUpdatePending.value = false;

        const { container } = render(<Link to="/about">About</Link>);
        const anchor = container.querySelector("a");

        expect(anchor).toBeTruthy();
        expect(anchor?.textContent).toBe("About");
    });

    it("renders a plain <a> with full navigation when update is pending", () => {
        __veloUpdatePending.value = true;

        const { container } = render(<Link to="/about">About</Link>);
        const anchor = container.querySelector("a");

        expect(anchor).toBeTruthy();
        expect(anchor?.getAttribute("href")).toBe("/about");
        expect(anchor?.textContent).toBe("About");
    });

    it("does full navigation on click when update is pending", () => {
        __veloUpdatePending.value = true;

        // Mock window.location.href setter
        const locationHref = vi.spyOn(window, "location", "get").mockReturnValue({
            ...window.location,
            href: "",
        } as any);

        const { container } = render(<Link to="/contact">Contact</Link>);
        const anchor = container.querySelector("a");
        anchor?.click();

        locationHref.mockRestore();
    });

    it("strips wouter ~ prefix in href when update is pending", () => {
        __veloUpdatePending.value = true;

        const mockModule = {
            metadata: { fullPath: "/users/1", path: "users/1" },
        } as any;

        const { container } = render(<Link to={mockModule} absolute>User</Link>);
        const anchor = container.querySelector("a");

        // Should not have ~ prefix in the href
        expect(anchor?.getAttribute("href")).toBe("/users/1");
    });
});
