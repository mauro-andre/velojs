/**
 * Live actions — telemetry (CA14): the subscription and every delivery are
 * traced as their own boundary, distinguishable from a loader's channel
 * connection in the JSONL and in `velojs telemetry`'s ranking.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestApp } from "../src/testing/index.js";
import { emit } from "../src/channels.js";
import { buildTelemetryReport, formatTelemetryReport } from "../src/telemetry-cli.js";
import { __resetTelemetry, flushTelemetry, type TelemetryEvent } from "../src/telemetry.js";
import type { ActionArgs, AppRoutes, LoaderArgs, RouteModule } from "../src/types.js";

// ============================================
// Fixture
// ============================================

let fichas: Record<number, { nome: string; fase: string }>;

const CHANNELS = {
    fichaProjeto: { scope: ({ args }: any) => (args?.id != null ? `projeto:${args.id}` : null) },
    teamExpenses: { scope: () => "all" },
};

const getSessionCookie = async ({ user }: { user: any }) => ({
    user: JSON.stringify(user),
});

const requireUser: MiddlewareHandler = async (c, next) => {
    const raw = getCookie(c, "user");
    if (!raw) return c.json({ error: "unauthorized" }, 401);
    (c.set as unknown as (k: string, v: unknown) => void)("user", JSON.parse(raw));
    await next();
};

function liveModule(): RouteModule {
    const mod: any = {
        Component: () => null,
        metadata: { moduleId: "projeto/Projeto", fullPath: "/projeto" },
        loader: async ({ c }: LoaderArgs) => ({ quem: (c.get as any)("user")?.id }),
        channels: ["teamExpenses"],
        action_abrirFicha: async ({ body }: ActionArgs<{ id: number }>) => ({ ...fichas[body.id]! }),
        liveActions: { abrirFicha: ["fichaProjeto"] },
    };
    return mod as RouteModule;
}

let dir: string;
let base: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
    fichas = { 7: { nome: "Site", fase: "build" } };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "velo-live-action-telemetry-"));
    base = path.join(dir, "telemetry.jsonl");
    savedEnv = {
        file: process.env.VELO_TELEMETRY_FILE,
        sink: process.env.VELO_TELEMETRY_SINK_URL,
        max: process.env.VELO_TELEMETRY_MAX_MB,
    };
    process.env.VELO_TELEMETRY_FILE = base;
    delete process.env.VELO_TELEMETRY_SINK_URL;
    delete process.env.VELO_TELEMETRY_MAX_MB;
    await __resetTelemetry();
});

afterEach(async () => {
    await __resetTelemetry();
    for (const [key, value] of [
        ["VELO_TELEMETRY_FILE", savedEnv.file],
        ["VELO_TELEMETRY_SINK_URL", savedEnv.sink],
        ["VELO_TELEMETRY_MAX_MB", savedEnv.max],
    ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
});

function effectiveFile(): string {
    const name = fs
        .readdirSync(dir)
        .find((entry) => entry.startsWith("telemetry.") && entry.endsWith(".jsonl"));
    if (!name) throw new Error(`no effective telemetry file in ${dir}`);
    return path.join(dir, name);
}

async function readEvents(): Promise<TelemetryEvent[]> {
    await flushTelemetry();
    return fs
        .readFileSync(effectiveFile(), "utf-8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as TelemetryEvent);
}

const ofType = (events: TelemetryEvent[], type: string): TelemetryEvent[] =>
    events.filter((event) => event.type === type);

// ============================================
// The boundary
// ============================================

describe("live action — telemetry (CA14)", () => {
    it("the subscription is its own trace: module and name, never a channel", async () => {
        const Mod = liveModule();
        const app = await createTestApp({
            routes: [{ path: "/projeto", module: Mod, middlewares: [requireUser] }],
            channels: CHANNELS,
            getSessionCookie,
        });

        const sub = await app
            .as({ user: { id: 1 } })
            .liveAction(Mod, "abrirFicha", { args: { id: 7 } });
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ nome: "Site", fase: "build" });

        fichas[7] = { nome: "Site", fase: "review" };
        await emit("fichaProjeto", { args: { id: 7 } });
        expect(await sub.next({ timeoutMs: 1000 })).toEqual({ nome: "Site", fase: "review" });

        await sub.close();

        const events = await readEvents();
        const connects = ofType(events, "live-action-connect");
        expect(connects).toHaveLength(1);
        expect(connects[0]).toMatchObject({
            route: "/_live/projeto/Projeto/abrirFicha",
            module: "projeto/Projeto",
            name: "abrirFicha",
            status: "ok",
        });
        expect(connects[0]!.channel).toBeUndefined(); // the loader twin carries a channel

        // The re-execution span names the action — the loader twin says loader:.
        const spans = (connects[0]!.spans ?? []).map((span) => span.name);
        expect(spans).toContain("snapshot");

        // One delivery line per snapshot (connect + emit), same trace.
        const trace = connects[0]!.trace;
        const deliveries = ofType(events, "delivery").filter((e) => e.trace === trace);
        expect(deliveries).toHaveLength(2);
        expect(deliveries[0]).toMatchObject({ module: "projeto/Projeto", name: "abrirFicha" });
        expect(deliveries[0]!.bytes).toBeGreaterThan(0);

        // The close line totals the deliveries.
        const closes = ofType(events, "close").filter((e) => e.trace === trace);
        expect(closes).toHaveLength(1);
        expect(closes[0]!.deliveries).toBe(2);

        await app.close();
    });

    it("the emit's re-execution span is named after the action, apart from the loader's", async () => {
        const Mod = liveModule();
        const app = await createTestApp({
            routes: [{ path: "/projeto", module: Mod, middlewares: [requireUser] }],
            channels: CHANNELS,
            getSessionCookie,
        });
        const user = app.as({ user: { id: 1 } });

        // One loader connection (channel) and one live subscription — the two
        // surfaces of the same registry, awakened by their own emits.
        const page = await user.channel(Mod, "teamExpenses");
        await page.next({ timeoutMs: 1000 });
        const tab = await user.liveAction(Mod, "abrirFicha", { args: { id: 7 } });
        await tab.next({ timeoutMs: 1000 });

        await emit("teamExpenses", {});
        await emit("fichaProjeto", { args: { id: 7 } });
        await page.next({ timeoutMs: 1000 });
        await tab.next({ timeoutMs: 1000 });

        const events = await readEvents();
        const emitTraces = ofType(events, "emit");
        const spanNames = emitTraces.flatMap((t) => (t.spans ?? []).map((s) => s.name));
        expect(spanNames).toContain("loader:projeto/Projeto");
        expect(spanNames).toContain("action:projeto/Projeto/abrirFicha");

        // Each emit stays one line per gesture.
        expect(emitTraces).toHaveLength(2);

        await page.close();
        await tab.close();
        await app.close();
    });

    it("`velojs telemetry` ranks the live action apart from the channels (CA14)", async () => {
        const Mod = liveModule();
        const app = await createTestApp({
            routes: [{ path: "/projeto", module: Mod, middlewares: [requireUser] }],
            channels: CHANNELS,
            getSessionCookie,
        });
        const user = app.as({ user: { id: 1 } });

        const page = await user.channel(Mod, "teamExpenses");
        await page.next({ timeoutMs: 1000 });
        const tab = await user.liveAction(Mod, "abrirFicha", { args: { id: 7 } });
        await tab.next({ timeoutMs: 1000 });

        fichas[7] = { nome: "Site", fase: "review" };
        await emit("fichaProjeto", { args: { id: 7 } });
        await tab.next({ timeoutMs: 1000 });

        await page.close();
        await tab.close();
        await app.close();

        const events = await readEvents();
        const report = buildTelemetryReport([effectiveFile()], events);

        const liveRow = report.liveActions.find((row) => row.key === "projeto/Projeto/abrirFicha");
        expect(liveRow).toBeDefined();
        expect(liveRow!.count).toBeGreaterThanOrEqual(3); // connect + delivery + close
        expect(liveRow!.bytes).toBeGreaterThan(0);        // the snapshots' bytes

        // The channel ranking holds the loader surface; the live action is its
        // own ranking — distinguishable, as the criterion demands.
        expect(report.channels.map((row) => row.key)).toContain("teamExpenses");
        expect(report.channels.map((row) => row.key)).not.toContain("projeto/Projeto/abrirFicha");

        const text = formatTelemetryReport(report, null, Date.now());
        expect(text).toContain("By live action");
        expect(text).toContain("projeto/Projeto/abrirFicha");
    });
});
