// Merge gates as data and records (DIPO-150 with DIPO-151; 0019 section 11): each waiting condition
// makes the gate wait for the maintainer and none decides it by rule; the summary names why it
// waits, and for a flagged story the manual test-plan entries and the worktree; the hold labels
// always hold `autorelease: pending`; a gate opened by rule is decided and recorded at once; a hand
// merge decides the open gate with the note "merged on the host".

import { afterEach, describe, expect, it } from "bun:test";

import { type GateId } from "@dipsaus-orchestrator/contract";

import {
  AUTORELEASE_LABEL,
  decideOnHandMerge,
  HAND_MERGE_NOTE,
  holdLabelsOn,
  mergeGate,
  mergeGateSummary,
  mergeWaits,
  openMaintainerMergeGate,
  openMergeGate,
} from "../../src/merge-slot";
import { storyVerdicts } from "../../src/views/feature";
import { addAgent, type RoundsWorld, roundsWorld, storyRun } from "../run/rounds-helpers";

const HEAD = "1".repeat(40);
const MET = [{ n: 1, status: "met" as const, evidence: "fine" }];
const NONE = { autoMerge: true, testBeforeMerge: false, holdLabels: [] };

describe("mergeWaits", () => {
  it("decides by rule when nothing makes the gate wait", () => {
    expect(mergeWaits({ ...NONE, verdict: { criteria: MET, override: null } })).toEqual([]);
  });

  it("waits for each condition of section 11", () => {
    const verdict = { criteria: MET, override: null };
    expect(mergeWaits({ ...NONE, autoMerge: false, verdict })).toEqual([{ kind: "autoMergeOff" }]);
    expect(mergeWaits({ ...NONE, testBeforeMerge: true, verdict })).toEqual([
      { kind: "testBeforeMerge" },
    ]);
    expect(
      mergeWaits({
        ...NONE,
        verdict: {
          criteria: [...MET, { n: 2, status: "maintainer", evidence: "an approval" }],
          override: null,
        },
      }),
    ).toEqual([{ kind: "maintainerCriteria", criteria: [2] }]);
    expect(
      mergeWaits({ ...NONE, verdict: { criteria: MET, override: { note: "ok", at: 1 } } }),
    ).toEqual([{ kind: "override" }]);
    expect(mergeWaits({ ...NONE, holdLabels: ["hold"], verdict })).toEqual([
      { kind: "holdLabel", labels: ["hold"] },
    ]);
  });
});

describe("holdLabelsOn", () => {
  it("always holds autorelease: pending, and the office's hold labels, in any case", () => {
    expect(holdLabelsOn(["autorelease: pending", "bug"], [])).toEqual([AUTORELEASE_LABEL]);
    expect(holdLabelsOn(["Hold", "bug"], ["hold"])).toEqual(["Hold"]);
    expect(holdLabelsOn(["bug"], ["hold"])).toEqual([]);
  });
});

describe("mergeGateSummary", () => {
  const pr = { number: 7, url: "https://github.com/o/r/pull/7" };

  it("says dipo merges when nothing waits", () => {
    expect(mergeGateSummary({ story: "DIPO-7", pr, head: HEAD, waits: [] })).toContain(
      "dipo merges it through the merge slot",
    );
  });

  it("names why it waits and what to do", () => {
    const text = mergeGateSummary({
      story: "DIPO-7",
      pr,
      head: HEAD,
      waits: [{ kind: "autoMergeOff" }, { kind: "maintainerCriteria", criteria: [3] }],
    });
    expect(text).toContain("mergeSlot.autoMerge is off");
    expect(text).toContain("#3");
    expect(text).toContain("dipo approve DIPO-7");
    expect(text).toContain("dipo reject DIPO-7 --note <text>");
  });

  it("lists a flagged story's manual test-plan entries and the worktree path", () => {
    const text = mergeGateSummary({
      story: "DIPO-7",
      pr,
      head: HEAD,
      waits: [{ kind: "testBeforeMerge" }],
      manual: [
        { check: "Open the TUI", expect: "the greeting shows" },
        { check: "Run dipo watch" },
      ],
      worktree: "/trees/DIPO-7",
    });
    expect(text).toContain("1. Open the TUI (expect: the greeting shows)");
    expect(text).toContain("2. Run dipo watch");
    expect(text).toContain("Test in the story worktree: /trees/DIPO-7");
  });

  it("names a hand merge as the only way for autorelease: pending", () => {
    const text = mergeGateSummary({
      story: "DIPO-7",
      pr,
      head: HEAD,
      waits: [{ kind: "holdLabel", labels: [AUTORELEASE_LABEL] }],
    });
    expect(text).toContain("merge it by hand on GitHub");
    expect(text).not.toContain("dipo approve");
  });
});

describe("the gate records", () => {
  let w: RoundsWorld;
  afterEach(() => w?.close());

  it("records a gate opened by rule as approved, with gate.reached and gate.decided", async () => {
    w = await roundsWorld("merge-gates-");
    const story = storyRun(w, { story: "DIPO-7" });
    addAgent(w, story.run, "developer", false);
    const made = w.office.immediate(() =>
      openMergeGate(w.office, w.t.ids, {
        runId: story.run,
        key: story.key,
        head: HEAD,
        waits: [],
        summary: "merges",
        phase: "merge",
        at: 5,
      }),
    );
    expect(made.gate).toMatchObject({
      head: HEAD,
      waitingOn: "rule",
      decision: { decision: "approved", by: "rule", note: null, at: 5 },
    });
    expect(made.entries.map((entry) => entry.type)).toEqual([
      "work.output",
      "work.phase",
      "gate.reached",
      "gate.decided",
    ]);
    // The audit trail shows the merge decision.
    expect(storyVerdicts(w.office, story.key)).toEqual([
      expect.objectContaining({ kind: "merge", decision: "approved", by: "rule" }),
    ]);
    expect(openMaintainerMergeGate(w.office, story.key)).toBeNull();
  });

  it("decides the open gate approved by the maintainer with 'merged on the host' after a hand merge", async () => {
    w = await roundsWorld("merge-gates-");
    const story = storyRun(w, { story: "DIPO-7" });
    addAgent(w, story.run, "developer", false);
    const gate: GateId = w.office.immediate(
      () =>
        openMergeGate(w.office, w.t.ids, {
          runId: story.run,
          key: story.key,
          head: HEAD,
          waits: [{ kind: "autoMergeOff" }],
          summary: "waits",
          phase: "merge",
          at: 5,
        }).gate.gate,
    );
    expect(openMaintainerMergeGate(w.office, story.key)?.gate).toBe(gate);
    const entries = w.office.immediate(() => decideOnHandMerge(w.office, story.key, 9));
    expect(entries).toEqual([
      expect.objectContaining({
        type: "gate.decided",
        delta: { gate, decision: "approved", by: "maintainer", note: HAND_MERGE_NOTE },
      }),
    ]);
    expect(mergeGate(w.office, gate)?.decision).toEqual({
      decision: "approved",
      by: "maintainer",
      note: HAND_MERGE_NOTE,
      at: 9,
    });
    // Nothing is open any more.
    expect(w.office.immediate(() => decideOnHandMerge(w.office, story.key, 10))).toEqual([]);
  });
});
