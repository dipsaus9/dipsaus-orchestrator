// Text pieces of the overview and the queue (DIPO-54).

import { describe, expect, it } from "bun:test";

import {
  evidenceOf,
  elapsed,
  gateLine,
  marked,
  shortRole,
  skipReason,
  truncate,
  widthOf,
} from "./format";

describe("format", () => {
  it("picks the 0009 width breakpoints", () => {
    expect([150, 120, 119, 80, 79, 60].map(widthOf)).toEqual([
      "full",
      "full",
      "medium",
      "medium",
      "cards",
      "cards",
    ]);
  });

  it("puts the rule id first in a Ready gate message, and keeps another shape as is", () => {
    expect(gateLine("ready DIPO-33 failed R15: 2 unknowns open")).toBe("R15 2 unknowns open");
    expect(gateLine("no rule here")).toBe("no rule here");
  });

  it("explains a plan-limit skip apart from a full office, and shows an unknown reason as is", () => {
    expect(skipReason("planLimit")).toBe(
      "a plan limit or plan-limit warning holds new runs on its model until the reset",
    );
    expect(skipReason("capacity")).toBe("the office runs as many stories as it may");
    expect(skipReason("quota")).toBe("quota");
  });

  it("marks claimed, estimated and missing values only with the evidence flag", () => {
    const map = { a: "claimed", b: "estimated", c: "none" } as const;
    expect(marked("4/7", evidenceOf(map, "a", true))).toBe("4/7*");
    expect(marked("$3", evidenceOf(map, "b", true))).toBe("~$3");
    expect(marked("12", evidenceOf(map, "c", true))).toBe("?");
    expect(marked("4/7", evidenceOf(map, "a", false))).toBe("4/7");
  });

  it("formats time, roles and truncation", () => {
    expect([0, 59 * 60_000, 65 * 60_000].map(elapsed)).toEqual(["0m", "59m", "1h05"]);
    expect([shortRole("developer"), shortRole("reviewer"), shortRole("architect")]).toEqual([
      "dev",
      "rev",
      "arc",
    ]);
    expect(truncate("Office forget flow", 10, "…")).toBe("Office fo…");
    expect(truncate("short", 10, "…")).toBe("short");
  });
});
