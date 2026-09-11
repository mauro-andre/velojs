import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "node:net";
import type { ComponentChildren } from "preact";
import { startServer, onServer } from "../src/server.js";
import type { AppRoutes } from "../src/types.js";

// @vitest-environment node

const Root = {
    Component: ({ children }: { children?: ComponentChildren }) => (
        <html>
            <head></head>
            <body>{children}</body>
        </html>
    ),
    metadata: { moduleId: "Root" },
};

const routes: AppRoutes = [
    {
        module: Root,
        isRoot: true,
        children: [
            {
                path: "/",
                module: {
                    Component: () => <div>home</div>,
                    metadata: { moduleId: "Home", fullPath: "/" },
                },
            },
        ],
    },
];

function freePort(): Promise<number> {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.listen(0, "127.0.0.1", () => {
            const port = (srv.address() as net.AddressInfo).port;
            srv.close(() => resolve(port));
        });
    });
}

let captured: import("http").Server | undefined;
let prevNodeEnv: string | undefined;
let prevHost: string | undefined;

beforeEach(() => {
    prevNodeEnv = process.env.NODE_ENV;
    prevHost = process.env.HOST;
    process.env.NODE_ENV = "production";
    delete process.env.HOST;
    captured = undefined;
    onServer((server) => {
        captured = server;
    });
});

afterEach(async () => {
    process.env.NODE_ENV = prevNodeEnv;
    if (prevHost === undefined) delete process.env.HOST;
    else process.env.HOST = prevHost;
    await new Promise<void>((r) => captured?.close(() => r()));
});

describe("startServer — hostname binding", () => {
    it("binds the configured hostname (loopback for local/sensitive apps)", async () => {
        const port = await freePort();
        await startServer({ routes, port, hostname: "127.0.0.1" } as any);

        const addr = captured!.address() as net.AddressInfo;
        expect(addr.address).toBe("127.0.0.1");
    });

    it("HOST env wins over the config hostname (same precedence as PORT)", async () => {
        process.env.HOST = "127.0.0.1";
        const port = await freePort();
        await startServer({ routes, port, hostname: "0.0.0.0" } as any);

        const addr = captured!.address() as net.AddressInfo;
        expect(addr.address).toBe("127.0.0.1");
    });

    it("default binds all interfaces — current behavior, unchanged (semver)", async () => {
        const port = await freePort();
        await startServer({ routes, port } as any);

        const addr = captured!.address() as net.AddressInfo;
        expect(["::", "0.0.0.0"]).toContain(addr.address);
    });
});
