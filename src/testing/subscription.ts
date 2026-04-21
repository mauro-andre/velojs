/**
 * SSE subscription helper — parses the SSE protocol from a streaming Response
 * and exposes assertion-friendly methods for tests.
 */

import type { TestSubscription, NextOptions } from "./types.js";

interface SseEvent {
    event: string; // default "message"
    data: string;
    id?: string;
}

/** Parses chunks of `event: foo\ndata: bar\n\n` into SseEvent objects. */
class SseParser {
    private buffer = "";
    private current: { event: string; data: string[]; id?: string } = {
        event: "message",
        data: [],
    };

    push(chunk: string): SseEvent[] {
        this.buffer += chunk;
        const events: SseEvent[] = [];

        let idx;
        while ((idx = this.buffer.indexOf("\n")) !== -1) {
            const line = this.buffer.slice(0, idx);
            this.buffer = this.buffer.slice(idx + 1);

            if (line === "") {
                // End of event
                if (this.current.data.length > 0 || this.current.event !== "message") {
                    const ev: SseEvent = {
                        event: this.current.event,
                        data: this.current.data.join("\n"),
                    };
                    if (this.current.id !== undefined) ev.id = this.current.id;
                    events.push(ev);
                }
                this.current = { event: "message", data: [] };
                continue;
            }

            // SSE comment (heartbeat): line starts with ":"
            if (line.startsWith(":")) continue;

            const colon = line.indexOf(":");
            if (colon === -1) continue;
            const field = line.slice(0, colon);
            let value = line.slice(colon + 1);
            if (value.startsWith(" ")) value = value.slice(1);

            if (field === "event") this.current.event = value;
            else if (field === "data") this.current.data.push(value);
            else if (field === "id") this.current.id = value;
        }

        return events;
    }
}

interface BuildSubscriptionOptions {
    response: Response;
    parseJson?: boolean;
}

export async function buildSubscription<TEvent, TSnapshot>(
    opts: BuildSubscriptionOptions
): Promise<TestSubscription<TEvent, TSnapshot>> {
    const { response } = opts;
    const status = response.status;
    const events: TEvent[] = [];
    let snapshot: TSnapshot | null = null;
    let closed = false;
    let parseError: Error | null = null;

    // Pending "next" waiters, FIFO
    const waiters: Array<{
        resolve: (e: TEvent) => void;
        reject: (err: Error) => void;
    }> = [];

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let pumpDone = Promise.resolve<void>(undefined);

    const settleAll = (err?: Error) => {
        while (waiters.length > 0) {
            const w = waiters.shift()!;
            if (err) w.reject(err);
            else w.reject(new Error("[velojs/testing] subscription closed before next event"));
        }
    };

    if (status >= 200 && status < 300 && response.body) {
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();

        pumpDone = (async () => {
            try {
                while (true) {
                    const { value, done } = await reader!.read();
                    if (done) {
                        if (!closed) {
                            // Server-initiated EOF without a "close" event — treat as closed
                            closed = true;
                        }
                        settleAll();
                        return;
                    }
                    const chunk = decoder.decode(value, { stream: true });
                    const sseEvents = parser.push(chunk);
                    for (const sse of sseEvents) {
                        if (sse.event === "snapshot") {
                            try {
                                snapshot = JSON.parse(sse.data) as TSnapshot;
                            } catch (e) {
                                parseError = e as Error;
                            }
                            continue;
                        }
                        if (sse.event === "close") {
                            closed = true;
                            settleAll();
                            // Cancel reader so the loop exits
                            reader!.cancel().catch(() => {});
                            return;
                        }
                        if (sse.event === "heartbeat") continue;
                        // Default "message" event
                        try {
                            const parsed = JSON.parse(sse.data) as TEvent;
                            events.push(parsed);
                            const w = waiters.shift();
                            if (w) w.resolve(parsed);
                        } catch (e) {
                            parseError = e as Error;
                        }
                    }
                }
            } catch (err: any) {
                if (err?.name === "AbortError") {
                    settleAll();
                    return;
                }
                settleAll(err);
            }
        })();
    } else {
        // Non-2xx response — drain body and consider closed
        await response.text().catch(() => "");
        closed = true;
    }

    const sub: TestSubscription<TEvent, TSnapshot> = {
        get status() { return status; },
        get events() { return events as ReadonlyArray<TEvent>; },
        get snapshot() { return snapshot; },
        get closed() { return closed; },

        async next({ timeoutMs }: NextOptions): Promise<TEvent> {
            if (parseError) throw parseError;
            if (events.length > waitedCount) {
                const event = events[waitedCount]!;
                waitedCount++;
                return event;
            }
            if (closed) {
                throw new Error("[velojs/testing] subscription is closed");
            }
            return new Promise<TEvent>((resolve, reject) => {
                const timer = setTimeout(() => {
                    const idx = waiters.findIndex((w) => w.resolve === wrapResolve);
                    if (idx !== -1) waiters.splice(idx, 1);
                    reject(new Error(
                        `[velojs/testing] timed out after ${timeoutMs}ms waiting for next event`
                    ));
                }, timeoutMs);
                const wrapResolve = (e: TEvent) => {
                    clearTimeout(timer);
                    waitedCount++;
                    resolve(e);
                };
                const wrapReject = (err: Error) => {
                    clearTimeout(timer);
                    reject(err);
                };
                waiters.push({ resolve: wrapResolve, reject: wrapReject });
            });
        },

        async nextN(n: number, { timeoutMs }: NextOptions): Promise<TEvent[]> {
            const start = Date.now();
            const out: TEvent[] = [];
            for (let i = 0; i < n; i++) {
                const remaining = timeoutMs - (Date.now() - start);
                if (remaining <= 0) {
                    throw new Error(
                        `[velojs/testing] timed out after ${timeoutMs}ms waiting for ${n} events (got ${out.length})`
                    );
                }
                out.push(await sub.next({ timeoutMs: remaining }));
            }
            return out;
        },

        async close(): Promise<void> {
            if (reader) {
                try {
                    await reader.cancel();
                } catch {}
            }
            closed = true;
            settleAll();
            await pumpDone.catch(() => {});
        },
    };

    // Track how many events the consumer has already taken
    let waitedCount = 0;

    return sub;
}
