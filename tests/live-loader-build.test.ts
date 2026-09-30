/**
 * Live loader — dev/build guards (CA9, CA10) and the convention-file parsing.
 *
 * The guards live in the Vite transform, which is where a module's declaration
 * meets the app's channel map. They are loud on purpose: a `channels` export
 * without a loader, or a channel with no entry in `app/channels.ts`, fails the
 * dev server / the build instead of producing an inert channel.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
    veloPlugin,
    declaredChannelNames,
    readChannelMapNames,
} from "../src/vite.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "velo-live-loader-"));

const CHANNEL_MAP = `export const channels = {
    gastosFamilia: { scope: (ctx: any) => \`familia:\${ctx.familiaId}\` },
    publico: { scope: () => "all" },
};
`;

function writeApp(withMap: boolean): void {
    fs.rmSync(path.join(ROOT, "app"), { recursive: true, force: true });
    fs.mkdirSync(path.join(ROOT, "app/pages"), { recursive: true });
    if (withMap) fs.writeFileSync(path.join(ROOT, "app/channels.ts"), CHANNEL_MAP);
}

function transformPlugin(): any {
    const plugin = (veloPlugin() as any[]).find((p) => p?.name === "velo:transform");
    plugin.configResolved({ root: ROOT });
    plugin.buildStart?.();
    return plugin;
}

const PAGE = `export const Component = () => null;
export const loader = async ({ c }: any) => ({ soma: 1 });
export const channels = ["gastosFamilia"];
`;

const pagePath = (file: string) => path.join(ROOT, "app/pages", file);

let staticEnv: string | undefined;

beforeEach(() => {
    writeApp(true);
    staticEnv = process.env.VELO_STATIC;
    delete process.env.VELO_STATIC;
});

afterEach(() => {
    if (staticEnv === undefined) delete process.env.VELO_STATIC;
    else process.env.VELO_STATIC = staticEnv;
    vi.restoreAllMocks();
});

// ============================================
// Guards
// ============================================

describe("live loader — dev/build guards (CA9)", () => {
    it("a declared channel with an entry in the map transforms normally (control)", () => {
        const out = transformPlugin().transform(PAGE, pagePath("Gastos.tsx"), {});
        expect(out).not.toBeNull();
        expect(out.code).toContain("gastosFamilia");
        expect(out.code).toContain("moduleId");
    });

    it("`channels` without a `loader` is an explicit error", () => {
        const code = `export const Component = () => null;
export const channels = ["gastosFamilia"];
`;
        expect(() => transformPlugin().transform(code, pagePath("Bad.tsx"), {})).toThrow(
            /without a `loader`/,
        );
    });

    it("a channel with no entry in app/channels.ts is an explicit error naming it", () => {
        const code = `export const Component = () => null;
export const loader = async () => ({});
export const channels = ["gastosFamila"];
`;
        expect(() => transformPlugin().transform(code, pagePath("Typo.tsx"), {})).toThrow(
            /gastosFamila/,
        );
    });

    it("with no app/channels.ts at all, every declared channel is unknown", () => {
        writeApp(false);
        expect(() => transformPlugin().transform(PAGE, pagePath("Gastos.tsx"), {})).toThrow(
            /app\/channels\.ts/,
        );
    });

    it("app/channels.ts itself is not a module declaring channels", () => {
        const plugin = transformPlugin();
        const out = plugin.transform(
            CHANNEL_MAP,
            path.join(ROOT, "app/channels.ts"),
            {},
        );
        // The map file exports an object — no channel declaration, no transforms.
        expect(out).toBeNull();
    });
});

// ============================================
// Static build
// ============================================

describe("live loader — static build (CA10)", () => {
    it("warns once per module, naming it", () => {
        process.env.VELO_STATIC = "1";
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const plugin = transformPlugin();

        plugin.transform(PAGE, pagePath("Gastos.tsx"), {});
        plugin.transform(PAGE, pagePath("Gastos.tsx"), {});
        plugin.transform(PAGE, pagePath("Gastos.tsx"), {});

        const warnings = warn.mock.calls.map((c) => String(c[0]));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("pages/Gastos");
        expect(warnings[0]).toContain("gastosFamilia");
    });

    it("does not warn outside a static build", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        transformPlugin().transform(PAGE, pagePath("Gastos.tsx"), {});
        expect(warn).not.toHaveBeenCalled();
    });
});

// ============================================
// The convention file
// ============================================

describe("live loader — reading the conventions", () => {
    it("declaredChannelNames reads the array form and ignores the object form", () => {
        expect(declaredChannelNames(PAGE)).toEqual(["gastosFamilia"]);
        expect(declaredChannelNames(CHANNEL_MAP)).toBeNull();
        expect(declaredChannelNames(`export const Component = () => null;`)).toBeNull();
    });

    it("readChannelMapNames collects the keys of the app map", () => {
        const names = readChannelMapNames(path.join(ROOT, "app/channels.ts"));
        expect([...names]).toEqual(["gastosFamilia", "publico"]);
        expect(readChannelMapNames(path.join(ROOT, "app/nope.ts")).size).toBe(0);
    });
});

// ============================================
// Virtual entry — the app map is registered for the server
// ============================================

describe("live loader — virtual server entry", () => {
    it("imports and registers app/channels.ts when it exists", () => {
        const out = transformPlugin().load("\0virtual:velo/server-entry");
        expect(out).toContain("registerChannels");
        expect(out).toContain("channels.js");
    });

    it("registers nothing when the app has no channel map", () => {
        writeApp(false);
        const out = transformPlugin().load("\0virtual:velo/server-entry");
        expect(out).not.toContain("registerChannels");
    });
});
