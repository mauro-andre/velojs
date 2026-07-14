import { describe, it, expect } from "vitest";
import { signal } from "@preact/signals";
import { touch } from "../src/hooks.js";

describe("touch", () => {
    it("re-emits an object signal with a new reference", () => {
        const sig = signal<{ name: string } | null>({ name: "ana" });
        const before = sig.value;

        touch(sig);

        expect(sig.value).not.toBe(before);
        expect(sig.value).toEqual({ name: "ana" });
    });

    it("notifies subscribers after a nested mutation", () => {
        const sig = signal<{ items: { done: boolean }[] } | null>({
            items: [{ done: false }],
        });
        let notifications = 0;
        const dispose = sig.subscribe(() => {
            notifications++;
        });
        notifications = 0; // subscribe fires once on attach

        sig.value!.items[0]!.done = true; // mutate in place — no notification
        expect(notifications).toBe(0);

        touch(sig);
        expect(notifications).toBe(1);
        expect(sig.value!.items[0]!.done).toBe(true);

        dispose();
    });

    it("keeps an array signal an array", () => {
        // A spread into an object literal would turn [a, b] into {0: a, 1: b},
        // silently breaking every later .map/.filter on the signal.
        const sig = signal<{ id: number }[] | null>([{ id: 1 }, { id: 2 }]);
        const before = sig.value;

        touch(sig);

        expect(Array.isArray(sig.value)).toBe(true);
        expect(sig.value).not.toBe(before);
        expect(sig.value).toEqual([{ id: 1 }, { id: 2 }]);
        expect(sig.value!.map((i) => i.id)).toEqual([1, 2]);
    });

    it("is a no-op for null", () => {
        const sig = signal<{ name: string } | null>(null);
        touch(sig);
        expect(sig.value).toBeNull();
    });

    it("is a no-op for a primitive", () => {
        const sig = signal<string | null>("hello");
        touch(sig);
        expect(sig.value).toBe("hello");
    });
});
