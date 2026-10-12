import { describe, expect, it } from "bun:test";

import type { Clock, IdSource, Spawn } from "./index";
import * as runtime from "./runtime";

const spawn: Spawn = () => {
  throw new Error("not called");
};

describe("runtime seams", () => {
  it("are types only, with no runtime values", () => {
    expect(Object.keys(runtime)).toEqual([]);
  });

  it("can be implemented without importing any other package", () => {
    const clock: Clock = { now: () => 0, setTimeout: () => ({}) as never, clearTimeout: () => {} };
    const ids: IdSource = { next: (prefix) => `${prefix}-1` };
    expect(clock.now()).toBe(0);
    expect(ids.next("run")).toBe("run-1");
    expect(typeof spawn).toBe("function");
  });
});
