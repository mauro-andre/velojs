import { describe, it, expect, afterEach } from "vitest";
import { resolveConfig } from "vite";
import { veloPlugin } from "../src/vite.js";

// Resolve a dev config through the real Vite pipeline, so we exercise Vite's
// actual merge semantics (a plugin's config() return is merged LAST and wins)
// rather than our assumption about them.
const resolveDev = (inline: Record<string, unknown> = {}, pluginPort?: number) =>
    resolveConfig(
        {
            configFile: false,
            root: process.cwd(),
            plugins: [veloPlugin(pluginPort ? { port: pluginPort } : {})],
            ...inline,
        },
        "serve",
    );

const originalPort = process.env.PORT;
afterEach(() => {
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
});

describe("veloPlugin — dev server port", () => {
    it("defaults to 3000", async () => {
        delete process.env.PORT;
        const resolved = await resolveDev();
        expect(resolved.server.port).toBe(3000);
    });

    it("uses the port from veloPlugin({ port })", async () => {
        delete process.env.PORT;
        const resolved = await resolveDev({}, 4000);
        expect(resolved.server.port).toBe(4000);
    });

    it("lets the PORT env win over veloPlugin({ port })", async () => {
        process.env.PORT = "8080";
        const resolved = await resolveDev({}, 4000);
        expect(resolved.server.port).toBe(8080);
    });

    it("does not clobber an explicit server.port (velojs dev --port)", async () => {
        // `velojs dev --port 5000` forwards to `vite --port 5000`, which lands
        // in the inline config as server.port. Vite merges a plugin's config()
        // return LAST, so returning server.port unconditionally silently ate
        // the flag.
        delete process.env.PORT;
        const resolved = await resolveDev({ server: { port: 5000 } }, 4000);
        expect(resolved.server.port).toBe(5000);
    });

    it("an explicit server.port also beats the PORT env", async () => {
        process.env.PORT = "8080";
        const resolved = await resolveDev({ server: { port: 5000 } });
        expect(resolved.server.port).toBe(5000);
    });
});
