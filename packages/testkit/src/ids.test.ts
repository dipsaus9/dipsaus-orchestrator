import { describe, expect, it } from "bun:test";

import { SequentialIds } from "./ids";

const sequence = (ids: SequentialIds) =>
  (["sto", "run", "run", "qst", "sto"] as const).map((prefix) => ids.next(prefix));

describe("SequentialIds", () => {
  it("counts per prefix with four digits", () => {
    const ids = new SequentialIds();
    expect(ids.next("run")).toBe("run-0001");
    expect(ids.next("run")).toBe("run-0002");
    expect(ids.next("agt")).toBe("agt-0001");
    expect(ids.next("run")).toBe("run-0003");
  });

  it("is deterministic across instances", () => {
    expect(sequence(new SequentialIds())).toEqual(sequence(new SequentialIds()));
    expect(sequence(new SequentialIds())).toEqual([
      "sto-0001",
      "run-0001",
      "run-0002",
      "qst-0001",
      "sto-0002",
    ]);
  });
});
