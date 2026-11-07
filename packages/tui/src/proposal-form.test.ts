// A planning proposal as the form the maintainer edits (DIPO-450): written and read back to the
// same proposal for each kind, with the kind and id kept, an edited field taken over, an emptied
// optional field left out, and a line the form cannot read named.

import { describe, expect, it } from "bun:test";

import { type PlanningProposal, PlanningProposal as Schema } from "@dipsaus-orchestrator/contract";

import { proposalForm, readProposalForm } from "./proposal-form";

const STORY: PlanningProposal = {
  kind: "story",
  title: "Export the stories as CSV",
  type: "feature",
  milestone: "m-3",
  tier: "M",
  storyLine:
    "As maintainer I want to export the stories as a CSV file so that I can share the backlog with people outside dipo.",
  context: "The export reads the base.\n\nIt writes UTF-8.",
  criteria: ["The export writes one CSV row per active story", "A Done story is left out of it"],
  references: ["packages/cli/src/export-command.ts"],
  dependencies: ["DIPO-12"],
  testPlan: {
    entries: [
      { kind: "automated", check: "(unit) one CSV row per active story" },
      { kind: "manual", check: "Export the scratch stories", expect: "One row per story opens" },
    ],
  },
  why: "The maintainer shares the backlog by hand.",
};

const SPLIT: PlanningProposal = {
  kind: "split",
  id: "DIPO-30",
  edit: { criteria: ["Only the JSON export stays here"] },
  story: {
    title: "Export the stories as JSON lines",
    type: "spike",
    milestone: "m-3",
    tier: "S",
    storyLine: "We need to decide the JSON lines format so that scripts read one story per line.",
    criteria: ["docs/decisions/0030-json-lines.md records the format"],
    references: ["docs/decisions/0030-json-lines.md"],
  },
  why: "It grew two outputs.",
};

const EDIT: PlanningProposal = {
  kind: "edit",
  id: "DIPO-31",
  title: "Rename the export setting everywhere",
  references: ["packages/cli/src/export-command.ts", "docs/export.md"],
  why: "Two names confuse.",
};

// A triage session's refine and drop of a draft (DIPO-454).
const { kind: _kind, why: _why, ...storyFields } = STORY;
const REFINE: PlanningProposal = {
  kind: "refine",
  draft: "DRAFT-3",
  ...storyFields,
  why: "The draft is ready.",
};
const DROP: PlanningProposal = { kind: "drop", draft: "DRAFT-4", why: "Covered by DIPO-30." };

describe("the proposal form (DIPO-450)", () => {
  it("keeps a refine's and a drop's draft, which the form never edits (DIPO-454)", () => {
    expect(proposalForm(DROP).split("\n")[0]).toBe("# drop DRAFT-4: edit the fields, then Ctrl-S");
    expect(proposalForm(REFINE)).not.toContain("draft:");
    const read = readProposalForm(REFINE, `draft: DRAFT-9\n${proposalForm(REFINE)}`);
    expect(read).toEqual({ ok: true, proposal: REFINE });
  });

  it("reads back each kind of proposal as it was written", () => {
    for (const proposal of [STORY, SPLIT, EDIT, REFINE, DROP]) {
      const read = readProposalForm(proposal, proposalForm(proposal));
      expect(read).toEqual({ ok: true, proposal });
      expect(Schema.safeParse(read.ok ? read.proposal : null).success).toBe(true);
    }
  });

  it("writes one field per line, lists as items and the context indented", () => {
    const form = proposalForm(STORY);
    expect(form).toContain("tier: M\n");
    expect(form).toContain("criteria:\n- The export writes one CSV row per active story\n");
    expect(form).toContain("context:\n  The export reads the base.\n  \n  It writes UTF-8.\n");
    expect(form).toContain("- manual: Export the scratch stories => One row per story opens");
    expect(proposalForm(SPLIT)).toContain("story.tier: S");
    expect(proposalForm(SPLIT)).not.toContain("DIPO-30\n");
  });

  it("takes an edited field, leaves an emptied one out and keeps the kind and id", () => {
    const form = proposalForm(EDIT)
      .replace("title: Rename the export setting everywhere", "title: Rename the setting")
      .replace("why: Two names confuse.", "why: They confuse.\nstoryLine:");
    expect(readProposalForm(EDIT, `id: DIPO-99\n${form}`)).toMatchObject({
      ok: true,
      proposal: { kind: "edit", id: "DIPO-31", title: "Rename the setting", why: "They confuse." },
    });
    const read = readProposalForm(EDIT, form);
    expect(read.ok && (read.proposal as { id: string }).id).toBe("DIPO-31");
    expect(read.ok && "storyLine" in (read.proposal as object)).toBe(false);
  });

  it("names a line it cannot read, a field of no group and a test plan it cannot read", () => {
    expect(readProposalForm(STORY, "title: x\nsome loose text")).toEqual({
      ok: false,
      error: 'line 2 is no "name: value", "- item" or indented context line',
    });
    expect(readProposalForm(STORY, "story.title: x")).toEqual({
      ok: false,
      error: "story.title is not a field of this proposal",
    });
    expect(readProposalForm(STORY, "testPlan:\n- later: x")).toMatchObject({ ok: false });
  });
});
