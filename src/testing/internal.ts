/**
 * Internal helpers — not exported from `@mauroandre/velojs/testing`.
 */

import type { Cookies, Headers as TestHeaders, Query } from "./types.js";

/** Serialize cookies object into a `Cookie` header value. */
export function serializeCookies(cookies?: Cookies): string | undefined {
    if (!cookies) return undefined;
    const entries = Object.entries(cookies);
    if (entries.length === 0) return undefined;
    return entries
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("; ");
}

/** Parse Set-Cookie header(s) into a cookies record (best effort). */
export function parseSetCookies(headers: Headers): Cookies {
    const out: Cookies = {};
    // headers.getSetCookie() is the standard way (Node 22+, undici)
    const list: string[] = (headers as any).getSetCookie?.() ?? [];
    for (const raw of list) {
        const firstSemi = raw.indexOf(";");
        const pair = firstSemi === -1 ? raw : raw.slice(0, firstSemi);
        const eq = pair.indexOf("=");
        if (eq === -1) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (name) out[name] = decodeURIComponent(value);
    }
    return out;
}

/** Convert query object to URL search string (without leading `?`). */
export function buildQueryString(query?: Query): string {
    if (!query) return "";
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
        if (Array.isArray(v)) {
            for (const item of v) params.append(k, item);
        } else {
            params.set(k, v);
        }
    }
    const s = params.toString();
    return s ? `?${s}` : "";
}

/** Convert headers record (any case) to a Headers instance. */
export function toHeaders(record?: TestHeaders): Headers {
    const h = new Headers();
    if (!record) return h;
    for (const [k, v] of Object.entries(record)) h.set(k, v);
    return h;
}

/** Headers instance → flat record. */
export function fromHeaders(h: Headers): TestHeaders {
    const out: TestHeaders = {};
    h.forEach((v, k) => {
        out[k] = v;
    });
    return out;
}

/**
 * Encode a body for fetch:
 * - FormData / URLSearchParams / Blob / ReadableStream / string → passed as-is
 * - undefined/null → no body
 * - everything else → JSON.stringify + Content-Type: application/json
 */
export function encodeBody(body: unknown): {
    body: BodyInit | null;
    contentType: string | null;
} {
    if (body == null) return { body: null, contentType: null };
    if (
        typeof body === "string" ||
        body instanceof FormData ||
        body instanceof URLSearchParams ||
        body instanceof Blob ||
        body instanceof ArrayBuffer ||
        ArrayBuffer.isView(body)
    ) {
        return { body: body as BodyInit, contentType: null };
    }
    return {
        body: JSON.stringify(body),
        contentType: "application/json",
    };
}

/**
 * Build a Request URL using a base — Hono's `app.fetch` requires absolute URLs.
 * We use a fixed in-memory host since no socket is opened.
 */
export const TEST_BASE_URL = "http://velojs.test";

export function buildUrl(path: string, query?: Query): string {
    const qs = buildQueryString(query);
    if (path.startsWith("http://") || path.startsWith("https://")) {
        return path + qs;
    }
    if (!path.startsWith("/")) path = "/" + path;
    return TEST_BASE_URL + path + qs;
}
