import { describe, it, expect, afterEach } from "vitest";
import { resolveConfig } from "vite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

// Same pipeline, but with a full veloPlugin config (hostname, port, ...).
const resolveDevWith = (
    veloConfig: Record<string, unknown> = {},
    inline: Record<string, unknown> = {},
) =>
    resolveConfig(
        {
            configFile: false,
            root: process.cwd(),
            plugins: [veloPlugin(veloConfig)],
            ...inline,
        },
        "serve",
    );

// Temp project roots carrying a `.env` — the files Vite itself loads.
const tempRoots: string[] = [];
const makeRootWithEnv = (content: string): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "velo-host-"));
    fs.writeFileSync(path.join(root, ".env"), content);
    tempRoots.push(root);
    return root;
};

const originalPort = process.env.PORT;
const originalHost = process.env.HOST;

afterEach(() => {
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;

    if (originalHost === undefined) delete process.env.HOST;
    else process.env.HOST = originalHost;

    for (const root of tempRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
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

describe("veloPlugin — dev server host (HOST env in dev)", () => {
    it("leaves Vite's default (loopback) when nothing is declared", async () => {
        delete process.env.HOST;
        const resolved = await resolveDev();
        expect(resolved.server.host).toBeUndefined();
        // Not a broad bind → Vite's DNS-rebinding guard stays on.
        expect(resolved.server.allowedHosts).not.toBe(true);
    });

    it("reads HOST from the process env, binding every interface", async () => {
        process.env.HOST = "0.0.0.0";
        const resolved = await resolveDev();
        expect(resolved.server.host).toBe("0.0.0.0");
    });

    it("keeps loopback when HOST is a specific interface", async () => {
        process.env.HOST = "127.0.0.1";
        const resolved = await resolveDev();
        expect(resolved.server.host).toBe("127.0.0.1");
        expect(resolved.server.allowedHosts).not.toBe(true);
    });

    it("reads HOST from the project's .env when the shell has none", async () => {
        delete process.env.HOST;
        const root = makeRootWithEnv("HOST=0.0.0.0\n");
        const resolved = await resolveDev({ root });
        expect(resolved.server.host).toBe("0.0.0.0");
    });

    it("lets the process HOST win over the .env HOST", async () => {
        process.env.HOST = "127.0.0.1";
        const root = makeRootWithEnv("HOST=0.0.0.0\n");
        const resolved = await resolveDev({ root });
        expect(resolved.server.host).toBe("127.0.0.1");
    });

    it("uses hostname from veloPlugin() when no env/flag declares one", async () => {
        delete process.env.HOST;
        const resolved = await resolveDevWith({ hostname: "127.0.0.1" });
        expect(resolved.server.host).toBe("127.0.0.1");
        expect(resolved.server.allowedHosts).not.toBe(true);
    });

    it("lets the HOST env win over veloPlugin({ hostname })", async () => {
        process.env.HOST = "0.0.0.0";
        const resolved = await resolveDevWith({ hostname: "127.0.0.1" });
        expect(resolved.server.host).toBe("0.0.0.0");
    });

    it("does not clobber an explicit server.host (velojs dev --host)", async () => {
        process.env.HOST = "0.0.0.0";
        const resolved = await resolveDev({ server: { host: "127.0.0.1" } });
        expect(resolved.server.host).toBe("127.0.0.1");
        expect(resolved.server.allowedHosts).not.toBe(true);
    });
});

describe("veloPlugin — dev server allowed hosts (broad bind)", () => {
    // The three broad-bind triggers: `0.0.0.0`, `::`, and `--host` with no
    // value (which reaches Vite as server.host === true).
    it("allows any Host header when HOST=0.0.0.0", async () => {
        process.env.HOST = "0.0.0.0";
        const resolved = await resolveDev();
        expect(resolved.server.allowedHosts).toBe(true);
    });

    it("allows any Host header when HOST=::", async () => {
        process.env.HOST = "::";
        const resolved = await resolveDev();
        expect(resolved.server.allowedHosts).toBe(true);
    });

    it("allows any Host header when --host has no value (host === true)", async () => {
        delete process.env.HOST;
        const resolved = await resolveDev({ server: { host: true } });
        expect(resolved.server.host).toBe(true);
        expect(resolved.server.allowedHosts).toBe(true);
    });

    it("opens the guard when veloPlugin({ hostname: '0.0.0.0' })", async () => {
        delete process.env.HOST;
        const resolved = await resolveDevWith({ hostname: "0.0.0.0" });
        expect(resolved.server.host).toBe("0.0.0.0");
        expect(resolved.server.allowedHosts).toBe(true);
    });

    it("respects a server.allowedHosts declared by the project on a broad bind", async () => {
        process.env.HOST = "0.0.0.0";
        const resolved = await resolveDev({
            server: { allowedHosts: ["app.exemplo.com"] },
        });
        expect(resolved.server.host).toBe("0.0.0.0");
        expect(resolved.server.allowedHosts).not.toBe(true);
        expect(resolved.server.allowedHosts).toContain("app.exemplo.com");
    });
});