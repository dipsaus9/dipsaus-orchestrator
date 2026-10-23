// The done report lines of `dipo watch` at a run's end (DIPO-152).

import { describe, expect, it } from "bun:test";

import type { RunRecord } from "@dipsaus-orchestrator/contract";

import { doneReportLines } from "./watch-command";

const record = (doneReport: RunRecord["doneReport"]): RunRecord =>
  ({ run: "run_1", doneReport }) as unknown as RunRecord;

describe("dipo watch done report", () => {
  it("prints the notes and proposals marked as the worker's words", () => {
    expect(
      doneReportLines(
        record({
          notes: "Deviated: kept the old key.\nSecond line.",
          proposals: [{ kind: "tool", title: "Add jq", outcome: "jq is installed", why: "w" }],
        }),
      ),
    ).toEqual([
      "  worker's done report (the worker's words, not checked by dipo):",
      "    Deviated: kept the old key.",
      "    Second line.",
      "    proposal (tool): Add jq — jq is installed",
    ]);
  });

  it("prints nothing for a run without a done report", () => {
    expect(doneReportLines(record(undefined))).toEqual([]);
  });
});
