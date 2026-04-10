// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/preact";
import { Scripts } from "../src/components.js";

describe("Scripts", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
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
});
