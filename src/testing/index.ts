/**
 * @mauroandre/velojs/testing
 *
 * Backend testing toolkit for VeloJS apps. FastAPI-TestClient-style API:
 * spin up the app in memory, fire HTTP requests against the registered handlers,
 * subscribe to event streams, assert on the result. No socket, no browser.
 *
 * @example
 * ```typescript
 * import { createTestApp } from "@mauroandre/velojs/testing";
 * import routes from "../app/routes.js";
 *
 * const app = await createTestApp({ routes });
 * const res = await app.get("/api/health");
 * expect(res.status).toBe(200);
 * await app.close();
 * ```
 *
 * The live loader is exercised deterministically with `app.channel(module,
 * name)`: open a channel connection with a principal, emit and await the next
 * snapshot — no sleep, no retry.
 */

export { createTestApp } from "./createTestApp.js";
export type {
    TestApp,
    TestResponse,
    TestSubscription,
    TestChannelSubscription,
    ChannelModuleRef,
    CreateTestAppOptions,
    RequestOptions,
    BodyRequestOptions,
    LoaderRequestOptions,
    SubscribeOptions,
    NextOptions,
    MockContextOptions,
    Cookies,
    Headers,
    Query,
    Params,
} from "./types.js";
