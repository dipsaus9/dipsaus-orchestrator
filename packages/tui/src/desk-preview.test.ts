// The Desk's preview (DIPO-459): what the focused item shows, from its `DeskItem` alone. The MERGE
// preview prints the PR's required checks and change stats the engine read; the PROPOSAL preview
// the audit's story text, Why, Blocks, Size and who raised it; every preview its bound actions as
// buttons with the first primary, the consequence line (the engine's, else the TUI's) and the
// `$ dipo …` line. Nothing is cut: every text wraps.

import { describe, expect, it } from "bun:test";

import { DeskItem } from "@dipsaus-orchestrator/contract";

import { CONSEQUENCE_FALLBACK, type PreviewContext, previewLines } from "./desk-preview";
import { lineText, type SegLine } from "./segments";

const NOW = Date.parse("2026-11-06T13:12:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const CTX: PreviewContext = {
  width: 63,
  now: NOW,
  ascii: false,
  title: null,
  phase: null,
  waitingOn: [],
  prompt: null,
};

const text = (lines: readonly SegLine[]) => lines.map((line) => lineText(line).trimEnd());

/** The piece of `lines` whose text is `wanted`, for its role. */
const piece = (lines: readonly SegLine[], wanted: string) =>
  lines.flat().find((candidate) => candidate.text === wanted);

const merge = DeskItem.parse({
  kind: "MERGE",
  story: "DIPO-446",
  key: "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C46",
  gate: "gat_01J9ZK5Q8W3V4X6Y7Z8A9B0G46",
  pr: {
    number: 612,
    url: "https://github.com/o/r/pull/612",
    state: "open",
    checks: { required: 4, state: "passed" },
    change: { files: 6, additions: 214, deletions: 38 },
  },
  detail: "you flagged it test-before-merge",
  since: ago(8),
  blocks: ["DIPO-448", "DIPO-449"],
  actions: [
    { command: "test.start", cli: "dipo test DIPO-446" },
    {
      command: "gate.approve",
      cli: "dipo approve DIPO-446",
      consequence: "Approve merges once the checks pass on the close-out head.",
    },
    { command: "gate.reject", cli: 'dipo reject DIPO-446 --note "<why>"' },
  ],
});

const proposal = DeskItem.parse({
  kind: "PROPOSED STORY",
  story: "DIPO-447",
  idea: {
    id: "3f9a01c2".repeat(8),
    origin: "finding",
    title: "CLI verbs for the planning session",
    story: {
      found: "There is no CLI verb for a planning session.",
      evidence: [{ file: "packages/cli/src/index.ts", line: 40 }],
      sourceStory: "DIPO-447",
      storyLine:
        "As maintainer I want dipo plan start, say and end so I can drive a planning session from my shell without opening the TUI.",
      proposed: "Add the three verbs.",
      why: "Reviewer asked for it in round 2 of DIPO-447",
      serves: "m-3",
      tier: "S",
    },
    raisedBy: { role: "reviewer", model: "opus-5.5" },
  },
  detail: '"CLI verbs for the planning session" · milestone m-3 · from a reviewer\'s finding',
  since: ago(7),
  blocks: ["DIPO-448", "DIPO-449", "DIPO-450"],
  actions: [
    { command: "idea.accept", cli: "dipo idea accept 3f9a01c2" },
    { command: "idea.dismiss", cli: "dipo idea dismiss 3f9a01c2" },
  ],
});

describe("the MERGE preview", () => {
  it("shows the pipeline, Why, the required checks and the change stats, then its buttons", () => {
    const lines = previewLines(merge, {
      ...CTX,
      title: "Planning tools for workers",
      phase: "test",
    });
    expect(text(lines)).toEqual([
      "MERGE · waits for you",
      "DIPO-446 Planning tools for workers",
      "setup ━━ build ━━ review ━━ ● test ┄┄ merge",
      "",
      "Why     you flagged it test-before-merge",
      "CI      ✓ 4 required checks green",
      "Change  6 files · +214 −38",
      "Blocks  DIPO-448 · DIPO-449",
      "",
      "⟦ t Test first ⟧  ⟦ y Approve ⟧  ⟦ n Reject… ⟧  ⟦ o PR ⟧",
      "",
      "Approve merges once the checks pass on the close-out head.",
      "$ dipo approve DIPO-446",
    ]);
    // The first button is the primary one: its brackets in acc, the others' faint.
    const buttons = lines[9] ?? [];
    expect(buttons[0]).toMatchObject({ text: "⟦", role: "acc" });
    expect(buttons.find((part, i) => i > 0 && part.text === "⟦")?.role).toBe("faint");
    expect(piece(lines, "✓")?.role).toBe("ok");
  });

  it("says where pending or failed checks stand, and leaves out what the engine did not read", () => {
    const pending = DeskItem.parse({
      ...merge,
      pr: { ...merge.pr, checks: { required: 2, state: "pending" }, change: undefined },
    });
    const shown = text(previewLines(pending, CTX));
    expect(shown).toContain("CI      ● 2 required checks pending");
    expect(shown.some((line) => line.startsWith("Change"))).toBe(false);
    const failed = DeskItem.parse({
      ...merge,
      pr: { ...merge.pr, checks: { required: 1, state: "failed" } },
    });
    expect(text(previewLines(failed, CTX))).toContain("CI      ✗ 1 required check, failing");
  });
});

describe("the PROPOSED STORY preview", () => {
  it("shows the audit's story text, Why, Blocks, Size and who raised it, with Accept and Dismiss", () => {
    expect(text(previewLines(proposal, CTX))).toEqual([
      "PROPOSED STORY · follow-up to DIPO-447",
      "CLI verbs for the planning session",
      "",
      "As maintainer I want dipo plan start, say and end so I can",
      "drive a planning session from my shell without opening the",
      "TUI.",
      "",
      "Why     Reviewer asked for it in round 2 of DIPO-447",
      "Blocks  DIPO-448 · DIPO-449 · DIPO-450",
      "Size    S",
      "Raised  7 min ago by reviewer (opus-5.5)",
      "",
      "⟦ y Accept ⟧  ⟦ n Dismiss ⟧",
      "",
      "Accepting files it as a Backlog draft. You refine it in a",
      "triage session.",
      "$ dipo idea accept 3f9a01c2",
    ]);
  });

  it("names who raised it without a model for the maintainer's quick idea, and no Size without a tier", () => {
    const quick = DeskItem.parse({
      ...proposal,
      idea: {
        ...proposal.idea,
        origin: "quick",
        story: { ...proposal.idea?.story, tier: undefined, sourceStory: undefined },
        raisedBy: { role: "maintainer" },
      },
      story: undefined,
    });
    const shown = text(previewLines(quick, CTX));
    expect(shown[0]).toBe("PROPOSED STORY · your quick idea");
    expect(shown).toContain("Raised  7 min ago by maintainer");
    expect(shown.some((line) => line.startsWith("Size"))).toBe(false);
  });
});

describe("the consequence line", () => {
  it("is the engine's consequence of the y action, else the TUI's sentence for its command", () => {
    const engine = DeskItem.parse({
      ...proposal,
      actions: [
        { command: "idea.accept", cli: "dipo idea accept 3f9a01c2", consequence: "Files a draft." },
        { command: "idea.dismiss", cli: "dipo idea dismiss 3f9a01c2" },
      ],
    });
    const shown = text(previewLines(engine, CTX));
    const buttons = shown.indexOf("⟦ y Accept ⟧  ⟦ n Dismiss ⟧");
    expect(shown.slice(buttons + 1)).toEqual(["", "Files a draft.", "$ dipo idea accept 3f9a01c2"]);
    // Without one from the engine the TUI's map says it (migration.md, addition 5).
    const fallback = text(previewLines(proposal, CTX)).join(" ");
    expect(fallback).toContain(CONSEQUENCE_FALLBACK["idea.accept"] ?? "no fallback");
  });

  it("shows the command line of every action no key sends, so the TUI teaches the CLI", () => {
    const paused = DeskItem.parse({
      kind: "STARTS PAUSED",
      detail: "Claude plan limit reached",
      since: "2026-11-06T12:40:00.000Z",
      blocks: [],
      actions: [
        {
          command: "daemon.resumeStarts",
          cli: "dipo daemon resume-starts",
          consequence: "Lift it early, only if you raised your plan.",
        },
      ],
      hand: "by itself",
    });
    const shown = text(previewLines(paused, CTX));
    expect(shown[1]).toBe("No new sessions start in this office");
    expect(shown).toContain("Reason  Claude plan limit reached");
    expect(shown).toContain("Lifts   by itself");
    expect(shown).toContain("✓ Nothing to do. Look away until it lifts.");
    expect(shown.slice(-2)).toEqual([
      "Lift it early, only if you raised your plan.",
      "$ dipo daemon resume-starts",
    ]);
  });
});

describe("the preview never truncates", () => {
  it("wraps a long question in full at the pane's width", () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const question = DeskItem.parse({
      kind: "QUESTION",
      story: "DIPO-450",
      question: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0Q50",
      detail: JSON.stringify(words),
      since: ago(12),
      blocks: [],
      actions: [{ command: "work.answer", cli: 'dipo answer qst_7f2c --text "<answer>"' }],
    });
    const lines = text(
      previewLines(question, { ...CTX, title: "Should filed stories keep their ordinal?" }),
    );
    expect(lines[0]).toBe("QUESTION · worker waiting 12m");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(63);
    expect(lines.join(" ")).toContain("word0 word1");
    expect(lines.join(" ")).toContain('word59"');
  });
});

describe("the state cards of screens/15", () => {
  it("offers the top-up on a budget-exceeded park and start again with a hint on a failed run", () => {
    const budget = DeskItem.parse({
      kind: "PARKED",
      story: "DIPO-447",
      reason: "budget-exceeded",
      detail: "Used 2.0M of 2.0M · loop 6 of 8 · criteria 8/10",
      since: ago(31),
      blocks: ["DIPO-448", "DIPO-449", "DIPO-450"],
      actions: [
        { command: "work.resume", cli: 'dipo resume DIPO-447 --budget +50% --note "<why>"' },
      ],
    });
    const shown = text(previewLines(budget, CTX));
    expect(shown.slice(0, 4)).toEqual([
      "PARKED · budget-exceeded · 31m · blocks 3",
      "DIPO-447 paused: token budget reached",
      "",
      "Used 2.0M of 2.0M · loop 6 of 8 · criteria 8/10",
    ]);
    expect(shown).toContain("r start again with a top-up: +25% · +50% · +100%   ⏎ inspect");
    const failed = DeskItem.parse({
      ...budget,
      story: "DIPO-450",
      reason: "verify-failing",
      detail: "bun run verify → 2 shards failed (reattach.test.ts)",
      actions: [{ command: "work.resume", cli: "dipo resume DIPO-450" }],
    });
    const lines = previewLines(failed, { ...CTX, phase: "build" });
    expect(text(lines).slice(1, 3)).toEqual([
      "DIPO-450 failed in verify",
      "setup ━━ ✗ build ┄┄ review ┄┄ test ┄┄ merge",
    ]);
    expect(text(lines)).toContain("r start again   s start again with a hint   ⏎ open run");
    expect(piece(lines, "✗ build")?.role).toBe("err");
  });
});

describe("the NEXT UP preview", () => {
  it("offers Start it and Offer the next one, and says nothing starts until you confirm", () => {
    const nextUp = DeskItem.parse({
      kind: "NEXT UP",
      story: "DIPO-452",
      detail: "first Ready story whose dependencies are Done",
      since: ago(1),
      blocks: [],
      actions: [
        { command: "nextUp.confirm", cli: "dipo next confirm DIPO-452" },
        { command: "nextUp.decline", cli: "dipo next decline DIPO-452" },
      ],
    });
    const shown = text(
      previewLines(nextUp, { ...CTX, title: "File every incoming idea as a draft" }),
    );
    expect(shown.slice(0, 2)).toEqual([
      "NEXT UP · a run slot is free",
      "DIPO-452 File every incoming idea as a draft",
    ]);
    expect(shown).toContain("⟦ y Start it ⟧  ⟦ n Offer the next one ⟧");
    // Wrapped at the 60-column measure, as mock 5 shows it.
    expect(shown).toContain("Nothing starts until you confirm. Declined stories return");
    expect(shown).toContain("once their task file changes.");
    expect(shown.at(-1)).toBe("$ dipo next confirm DIPO-452");
  });
});

describe("the Refined stories of an item (DIPO-484)", () => {
  const parked = DeskItem.parse({
    kind: "PARKED",
    story: "DIPO-447",
    reason: "budget-exceeded",
    detail: "Used 2.0M of 2.0M",
    since: ago(31),
    blocks: ["DIPO-448"],
    refined: [{ story: "DIPO-449", reason: "no test plan" }, { story: "DIPO-450" }],
    actions: [],
  });

  it("counts them apart from blocks and names each as Refined, not Ready yet with its first gate failure", () => {
    const shown = text(previewLines(parked, CTX));
    expect(shown[0]).toBe("PARKED · budget-exceeded · 31m · blocks 1 · 2 Refined, not Ready yet");
    expect(shown.some((row) => row.includes("Blocks") && row.includes("DIPO-448"))).toBe(true);
    expect(shown.some((row) => row.includes("DIPO-449 Refined, not Ready yet: no test plan"))).toBe(
      true,
    );
    expect(shown.some((row) => row.includes("DIPO-450 Refined, not Ready yet"))).toBe(true);
  });
});
