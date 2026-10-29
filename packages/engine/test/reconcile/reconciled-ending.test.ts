// How a run ends that reconcile stops because its story left In Progress and In Review (0020,
// DIPO-373): the story's status decides. A story finished outside dipo ends it done, one parked by
// hand parked, and one removed or moved back before In Progress dropped.

import { describe, expect, it } from "bun:test";

import { reconciledEnding } from "../../src/reconcile/reconcile";

describe("reconciledEnding", () => {
  it("ends the run done, parked or dropped from its story's status", () => {
    expect(reconciledEnding({ removed: false, lifecycle: "Done" })).toBe("done");
    expect(reconciledEnding({ removed: false, lifecycle: "Parked" })).toBe("parked");
    for (const lifecycle of ["Draft", "Refined", "Ready", null]) {
      expect(reconciledEnding({ removed: false, lifecycle })).toBe("dropped");
    }
    // A removed story is dropped, unless it was completed: Done.
    expect(reconciledEnding({ removed: true, lifecycle: "Ready" })).toBe("dropped");
    expect(reconciledEnding({ removed: true, lifecycle: "Parked" })).toBe("dropped");
    expect(reconciledEnding({ removed: true, lifecycle: "Done" })).toBe("done");
  });
});
