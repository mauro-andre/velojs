import { describe, it, expect } from "vitest";
import { substituteParams } from "../src/components.js";

describe("substituteParams", () => {
    it("replaces :id with actual value", () => {
        const result = substituteParams("/users/:id", { id: "123" });
        expect(result).toBe("/users/123");
    });

    it("replaces multiple params", () => {
        const result = substituteParams("/users/:userId/posts/:postId", {
            userId: "42",
            postId: "7",
        });
        expect(result).toBe("/users/42/posts/7");
    });

    it("returns path unchanged when no params match", () => {
        const result = substituteParams("/about", { id: "123" });
        expect(result).toBe("/about");
    });

    it("handles empty params object", () => {
        const result = substituteParams("/users/:id", {});
        expect(result).toBe("/users/:id");
    });

    it("replaces only matching params", () => {
        const result = substituteParams("/users/:id/edit", { id: "5", name: "test" });
        expect(result).toBe("/users/5/edit");
    });
});
