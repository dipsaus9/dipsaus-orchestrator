// Reconcile step 4 decided by `parkStateAction` (DIPO-190; 0012 F16, 0010 section 3, the 0007
// section 6 note of 2026-10-20): an F16 park block with no open park row is a park recorded by hand
// only on a Parked story; on any other status it is stale. The whole pass with real git, the
// notice and the parks rows is in reconcile.ci.test.ts.

import { describe, expect, it } from "bun:test";

import type { FieldBlockPark } from "@dipsaus-orchestrator/contract";

import { parkStateAction } from "../../src/reconcile";

const AMBIGUOUS: FieldBlockPark = {
  reason: "ambiguous-spec",
  from: "In Progress",
  note: "Which flag?",
} as FieldBlockPark;

describe("reconcile's park state (step 4)", () => {
  it("replays DIPO-129: a Done story with an ambiguous-spec F16 block and no park row is stale", () => {
    expect(parkStateAction({ lifecycle: "Done", park: AMBIGUOUS }, false)).toBe("stale");
  });

  it("calls an F16 block stale on every status but Parked", () => {
    for (const lifecycle of ["Draft", "Refined", "Ready", "In Progress", "In Review", "Done"]) {
      expect(parkStateAction({ lifecycle, park: AMBIGUOUS }, false)).toBe("stale");
    }
  });

  it("still records a Parked story's F16 block with no park row by hand", () => {
    expect(parkStateAction({ lifecycle: "Parked", park: AMBIGUOUS }, false)).toBe("record");
  });

  it("closes an open park with no F16 block, and leaves a matching pair alone", () => {
    expect(parkStateAction({ lifecycle: "In Progress", park: null }, true)).toBe("close");
    expect(parkStateAction({ lifecycle: "Parked", park: AMBIGUOUS }, true)).toBeNull();
    expect(parkStateAction({ lifecycle: "Ready", park: null }, false)).toBeNull();
  });
});
