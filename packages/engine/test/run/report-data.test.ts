// The pure rules of the report gate (DIPO-186 with DIPO-254): which automated test-plan entries a
// done report leaves open, and whether a decision note's section is in its file.

import { describe, expect, it } from "bun:test";

import type { TestPlan } from "@dipsaus-orchestrator/contract";

import {
  hasSection,
  noteMiss,
  proposalHash,
  sectionHeadings,
  testPlanGaps,
} from "../../src/run/report-data";

const PLAN: TestPlan = {
  entries: [
    { kind: "automated", check: "(unit) one" },
    { kind: "manual", check: "look" },
    { kind: "automated", check: " (unit) three " },
  ],
};

describe("testPlanGaps", () => {
  it("names each automated entry not reported done, in plan order, and never a manual one", () => {
    expect(
      testPlanGaps(PLAN, [
        { n: 3, status: "manual", evidence: "e" },
        { n: 2, status: "not-done", evidence: "e" },
      ]),
    ).toEqual([
      { n: 1, check: "(unit) one", reported: "missing" },
      { n: 3, check: "(unit) three", reported: "manual" },
    ]);
    expect(testPlanGaps(PLAN, undefined).map((gap) => gap.n)).toEqual([1, 3]);
    expect(
      testPlanGaps(PLAN, [
        { n: 1, status: "done", evidence: "e" },
        { n: 3, status: "done", evidence: "e" },
      ]),
    ).toEqual([]);
  });

  it("reads the first entry of a number and ignores numbers the plan does not have", () => {
    expect(
      testPlanGaps(PLAN, [
        { n: 1, status: "not-done", evidence: "e" },
        { n: 1, status: "done", evidence: "e" },
        { n: 3, status: "done", evidence: "e" },
        { n: 9, status: "done", evidence: "e" },
      ]),
    ).toEqual([{ n: 1, check: "(unit) one", reported: "not-done" }]);
  });

  it("checks nothing without a plan, for a plan that does not apply, or for a spike", () => {
    expect(testPlanGaps(undefined, undefined)).toEqual([]);
    expect(testPlanGaps({ not_applicable: "docs" }, undefined)).toEqual([]);
    expect(testPlanGaps(PLAN, undefined, "spike")).toEqual([]);
    expect(testPlanGaps(PLAN, undefined, "Spike")).toEqual([]);
  });
});

describe("decision note sections", () => {
  const TEXT = [
    "# 0008 Worker adapter",
    "",
    "## Decision",
    "",
    "### 1. The worker port ###",
    "",
    "```md",
    "## Not a heading",
    "```",
    "#hashtag is no heading",
  ].join("\n");

  it("reads Markdown headings outside fences", () => {
    expect(sectionHeadings(TEXT)).toEqual([
      "0008 Worker adapter",
      "Decision",
      "1. The worker port",
    ]);
  });

  it("matches a section by its heading, with or without marks, number, case or extra spaces", () => {
    for (const section of [
      "1. The worker port",
      "### 1. The worker port",
      "the  worker PORT",
      "Decision",
    ]) {
      expect(hasSection(TEXT, section)).toBe(true);
    }
    for (const section of ["Not a heading", "worker port", "", "##"]) {
      expect(hasSection(TEXT, section)).toBe(false);
    }
  });

  it("tells a missing file from a missing section", () => {
    const note = { file: "docs/decisions/0008-worker-adapter.md", section: "Decision", text: "t" };
    expect(noteMiss(note, null)).toBe("file");
    expect(noteMiss(note, TEXT)).toBeNull();
    expect(noteMiss({ ...note, section: "Context" }, TEXT)).toBe("section");
  });
});

describe("proposalHash", () => {
  it("keys a proposal by its title and its paths in any order, not by its other fields", () => {
    const a = proposalHash({ title: "Split", paths: ["b", "a"] });
    expect(proposalHash({ title: " Split ", paths: ["a", "b"] })).toBe(a);
    expect(proposalHash({ title: "Split", paths: ["a"] })).not.toBe(a);
    expect(proposalHash({ title: "Split" })).toBe(proposalHash({ title: "Split", paths: [] }));
    expect(proposalHash({ title: "Other", paths: ["a", "b"] })).not.toBe(a);
  });
});
