import { describe, expect, it } from "bun:test";

import type { Clock } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { createSystemIds, createUlid, systemIds } from "./ids";

const CROCKFORD_ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A clock that returns the given times in turn, to model a clock that steps back. */
function scriptedClock(times: number[]): Clock {
  const base = new ManualClock();
  let i = 0;
  return {
    now: () => times[Math.min(i++, times.length - 1)] ?? 0,
    setTimeout: (callback, delayMs) => base.setTimeout(callback, delayMs),
    clearTimeout: (handle) => base.clearTimeout(handle),
  };
}

const isSorted = (ids: string[]) => ids.every((id, i) => i === 0 || (ids[i - 1] ?? "") < id);

describe("ULID", () => {
  it("is 26 Crockford base32 characters with the time in the first 10", () => {
    // The example from the ULID specification: time 1469918176385 encodes as 01ARYZ6S41.
    const ulid = createUlid(new ManualClock(1_469_918_176_385))();
    expect(ulid).toMatch(CROCKFORD_ULID);
    expect(ulid.slice(0, 10)).toBe("01ARYZ6S41");
  });

  it("sorts by creation time within one millisecond", () => {
    const ulid = createUlid(new ManualClock());
    const made = Array.from({ length: 1000 }, () => ulid());
    expect(new Set(made.map((id) => id.slice(0, 10))).size).toBe(1);
    expect(isSorted(made)).toBe(true);
  });

  it("sorts by creation time across milliseconds and when the clock steps back", () => {
    const ulid = createUlid(scriptedClock([5, 5, 6, 4, 4, 7, 3, 9]));
    const made = Array.from({ length: 8 }, () => ulid());
    expect(isSorted(made)).toBe(true);
  });

  it("carries into higher digits and refuses to overflow within one millisecond", () => {
    const ulid = createUlid(new ManualClock(0), (bytes) => {
      bytes.fill(31);
      bytes[0] = 0;
    });
    expect(ulid().slice(10)).toBe("0ZZZZZZZZZZZZZZZ");
    expect(ulid().slice(10)).toBe("1000000000000000");

    const full = createUlid(new ManualClock(0), (bytes) => bytes.fill(31));
    expect(full().slice(10)).toBe("ZZZZZZZZZZZZZZZZ");
    expect(() => full()).toThrow(RangeError);
  });
});

describe("system IdSource", () => {
  it("prefixes a ULID with each 0005 prefix", () => {
    for (const prefix of ["off", "sto", "run", "agt", "gat", "qst", "tst"] as const) {
      const id = systemIds.next(prefix);
      expect(id.startsWith(`${prefix}_`)).toBe(true);
      expect(id.slice(prefix.length + 1)).toMatch(CROCKFORD_ULID);
    }
  });

  it("takes the time part from the injected clock", () => {
    const ids = createSystemIds(new ManualClock(1_469_918_176_385));
    expect(ids.next("run").slice(4, 14)).toBe("01ARYZ6S41");
  });
});
