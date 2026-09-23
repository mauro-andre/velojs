/**
 * `createTestApp({ port })` — the TCP listener mode of the testing toolkit.
 *
 * Real sockets onto the very same app instance: an actor outside this process
 * (a worker notifying the control-plane) cannot call `hono.fetch` in-memory.
 * Everything here binds loopback and dials `localhost` from this own process —
 * real TCP, zero external network.
 */

import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { WebSocket } from "ws";
import { h } from "preact";
import { createTestApp } from "../src/testing/index.js";
import type { CreateTestAppOptions, TestApp, TestResponse } from "../src/testing/index.js";
import { createEventStream } from "../src/events.js";
import { addRoutes, onServer } from "../src/server.js";
import type { AppRoutes, RouteModule } from "../src/types.js";
import type { SocketHandler } from "../src/sockets.js";

// ============================================
// Fixture app — page + loader + action + stream + socket, plus raw endpoints
// ============================================

/** Standalone stream (same registration path as a `stream_*` export). */
const stream_notify = createEventStream<{ msg: string }>({ path: "/_event/Jobs/notify" });

const action_notify = async ({ body }: any) => {
    stream_notify.emit(String(body?.channel ?? ""), { msg: "notified" });
    return { ok: true };
};

const loader_home = async () => ({ greeting: "hello" });

const socket_terminal: SocketHandler = async ({ incoming, send, keepOpen }) => {
    keepOpen();
    send({ type: "ready" });
    for await (const msg of incoming) {
        const parsed = typeof msg === "string" ? JSON.parse(msg) : null;
        send({ type: "echo", payload: parsed?.payload ?? null });
    }
};

const Root = ({ children }: any) => h("html", null, h("head", null), h("body", null, children));
const Home = () => h("div", { id: "home" }, "home");
const Jobs = () => h("div", { id: "jobs" }, "jobs");

function makeModule(mod: Record<string, unknown>): RouteModule {
    return { Component: () => null, ...mod } as unknown as RouteModule;
}

const routes: AppRoutes = [
    {
        module: makeModule({ Component: Root, metadata: { moduleId: "Root" } }),
        isRoot: true,
        children: [
            {
                path: "/",
                module: makeModule({
                    Component: Home,
                    metadata: { moduleId: "Home", fullPath: "/" },
                    loader: loader_home,
                }),
            },
            {
                path: "/jobs",
                module: makeModule({
                    Component: Jobs,
                    metadata: { moduleId: "Jobs", fullPath: "/jobs" },
                    action_notify,
                    socket_terminal,
                }),
            },
        ],
    },
];

/** Raw endpoints (auth-free) — the shapes whose headers/status are compared. */
async function fixtureEndpoints(): Promise<void> {
    addRoutes((app) => {
        app.get("/api/echo", (c) => {
            c.header("cache-control", "no-store");
            c.header("set-cookie", "sid=abc; Path=/; HttpOnly");
            return c.json({ ok: true, query: c.req.query() });
        });
        app.get("/api/text", (c) => c.text("plain text"));
        app.get("/api/redirect", (c) => c.redirect("/jobs", 302));
        app.post("/api/notify", async (c) => {
            const body = await c.req.json().catch(() => ({}));
            stream_notify.emit(String(body.channel ?? ""), { msg: "notified" });
            return c.json({ ok: true });
        });
    });
}

const openApps: TestApp[] = [];

async function makeApp(opts: Partial<CreateTestAppOptions> = {}): Promise<TestApp> {
    const app = await createTestApp({ routes, bootstrap: fixtureEndpoints, ...opts });
    openApps.push(app);
    return app;
}

/** `app.port` of a TCP app — fails loudly instead of comparing against undefined. */
function portOf(app: TestApp): number {
    if (app.port === undefined) throw new Error("expected a TCP listener, got app.port === undefined");
    return app.port;
}

afterEach(async () => {
    // close() is idempotent — a test may close early to assert the teardown.
    for (const app of openApps.splice(0)) await app.close();
});

// ============================================
// Helpers — response comparison and promise bounds
// ============================================

/**
 * Headers the HTTP listener frames on its own — `hono.fetch` never produces
 * them, and they say nothing about the app under test. `content-length` is the
 * listener sizing a body the in-memory response leaves unframed.
 */
const TRANSPORT_HEADERS = new Set([
    "date",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "content-length",
]);

/** Status, body and application headers must match the in-memory response. */
async function expectSameResponse(memory: TestResponse, tcp: Response): Promise<void> {
    expect(tcp.status).toBe(memory.status);
    expect(await tcp.text()).toBe(await memory.text());

    const tcpHeaders = Object.fromEntries(
        [...tcp.headers].filter(([key]) => !TRANSPORT_HEADERS.has(key))
    );
    const memoryHeaders = Object.fromEntries(
        Object.entries(memory.headers).filter(([key]) => !TRANSPORT_HEADERS.has(key))
    );
    expect(tcpHeaders).toEqual(memoryHeaders);
}

/** Rejects if `promise` does not settle within `ms` — a hang must fail, not stall. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`[test] timed out after ${ms}ms waiting for ${what}`)),
            ms
        );
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

function openEvent(ws: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
    });
}

/**
 * Real `ws` client with the message queue attached before the handshake:
 * the first server frame can travel with the 101 response, so a listener
 * attached after `open` would miss it.
 */
function wsClient(url: string) {
    const socket = new WebSocket(url);
    // Transport noise is not the signal here — the assertions are.
    socket.on("error", () => {});

    const opened = openEvent(socket);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

    const queue: string[] = [];
    const waiters: Array<(msg: string) => void> = [];
    socket.on("message", (data: any) => {
        const msg = data.toString();
        const waiter = waiters.shift();
        if (waiter) waiter(msg);
        else queue.push(msg);
    });

    return {
        socket,
        opened,
        closed,
        next(ms = 3000): Promise<string> {
            const queued = queue.shift();
            if (queued !== undefined) return Promise.resolve(queued);
            return new Promise<string>((resolve, reject) => {
                const wrapped = (msg: string) => {
                    clearTimeout(timer);
                    resolve(msg);
                };
                const timer = setTimeout(() => {
                    const idx = waiters.indexOf(wrapped);
                    if (idx !== -1) waiters.splice(idx, 1);
                    reject(new Error(`[test] no WebSocket message within ${ms}ms`));
                }, ms);
                waiters.push(wrapped);
            });
        },
    };
}

// ============================================
// HTTP parity with the in-memory path
// ============================================

describe("createTestApp({ port }) — HTTP over real sockets", () => {
    it("answers the same status, body and application headers as the in-memory API", async () => {
        const app = await makeApp({ port: 0 });
        const base = `http://localhost:${portOf(app)}`;

        const pairs: Array<[string, TestResponse]> = [
            ["/", await app.get("/")],
            ["/?_data=1", await app.get("/", { query: { _data: "1" } })],
            ["/jobs", await app.get("/jobs")],
            ["/api/echo?a=1", await app.get("/api/echo", { query: { a: "1" } })],
            ["/api/text", await app.get("/api/text")],
        ];

        for (const [path, memory] of pairs) {
            const tcp = await fetch(`${base}${path}`);
            expect(tcp.status, path).toBe(memory.status);
            await expectSameResponse(memory, tcp);
        }
    });

    it("answers a redirect with the same status and Location", async () => {
        const app = await makeApp({ port: 0 });

        const memory = await app.get("/api/redirect");
        const tcp = await fetch(`${app.url}/api/redirect`, { redirect: "manual" });

        expect(memory.status).toBe(302);
        expect(tcp.status).toBe(302);
        expect(tcp.headers.get("location")).toBe(memory.headers["location"]);
        expect(await tcp.text()).toBe(await memory.text());
    });
});

// ============================================
// Convergence — the same instance behind both paths
// ============================================

describe("createTestApp({ port }) — TCP and in-memory share the instance", () => {
    it("an action POSTed over TCP reaches a stream watched in-memory", async () => {
        const app = await makeApp({ port: 0, hostname: "127.0.0.1" });

        const sub = await app.subscribe(stream_notify, { channel: "podcubo-1" });
        expect(sub.status).toBe(200);

        const res = await fetch(`${app.url}/_action/Jobs/notify`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ channel: "podcubo-1" }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });

        expect(await sub.next({ timeoutMs: 2000 })).toEqual({ msg: "notified" });
        await sub.close();
    });

    it("an endpoint POSTed over TCP reaches a stream watched in-memory", async () => {
        const app = await makeApp({ port: 0, hostname: "127.0.0.1" });

        const sub = await app.subscribe(stream_notify, { channel: "podcubo-2" });
        expect(sub.status).toBe(200);

        const res = await fetch(`${app.url}/api/notify`, {
            method: "POST",
            body: JSON.stringify({ channel: "podcubo-2" }),
        });
        expect(res.status).toBe(200);

        expect(await sub.next({ timeoutMs: 2000 })).toEqual({ msg: "notified" });
        await sub.close();
    });
});

// ============================================
// Ports — ephemeral, coexistence, bind failure
// ============================================

describe("createTestApp({ port }) — binding", () => {
    it("port: 0 reports the real port and two apps coexist", async () => {
        const a = await makeApp({ port: 0, hostname: "127.0.0.1" });
        const b = await makeApp({ port: 0, hostname: "127.0.0.1" });

        expect(portOf(a)).toBeGreaterThan(0);
        expect(portOf(b)).toBeGreaterThan(0);
        expect(portOf(a)).not.toBe(portOf(b));

        const [resA, resB] = await Promise.all([
            fetch(`http://127.0.0.1:${portOf(a)}/api/text`),
            fetch(`http://127.0.0.1:${portOf(b)}/api/text`),
        ]);
        expect(resA.status).toBe(200);
        expect(resB.status).toBe(200);
        expect(await resA.text()).toBe("plain text");
        expect(await resB.text()).toBe("plain text");
    });

    it("rejects with the port and hostname when the bind fails", async () => {
        const blocker = net.createServer();
        await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
        const port = (blocker.address() as net.AddressInfo).port;

        try {
            const failure = await createTestApp({
                routes,
                bootstrap: fixtureEndpoints,
                port,
                hostname: "127.0.0.1",
            }).then(
                () => null,
                (err: Error) => err
            );

            expect(failure).toBeInstanceOf(Error);
            expect(failure!.message).toContain(`127.0.0.1:${port}`);
            expect(failure!.message).toContain("EADDRINUSE");
        } finally {
            await new Promise<void>((resolve) => blocker.close(() => resolve()));
        }
    });

    it("reports the explicit hostname; wildcard or omitted hostnames report localhost", async () => {
        const explicit = await makeApp({ port: 0, hostname: "127.0.0.1" });
        expect(explicit.url).toBe(`http://127.0.0.1:${portOf(explicit)}`);

        const omitted = await makeApp({ port: 0 });
        expect(omitted.url).toBe(`http://localhost:${portOf(omitted)}`);

        const wildcard = await makeApp({ port: 0, hostname: "0.0.0.0" });
        expect(wildcard.url).toBe(`http://localhost:${portOf(wildcard)}`);
    });

    it("onServer() in bootstrap receives the listening TCP server", async () => {
        let captured: import("http").Server | undefined;
        const app = await makeApp({
            port: 0,
            hostname: "127.0.0.1",
            bootstrap: async () => {
                await fixtureEndpoints();
                onServer((server) => { captured = server; });
            },
        });

        expect(captured).toBeDefined();
        expect(captured!.listening).toBe(true);
        expect((captured!.address() as net.AddressInfo).port).toBe(portOf(app));
        // The wait for 'listening' must not leave its error listener behind
        // (Node keeps its own 'listening' bookkeeping on every server).
        expect(captured!.listenerCount("error")).toBe(0);

        await app.close();

        // A closed listener is released: a late registrant queues for the next
        // server instead of receiving a dead instance.
        let late: unknown = "not called";
        onServer((server) => { late = server; });
        expect(late).toBe("not called");
    });

    it("app.as(user) keeps port and url", async () => {
        const app = await makeApp({
            port: 0,
            hostname: "127.0.0.1",
            getSessionCookie: () => ({ session: "signed" }),
        });

        const sub = app.as({ user: { id: "alice" } });

        expect(sub.port).toBe(app.port);
        expect(sub.url).toBe(app.url);
        expect((await sub.get("/api/text")).status).toBe(200);
    });
});

// ============================================
// WebSocket parity
// ============================================

describe("createTestApp({ port }) — WebSocket over the listener", () => {
    it("handshakes and exchanges messages with a real client", async () => {
        const app = await makeApp({ port: 0, hostname: "127.0.0.1" });
        const client = wsClient(
            `ws://127.0.0.1:${portOf(app)}/_socket/Jobs/terminal?channel=ws-1`
        );

        await within(client.opened, 3000, "the WebSocket handshake");
        expect(await client.next()).toBe(JSON.stringify({ type: "ready" }));

        client.socket.send(JSON.stringify({ type: "echo", payload: "hi" }));
        expect(JSON.parse(await client.next())).toEqual({ type: "echo", payload: "hi" });

        client.socket.close();
        await within(client.closed, 3000, "the client close");
    });
});

// ============================================
// close() — new connections refused, in-flight ones terminated
// ============================================

describe("createTestApp({ port }) — close()", () => {
    it("refuses new connections, is idempotent and leaves no listener behind", async () => {
        const app = await makeApp({ port: 0, hostname: "127.0.0.1" });
        const url = `http://127.0.0.1:${portOf(app)}/api/text`;

        expect((await fetch(url)).status).toBe(200);

        await app.close();
        await expect(app.close()).resolves.toBeUndefined();

        const failure: any = await fetch(url).then(() => null, (err: any) => err);
        expect(failure).toBeTruthy();
        expect(failure?.cause?.code ?? failure?.code).toBe("ECONNREFUSED");
    });

    it("resolves with an SSE stream open on the listener", async () => {
        const app = await makeApp({ port: 0, hostname: "127.0.0.1" });

        const res = await fetch(
            `http://127.0.0.1:${portOf(app)}${stream_notify.__path}?channel=sse-1`,
            { headers: { accept: "text/event-stream" } }
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");

        // Drain in the background so the connection is mid-stream at close().
        const reader = res.body!.getReader();
        const streamEnded = (async () => {
            try {
                while (!(await reader.read()).done) { /* keep the stream flowing */ }
            } catch {
                // close() drops the socket — an aborted read is the expected end
            }
        })();

        await within(app.close(), 3000, "close() with an SSE stream mid-flight");
        await within(streamEnded, 3000, "the SSE client read to finish");
    });

    it("resolves with a WebSocket open on the listener", async () => {
        const app = await makeApp({ port: 0, hostname: "127.0.0.1" });

        const client = wsClient(
            `ws://127.0.0.1:${portOf(app)}/_socket/Jobs/terminal?channel=ws-2`
        );
        await within(client.opened, 3000, "the WebSocket handshake");
        expect(await client.next()).toBe(JSON.stringify({ type: "ready" }));

        await within(app.close(), 3000, "close() with a WebSocket open");
        await within(client.closed, 3000, "the WebSocket client to close");
        expect(client.socket.readyState).toBe(WebSocket.CLOSED);
    });
});

// ============================================
// Default mode — untouched
// ============================================

describe("createTestApp — without port", () => {
    it("stays purely in-memory: no listener, no port, no url", async () => {
        const app = await makeApp();

        expect(app.port).toBeUndefined();
        expect(app.url).toBeUndefined();
        expect((await app.get("/api/text")).status).toBe(200);

        await app.close();
    });

    it("never takes the port from process.env.PORT/HOST", async () => {
        const prevPort = process.env.PORT;
        const prevHost = process.env.HOST;
        process.env.PORT = "9";
        process.env.HOST = "127.0.0.1";

        try {
            const app = await makeApp();
            expect(app.port).toBeUndefined();
            expect(app.url).toBeUndefined();
            await app.close();
        } finally {
            if (prevPort === undefined) delete process.env.PORT;
            else process.env.PORT = prevPort;
            if (prevHost === undefined) delete process.env.HOST;
            else process.env.HOST = prevHost;
        }
    });
});