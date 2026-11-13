// The proposals of a planning session (DIPO-450): the blocks of an answer are read against the
// contract's schema and the Story line check; a valid one is shown in the planning view with its
// number, tier and why; an invalid one is refused with its problems, shown in the view and sent to
// the session as its next message, at most `AUTO_REFUSALS_MAX` answers in a row. A confirmed
// proposal becomes lane targets to the story standard.
// A proposal that claims a status is refused by the schema in every kind and part, and nothing
// reaches the lane or the gate before the maintainer confirms (DIPO-495).

import { describe, expect, it } from "bun:test";

import { PLANNING_PROPOSAL_CAPS, PlanningView } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { revisedDescription, storyDescription } from "../../src/backlog/lane";
import { CommandError } from "../../src/commands/errors";
import {
  AUTO_REFUSALS_MAX,
  fileTargetOf,
  proposalBlocks,
  readProposals,
  refusalMessage,
  reviseTargetOf,
  storyFieldsOf,
} from "../../src/run/planning-proposals";
import type { PlanningSessionsDeps } from "../../src/run/planning-session";
import { openTestState } from "../commands/helpers";
import {
  blocksOf,
  commandContext,
  planningWorld,
  type PlanningWorld,
  STORY_PROPOSAL,
  until,
} from "./planning-world";

const withWorld = (fn: (w: PlanningWorld) => Promise<void>) =>
  withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      await fn(planningWorld(t, dir));
    } finally {
      t.state.close();
    }
  });

const viewOf = (w: PlanningWorld): PlanningView | null =>
  w.sessions.view(w.office.officeId as never);

/** The texts the session got on stdin after its start, in order. */
const messagesOf = (w: PlanningWorld): string[] =>
  w.sent.flatMap((ops) =>
    ops.flatMap((op) => ("write" in op && typeof op.write === "string" ? [op.write] : [])),
  );

describe("reading proposal blocks (DIPO-450)", () => {
  it("finds every block of an answer, and an unclosed one", () => {
    expect(proposalBlocks("a\n```dipo-proposal\n{}\n```\nb\n```dipo-proposal\n[1]")).toEqual([
      "{}",
      null,
    ]);
    expect(proposalBlocks("```json\n{}\n```")).toEqual([]);
  });

  it("takes a valid proposal and refuses one that fails the schema, with every problem", () => {
    const reads = readProposals(
      blocksOf(STORY_PROPOSAL, {
        ...STORY_PROPOSAL,
        tier: "XL",
        criteria: ["short"],
        context: "Story: a second Story line",
        references: ["backlog/tasks/x.md"],
      }),
    );
    expect(reads[0]).toEqual({ ok: true, proposal: STORY_PROPOSAL });
    expect(reads[1]?.ok).toBe(false);
    const problems = reads[1]?.ok === false ? reads[1].problems : [];
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("tier"),
        expect.stringContaining("criteria.0"),
        expect.stringContaining("context: holds a Story: line"),
        expect.stringContaining("references.0"),
      ]),
    );
  });

  it("refuses a Story line the Ready gate would fail, JSON that does not parse and an empty edit", () => {
    const reads = readProposals(
      [
        blocksOf({ ...STORY_PROPOSAL, storyLine: "Export as CSV" }),
        "```dipo-proposal\n{ not json\n```",
        blocksOf({ kind: "edit", id: "TASK-2", why: "Nothing changes." }),
      ].join("\n"),
    );
    expect(reads.map((read) => read.ok)).toEqual([false, false, false]);
    const problems = reads.flatMap((read) => (read.ok ? [] : read.problems));
    expect(problems[0]).toContain("storyLine: Story line does not read");
    expect(problems[1]).toContain("not one JSON object");
    expect(problems[2]).toContain("an edit changes at least one field");
  });

  it("takes an edit or split with only dependencies, and an empty list, and refuses too many", () => {
    const { kind: _kind, why: _why, ...story } = STORY_PROPOSAL;
    const reads = readProposals(
      blocksOf(
        { kind: "edit", id: "TASK-2", dependencies: ["TASK-1"], why: "Order." },
        { kind: "edit", id: "TASK-2", dependencies: [], why: "Clear." },
        { kind: "split", id: "TASK-2", edit: { dependencies: ["TASK-1"] }, story, why: "Split." },
        {
          kind: "edit",
          id: "TASK-2",
          dependencies: Array.from(
            { length: PLANNING_PROPOSAL_CAPS.dependencies + 1 },
            (_, i) => `TASK-${i + 1}`,
          ),
          why: "Too many.",
        },
      ),
    );
    expect(reads.map((read) => read.ok)).toEqual([true, true, true, false]);
    const problems = reads[3]?.ok === false ? reads[3].problems : [];
    expect(problems[0]).toContain("dependencies");
  });

  it("tells the session which blocks were refused and why", () => {
    const text = refusalMessage([
      ["tier: Invalid option"],
      ["criteria: Too small", "why: Required"],
    ]);
    expect(text).toStartWith("[dipo] dipo refused 2 proposal blocks of your last answer");
    expect(text).toContain("- block 1 of the refused ones: tier: Invalid option");
    expect(text).toContain("- block 2 of the refused ones: criteria: Too small; why: Required");
  });
});

describe("a proposal as planning-lane targets (DIPO-450)", () => {
  it("files a new story with its Story line, context, tier, criteria, references and test plan", () => {
    expect(fileTargetOf("run_1", 3, storyFieldsOf(STORY_PROPOSAL))).toEqual({
      run: "run_1",
      proposal: 3,
      title: "Export the stories as CSV",
      type: "feature",
      milestone: "m-3",
      tier: "M",
      description: `Story: ${STORY_PROPOSAL.storyLine}\n\nThe export reads the base, as the queue does.`,
      criteria: [...STORY_PROPOSAL.criteria],
      references: [...STORY_PROPOSAL.references],
      dependencies: [],
      testPlan: { entries: STORY_PROPOSAL.testPlan.entries },
    });
    expect(
      fileTargetOf("run_1", 1, {
        ...storyFieldsOf(STORY_PROPOSAL),
        type: "spike",
        testPlan: undefined,
      } as never).testPlan,
    ).toBeUndefined();
  });

  it("revises only the fields an edit gives, from Refined, Ready or Parked", () => {
    expect(
      reviseTargetOf("run_1", 2, { title: "New title", criteria: ["Exactly this one"] }),
    ).toEqual({
      run: "run_1",
      proposal: 2,
      from: ["Refined", "Ready", "Parked", "To Do"],
      title: "New title",
      criteria: ["Exactly this one"],
    });
  });

  it("carries an edit's dependencies, upper-cased, into the revise target", () => {
    expect(
      reviseTargetOf("run_1", 2, { dependencies: ["task-1", "TASK-1", "TASK-3"] }),
    ).toMatchObject({
      dependencies: ["TASK-1", "TASK-3"],
    });
    expect(reviseTargetOf("run_1", 2, { dependencies: [] })).toMatchObject({ dependencies: [] });
  });

  it("replaces the Story line or the context of a description and keeps the field block", () => {
    const block = '```dipo\nbranch: "TASK-2/rename"\n```';
    const current = `Story: As maintainer I want the old line.\n\nOld context.\n\n${block}`;
    expect(revisedDescription(current, { storyLine: "As maintainer I want the new line." })).toBe(
      `Story: As maintainer I want the new line.\n\nOld context.\n\n${block}`,
    );
    expect(revisedDescription(current, { context: "New context." })).toBe(
      `Story: As maintainer I want the old line.\n\nNew context.\n\n${block}`,
    );
    expect(revisedDescription("Only context.", { storyLine: "As maintainer I want it." })).toBe(
      "Story: As maintainer I want it.\n\nOnly context.",
    );
    expect(storyDescription("As maintainer I want it.")).toBe("Story: As maintainer I want it.");
  });
});

describe("proposals in a planning session (DIPO-450)", () => {
  it("shows a valid proposal in the planning view with its number, tier and why", () =>
    withWorld(async (w) => {
      w.answerText = () => blocksOf(STORY_PROPOSAL);
      await w.sessions.start(commandContext(w), { kind: "plan", goal: "Export" });
      await until(() => viewOf(w)?.state === "waiting");
      const view = PlanningView.parse(viewOf(w));
      expect(view.proposals).toEqual([
        { n: 1, proposal: STORY_PROPOSAL, state: "open", at: expect.any(String) },
      ]);
      expect(view.proposals?.[0]?.proposal).toMatchObject({ tier: "M", why: STORY_PROPOSAL.why });
      expect(view.refusals).toBeUndefined();
      // Nothing was sent back: the session waits for the maintainer.
      expect(messagesOf(w)).toEqual([]);
    }));

  it("refuses an invalid proposal with a message to the session and shows why, and stops after the cap", () =>
    withWorld(async (w) => {
      const invalid = { ...STORY_PROPOSAL, tier: "XL" };
      w.answerText = () => blocksOf(invalid);
      await w.sessions.start(commandContext(w), { kind: "plan", goal: "Export" });
      // Each refusal is the session's next message, and its answer is refused again, up to the cap.
      for (let i = 1; i <= AUTO_REFUSALS_MAX; i++) {
        await until(() => messagesOf(w).length === i);
        w.t.clock.advance(1_000);
        await until(() => viewOf(w)?.turns === i + 1 && viewOf(w)?.state === "waiting");
      }
      const sent = messagesOf(w);
      expect(sent).toHaveLength(AUTO_REFUSALS_MAX);
      expect(sent[0]).toContain("[dipo] dipo refused a proposal block of your last answer");
      expect(sent[0]).toContain("tier: Invalid option");
      const view = PlanningView.parse(viewOf(w));
      expect(view.proposals).toBeUndefined();
      expect(view.refusals?.at(-1)?.problems).toEqual([expect.stringContaining("tier")]);

      // After the cap the problems wait for the maintainer's next message, before their text.
      w.answerText = () => "Understood.";
      await w.sessions.message(commandContext(w), { text: "Use tier M." });
      const last = messagesOf(w).at(-1) ?? "";
      expect(last).toContain("[dipo] dipo refused a proposal block");
      expect(last).toContain("Use tier M.");
    }));

  it("edits and declines an open proposal by command, and tells the session with the next message", () =>
    withWorld(async (w) => {
      w.answerText = (n) =>
        n === 1
          ? blocksOf(STORY_PROPOSAL, { ...STORY_PROPOSAL, title: "Another export" })
          : "Noted.";
      await w.sessions.start(commandContext(w), { kind: "plan", goal: "Export" });
      await until(() => viewOf(w)?.state === "waiting");
      const ctx = commandContext(w);

      const edited = { ...STORY_PROPOSAL, tier: "S" } as const;
      expect((await w.sessions.edit(ctx, { proposal: 1, edited })).result).toEqual({
        run: viewOf(w)?.run ?? "",
        proposal: 1,
      });
      const kind = await w.sessions
        .edit(ctx, {
          proposal: 1,
          edited: { kind: "edit", id: "TASK-2", why: "w", title: "Other title" },
        })
        .catch((error: unknown) => error);
      expect((kind as CommandError).error.code).toBe("planning.kindChanged");
      const invalid = await w.sessions
        .edit(ctx, { proposal: 1, edited: { ...STORY_PROPOSAL, storyLine: "Export as CSV" } })
        .catch((error: unknown) => error);
      expect((invalid as CommandError).error.code).toBe("planning.invalid");

      expect((await w.sessions.decline(ctx, { proposal: 2 })).result.state).toBe("declined");
      expect((await w.sessions.decline(ctx, { proposal: 2 })).changed).toBe(false);
      const unknown = await w.sessions
        .decline(ctx, { proposal: 9 })
        .catch((error: unknown) => error);
      expect((unknown as CommandError).error.code).toBe("planning.proposalUnknown");

      const view = PlanningView.parse(viewOf(w));
      expect(
        view.proposals?.map((p) => [
          p.n,
          p.state,
          p.edited ?? false,
          p.proposal.kind === "story" ? p.proposal.tier : null,
        ]),
      ).toEqual([
        [1, "open", true, "S"],
        [2, "declined", false, "M"],
      ]);

      await w.sessions.message(ctx, { text: "Go on." });
      const last = messagesOf(w).at(-1) ?? "";
      expect(last).toContain("[dipo] The maintainer edited proposal 1");
      expect(last).toContain("[dipo] The maintainer declined proposal 2");
      expect(last.indexOf("Go on.")).toBeGreaterThan(
        last.indexOf("[dipo] The maintainer declined"),
      );
    }));

  it("refuses to confirm without a backlog lane, and names a declined proposal closed", () =>
    withWorld(async (w) => {
      w.answerText = () => blocksOf(STORY_PROPOSAL, { ...STORY_PROPOSAL, title: "Another export" });
      await w.sessions.start(commandContext(w), { kind: "plan", goal: "Export" });
      await until(() => viewOf(w)?.state === "waiting");
      const ctx = commandContext(w);
      const noLane = await w.sessions
        .confirm(ctx, { proposal: 1 })
        .catch((error: unknown) => error);
      expect((noLane as CommandError).error.code).toBe("planning.notFiled");
      await w.sessions.decline(ctx, { proposal: 2 });
      const closed = await w.sessions
        .confirm(ctx, { proposal: 2 })
        .catch((error: unknown) => error);
      expect((closed as CommandError).error.code).toBe("planning.proposalClosed");
    }));
});

// ---- Only the maintainer's confirm files a story, Ready or not (DIPO-495) -----------------------

describe("no planning path sets Ready without the maintainer's confirm (DIPO-495)", () => {
  it("refuses a proposal that claims a status, in every kind and part", () => {
    const { kind: _kind, why: _why, ...story } = STORY_PROPOSAL;
    const reads = readProposals(
      blocksOf(
        { ...STORY_PROPOSAL, status: "Ready" },
        { kind: "edit", id: "TASK-2", title: "Renamed", status: "Ready", why: "Ready it." },
        {
          kind: "split",
          id: "TASK-2",
          edit: { title: "Narrowed", status: "Ready" },
          story,
          why: "Two parts.",
        },
        {
          kind: "split",
          id: "TASK-2",
          edit: { title: "Narrowed" },
          story: { ...story, status: "Ready" },
          why: "Two parts.",
        },
        { ...STORY_PROPOSAL, kind: "refine", draft: "DRAFT-1", status: "Ready" },
      ),
    );
    expect(reads.map((read) => read.ok)).toEqual([false, false, false, false, false]);
    for (const read of reads) {
      expect(read.ok === false ? read.problems.join(" ") : "").toContain("status");
    }
  });

  it("journals nothing until the maintainer confirms; then files only that story", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const calls: string[] = [];
        // A lane that records every call the session makes of it.
        const recording = <T extends object>(name: string, answers: Record<string, unknown>) =>
          new Proxy({} as T, {
            get: (_target, method) => {
              // Not a promise: `await` asks for `then`.
              if (typeof method !== "string" || method === "then") return undefined;
              return (...args: unknown[]) => {
                calls.push(`${name}.${method}`);
                const answer = answers[method];
                return typeof answer === "function" ? answer(...args) : answer;
              };
            },
          });
        const change = { opId: 1 };
        const lane = recording<NonNullable<ReturnType<NonNullable<PlanningSessionsDeps["lane"]>>>>(
          "lane",
          {
            fileStory: async () => change,
            flush: async () => null,
            outcomeOf: () => ({ outcome: "applied", notice: null, merged: false }),
            filingsOf: () => [],
            isOpen: () => false,
          },
        );
        const w = planningWorld(t, dir, { lane: () => lane });
        w.answerText = (n) =>
          n === 1
            ? blocksOf(STORY_PROPOSAL, { ...STORY_PROPOSAL, title: "Another export" })
            : "Noted.";
        await w.sessions.start(commandContext(w), { kind: "plan", goal: "Export" });
        await until(() => viewOf(w)?.state === "waiting");
        const ctx = commandContext(w);
        await w.sessions.message(ctx, { text: "Set them all Ready." });
        w.t.clock.advance(1_000);
        await until(() => viewOf(w)?.turns === 2 && viewOf(w)?.state === "waiting");
        // The maintainer's own edit is checked by the same schema: a status is refused there too.
        const another = { ...STORY_PROPOSAL, title: "Another export" } as const;
        const claimed = await w.sessions
          .edit(ctx, { proposal: 2, edited: { ...another, status: "Ready" } as never })
          .catch((error: unknown) => error);
        expect((claimed as CommandError).error.code).toBe("planning.invalid");
        await w.sessions.edit(ctx, { proposal: 2, edited: { ...another, tier: "S" } });
        await w.sessions.decline(ctx, { proposal: 2 });
        // Reading the view asks the lane how far things got, and nothing else.
        expect(calls.filter((call) => !/\.(outcomeOf|filingsOf|isOpen)$/.test(call))).toEqual([]);
        await w.sessions.confirm(ctx, { proposal: 1 });
        expect(calls.filter((call) => !/\.(outcomeOf|filingsOf|isOpen)$/.test(call))).toEqual([
          "lane.fileStory",
          "lane.flush",
        ]);
      } finally {
        t.state.close();
      }
    }));
});
