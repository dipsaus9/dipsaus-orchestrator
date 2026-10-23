// The done report in the facts of an ended run (DIPO-152).

import { describe, expect, it } from "bun:test";

import type { RunRecord } from "@dipsaus-orchestrator/contract";

import { doneReportFactLines } from "./past";

const record = (doneReport: RunRecord["doneReport"]): RunRecord =>
  ({ run: "run_1", doneReport }) as unknown as RunRecord;

describe("past run done report", () => {
  it("marks the worker's words and holds them to a few lines", () => {
    const lines = doneReportFactLines(
      record({
        notes: Array.from({ length: 20 }, (_, i) => `note ${i}`).join("\n"),
        proposals: [{ kind: "spike", title: "Look", outcome: "o", why: "w" }],
      }),
    );
    expect(lines[0]).toBe("worker's done report (its words):");
    expect(lines).toHaveLength(6);
    expect(lines[1]).toBe("note 0");
  });

  it("is empty for a run without a done report", () => {
    expect(doneReportFactLines(record(undefined))).toEqual([]);
  });
});
