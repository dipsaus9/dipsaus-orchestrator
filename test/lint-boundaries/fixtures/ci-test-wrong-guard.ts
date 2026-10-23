// Guarded by another variable, a truthy check, or in the else branch: each refused (DIPO-316).
import { describe, expect, it, test } from "bun:test";

if (process.env["CI"] === "1") {
  describe("another variable", () => {
    it("runs", () => expect(1).toBe(1));
  });
}

if (process.env["DIPO_TEST_CI"]) {
  test("any value", () => expect(1).toBe(1));
}

if (process.env["DIPO_TEST_CI"] === "1") {
  // Guarded.
} else {
  it.each([1, 2])("in the else branch %p", (n) => expect(n).toBeGreaterThan(0));
}
