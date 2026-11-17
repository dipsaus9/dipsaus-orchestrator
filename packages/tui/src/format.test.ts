// Text pieces of the overview and the queue (DIPO-54).

import { describe, expect, it } from "bun:test";

import { elapsed, gateLine, shortRole, skipReason, tickerLines, truncate, widthOf } from "./format";

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

  it("puts the rule id field first, then what failed, and keeps a message no rule gave as is", () => {
    const message = "ready DIPO-33 failed R15: 2 unknowns open";
    const failure = { rule: "R15", message, text: "2 unknowns open" };
    expect(gateLine({ gateMessages: [message], gateFailures: [failure] })).toBe(
      "R15 2 unknowns open",
    );
    // The rule comes from the field, never from the message text (DIPO-97).
    expect(gateLine({ gateMessages: [message] })).toBe(message);
    expect(gateLine({ gateFailures: [{ ...failure, rule: "R07" }] })).toBe("R07 2 unknowns open");
    expect(gateLine({ gateMessages: ["DIPO-33 cannot start: too large"] })).toBe(
      "DIPO-33 cannot start: too large",
    );
    expect(gateLine({})).toBeUndefined();
  });

  it("explains a full office, and shows an unknown reason as is", () => {
    expect(skipReason("capacity")).toBe("the office runs as many stories as it may");
    expect(skipReason("quota")).toBe("quota");
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

describe("tickerLines", () => {
  it("wraps on words to as many rows as the message needs, up to three", () => {
    expect(tickerLines("short message", 80)).toEqual(["short message"]);
    expect(tickerLines("one two three four", 9)).toEqual(["one two", "three", "four"]);
  });

  it("ends the third row in an ellipsis when the message needs more rows", () => {
    const text = "word ".repeat(80).trim();
    const rows = tickerLines(text, 20);
    expect(rows).toHaveLength(3);
    expect(rows.slice(0, 2).every((row) => row.length <= 20 && !row.endsWith("…"))).toBe(true);
    expect(rows[2]).toHaveLength(20);
    expect(rows[2]?.endsWith("…")).toBe(true);
  });
});
