import { describe, it, expect, vi } from "vitest";
import { createTestApp } from "../src/testing/index.js";
import type { SocketHandler } from "../src/sockets.js";
import { parseJson } from "../src/sockets.js";
import type { AppRoutes, RouteModule } from "../src/types.js";

function makeModuleWithSocket(opts: {
    moduleId: string;
    sockets?: Record<string, SocketHandler>;
}): RouteModule {
    const mod: any = {
        Component: () => null,
        metadata: { moduleId: opts.moduleId },
    };
    for (const [name, handler] of Object.entries(opts.sockets ?? {})) {
        mod[`socket_${name}`] = handler;
    }
    return mod as RouteModule;
}

// ============================================
// socket_* — basics
// ============================================

describe("socket_* — basic lifecycle", () => {
    it("invokes the handler and delivers send() output to the client", async () => {
        const terminal: SocketHandler = async ({ send, keepOpen }) => {
            send({ type: "greet", msg: "hi" });
            keepOpen();
        };

        const module = makeModuleWithSocket({
            moduleId: "workers/Terminal",
            sockets: { terminal },
        });

        const app = await createTestApp({
            routes: [{ path: "/workers", module }] as AppRoutes,
        });

        const ws = await app.socket(terminal, { channel: "abc" });
        const first = await ws.next({ timeoutMs: 200 });
        expect(first).toBe(JSON.stringify({ type: "greet", msg: "hi" }));
        await ws.close();
        await app.close();
    });

    it("echoes messages client → server → client via incoming + send", async () => {
        const echo: SocketHandler = async ({ incoming, send, keepOpen }) => {
            keepOpen();
            for await (const msg of incoming) {
                send(`echo:${typeof msg === "string" ? msg : "[binary]"}`);
            }
        };

        const module = makeModuleWithSocket({
            moduleId: "test/Echo",
            sockets: { echo },
        });
        const app = await createTestApp({ routes: [{ module }] as AppRoutes });

        const ws = await app.socket(echo);
        ws.send("hello");
        const reply = await ws.next({ timeoutMs: 200 });
        expect(reply).toBe("echo:hello");

        ws.send({ foo: 1 });
        const reply2 = await ws.next({ timeoutMs: 200 });
        expect(reply2).toBe(`echo:${JSON.stringify({ foo: 1 })}`);

        await ws.close();
        await app.close();
    });

    it("close() from client aborts the handler's abortSignal", async () => {
        let aborted = false;
        const handler: SocketHandler = async ({ abortSignal, keepOpen }) => {
            keepOpen();
            abortSignal.addEventListener("abort", () => { aborted = true; });
            await new Promise<void>((r) =>
                abortSignal.addEventListener("abort", () => r())
            );
        };

        const module = makeModuleWithSocket({
            moduleId: "test/AbortSignal",
            sockets: { thing: handler },
        });
        const app = await createTestApp({ routes: [{ module }] as AppRoutes });

        const ws = await app.socket(handler);
        await new Promise((r) => setTimeout(r, 10));
        expect(aborted).toBe(false);

        await ws.close();
        expect(aborted).toBe(true);
        await app.close();
    });

    it("handler returning without keepOpen closes the session", async () => {
        const shortLived: SocketHandler = async ({ send }) => {
            send("bye");
            // no keepOpen → session auto-closes on return
        };

        const module = makeModuleWithSocket({
            moduleId: "test/Short",
            sockets: { x: shortLived },
        });
        const app = await createTestApp({ routes: [{ module }] as AppRoutes });

        const ws = await app.socket(shortLived);
        await ws.done;
        expect(ws.closed).toBe(true);
        await app.close();
    });

    it("handler that throws finalizes the session and does not crash the test", async () => {
        const errSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});

        const crasher: SocketHandler = async () => {
            throw new Error("boom");
        };

        const module = makeModuleWithSocket({
            moduleId: "test/Crash",
            sockets: { c: crasher },
        });
        const app = await createTestApp({ routes: [{ module }] as AppRoutes });

        const ws = await app.socket(crasher);
        await ws.done;
        expect(ws.closed).toBe(true);
        expect(errSpy).toHaveBeenCalledWith(
            expect.stringContaining("socket handler threw"),
            expect.any(Error)
        );
        errSpy.mockRestore();
        await app.close();
    });
});

// ============================================
// socket_* — context, user, params, query
// ============================================

describe("socket_* — context", () => {
    it("handler receives user via c.get() and params/query", async () => {
        const captured: any = {};
        const handler: SocketHandler = async ({ c, params, query, keepOpen }) => {
            captured.user = c.get("user");
            captured.params = params;
            captured.query = query;
            keepOpen();
        };

        const module = makeModuleWithSocket({
            moduleId: "test/Ctx",
            sockets: { ctx: handler },
        });
        const app = await createTestApp({ routes: [{ module }] as AppRoutes });

        const ws = await app.socket(handler, {
            user: { id: "u1", name: "Alice" },
            params: { workerId: "w42" },
            query: { tenant: "acme" },
            channel: "live",
        });
        await new Promise((r) => setTimeout(r, 10));

        expect(captured.user).toEqual({ id: "u1", name: "Alice" });
        expect(captured.params).toEqual({ workerId: "w42" });
        expect(captured.query.tenant).toBe("acme");
        expect(captured.query.channel).toBe("live");

        await ws.close();
        await app.close();
    });
});

// ============================================
// parseJson helper
// ============================================

describe("parseJson helper", () => {
    it("parses incoming frames and skips malformed JSON", async () => {
        const received: any[] = [];
        const handler: SocketHandler = async ({ incoming, send, keepOpen }) => {
            keepOpen();
            for await (const msg of parseJson<{ type: string; value?: number }>(incoming)) {
                received.push(msg);
                send({ echoed: msg });
            }
        };

        const module = makeModuleWithSocket({
            moduleId: "test/Json",
            sockets: { json: handler },
        });
        const app = await createTestApp({ routes: [{ module }] as AppRoutes });

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        const ws = await app.socket(handler);
        ws.send({ type: "a", value: 1 });
        ws.send("not-json-{");
        ws.send({ type: "b", value: 2 });

        const [first, second] = await ws.nextN(2, { timeoutMs: 200 });
        expect(JSON.parse(first as string)).toEqual({ echoed: { type: "a", value: 1 } });
        expect(JSON.parse(second as string)).toEqual({ echoed: { type: "b", value: 2 } });

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("invalid JSON frame")
        );

        await ws.close();
        warnSpy.mockRestore();
        await app.close();
    });
});

// ============================================
// socket_* — registry + app.close
// ============================================

describe("socket_* — registry + app.close", () => {
    it("app.close aborts open socket sessions", async () => {
        let aborted = false;
        const handler: SocketHandler = async ({ abortSignal, keepOpen }) => {
            keepOpen();
            abortSignal.addEventListener("abort", () => { aborted = true; });
            await new Promise<void>((r) =>
                abortSignal.addEventListener("abort", () => r())
            );
        };

        const module = makeModuleWithSocket({
            moduleId: "test/RegClose",
            sockets: { s: handler },
        });
        const app = await createTestApp({ routes: [{ module }] as AppRoutes });

        await app.socket(handler);
        await new Promise((r) => setTimeout(r, 5));
        expect(aborted).toBe(false);

        await app.close();
        expect(aborted).toBe(true);
    });

    it("app.socket(path) resolves by string path in the registry", async () => {
        const ping: SocketHandler = async ({ send }) => {
            send("pong");
        };

        const module = makeModuleWithSocket({
            moduleId: "net/Ping",
            sockets: { ping },
        });
        const app = await createTestApp({ routes: [{ module }] as AppRoutes });

        const ws = await app.socket("/_socket/net/Ping/ping");
        const reply = await ws.next({ timeoutMs: 200 });
        expect(reply).toBe("pong");

        await app.close();
    });

    it("app.socket() throws a clear error when the handler is unknown", async () => {
        const app = await createTestApp({ routes: [] as AppRoutes });
        await expect(
            app.socket("/_socket/nope/thing")
        ).rejects.toThrow(/no socket handler registered/);
        await app.close();
    });
});
