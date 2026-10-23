// The per-reason resume policy table of `resumption.ts` (DIPO-138): the M0 rows resume a
// needs-permission park through its answer and a plan-limit hold through work.resume; the parks of
// the 0020 matrix resume through work.resume by their cause (DIPO-155, test/run/resume-parks.test.ts),
// and a park whose reason and cause have no resuming row answers story.notPausedOrParked. The command and the
// park resume are driven on a migrated state database with one story run, a fake plan-limit
// schedule, a fake unpark writer and a fake next session.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  KNOWN_PARK_REASONS,
  type OfficeId,
  type RunId,
  StoryId,
  type StoryKey,
} from "@dipsaus-orchestrator/contract";

import { CommandError } from "../../src/commands/errors";
import { insertParkQuestion } from "../../src/hooks/questions";
import type { AsyncCommandContext } from "../../src/commands/registry";
import {
  createRunOutcomes,
  endRun,
  type HeldRunResumer,
  INTENT_TAGS,
  insertRun,
  PARK_RESUME_POLICY,
  parkResumeRow,
  raiseSignal,
  recordIntent,
  type Resumption,
  type RunEnder,
  resumeVia,
  runIntents,
  type ResumeWaitOutcome,
  type UnparkBranchRequest,
} from "../../src/run";
import type { NextSessionRequest } from "../../src/run/resume";
import { addStory } from "../../src/stories/keys";
import { encode } from "../../src/workers/claude-cli/encode";
import type { Caps } from "../../src/workers/types";
import { insertClaim } from "../../src/worktree/records";
import { type IngestFixture, ingestFixture } from "../ingest/helpers";

describe("the resume policy table", () => {
  it("resumes a needs-permission park through the permission answer", () => {
    expect(resumeVia("needs-permission")).toBe("permission-answer");
  });

  it("resumes a plan-limit hold through work.resume", () => {
    expect(resumeVia("plan-limit")).toBe("work.resume");
  });

  it("resumes an on-hold park through work.resume (DIPO-160)", () => {
    expect(resumeVia("on-hold")).toBe("work.resume");
  });

  it("resumes a paused run through work.resume (DIPO-163)", () => {
    expect(resumeVia("paused")).toBe("work.resume");
  });

  it("has the rows of M0, of the hold, of the pause and of the 0020 matrix reasons (DIPO-155)", () => {
    expect(Object.keys(PARK_RESUME_POLICY).toSorted()).toEqual([
      "ambiguous-spec",
      "budget-exceeded",
      "conflict",
      "interrupted",
      "needs-permission",
      "on-hold",
      "paused",
      "plan-limit",
      "review-blocked",
      "scope-violation",
      "stopped",
      "verify-failing",
      "worker-failed",
    ]);
    for (const reason of KNOWN_PARK_REASONS) {
      if (reason === "needs-permission") continue;
      expect(resumeVia(reason)).toBe(
        Object.hasOwn(PARK_RESUME_POLICY, reason) ? "work.resume" : null,
      );
    }
    expect(resumeVia("constructor")).toBeNull();
    expect(resumeVia("not-a-reason")).toBeNull();
  });
});

const CAPS: Caps = { budgetTokens: 1_000_000, maxTurns: 100, maxMinutes: 30 };

interface World {
  readonly dir: string;
  readonly f: IngestFixture;
  readonly key: StoryKey;
  /** The fake schedule's `resumeNow` calls. */
  readonly resumed: { office: OfficeId; run: RunId }[];
  readonly lifts: UnparkBranchRequest[];
  readonly sessions: NextSessionRequest[];
}

let w: World;

beforeEach(async () => {
  const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "resumption-"));
  const f = await ingestFixture(dir);
  const { office, run } = f;
  const { key } = office.immediate(() =>
    addStory(office, f.t.ids, { story: StoryId.parse("DIPO-1") }, f.t.clock.now()),
  );
  office.immediate(() => {
    insertRun(office, {
      runId: run,
      kind: "story",
      key,
      story: "DIPO-1",
      tier: "M",
      role: "developer",
      model: "haiku",
      startSha: "b".repeat(40),
      branch: "DIPO-1/add-a-greeting",
      worktree: join(dir, "trees", "DIPO-1"),
      slot: 1,
      budgetUnit: "tokens",
      budgetLimit: CAPS.budgetTokens,
      loopCap: 3,
      reviewRoundCap: null,
      configHash: "h",
      overrideKeys: null,
      runProfileId: null,
      startedAt: f.t.clock.now(),
    });
    insertClaim(office, {
      runId: run,
      key,
      story: "DIPO-1",
      branch: "DIPO-1/add-a-greeting",
      worktree: join(dir, "trees", "DIPO-1"),
      base: "main",
      baseSha: "b".repeat(40),
      startSha: "b".repeat(40),
      claimSha: "d".repeat(40),
      reused: false,
      snapshot: { path: "/x", adminDir: "/x", commondir: "/x", gitdir: "/x", pointer: "/x" },
      firstFeedback: null,
      claimedAt: f.t.clock.now(),
    });
    office.run(
      `insert into agents (office_id, agent_id, run_id, role, model, session_id, started_at,
         ended_at, end_reason)
       values ($office_id, $agent, $run, 'developer', 'haiku', 'session-1', $at, $at, 'exited')`,
      { agent: f.agent, run, at: f.t.clock.now() },
    );
  });
  w = { dir, f, key, resumed: [], lifts: [], sessions: [] };
});

afterEach(() => {
  w.f.t.state.close();
  rmSync(w.dir, { recursive: true, force: true });
});

const schedule: HeldRunResumer = {
  resumeNow: async (office, run): Promise<ResumeWaitOutcome> => {
    w.resumed.push({ office, run });
    return "started";
  },
};

/** The resumption, with the fake schedule unless `planLimits` is null (an office without one). */
function resumption(planLimits: HeldRunResumer | null = schedule): Resumption {
  const { f } = w;
  const ender = { isTracked: () => false } as unknown as RunEnder;
  return createRunOutcomes(
    {
      clock: f.t.clock,
      offices: { get: () => f.office },
      steering: { send: async () => ({ ok: true }) },
      encode,
      worker: { id: "claude-cli", result: () => ({ outcome: "done", resumable: true }) as never },
      ender: () => ender,
      resumer: {
        next: async (request) => {
          w.sessions.push(request);
          return { kind: "started", agent: "agt_x" as never, resumed: true };
        },
      },
      caps: () => CAPS,
      unpark: {
        lift: async (_office, request) => {
          w.lifts.push(request);
          return { commit: null, pushed: true, pushError: null };
        },
      },
    },
    { planLimits: () => planLimits ?? undefined },
  ).resumption;
}

/**
 * Parks the story `reason` at the current time with its permission question and ends its run;
 * returns the park and question ids.
 */
function park(reason: string): { parkId: number; question: string } {
  const { office, run, t } = w.f;
  const at = t.clock.now();
  const question = t.ids.next("qst");
  let parkId = 0;
  office.immediate(() => {
    office.run(
      `insert into parks (office_id, park_id, key, story_id, run_id, reason, from_state, detail, at)
       values ($office_id, (select coalesce(max(park_id), 0) + 1 from parks
         where office_id = $office_id), $key, 'DIPO-1', $run, $reason, 'In Progress', 'x', $at)`,
      { key: w.key, run, reason, at },
    );
    parkId = office.get<{ id: number }>(
      "select max(park_id) as id from parks where office_id = $office_id",
    )?.id as number;
    endRun(office, run, at, "blocked");
    insertParkQuestion(office, {
      questionId: question,
      runId: run,
      agentId: w.f.agent,
      parkId,
      tool: "Bash",
      action: "docker ps",
      text: "Bash(docker ps)",
      at,
    });
  });
  return { parkId, question };
}

/** The run is held by a plan limit: its `plan-limit` signal and wait fact, as outcomes store them. */
function hold(): void {
  const { office, run, t } = w.f;
  const at = t.clock.now();
  office.immediate(() => {
    raiseSignal(office, run, "plan-limit", at);
    recordIntent(
      office,
      run,
      "pause",
      `${INTENT_TAGS.planLimit} ${JSON.stringify({ scope: "credits", since: at })}`,
      at,
    );
  });
}

function ctx(): AsyncCommandContext {
  return {
    office: w.f.office,
    stories: { get: () => ({ story: "DIPO-1", key: w.key }) },
  } as unknown as AsyncCommandContext;
}

async function refusal(of: Resumption): Promise<CommandError | null> {
  try {
    await of.resumeCommand(ctx(), { story: StoryId.parse("DIPO-1") });
  } catch (error) {
    if (error instanceof CommandError) return error;
    throw error;
  }
  return null;
}

describe("work.resume through the policy table", () => {
  // A park recorded without a cause has a resuming row only where the matrix holds for every cause
  // of its reason (DIPO-155); those resume in resume-parks.test.ts, and needs-permission answers
  // resume.decisionRequired there.
  for (const reason of KNOWN_PARK_REASONS.filter((known) => parkResumeRow(known, null) === null)) {
    // An on-hold park is resumed by the planning lane (planning.test.ts, DIPO-160).
    if (reason === "on-hold") continue;
    it(`answers story.notPausedOrParked for a story parked ${reason}`, async () => {
      park(reason);
      const error = await refusal(resumption());
      expect(error?.error.code).toBe("story.notPausedOrParked");
      expect(error?.error.details).toEqual({ story: "DIPO-1" });
      expect(w.resumed).toEqual([]);
    });
  }

  it("answers story.notPausedOrParked for a story with no run standing still", async () => {
    const error = await refusal(resumption());
    expect(error?.error.code).toBe("story.notPausedOrParked");
    expect(error?.error.details).toEqual({ story: "DIPO-1" });
    expect(w.resumed).toEqual([]);
  });

  it("resumes a plan-limit hold through the schedule and names the run", async () => {
    hold();
    const reply = await resumption().resumeCommand(ctx(), { story: StoryId.parse("DIPO-1") });
    expect(reply.result).toEqual({
      story: "DIPO-1",
      key: w.key,
      to: "In Progress",
      run: w.f.run,
    });
    expect(w.resumed).toEqual([{ office: w.f.office.officeId as OfficeId, run: w.f.run }]);
  });

  it("refuses a plan-limit hold when the office has no plan-limit schedule", async () => {
    hold();
    await expect(
      resumption(null).resumeCommand(ctx(), { story: StoryId.parse("DIPO-1") }),
    ).rejects.toThrow("needs the plan-limit schedule");
    expect(w.resumed).toEqual([]);
  });
});

describe("park resume through the policy table", () => {
  it("resumes a needs-permission park on its answer", async () => {
    const resuming = resumption();
    const outcome = await resuming.resumePark(w.f.office.officeId as OfficeId, w.f.run, {
      ...park("needs-permission"),
      decision: "allow",
      text: "",
    });
    expect(outcome).toEqual({ kind: "started" });
    await resuming.idle();
    expect(w.lifts).toHaveLength(1);
    expect(w.sessions).toHaveLength(1);
  });

  for (const reason of KNOWN_PARK_REASONS.filter((known) => known !== "needs-permission")) {
    it(`answers not parked for a park ${reason} with an open question, and changes nothing`, async () => {
      const outcome = await resumption().resumePark(w.f.office.officeId as OfficeId, w.f.run, {
        ...park(reason),
        decision: "allow",
        text: "",
      });
      expect(outcome).toEqual({ kind: "notParked" });
      expect(w.lifts).toEqual([]);
      expect(w.sessions).toEqual([]);
      expect(runIntents(w.f.office, w.f.run)).toEqual([]);
    });
  }
});
