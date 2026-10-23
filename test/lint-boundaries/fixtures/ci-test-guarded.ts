// The accepted forms (DIPO-316): an if on the comparison, either way round or through a
// top-level const, `describe.if`, and hooks or helpers outside the guard.
import { afterEach, describe, expect, it } from "bun:test";

const CI = process.env["DIPO_TEST_CI"] === "1";

afterEach(() => undefined);

function helper(): void {
  it("registered by a guarded caller", () => expect(1).toBe(1));
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("guarded", () => {
    it("runs in CI", () => expect(1).toBe(1));
    helper();
  });
}

if ("1" === process.env.DIPO_TEST_CI) {
  it("reversed", () => expect(1).toBe(1));
}

if (CI) {
  describe.each([1])("through a const %p", (n) => {
    it("runs", () => expect(n).toBe(1));
  });
}

describe.if(CI)("describe.if", () => {
  it("runs", () => expect(1).toBe(1));
});
