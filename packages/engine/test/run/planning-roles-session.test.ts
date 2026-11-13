// The roles session (DIPO-475): started from the Roles room, it shares the office's one planning
// slot, its first message holds the roster, the invalid role files and each role's recent runs
// counted by code, and it takes only role proposals while every other kind takes none.

import { describe, expect, it } from "bun:test";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { CommandError } from "../../src/commands/errors";
import type { OfficeHandle } from "../../src/db/office";
import { roleRunCounts } from "../../src/records/retro";
import { renderRoleFile } from "../../src/roles/file";
import { checkProposal, readProposals } from "../../src/run/planning-proposals";
import { openTestState } from "../commands/helpers";
import {
  blocksOf,
  commandContext,
  planningWorld,
  type PlanningWorld,
  ROSTER_FILES,
  STORY_PROPOSAL,
  until,
} from "./planning-world";

const FILES: ReadonlyMap<string, string | undefined> = new Map([
  ...ROSTER_FILES,
  [
    ".dipo/roles/writer.md",
    renderRoleFile({
      purpose: "Writes the docs",
      model: "claude-sonnet-5-5",
      effort: "high",
      instructions: "Write clearly.",
    }),
  ],
  [".dipo/roles/broken.md", "---\nversion: 1\n---\n\nNo purpose.\n"],
]);

let next = 0;
/** One ended story run of `role`, with its outcome row. */
function runOf(
  office: OfficeHandle,
  role: string | null,
  fields: {
    outcome: string;
    reasons?: string[];
    failed?: number;
    rounds?: number;
    ci?: number;
    cost?: number | null;
  },
): void {
  next += 1;
  const run = `run_roles_${next}`;
  office.immediate(() => {
    office.run(
      `insert into runs (office_id, run_id, kind, key, story_id, branch, start_sha, role, model, budget_unit, budget_limit, loop_cap,
         config_hash, started_at, ended_at, end_kind)
       values ($office_id, $run, 'story', $run, 's', 'b', 'sha', $role, 'sonnet', 'tokens', 1000, 3, 'h', 0, $at, $outcome)`,
      { run, role: role ?? "", at: next, outcome: fields.outcome },
    );
    office.run(
      `insert into run_outcomes (office_id, run_id, tier, role, model, outcome, park_reasons, loops,
         review_rounds, verify_failures, budget_tokens, minutes, ended_at, review_rounds_failed,
         ci_attempts, cost_micros)
       values ($office_id, $run, 'M', $role, 'sonnet', $outcome, $reasons, 0, $rounds, 0, 0, 1, $at,
         $failed, $ci, $cost)`,
      {
        run,
        role: role ?? "developer",
        at: next,
        outcome: fields.outcome,
        reasons: JSON.stringify(fields.reasons ?? []),
        rounds: fields.rounds ?? 0,
        failed: fields.failed ?? 0,
        ci: fields.ci ?? 0,
        cost: fields.cost ?? null,
      },
    );
  });
}

/** Two roles with different endings, parks, rounds, CI attempts and cost. */
function fixture(office: OfficeHandle): void {
  runOf(office, "developer", { outcome: "done", rounds: 2, failed: 1, ci: 1, cost: 1_500_000 });
  runOf(office, "developer", { outcome: "parked", reasons: ["verify-failing"], ci: 2 });
  runOf(office, null, {
    outcome: "parked",
    reasons: ["verify-failing", "conflict"],
    cost: 500_000,
  });
  runOf(office, "writer", { outcome: "done", rounds: 1, cost: 250_000 });
}

const withWorld = (
  fn: (w: PlanningWorld) => Promise<void>,
  roleFiles: () => ReadonlyMap<string, string | undefined> = () => FILES,
) =>
  withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      await fn(planningWorld(t, dir, { roleFiles }));
    } finally {
      t.state.close();
    }
  });

describe("the counts of a role's recent runs", () => {
  it("match a fixture with runs of two roles, different endings and parks; a run with no role counts as developer", () =>
    withWorld(async (w) => {
      fixture(w.office);
      expect(roleRunCounts(w.office)).toEqual([
        {
          role: "developer",
          runs: 3,
          endings: { done: 1, parked: 2 },
          parks: { "verify-failing": 2, conflict: 1 },
          reviewRounds: 2,
          reviewRoundsFailed: 1,
          ciAttempts: 3,
          costMicros: 2_000_000,
        },
        {
          role: "writer",
          runs: 1,
          endings: { done: 1 },
          parks: {},
          reviewRounds: 1,
          reviewRoundsFailed: 0,
          ciAttempts: 0,
          costMicros: 250_000,
        },
      ]);
    }));
});

describe("a roles session", () => {
  it("opens with a first message holding each role, the invalid file and each role's run counts, and only the role proposal schema", () =>
    withWorld(async (w) => {
      fixture(w.office);
      const { view } = (
        await w.sessions.start(commandContext(w), { kind: "roles", goal: "How is the writer?" })
      ).result;
      expect(view.kind).toBe("roles");
      const first = (JSON.parse(w.plans[0]?.stdin[0] ?? "{}") as { message: { content: string } })
        .message.content;
      expect(first).toContain("kind: roles");
      expect(first).toContain("goal: How is the writer?");
      expect(first).toContain("## developer\npurpose: Builds the story");
      expect(first).toContain("## writer\npurpose: Writes the docs");
      expect(first).toContain("model: claude-sonnet-5-5\neffort: high");
      expect(first).toContain("instructions:\nWrite clearly.");
      expect(first).toContain(".dipo/roles/broken.md");
      expect(first).toContain(
        "3 recent runs; ended: parked 2, done 1; parks: verify-failing 2, conflict 1; review rounds failed 1 of 2, CI attempts 3; cost: $2.00",
      );
      expect(first).toContain(
        "1 recent run; ended: done 1; parks: none; review rounds failed 0 of 1, CI attempts 0; cost: $0.25",
      );
      expect(first).toContain("role-remove");
      expect(first).not.toContain('"const":"split"');
      expect(first).not.toContain("<drafts>");
    }));

  it("is refused as planning.open while a plan session is open, and the other way round", () =>
    withWorld(async (w) => {
      await w.sessions.start(commandContext(w), { kind: "plan", goal: "Plan" });
      const refused = await w.sessions
        .start(commandContext(w), { kind: "roles", goal: "Roles" })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(CommandError);
      expect((refused as CommandError).error.code).toBe("planning.open");
      expect(w.boxes.made).toHaveLength(1);
    }));

  it("refuses a story proposal block in its answer and keeps the role proposal", () =>
    withWorld(async (w) => {
      w.answerText = (n) =>
        n > 1
          ? "Noted."
          : blocksOf(STORY_PROPOSAL, {
              kind: "role",
              name: "tester",
              purpose: "Writes the tests",
              instructions: "Test each criterion.",
              why: "Stories need a tester.",
            });
      await w.sessions.start(commandContext(w), { kind: "roles", goal: "Roles" });
      const office = w.office.officeId as never;
      await until(() => (w.sessions.view(office)?.refusals?.length ?? 0) > 0);
      expect(w.sessions.view(office)?.proposals?.map((p) => p.proposal.kind)).toEqual(["role"]);
      expect(w.sessions.view(office)?.refusals?.[0]?.problems.join()).toContain(
        "a roles session takes only role, role-edit and role-remove proposals",
      );
    }));
});

describe("the kind of a session and its proposals", () => {
  const role = {
    kind: "role",
    name: "tester",
    purpose: "Writes the tests",
    instructions: "Test each criterion.",
    why: "Stories need a tester.",
  };
  const facts = { files: FILES, openStories: () => [] };
  const problems = (value: unknown, kind: string): string[] => {
    const read = checkProposal(value, facts, kind);
    return read.ok ? [] : [...read.problems];
  };

  it("a roles session refuses a story proposal, naming the kind", () => {
    expect(problems(STORY_PROPOSAL, "roles").join()).toContain("a roles session takes only role");
    expect(problems(role, "roles")).toEqual([]);
  });

  it("a plan, refine and triage session refuse a role proposal, naming the kind", () => {
    for (const kind of ["plan", "refine", "triage"]) {
      expect(problems(role, kind).join()).toContain(`a ${kind} session takes no \`role\` proposal`);
      expect(problems({ kind: "role-remove", name: "writer", why: "x" }, kind)).toHaveLength(1);
    }
    expect(problems(STORY_PROPOSAL, "plan").join()).not.toContain("session takes");
  });

  it("reads blocks of an answer against the session's kind", () => {
    const reads = readProposals(blocksOf(role, STORY_PROPOSAL), facts, "plan");
    expect(reads.map((read) => read.ok)).toEqual([false, true]);
  });
});
