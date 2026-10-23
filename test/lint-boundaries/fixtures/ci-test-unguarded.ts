// A CI-only test file whose describe registers in every run: refused (DIPO-316).
import { describe, expect, it } from "bun:test";

describe("runs locally too", () => {
  it("is not guarded", () => {
    expect(1).toBe(1);
  });
});
