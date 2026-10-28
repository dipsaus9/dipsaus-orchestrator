// Reconcile step 4 decided by `parkStateAction` (DIPO-190, DIPO-360; 0012 F16, 0010 section 3,
// 0007): whether a story is parked is Backlog.md's answer (`backlogPark`), never the parks table.
// An open park row of a story Backlog.md does not hold as Parked is closed; a park Backlog.md holds
// with no row is recorded by hand; an F16 block on any other status is stale. The whole pass with
// real git, the notice and the parks rows is in reconcile.ci.test.ts.

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
    expect(parkStateAction({ park: AMBIGUOUS }, null, false)).toBe("stale");
  });

  it("records a park Backlog.md holds with no park row by hand", () => {
    expect(parkStateAction({ park: AMBIGUOUS }, AMBIGUOUS, false)).toBe("record");
  });

  it("closes an open park Backlog.md does not hold, and leaves a matching pair alone", () => {
    expect(parkStateAction({ park: null }, null, true)).toBe("close");
    expect(parkStateAction({ park: AMBIGUOUS }, null, true)).toBe("close");
    expect(parkStateAction({ park: AMBIGUOUS }, AMBIGUOUS, true)).toBeNull();
    expect(parkStateAction({ park: null }, null, false)).toBeNull();
  });
});
