/**
 * Live actions — dev/build guards (CA11) and the client stub address.
 *
 * The guards live in the Vite transform, where a module's declaration meets
 * the app's channel map — the same ruler the live loader uses. They are loud
 * on purpose: a `liveActions` entry naming an action the module does not
 * export, or a channel with no entry in `app/channels.ts`, fails the dev
 * server / the build instead of producing an inert route.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { veloPlugin, declaredLiveActions } from "../src/vite.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "velo-live-action-"));

const CHANNEL_MAP = `export const channels = {
    fichaProjeto: { scope: ({ user, args }: any) => \`projeto:\${args.id}\` },
    public: { scope: () => "all" },
};
`;

function writeApp(withMap: boolean): void {
    fs.rmSync(path.join(ROOT, "app"), { recursive: true, force: true });
    fs.mkdirSync(path.join(ROOT, "app/projeto"), { recursive: true });
    if (withMap) fs.writeFileSync(path.join(ROOT, "app/channels.ts"), CHANNEL_MAP);
}

function transformPlugin(): any {
    const plugin = (veloPlugin() as any[]).find((p) => p?.name === "velo:transform");
    plugin.configResolved({ root: ROOT });
    plugin.buildStart?.();
    return plugin;
}

/** The page module of a tab UI: a live action plus a plain one. */
const PAGE = `import type { ActionArgs } from "@mauroandre/velojs";

export const Component = () => null;

export const action_abrirFicha = async ({ body }: ActionArgs<{ id: number }>) => {
    const { ficha } = await import("./projeto.service.js");
    return ficha(body.id);
};

export const action_salvarFicha = async ({ body }: ActionArgs<{ id: number }>) => {
    const { salvar } = await import("./projeto.service.js");
    return salvar(body.id);
};

export const liveActions = { abrirFicha: ["fichaProjeto"] };
`;

const pagePath = (file: string) => path.join(ROOT, "app/projeto", file);

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

describe("live action — dev/build guards (CA11)", () => {
    it("a well-formed declaration transforms normally (control)", () => {
        const out = transformPlugin().transform(PAGE, pagePath("Projeto.tsx"), {});
        expect(out).not.toBeNull();
        expect(out.code).toContain("liveActions");
    });

    it("`liveActions` naming an action the module does not export is an explicit error", () => {
        const code = `export const Component = () => null;
export const action_abrirFicha = async ({ body }: any) => ({});
export const liveActions = { abrirOutra: ["fichaProjeto"] };
`;
        expect(() => transformPlugin().transform(code, pagePath("Typo.tsx"), {})).toThrow(
            /projeto\/Typo.*abrirOutra.*action_abrirOutra/,
        );
    });

    it("a channel with no entry in app/channels.ts is an explicit error naming it", () => {
        const code = `export const Component = () => null;
export const action_abrirFicha = async ({ body }: any) => ({});
export const liveActions = { abrirFicha: ["fichaProjeto", "fichaTypo"] };
`;
        expect(() => transformPlugin().transform(code, pagePath("Typo.tsx"), {})).toThrow(
            /fichaTypo.*app\/channels\.ts/,
        );
    });

    it("with no app/channels.ts at all, every declared channel is unknown", () => {
        writeApp(false);
        expect(() => transformPlugin().transform(PAGE, pagePath("Projeto.tsx"), {})).toThrow(
            /app\/channels\.ts/,
        );
    });

    it("a module may declare `channels` and `liveActions` side by side — both pass", () => {
        const code = `export const Component = () => null;
export const loader = async () => ({});
export const channels = ["public"];
export const action_abrirFicha = async ({ body }: any) => ({});
export const liveActions = { abrirFicha: ["fichaProjeto"] };
`;
        const out = transformPlugin().transform(code, pagePath("Both.tsx"), {});
        expect(out).not.toBeNull();
    });
});

// ============================================
// Static build (CA15)
// ============================================

describe("live action — static build (CA15)", () => {
    it("warns once per (module, action), naming both", () => {
        process.env.VELO_STATIC = "1";
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const plugin = transformPlugin();

        plugin.transform(PAGE, pagePath("Projeto.tsx"), {});
        plugin.transform(PAGE, pagePath("Projeto.tsx"), {});
        plugin.transform(PAGE, pagePath("Outro.tsx"), {});

        const warnings = warn.mock.calls.map((c) => String(c[0]));
        expect(warnings).toHaveLength(2); // once for Projeto#abrirFicha, once for Outro#abrirFicha
        expect(warnings[0]).toContain("projeto/Projeto");
        expect(warnings[0]).toContain("abrirFicha");
        expect(warnings[1]).toContain("projeto/Outro");
    });

    it("does not warn outside a static build", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        transformPlugin().transform(PAGE, pagePath("Projeto.tsx"), {});
        expect(warn).not.toHaveBeenCalled();
    });
});

// ============================================
// The client stub — the subscription address travels with the action
// ============================================

describe("live action — client stub", () => {
    it("the live action's stub carries __isVeloLiveAction and the /_live path (CA12)", () => {
        const out = transformPlugin().transform(PAGE, pagePath("Projeto.tsx"), {
            ssr: false,
        });
        // The stub is the fetch arrow wrapped with the live marks — the
        // `__path` ruler the socket stubs use.
        expect(out.code).toContain("__isVeloLiveAction: true");
        expect(out.code).toContain('"/_live/projeto/Projeto/abrirFicha"');
        expect(out.code).toContain("Object.assign");
    });

    it("an action not declared live keeps today's stub — no marks, no address", () => {
        const out = transformPlugin().transform(PAGE, pagePath("Projeto.tsx"), {
            ssr: false,
        });
        const salvar = out.code.split("action_salvarFicha")[1]!.split("export")[0];
        expect(salvar).not.toContain("__isVeloLiveAction");
        expect(salvar).not.toContain("/_live");
    });

    it("on the SSR pass the action bodies are untouched — the server runs them", () => {
        const out = transformPlugin().transform(PAGE, pagePath("Projeto.tsx"), {
            ssr: true,
        });
        expect(out.code).toContain("projeto.service.js");
        expect(out.code).not.toContain("__isVeloLiveAction");
    });
});

// ============================================
// The convention declaration
// ============================================

describe("live action — reading the declaration", () => {
    it("declaredLiveActions reads the object literal form", () => {
        expect(declaredLiveActions(PAGE)).toEqual({ abrirFicha: ["fichaProjeto"] });
        expect(declaredLiveActions(`export const Component = () => null;`)).toBeNull();
        // The satisfies form is unwrapped, arrays may hold several channels.
        expect(
            declaredLiveActions(
                `export const liveActions = { a: ["x", "y"], b: ["z"] } as const;`,
            ),
        ).toEqual({ a: ["x", "y"], b: ["z"] });
    });

    it("a `liveActions` that is not an object literal is not a declaration (the server guard is the backstop)", () => {
        expect(declaredLiveActions(`export const liveActions = compute();`)).toBeNull();
    });
});
