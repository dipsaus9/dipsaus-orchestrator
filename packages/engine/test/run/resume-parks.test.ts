// `work.resume` of a parked story by the 0020 table (DIPO-155, DIPO-344): every reason resumes, or
// is refused, as the table says, with its first message, and the session follows from the run's
// facts; the note lands on the resolved park, the top-up rules answer their `resume.*` codes, every
// cap change is a recorded grant, a resume whose place is taken is queued, and a retry of the same
// request repeats nothing.
// Driven on a migrated state database with one tier S story run, a fake unpark writer, a fake next
// session and fake review, fix-round and port starters; no git and no worker run.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  type AgentId,
  type CommandRequest,
  type OfficeId,
  RequestId,
  type RunId,
  StoryId,
  type StoryKey,
} from "@dipsaus-orchestrator/contract";

import { CommandError } from "../../src/commands/errors";
import { executeCommand, type ExecutorDeps } from "../../src/commands/execute";
import { stateOfficeDirectory } from "../../src/commands/offices";
import { buildRegistry } from "../../src/commands/registry";
import { MemoryRequestTable } from "../../src/commands/requests";
import type { AsyncCommandContext } from "../../src/commands/registry";
import { workerAnswerText } from "../../src/hooks/permissions";
import { closeQuestion, findQuestion, insertWorkerQuestion } from "../../src/hooks/questions";
import { HANDOFF_NOTE_MAX } from "../../src/prompts/handoff";
import { recordReviewVerdict } from "../../src/review/store";
import {
  appendRunStep,
  createRunOutcomes,
  endRun,
  findRun,
  grantTotals,
  insertRun,
  MAINTAINER_RESUME_TAG,
  noteText,
  PARK_RESUME_NOTICES,
  parkActions,
  parkResumeNeed,
  Places,
  RESUME_TABLE,
  type Resumption,
  type ResumptionOptions,
  type RunEnder,
  runCaps,
  runIntents,
  share,
  smallestShare,
  START_KINDS,
  type StartsPausedState,
  type UnparkBranchRequest,
} from "../../src/run";
import { storeFeedbackItems } from "../../src/run/feedback-items";
import { recordIntent } from "../../src/run/intents";
import { openPark } from "../../src/run/park";
import { sendFeedback } from "../../src/run/feedback";
import { insertPark, mirrorStory } from "./park-fixture";
import { parksBeingResumed } from "../../src/run/park-resume";
import { type HeldSession, withHeld } from "./held-session";
import { addStory } from "../../src/stories/keys";
import { encode } from "../../src/workers/claude-cli/encode";
import type { Caps } from "../../src/workers/types";
import { insertClaim } from "../../src/worktree/records";
import { CRASH, crashAfterHandler } from "../commands/crash";
import { type IngestFixture, ingestFixture } from "../ingest/helpers";

/**
 * The first message the session of `request` got (`RunResumer`): the resume delta of a native
 * resume, then every held message, the findings before the maintainer's words.
 */
function first(request: HeldSession | undefined): string {
  return request?.message ?? "";
}

/** Every command counts as implemented. */
const all = () => true;

/** Tier S of the office defaults (0008 section 9). */
const TIER_S: Caps = { budgetTokens: 300_000, maxTurns: 60, maxMinutes: 30 };

interface World {
  readonly dir: string;
  readonly f: IngestFixture;
  readonly key: StoryKey;
  readonly lifts: UnparkBranchRequest[];
  readonly sessions: HeldSession[];
  readonly reviews: RunId[];
  readonly considered: RunId[];
  readonly ported: string[];
  /** The office's starts paused (0020), as the park resume reads it. */
  paused: StartsPausedState | null;
  request: number;
  /** Why the fake lift did not write a question park's answer (DIPO-159), or null. */
  answerError: string | null;
}

let w: World;

beforeEach(async () => {
  const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "resume-parks-"));
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
      tier: "S",
      role: "developer",
      model: "haiku",
      startSha: "b".repeat(40),
      branch: "DIPO-1/add-a-greeting",
      budgetUnit: "tokens",
      budgetLimit: TIER_S.budgetTokens,
      loopCap: 3,
      maxTurns: TIER_S.maxTurns,
      maxMinutes: TIER_S.maxMinutes,
      reviewRoundCap: 3,
      ciCap: 2,
      conflictCap: 2,
      reviewMaxTurns: 40,
      reviewMaxMinutes: 20,
      reviewMaxTokens: 100_000,
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
      base: "main",
      baseSha: "b".repeat(40),
      startSha: "b".repeat(40),
      claimSha: "d".repeat(40),
      reused: false,
      claimedAt: f.t.clock.now(),
    });
    office.run(
      `insert into agents (office_id, agent_id, run_id, role, model, session_id, started_at,
         ended_at, end_reason)
       values ($office_id, $agent, $run, 'developer', 'haiku', 'session-1', $at, $at, 'exited')`,
      { agent: f.agent, run, at: f.t.clock.now() },
    );
  });
  w = {
    dir,
    f,
    key,
    lifts: [],
    sessions: [],
    reviews: [],
    considered: [],
    ported: [],
    paused: null,
    request: 0,
    answerError: null,
  };
});

afterEach(() => {
  w.f.t.state.close();
  rmSync(w.dir, { recursive: true, force: true });
});

/** The resumption with fakes for everything that would reach git, a worker or the host. */
function resumption(options: Partial<ResumptionOptions> = {}): Resumption {
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
          w.sessions.push(withHeld(f.office, request, f.t.clock.now()));
          return { kind: "started", agent: f.t.ids.next("agt") as AgentId, resumed: true };
        },
      },
      caps: () => TIER_S,
      unpark: {
        lift: async (_office, request) => {
          w.lifts.push(request);
          return {
            commit: null,
            pushed: true,
            pushError: null,
            ...(request.answer === undefined ? {} : { answerError: w.answerError }),
          };
        },
      },
    },
    {
      parks: {
        startsPaused: () => w.paused,
        startReview: async (_office, run) => {
          w.reviews.push(run.runId);
          return true;
        },
        fixRounds: () => ({
          consider: async (_office, run) => {
            w.considered.push(run);
            return true;
          },
        }),
        conflicts: () => ({
          prepare: async () => {
            w.ported.push("conflict");
            return { message: "Conflict item: src/a.ts has conflict markers." };
          },
        }),
        merge: () => ({
          reenter: async () => {
            w.ported.push("merge");
          },
        }),
        prs: () => ({
          replace: async () => {
            w.ported.push("pr");
          },
        }),
      },
      ...options,
    },
  ).resumption;
}

/**
 * Parks the story with `reason` and ends its run with `endKind` (`in-review` or `reviewed` for a
 * run that waited In Review when it parked); returns the park id.
 */
function park(reason: string, from = "In Progress", detail = "x", endKind = "parked"): number {
  const { office, run, t } = w.f;
  const at = t.clock.now();
  office.immediate(() => {
    insertPark(office, { key: w.key, story: "DIPO-1", runId: run, reason, from, detail, at });
    endRun(office, run, at, endKind);
  });
  return office.get<{ id: number }>(
    "select max(park_id) as id from parks where office_id = $office_id",
  )?.id as number;
}

function ctx(confirmed = false, request?: string): AsyncCommandContext {
  w.request += 1;
  return {
    office: w.f.office,
    clock: w.f.t.clock,
    ids: w.f.t.ids,
    requestId: (request ?? `req_${w.request}`) as RequestId,
    origin: "cli",
    confirmed,
    client: "dipo-cli",
    now: w.f.t.clock.now(),
    stories: { get: () => ({ story: "DIPO-1", key: w.key }) },
    commit: () => {},
  } as unknown as AsyncCommandContext;
}

async function resume(
  of: Resumption,
  args: { note?: string; budget?: { share: number } | { tokens: number } } = {},
  context: AsyncCommandContext = ctx(),
) {
  const reply = await of.resumeCommand(context, { story: StoryId.parse("DIPO-1"), ...args });
  await of.idle();
  return reply;
}

async function refusal(
  of: Resumption,
  args: { note?: string; budget?: { share: number } | { tokens: number } } = {},
  context: AsyncCommandContext = ctx(),
): Promise<CommandError> {
  try {
    await of.resumeCommand(context, { story: StoryId.parse("DIPO-1"), ...args });
  } catch (error) {
    if (error instanceof CommandError) return error;
    throw error;
  }
  throw new Error("work.resume did not refuse");
}

function parkRow(parkId: number) {
  return w.f.office.get<{ resolved_how: string | null; resolved_note: string | null }>(
    "select resolved_how, resolved_note from parks where office_id = $office_id and park_id = $park",
    { park: parkId },
  );
}

function grants() {
  return w.f.office.all<{
    kind: string;
    amount: string;
    note: string | null;
    origin: string;
    client: string | null;
  }>(
    "select kind, amount, note, origin, client from run_grants where office_id = $office_id order by at, grant_id",
  );
}

function usage(turns: number, tokens: number, agent: string = w.f.agent): void {
  w.f.office.immediate(() =>
    w.f.office.run(
      `insert into usage_totals (office_id, run_id, agent_id, model, role, tier, input, turns,
         updated_at)
       values ($office_id, $run, $agent, 'haiku', 'developer', 'S', $tokens, $turns, $at)`,
      { run: w.f.run, agent, tokens, turns, at: w.f.t.clock.now() },
    ),
  );
}

function storyStates(): { from: string; to: string }[] {
  return w.f.office
    .all<{ delta: string }>(
      "select delta from change_log where office_id = $office_id and type = 'story.state' order by seq",
    )
    .map((row) => JSON.parse(row.delta) as { from: string; to: string })
    .map(({ from, to }) => ({ from, to }));
}

/** `n` run steps of `kind` (a loop, a CI attempt or a failed review round) on the run. */
function steps(kind: "loop" | "ci" | "review-failed", n: number): void {
  const { office, run, t } = w.f;
  office.immediate(() => {
    for (let i = 0; i < n; i++) appendRunStep(office, run, kind, String(i + 1), t.clock.now());
  });
}

/** A reviewer session of the run, newer than the developer's; its agent id. */
function reviewerAgent(): string {
  const { office, run, t } = w.f;
  const reviewer = t.ids.next("agt");
  t.clock.advance(1_000);
  office.immediate(() =>
    office.run(
      `insert into agents (office_id, agent_id, run_id, role, model, session_id, started_at,
         ended_at, end_reason)
       values ($office_id, $agent, $run, 'reviewer', 'opus', 'session-r', $at, $at, 'capped')`,
      { agent: reviewer, run, at: t.clock.now() },
    ),
  );
  return reviewer;
}

describe("the resume table (0020)", () => {
  it("has one row per reason of 0001: what the resume requires", () => {
    expect(Object.keys(RESUME_TABLE).toSorted()).toEqual(
      [
        "ambiguous-spec",
        "budget-exceeded",
        "by-maintainer",
        "conflict",
        "review-blocked",
        "scope-violation",
        "verify-failing",
        "worker-failed",
      ].toSorted(),
    );
    expect(parkResumeNeed("ambiguous-spec")).toEqual({ kind: "resume", note: "answer" });
    expect(parkResumeNeed("review-blocked")).toEqual({ kind: "resume", note: "required" });
    expect(parkResumeNeed("budget-exceeded")).toEqual({
      kind: "resume",
      note: "required",
      budget: true,
    });
    for (const reason of ["verify-failing", "conflict", "by-maintainer", "worker-failed"]) {
      expect(parkResumeNeed(reason)).toEqual({ kind: "resume", note: "optional" });
    }
    expect(parkResumeNeed("scope-violation")).toEqual({
      kind: "refuse",
      code: "resume.notResumable",
    });
    // A reason outside the eight (a park record written by hand) resumes as worker-failed.
    expect(parkResumeNeed("something-else")).toEqual(parkResumeNeed("worker-failed"));
  });

  it("offers work.resume in story.parked.actions for every reason but scope-violation", () => {
    for (const reason of Object.keys(RESUME_TABLE)) {
      const actions = parkActions(reason, all);
      if (reason === "scope-violation") expect(actions).not.toContain("work.resume");
      else expect(actions).toContain("work.resume");
      // Only a park on a question waits for its answer.
      if (reason === "ambiguous-spec") expect(actions).toContain("work.answer");
      else expect(actions).not.toContain("work.answer");
    }
  });
});

describe("work.resume of a reason that needs nothing more (0020)", () => {
  const rows: {
    reason: string;
    note?: string;
    first: readonly string[];
  }[] = [
    {
      reason: "by-maintainer",
      first: [
        "dipo parked this story as by-maintainer, and the maintainer resumed it.\nthe worker host was lost",
      ],
    },
    {
      reason: "worker-failed",
      note: "The flaky disk is replaced.",
      first: [
        "dipo parked this story as worker-failed, and the maintainer resumed it.\nthe worker host was lost",
        "Note from the maintainer: The flaky disk is replaced.",
      ],
    },
    {
      reason: "verify-failing",
      first: [
        "dipo parked this story as verify-failing, and the maintainer resumed it.\nthe worker host was lost",
      ],
    },
  ];

  for (const row of rows) {
    it(`resumes ${row.reason} to In Progress with its first message`, async () => {
      const parkId = park(row.reason, "In Progress", "the worker host was lost");
      const reply = await resume(resumption(), row.note === undefined ? {} : { note: row.note });
      expect(reply.result).toEqual({
        story: "DIPO-1",
        key: w.key,
        to: "In Progress",
        run: w.f.run,
      });
      expect(w.lifts).toEqual([
        {
          story: "DIPO-1",
          branch: "DIPO-1/add-a-greeting",
          to: "In Progress",
          // The resume's line in the implementation notes (0020, DIPO-154).
          line: `Resumed 2026-01-01 00:00 UTC; grants: none; note: ${row.note ?? "none"}`,
        },
      ]);
      expect(w.sessions).toHaveLength(1);
      const session = w.sessions[0] as HeldSession;
      // The note follows the reason's part (0020).
      for (const part of row.first) expect(first(session)).toContain(part);
      if (row.note !== undefined) {
        expect(first(session).indexOf(noteText(row.note))).toBeGreaterThan(
          first(session).indexOf(row.first[0] ?? ""),
        );
      }
      // Maintainer text never starts a message (0020).
      expect(first(session)?.startsWith(row.note ?? "\0")).toBe(false);
      // The note is a fact on the resolved park; the run is active again.
      expect(parkRow(parkId)).toEqual({ resolved_how: "resume", resolved_note: row.note ?? null });
      expect(findRun(w.f.office, w.f.run)?.endedAt).toBeNull();
      expect(storyStates().at(-1)).toEqual({ from: "Parked", to: "In Progress" });
      expect(grants()).toEqual([]);
      const intent = runIntents(w.f.office, w.f.run).find((candidate) =>
        candidate.detail.startsWith(`${MAINTAINER_RESUME_TAG} `),
      );
      expect(intent?.outcome).toBe("resumed");
    });
  }

  it("returns a story the maintainer parked while it waited In Review there, with no session", async () => {
    park("by-maintainer", "In Review", "PR #7 closed on GitHub", "in-review");
    const reply = await resume(resumption());
    expect(reply.result.to).toBe("In Review");
    expect(w.lifts[0]?.to).toBe("In Review");
    expect(w.sessions).toEqual([]);
    expect(w.reviews).toEqual([]);
    // A closed PR is replaced (0002), then the auto-merge takes the story in again.
    expect(w.ported).toEqual(["pr", "merge"]);
    expect(findRun(w.f.office, w.f.run)?.endKind).toBe("in-review");
    expect(grants()).toEqual([]);
  });

  it("hands a story the maintainer parked before its review back to the reviewer place", async () => {
    park("by-maintainer", "In Review", "after the release", "in-review");
    const drained: string[] = [];
    const places = new Places({
      clock: w.f.t.clock,
      offices: { get: () => w.f.office },
      // The run is pending again once its park is resolved (`pendingReviews`).
      pending: (office) =>
        openPark(office, w.key) === null
          ? [{ kind: START_KINDS.review, runId: w.f.run, since: w.f.t.clock.now() }]
          : [],
      starters: {
        review: async (_office, run) => {
          drained.push(run.runId);
          return false;
        },
      },
    });
    await resume(resumption({ places: () => places }));
    await places.idle();
    expect(drained).toEqual([w.f.run]);
    expect(w.sessions).toEqual([]);
    places.close();
  });

  it("returns a reviewed run that waits In Review again to the reviewed end", async () => {
    const { office, run, t } = w.f;
    office.immediate(() =>
      recordReviewVerdict(office, t.ids, {
        runId: run,
        key: w.key,
        round: 1,
        agent: null,
        model: "opus",
        commit: "c".repeat(40),
        codeTreeKey: "tree",
        judged: { verdict: "approved", criteria: [], findings: [], summary: "Fine.", notes: [] },
        at: t.clock.now(),
      }),
    );
    park("by-maintainer", "In Review", "after the release", "reviewed");
    await resume(resumption(), { note: "Released." });
    expect(findRun(office, run)?.endKind).toBe("reviewed");
    expect(w.ported).toEqual(["pr", "merge"]);
  });

  for (const reason of ["by-maintainer", "worker-failed"] as const) {
    it(`starts a fresh reviewer session of the same round for ${reason} when the park stopped the reviewer, never sending the note`, async () => {
      reviewerAgent();
      const parkId = park(reason, "In Review");
      const reply = await resume(resumption(), { note: "for the record" });
      expect(reply.result.to).toBe("In Review");
      expect(w.reviews).toEqual([w.f.run]);
      expect(w.sessions).toEqual([]);
      expect(grants()).toEqual([]);
      expect(parkRow(parkId)?.resolved_note).toBe("for the record");
      expect(findRun(w.f.office, w.f.run)?.waiting).toBe("review-resume");
    });
  }
});

describe("work.resume refusals", () => {
  it("answers resume.notResumable for scope-violation, naming dipo discard, and changes nothing", async () => {
    const parkId = park("scope-violation");
    const error = await refusal(resumption(), { note: "please" });
    expect(error.error.code).toBe("resume.notResumable");
    expect(error.message).toContain("dipo discard DIPO-1");
    expect(w.lifts).toEqual([]);
    expect(parkRow(parkId)?.resolved_how).toBeNull();
    expect(runIntents(w.f.office, w.f.run)).toEqual([]);
  });

  it("refuses a scope-violation park with no run (one reconcile recorded) before the planning lane", async () => {
    const parkId = park("scope-violation");
    w.f.office.immediate(() =>
      w.f.office.run(
        "update parks set run_id = null where office_id = $office_id and park_id = $park",
        { park: parkId },
      ),
    );
    const lifted: number[] = [];
    const resuming = resumption({
      holds: () => ({
        resumeHold: async (_ctx, _identity, held) => {
          lifted.push(held.parkId);
          return "Ready";
        },
      }),
    });
    const error = await refusal(resuming);
    expect(error.error.code).toBe("resume.notResumable");
    expect(error.message).toContain("dipo discard DIPO-1");
    expect(lifted).toEqual([]);
    expect(parkRow(parkId)?.resolved_how).toBeNull();
  });

  for (const reason of ["review-blocked", "budget-exceeded"] as const) {
    it(`answers resume.noteRequired for ${reason} without a note`, async () => {
      park(reason, reason === "review-blocked" ? "In Review" : "In Progress");
      const error = await refusal(
        resumption(),
        reason === "budget-exceeded" ? { budget: { share: 50 } } : {},
        ctx(true),
      );
      expect(error.error.code).toBe("resume.noteRequired");
      expect(error.message).toContain("--note");
      expect(w.lifts).toEqual([]);
      expect(runIntents(w.f.office, w.f.run)).toEqual([]);
    });
  }

  it("names dipo approve --note as the other way on for review-blocked", async () => {
    park("review-blocked", "In Review");
    const error = await refusal(resumption());
    expect(error.message).toContain("dipo approve DIPO-1 --note");
  });

  it("refuses a resume while the office's starts are paused, naming why and what lifts it (0020)", async () => {
    park("worker-failed");
    w.paused = {
      reason: "adapter",
      detail: "claude-cli: start-failed: claude exited at once.",
      since: 0,
      until: null,
      lifts: "Fix it, then name the story to repeat the launch checks.",
    };
    const error = await refusal(resumption());
    expect(error.error.code).toBe("run.refused");
    expect(error.error.details).toEqual({ story: "DIPO-1", check: "adapter" });
    expect(error.message).toContain("claude exited at once");
    expect(error.message).toContain("repeat the launch checks");
    w.paused = null;
    await resume(resumption());
    expect(w.sessions).toHaveLength(1);
  });

  it("answers run.hostAlive while the parked worker has not exited", async () => {
    park("by-maintainer");
    w.f.office.immediate(() =>
      w.f.office.run("update agents set ended_at = null where office_id = $office_id"),
    );
    const error = await refusal(resumption());
    expect(error.error.code).toBe("run.hostAlive");
    expect(error.error.retryable).toBe(true);
  });

  it("answers scheduling.off while the daemon schedules no work", async () => {
    park("by-maintainer");
    const error = await refusal(
      resumption({ parks: { scheduling: () => false } } as Partial<ResumptionOptions>),
    );
    expect(error.error.code).toBe("scheduling.off");
    expect(error.error.retryable).toBe(true);
  });

  it("answers resume.capReached naming --budget when the caps are used up", async () => {
    park("by-maintainer");
    usage(60, 1_000);
    const error = await refusal(resumption());
    expect(error.error.code).toBe("resume.capReached");
    expect(error.message).toContain("--budget");
  });

  it("takes a top-up on any reason whose caps are used up, as a recorded grant", async () => {
    park("verify-failing", "In Progress", "Verify failed at the verify step.");
    usage(60, 100_000);
    const reply = await resume(
      resumption(),
      { budget: { share: 50 }, note: "Last push." },
      ctx(true),
    );
    expect(reply.result.grants).toEqual([
      { kind: "budget", tokens: 150_000, turns: 30, minutes: 15 },
    ]);
    expect(first(w.sessions[0])).toContain("Verify failed at the verify step.");
  });
});

describe("top-up of a budget-exceeded park (0020)", () => {
  it("answers resume.topUpRequired naming --budget and the cap that fired", async () => {
    park("budget-exceeded", "In Progress", "turn cap reached: 61 of 60 turns");
    usage(61, 100_000);
    const error = await refusal(resumption(), { note: "more" });
    expect(error.error.code).toBe("resume.topUpRequired");
    expect(error.message).toContain("--budget +50%");
    expect(error.message).toContain("turn cap");
    expect(error.error.details).toMatchObject({ cap: "maxTurns" });
  });

  it("needs a note with the top-up, and a confirmation showing the caps before and after", async () => {
    park("budget-exceeded");
    usage(61, 100_000);
    const noNote = await refusal(resumption(), { budget: { share: 50 } }, ctx(true));
    expect(noNote.error.code).toBe("resume.noteRequired");
    const unconfirmed = await refusal(resumption(), { budget: { share: 50 }, note: "go" });
    expect(unconfirmed.error.code).toBe("confirmation.required");
    expect(unconfirmed.error.details).toEqual({
      before: { budgetTokens: 300_000, maxTurns: 60, maxMinutes: 30 },
      after: { budgetTokens: 450_000, maxTurns: 90, maxMinutes: 45 },
    });
    expect(grants()).toEqual([]);
    expect(w.lifts).toEqual([]);
  });

  it("adds 150,000 tokens and half the turns and minutes on a tier S run as one grant", async () => {
    park("budget-exceeded");
    usage(61, 100_000);
    const before = runCaps(w.f.office, findRun(w.f.office, w.f.run) as never);
    const reply = await resume(
      resumption(),
      { budget: { share: 50 }, note: "DIPO-105" },
      ctx(true),
    );
    expect(reply.result.grants).toEqual([
      { kind: "budget", tokens: 150_000, turns: 30, minutes: 15 },
    ]);
    expect(grants()).toEqual([
      {
        kind: "budget",
        // The caps before and after it are part of the grant (0020).
        amount: JSON.stringify({
          tokens: 150_000,
          turns: 30,
          minutes: 15,
          before: { budgetTokens: 300_000, maxTurns: 60, maxMinutes: 30 },
          after: { budgetTokens: 450_000, maxTurns: 90, maxMinutes: 45 },
        }),
        note: "DIPO-105",
        origin: "cli",
        // The client name its connection gave in engine.hello.
        client: "dipo-cli",
      },
    ]);
    const after = runCaps(w.f.office, findRun(w.f.office, w.f.run) as never);
    expect(after.budgetTokens - before.budgetTokens).toBe(150_000);
    expect(after.maxTurns - before.maxTurns).toBe(30);
    expect(after.maxMinutes - before.maxMinutes).toBe(15);
    const message = first(w.sessions[0]) ?? "";
    expect(message).toContain(
      "The maintainer raised this story's budget by 150,000 tokens, 30 turns and 15 minutes",
    );
    expect(message.indexOf("raised this story's budget")).toBeLessThan(
      message.indexOf("Note from the maintainer: DIPO-105"),
    );
  });

  it("takes a fixed token amount as tokens, growing turns and minutes by its share", () => {
    expect(share(TIER_S, { tokens: 150_000 })).toEqual({ tokens: 150_000, turns: 30, minutes: 15 });
    expect(share(TIER_S, { share: 50 })).toEqual({ tokens: 150_000, turns: 30, minutes: 15 });
    expect(share(TIER_S, { share: 10 })).toEqual({ tokens: 30_000, turns: 6, minutes: 3 });
  });

  it("answers resume.topUpTooSmall with the smallest share that clears the cap", async () => {
    park("budget-exceeded");
    usage(80, 100_000);
    const error = await refusal(resumption(), { budget: { share: 10 }, note: "go" }, ctx(true));
    expect(error.error.code).toBe("resume.topUpTooSmall");
    // 80 turns used of 60: +34% of the starting 60 adds 21 turns, the fewest that leave the cap above
    // the 80 used; +33% adds 20, which leaves it reached.
    expect(error.error.details).toMatchObject({ cap: "maxTurns", smallestShare: 34 });
    expect(error.message).toContain("--budget +34%");
    expect(smallestShare(TIER_S, TIER_S, { budgetTokens: 0, turns: 80, elapsedMs: 0 })).toBe(34);
  });

  it("sends the undelivered feedback of a fix round the caps stopped before its session first", async () => {
    // A fix round was queued with its items, then the pre-start cap check parked it (DIPO-205).
    const { office, run, t } = w.f;
    office.immediate(() => {
      const { intentId } = sendFeedback(
        office,
        run,
        { source: "ci", key: "e".repeat(40), text: "Required check ci-ok failed." },
        { at: t.clock.now() },
      );
      storeFeedbackItems(office, run, {
        intentId,
        head: "e".repeat(40),
        round: 1,
        items: [
          { source: "ci", signature: "s1", text: "Required check ci-ok failed.", repeat: false },
        ],
        at: t.clock.now(),
      });
    });
    park("budget-exceeded", "In Review", "turn cap reached: 60 of 60 turns");
    usage(60, 100_000);
    const reply = await resume(
      resumption(),
      { budget: { share: 50 }, note: "finish it" },
      ctx(true),
    );
    expect(reply.result.to).toBe("In Progress");
    const message = first(w.sessions[0]) ?? "";
    expect(message.indexOf("Required check ci-ok failed.")).toBeGreaterThanOrEqual(0);
    expect(message.indexOf("Required check ci-ok failed.")).toBeLessThan(
      message.indexOf("raised this story's budget"),
    );
    const delivered = office.get<{ sent_at: number | null }>(
      "select sent_at from feedback_items where office_id = $office_id and run_id = $run",
      { run },
    );
    expect(delivered?.sent_at).not.toBeNull();
    const fix = runIntents(office, run).find((intent) => intent.detail.startsWith("feedback ci "));
    expect(fix?.outcome).toBe("resumed");
  });

  it("starts a fresh review, not a developer session, when the budget ran out in a review", async () => {
    reviewerAgent();
    park("budget-exceeded", "In Review");
    usage(10, 300_000);
    const reply = await resume(
      resumption(),
      { budget: { share: 50 }, note: "review it" },
      ctx(true),
    );
    expect(reply.result.to).toBe("In Review");
    expect(w.sessions).toEqual([]);
    expect(w.reviews).toEqual([w.f.run]);
    // No failed round is counted by the resume.
    const failed = w.f.office.get<{ n: number }>(
      "select count(*) as n from run_steps where office_id = $office_id and kind = 'review-failed'",
    );
    expect(failed?.n).toBe(0);
  });
});

describe("round grants: one more round of the cap that fired (0020)", () => {
  it("records one loops round grant with its note and the cap before and after, and sends the last verify item first for verify-failing at its loop cap", async () => {
    steps("loop", 3);
    park(
      "verify-failing",
      "In Progress",
      "verify failed 3 of 3 times. Verify failed at the verify step.",
    );
    await resume(resumption(), { note: "Use bun test --bail." });
    expect(grants().map((grant) => [grant.kind, JSON.parse(grant.amount), grant.note])).toEqual([
      ["round", { cap: "loops", count: 1, before: 3, after: 4 }, "Use bun test --bail."],
    ]);
    const message = first(w.sessions[0]) ?? "";
    expect(message.indexOf("Verify failed at the verify step.")).toBeLessThan(
      message.indexOf("Note from the maintainer: Use bun test --bail."),
    );
  });

  it("records one ciAttempts round grant and sends the last stored CI item first for verify-failing at its CI cap", async () => {
    const { office, run, t } = w.f;
    office.immediate(() =>
      storeFeedbackItems(office, run, {
        intentId: recordIntent(office, run, "steer", "an earlier round", t.clock.now()),
        head: "e".repeat(40),
        round: 1,
        items: [
          {
            source: "ci",
            signature: "s1",
            text: "Required check ci-ok failed: lint.",
            repeat: false,
          },
        ],
        at: t.clock.now(),
      }),
    );
    steps("ci", 2);
    park("verify-failing", "In Review", "required checks were red on 2 pushed heads");
    await resume(resumption(), { note: "Run the linter." });
    expect(grants().map((grant) => [grant.kind, JSON.parse(grant.amount)])).toEqual([
      ["round", { cap: "ciAttempts", count: 1, before: 2, after: 3 }],
    ]);
    const message = first(w.sessions[0]) ?? "";
    expect(message).toContain("Required check ci-ok failed: lint.");
    expect(message.indexOf("lint.")).toBeLessThan(message.indexOf("Note from the maintainer"));
  });

  it("grants nothing for verify-failing below every round cap", async () => {
    steps("loop", 1);
    park("verify-failing");
    await resume(resumption());
    expect(grants()).toEqual([]);
  });

  it("returns review-blocked to In Review and queues its fix round with one reviewRounds round grant", async () => {
    const parkId = park("review-blocked", "In Review", "blocking: no test", "reviewed");
    const reply = await resume(resumption(), { note: "Add the test, then it passes." });
    expect(reply.result.to).toBe("In Review");
    expect(w.lifts[0]?.to).toBe("In Review");
    expect(w.sessions).toEqual([]);
    expect(w.considered).toEqual([w.f.run]);
    expect(grants().map((grant) => [grant.kind, JSON.parse(grant.amount)])).toEqual([
      ["round", { cap: "reviewRounds", count: 1, before: 3, after: 4 }],
    ]);
    expect(findRun(w.f.office, w.f.run)?.endKind).toBe("reviewed");
    expect(parkRow(parkId)?.resolved_note).toBe("Add the test, then it passes.");
    // The note waits for the fix round's first message, after its findings.
    const held = runIntents(w.f.office, w.f.run).find((intent) =>
      intent.detail.startsWith("feedback resume - next "),
    );
    expect(held?.detail).toBe(
      "feedback resume - next Note from the maintainer: Add the test, then it passes.",
    );
  });

  it("continues a conflict through the conflict hand-off, the conflict item first", async () => {
    park("conflict");
    await resume(resumption(), { note: "Keep both sides." });
    expect(w.ported).toEqual(["conflict"]);
    const message = first(w.sessions[0]) ?? "";
    expect(message.indexOf("Conflict item")).toBeLessThan(
      message.indexOf("Note from the maintainer"),
    );
  });

  it("records one conflictAttempts round grant when the failed hand-offs reached the conflict cap", async () => {
    const { office, run, t } = w.f;
    office.immediate(() => {
      for (const value of ["start 1 a", "failed 1 markers", "start 2 b", "failed 2 markers"]) {
        appendRunStep(office, run, "conflict", value, t.clock.now());
      }
    });
    park("conflict");
    await resume(resumption());
    expect(grants().map((grant) => [grant.kind, JSON.parse(grant.amount)])).toEqual([
      ["round", { cap: "conflictAttempts", count: 1, before: 2, after: 3 }],
    ]);
  });

  it("answers resume.notResumable for a conflict park while no conflict hand-off exists", async () => {
    park("conflict");
    const error = await refusal(
      resumption({ parks: { conflicts: () => undefined } } as Partial<ResumptionOptions>),
      { note: "merge it" },
    );
    expect(error.error.code).toBe("resume.notResumable");
    expect(error.message).toContain("dipo discard DIPO-1");
  });

  it("starts the box merge a conflict resume prepared only once the session started", async () => {
    park("conflict");
    const order: string[] = [];
    await resume(
      resumption({
        parks: {
          conflicts: () => ({
            prepare: async () => {
              order.push("prepare");
              return {
                message: "The remote branch holds 1 commit your branch lacks.",
                afterStart: async () => {
                  order.push(`merge after ${w.sessions.length} session`);
                },
              };
            },
          }),
        },
      } as Partial<ResumptionOptions>),
      { note: "Merge theirs." },
    );
    expect(order).toEqual(["prepare", "merge after 1 session"]);
    expect(first(w.sessions[0])).toContain("The remote branch holds 1 commit");
  });

  it("starts no session when the conflict resume parked the story again", async () => {
    park("conflict");
    await resume(
      resumption({
        parks: { conflicts: () => ({ prepare: async () => ({ parked: true }) }) },
      } as Partial<ResumptionOptions>),
      { note: "Fixed on main." },
    );
    expect(w.sessions).toEqual([]);
    expect(
      runIntents(w.f.office, w.f.run).find((intent) =>
        intent.detail.startsWith("maintainer-resume"),
      )?.outcome,
    ).toBe("parked");
  });

  it("grants nothing when a reviewer stopped at its own cap resumes: the fresh session has its caps in full", async () => {
    const { office, run } = w.f;
    const reviewer = reviewerAgent();
    usage(40, 10_000, reviewer);
    park("worker-failed", "In Review", "the reviewer's turn cap reached: 40 of 40 turns");
    const before = runCaps(office, findRun(office, run) as never);
    await resume(resumption());
    const after = runCaps(office, findRun(office, run) as never);
    expect(grants()).toEqual([]);
    expect(after).toEqual(before);
    expect(w.reviews).toEqual([run]);
  });
});

describe("no resume raises a cap without a recorded grant (0020, never silent)", () => {
  const resumable = Object.entries(RESUME_TABLE).filter(([, row]) => row.need.kind === "resume");
  for (const [reason, row] of resumable) {
    it(`${reason}: every cap change is a run_grants row`, async () => {
      if (row.need.kind !== "resume") return;
      const budget = row.need.budget === true;
      park(reason, reason === "review-blocked" ? "In Review" : "In Progress");
      if (budget) usage(60, 100_000);
      const office = w.f.office;
      const before = runCaps(office, findRun(office, w.f.run) as never);
      const grantsBefore = grantTotals(office, w.f.run);
      await resume(
        resumption(),
        { note: "go", ...(budget ? { budget: { share: 50 } } : {}) },
        ctx(true),
      );
      const after = runCaps(office, findRun(office, w.f.run) as never);
      const added = grantTotals(office, w.f.run);
      expect(after.budgetTokens - before.budgetTokens).toBe(
        added.budget.tokens - grantsBefore.budget.tokens,
      );
      expect(after.maxTurns - before.maxTurns).toBe(added.budget.turns - grantsBefore.budget.turns);
      expect(after.maxMinutes - before.maxMinutes).toBe(
        added.budget.minutes - grantsBefore.budget.minutes,
      );
      expect(after.loopCap - before.loopCap).toBe(added.rounds.loops);
      expect((after.reviewRoundCap ?? 0) - (before.reviewRoundCap ?? 0)).toBe(
        added.rounds.reviewRounds,
      );
      expect((after.ciCap ?? 0) - (before.ciCap ?? 0)).toBe(added.rounds.ciAttempts);
      expect((after.conflictCap ?? 0) - (before.conflictCap ?? 0)).toBe(
        added.rounds.conflictAttempts,
      );
      // Only a top-up and the review round of review-blocked grow a cap here.
      expect(grants()).toHaveLength(budget || reason === "review-blocked" ? 1 : 0);
    });
  }
});
describe("a resume whose place is taken (0020 section 1, 0019 section 12)", () => {
  it("is accepted with its intent stored, replies queued, and starts when the worker place frees", async () => {
    const { office, t } = w.f;
    // Another story run holds the office's worker place with a live session.
    const other = t.ids.next("run") as RunId;
    const otherAgent = t.ids.next("agt");
    const { key: otherKey } = office.immediate(() =>
      addStory(office, t.ids, { story: StoryId.parse("DIPO-2") }, t.clock.now()),
    );
    office.immediate(() => {
      insertRun(office, {
        runId: other,
        kind: "story",
        key: otherKey,
        story: "DIPO-2",
        tier: "S",
        role: "developer",
        model: "haiku",
        startSha: "b".repeat(40),
        branch: "DIPO-2/x",
        budgetUnit: "tokens",
        budgetLimit: 1,
        loopCap: 3,
        reviewRoundCap: null,
        configHash: "h",
        overrideKeys: null,
        runProfileId: null,
        startedAt: t.clock.now(),
      });
      insertClaim(office, {
        runId: other,
        key: otherKey,
        story: "DIPO-2",
        branch: "DIPO-2/x",
        base: "main",
        baseSha: "b".repeat(40),
        startSha: "b".repeat(40),
        claimSha: "d".repeat(40),
        reused: false,
        claimedAt: t.clock.now(),
      });
      office.run(
        `insert into agents (office_id, agent_id, run_id, role, model, session_id, started_at)
         values ($office_id, $other_agent, $run, 'developer', 'haiku', 'session-2', $at)`,
        { run: other, at: t.clock.now(), other_agent: otherAgent },
      );
    });
    let places: Places | undefined;
    const resuming = resumption({ places: () => places });
    places = new Places({
      clock: t.clock,
      offices: { get: () => office },
      starters: { resume: (officeId, run) => resuming.startQueued(officeId, run) },
    });
    park("by-maintainer");
    const reply = await resume(resuming, { note: "When the other one is done." });
    expect(reply.result).toMatchObject({ to: "In Progress", queued: true });
    await places.idle();
    expect(w.sessions).toEqual([]);
    expect(findRun(office, w.f.run)?.waiting).toBe("resume");

    // The other story's session ends; the drain starts the resumed session with its message.
    office.immediate(() => {
      office.run(
        "update agents set ended_at = $at where office_id = $office_id and agent_id = $other_agent",
        {
          at: t.clock.now(),
          other_agent: otherAgent,
        },
      );
      endRun(office, other, t.clock.now(), "in-review");
    });
    await places.drain(office.officeId as OfficeId);
    await resuming.idle();
    expect(w.sessions).toHaveLength(1);
    expect(first(w.sessions[0])).toContain("Note from the maintainer: When the other one is done.");
    places.close();
  });
});

describe("a retry of the same request (0005 note of 2026-10-17)", () => {
  it("finishes and replies without a second lift, grant or session", async () => {
    steps("loop", 3);
    park("verify-failing");
    const context = ctx(false, "req_same");
    const resuming = resumption();
    const once = await resume(resuming, { note: "again" }, context);
    const second = await resume(resuming, { note: "again" }, ctx(false, "req_same"));
    expect(second.result).toEqual(once.result);
    expect(w.lifts).toHaveLength(1);
    expect(w.sessions).toHaveLength(1);
    expect(grants()).toHaveLength(1);
  });

  it("answers a lift that failed with its intent resolved failed, so a retry runs again", async () => {
    park("by-maintainer");
    let fail = true;
    const resuming = createRunOutcomesWithLift(async (request) => {
      if (fail) {
        fail = false;
        throw new Error("the remote refused the push");
      }
      w.lifts.push(request);
      return { commit: null, pushed: true, pushError: null };
    });
    await expect(resume(resuming, {}, ctx(false, "req_fail"))).rejects.toThrow("refused the push");
    const reply = await resume(resuming, {}, ctx(false, "req_fail"));
    expect(reply.result.to).toBe("In Progress");
    expect(w.lifts).toHaveLength(1);
    expect(w.sessions).toHaveLength(1);
    const resumes = runIntents(w.f.office, w.f.run).filter((intent) =>
      intent.detail.startsWith(`${MAINTAINER_RESUME_TAG} `),
    );
    expect(resumes.map((intent) => intent.outcome)).toEqual(["failed", "resumed"]);
  });

  it("finishes a resume a restart interrupted after its intent, once", async () => {
    steps("loop", 3);
    park("verify-failing");
    // The first daemon stores the intent and stops while the lift runs: it never comes back.
    const stopped = createRunOutcomesWithLift(() => new Promise(() => {}));
    void stopped.resumeCommand(ctx(false, "req_restart"), {
      story: StoryId.parse("DIPO-1"),
      note: "once",
    });
    await Bun.sleep(0);
    const pending = runIntents(w.f.office, w.f.run).filter((intent) =>
      intent.detail.startsWith(`${MAINTAINER_RESUME_TAG} `),
    );
    expect(pending.map((intent) => intent.state)).toEqual(["pending"]);
    // The next daemon finishes it from the intent: one lift, one grant, one session.
    const restarted = resumption();
    expect(await restarted.recoverParkResumes(w.f.office.officeId as OfficeId, w.f.office)).toBe(1);
    await restarted.idle();
    expect(w.lifts).toHaveLength(1);
    expect(w.sessions).toHaveLength(1);
    expect(grants().map((grant) => grant.kind)).toEqual(["round"]);
    expect(await restarted.recoverParkResumes(w.f.office.officeId as OfficeId, w.f.office)).toBe(0);
    expect(w.sessions).toHaveLength(1);
  });

  it("reopens the run when an index pass reads the lift before the resume's transaction (DIPO-360)", async () => {
    const parkId = park("by-maintainer");
    const resuming = createRunOutcomesWithLift(async (request) => {
      w.lifts.push(request);
      indexAfterLift();
      return { commit: "c".repeat(40), pushed: true, pushError: null };
    });
    const reply = await resume(resuming, { note: "go on" }, ctx(false, "req_index"));
    expect(reply.result.to).toBe("In Progress");
    expect(findRun(w.f.office, w.f.run)?.endedAt).toBeNull();
    expect(w.sessions).toHaveLength(1);
    expect(
      w.f.office.get<{ how: string | null }>(
        "select resolved_how as how from parks where office_id = $office_id and park_id = $park",
        { park: parkId },
      )?.how,
    ).toBe("resume");
  });

  it("finishes after a restart a resume whose lift reached the branch and the index (DIPO-360)", async () => {
    const parkId = park("by-maintainer");
    // The first daemon lifts the park on the branch, an index pass reads it, and it stops.
    const stopped = createRunOutcomesWithLift((request) => {
      w.lifts.push(request);
      indexAfterLift();
      return new Promise(() => {});
    });
    void stopped.resumeCommand(ctx(false, "req_lifted"), {
      story: StoryId.parse("DIPO-1"),
      note: "once",
    });
    await Bun.sleep(0);
    expect(openPark(w.f.office, w.key)).toBeNull();
    // Reconcile leaves the row to the resume that is lifting it.
    expect(parksBeingResumed(w.f.office).has(parkId)).toBe(true);
    const restarted = createRunOutcomesWithLift(async (request) => {
      w.lifts.push(request);
      return { commit: null, pushed: true, pushError: null };
    });
    expect(await restarted.recoverParkResumes(w.f.office.officeId as OfficeId, w.f.office)).toBe(1);
    await restarted.idle();
    expect(findRun(w.f.office, w.f.run)?.endedAt).toBeNull();
    expect(w.sessions).toHaveLength(1);
    expect(parksBeingResumed(w.f.office).size).toBe(0);
  });

  it("keeps a resume pending with a notice when its restart throws after the lift reached the branch, so a rescan cannot close the park (DIPO-362)", async () => {
    const parkId = park("by-maintainer");
    const stopped = createRunOutcomesWithLift(() => new Promise(() => {}));
    void stopped.resumeCommand(ctx(false, "req_err"), {
      story: StoryId.parse("DIPO-1"),
      note: "once",
    });
    await Bun.sleep(0);
    expect(parksBeingResumed(w.f.office).has(parkId)).toBe(true);
    // The next daemon's lift reaches the branch and answers nothing it can use: the finishing step
    // throws after the lift, not in it.
    const restarted = createRunOutcomesWithLift(async (request) => {
      w.lifts.push(request);
      indexAfterLift();
      return undefined as never;
    });
    expect(await restarted.recoverParkResumes(w.f.office.officeId as OfficeId, w.f.office)).toBe(0);
    const resumes = () =>
      runIntents(w.f.office, w.f.run).filter((intent) =>
        intent.detail.startsWith(`${MAINTAINER_RESUME_TAG} `),
      );
    // Pending, not failed: the park row stays held, so reconcile leaves it open.
    expect(resumes().map((intent) => [intent.state, intent.outcome])).toEqual([["pending", null]]);
    expect(parksBeingResumed(w.f.office).has(parkId)).toBe(true);
    expect(openPark(w.f.office, w.key)).toBeNull();
    expect(w.sessions).toEqual([]);
    const notice = entries("engine.notice").find(
      (data) => data["code"] === PARK_RESUME_NOTICES.unfinished,
    );
    expect(notice?.["text"]).toContain(
      "the park was lifted on its branch, but finishing the resume failed",
    );
    // The next recovery finishes it: the run reopens and its session starts, once.
    const again = createRunOutcomesWithLift(async (request) => {
      w.lifts.push(request);
      return { commit: null, pushed: true, pushError: null };
    });
    expect(await again.recoverParkResumes(w.f.office.officeId as OfficeId, w.f.office)).toBe(1);
    await again.idle();
    expect(findRun(w.f.office, w.f.run)?.endedAt).toBeNull();
    expect(w.sessions).toHaveLength(1);
    expect(resumes().map((intent) => intent.outcome)).toEqual(["resumed"]);
    expect(parksBeingResumed(w.f.office).size).toBe(0);
  });

  it("keeps a resume pending with the same notice when work.resume throws after the lift reached the branch (DIPO-362)", async () => {
    const parkId = park("by-maintainer");
    const resuming = createRunOutcomesWithLift(async (request) => {
      w.lifts.push(request);
      indexAfterLift();
      return undefined as never;
    });
    await expect(resume(resuming, { note: "go" }, ctx(false, "req_live"))).rejects.toThrow();
    const resumes = runIntents(w.f.office, w.f.run).filter((intent) =>
      intent.detail.startsWith(`${MAINTAINER_RESUME_TAG} `),
    );
    expect(resumes.map((intent) => [intent.state, intent.outcome])).toEqual([["pending", null]]);
    expect(parksBeingResumed(w.f.office).has(parkId)).toBe(true);
    expect(w.sessions).toEqual([]);
    const notice = entries("engine.notice").find(
      (data) => data["code"] === PARK_RESUME_NOTICES.unfinished,
    );
    expect(notice?.["text"]).toContain("tries it again when the daemon restarts");
    expect(notice?.["text"]).toContain("dipo drop DIPO-1");
    expect(notice?.["text"]).toContain("dipo discard DIPO-1 --note <why>");
  });

  it("fails a resume whose restart's lift fails, so it no longer holds the park (DIPO-360)", async () => {
    const parkId = park("by-maintainer");
    const stopped = createRunOutcomesWithLift(() => new Promise(() => {}));
    void stopped.resumeCommand(ctx(false, "req_err"), {
      story: StoryId.parse("DIPO-1"),
      note: "once",
    });
    await Bun.sleep(0);
    expect(parksBeingResumed(w.f.office).has(parkId)).toBe(true);
    const restarted = createRunOutcomesWithLift(async () => {
      throw new Error("the remote refused the push");
    });
    expect(await restarted.recoverParkResumes(w.f.office.officeId as OfficeId, w.f.office)).toBe(0);
    const resumes = runIntents(w.f.office, w.f.run).filter((intent) =>
      intent.detail.startsWith(`${MAINTAINER_RESUME_TAG} `),
    );
    expect(resumes.map((intent) => intent.outcome)).toEqual(["failed"]);
    expect(parksBeingResumed(w.f.office).size).toBe(0);
    expect(w.sessions).toEqual([]);
  });
});

/** What an index pass reads after the lift is on the branch: the story In Progress, unparked. */
function indexAfterLift(): void {
  w.f.office.immediate(() => mirrorStory(w.f.office, { key: w.key, story: "DIPO-1" }));
}

/** The resumption with a lift of its own. */
function createRunOutcomesWithLift(
  lift: (request: UnparkBranchRequest) => Promise<{
    commit: string | null;
    pushed: boolean;
    pushError: string | null;
  }>,
): Resumption {
  const { f } = w;
  const ender = { isTracked: () => false } as unknown as RunEnder;
  return createRunOutcomes({
    clock: f.t.clock,
    offices: { get: () => f.office },
    steering: { send: async () => ({ ok: true }) },
    encode,
    worker: { id: "claude-cli", result: () => ({ outcome: "done", resumable: true }) as never },
    ender: () => ender,
    resumer: {
      next: async (request) => {
        w.sessions.push(withHeld(f.office, request, f.t.clock.now()));
        return { kind: "started", agent: f.t.ids.next("agt") as AgentId, resumed: true };
      },
    },
    caps: () => TIER_S,
    unpark: { lift: async (_office, request) => lift(request) },
  }).resumption;
}

/** Executor deps with `of`'s `work.resume`; one request table, as one daemon has. */
function executor(of: Resumption): ExecutorDeps {
  return {
    registry: buildRegistry([of.feature]),
    offices: stateOfficeDirectory(w.f.t.state),
    clock: w.f.t.clock,
    ids: w.f.t.ids,
    softwareRequests: new MemoryRequestTable(w.f.t.clock),
  };
}

function resumeRequest(id: string, args: Record<string, unknown>): CommandRequest {
  return {
    requestId: RequestId.parse(id),
    name: "work.resume",
    args: { story: "DIPO-1", ...args },
    origin: "cli",
    confirmed: false,
    office: w.f.office.officeId as OfficeId,
  };
}

describe("work.resume on the waiting command path (0005 note of 2026-10-17, DIPO-168)", () => {
  it("repeats no lift, grant or session when a crash before the requests row makes the retry run the handler again", async () => {
    steps("loop", 3);
    park("verify-failing");
    const resuming = resumption();
    const deps = executor(resuming);
    const id = "01J9ZK5Q8W3V4X6Y7Z90000004";
    const crashed = await executeCommand(
      crashAfterHandler(deps, "work.resume"),
      resumeRequest(id, { note: "One more try." }),
    );
    await resuming.idle();
    expect(crashed.ok ? null : crashed.error.message).toContain(CRASH);
    expect([w.lifts.length, w.sessions.length, grants().length]).toEqual([1, 1, 1]);
    const retried = await executeCommand(deps, resumeRequest(id, { note: "One more try." }));
    await resuming.idle();
    expect(retried).toMatchObject({
      ok: true,
      result: {
        story: "DIPO-1",
        to: "In Progress",
        run: w.f.run,
        grants: [{ kind: "round", cap: "loops", count: 1 }],
      },
    });
    expect([w.lifts.length, w.sessions.length, grants().length]).toEqual([1, 1, 1]);
  });

  it("gives a duplicate that arrives while the first runs the same reply, and resumes once", async () => {
    park("by-maintainer");
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resuming = createRunOutcomesWithLift(async (lifted) => {
      await held;
      w.lifts.push(lifted);
      return { commit: null, pushed: true, pushError: null };
    });
    const deps = executor(resuming);
    const id = "01J9ZK5Q8W3V4X6Y7Z90000005";
    const original = executeCommand(deps, resumeRequest(id, {}));
    await Bun.sleep(0);
    const duplicate = executeCommand(deps, resumeRequest(id, {}));
    release?.();
    const [one, two] = await Promise.all([original, duplicate]);
    await resuming.idle();
    expect(two).toEqual(one);
    expect(one).toMatchObject({ ok: true, result: { to: "In Progress", run: w.f.run } });
    expect(w.lifts).toHaveLength(1);
    expect(w.sessions).toHaveLength(1);
  });
});

describe("two resumes of one park (DIPO-155 review)", () => {
  it("answers run.hostAlive to a second request with another id while the first one lifts", async () => {
    steps("loop", 3);
    park("verify-failing");
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resuming = createRunOutcomesWithLift(async (lifted) => {
      await held;
      w.lifts.push(lifted);
      return { commit: null, pushed: true, pushError: null };
    });
    const firstReply = resuming.resumeCommand(ctx(false, "req_one"), {
      story: StoryId.parse("DIPO-1"),
      note: "one",
    });
    await Bun.sleep(0);
    const error = await refusal(resuming, { note: "two" }, ctx(false, "req_two"));
    expect(error.error.code).toBe("run.hostAlive");
    expect(error.error.retryable).toBe(true);
    release?.();
    const done = await firstReply;
    await resuming.idle();
    expect(done.result).toMatchObject({
      to: "In Progress",
      grants: [{ kind: "round", cap: "loops", count: 1 }],
    });
    expect(w.lifts).toHaveLength(1);
    expect(w.sessions).toHaveLength(1);
    expect(grants()).toHaveLength(1);
  });

  it("writes nothing, starts nothing and answers story.notParked when the park changed during the lift", async () => {
    steps("loop", 3);
    const parkId = park("verify-failing");
    // Something else resolves the park while the lift runs (a drop, a hand edit picked up).
    const resuming = createRunOutcomesWithLift(async (lifted) => {
      w.lifts.push(lifted);
      w.f.office.immediate(() =>
        w.f.office.run(
          `update parks set resolved_at = 1, resolved_how = 'drop'
            where office_id = $office_id and park_id = $park`,
          { park: parkId },
        ),
      );
      return { commit: null, pushed: true, pushError: null };
    });
    const error = await refusal(resuming, { note: "late" }, ctx(false, "req_late"));
    await resuming.idle();
    expect(error.error.code).toBe("story.notParked");
    expect(error.message).toContain("no longer parked as it was");
    expect(w.sessions).toEqual([]);
    expect(grants()).toEqual([]);
    expect(findRun(w.f.office, w.f.run)?.endedAt).not.toBeNull();
    const resumes = runIntents(w.f.office, w.f.run).filter((intent) =>
      intent.detail.startsWith(`${MAINTAINER_RESUME_TAG} `),
    );
    expect(resumes.map((intent) => intent.outcome)).toEqual(["abandoned"]);
    // A retry of the same request checks again, and finds nothing parked to resume.
    const again = await refusal(resuming, { note: "late" }, ctx(false, "req_late"));
    expect(again.error.code).toBe("story.notParked");
    expect(w.lifts).toHaveLength(1);
  });
});

describe("the maintainer's note in a worker's message (DIPO-155 review)", () => {
  const long = `${"word ".repeat(400)}end`;

  it("caps a long note in the native resume with the handoff block's limit and marker", () => {
    const text = noteText(long);
    expect(text.startsWith("Note from the maintainer: ")).toBe(true);
    expect(text.length).toBeLessThanOrEqual("Note from the maintainer: ".length + HANDOFF_NOTE_MAX);
    expect(text).toContain("[dipo: note cut, showing");
    expect(text).toContain(`of ${long.length.toLocaleString("en-US")} characters.]`);
    expect(noteText("short")).toBe("Note from the maintainer: short");
  });

  it("caps the fix round's held note the same way", async () => {
    park("review-blocked", "In Review", "x", "reviewed");
    await resume(resumption(), { note: long });
    const held = runIntents(w.f.office, w.f.run).find((intent) =>
      intent.detail.startsWith("feedback resume - next "),
    );
    expect(held?.detail).toBe(`feedback resume - next ${noteText(long)}`);
    expect(held?.detail).toContain("[dipo: note cut, showing");
  });
});

describe("the client name of a top-up (0020 section 4, DIPO-155 review)", () => {
  it("records the client name the connection gave in engine.hello on the budget grant", async () => {
    park("budget-exceeded");
    usage(61, 100_000);
    const resuming = resumption();
    const reply = await executeCommand(
      executor(resuming),
      {
        ...resumeRequest("01J9ZK5Q8W3V4X6Y7Z90000006", {
          budget: { share: 50 },
          note: "one more go",
        }),
        confirmed: true,
      },
      { client: "dipo-tui" },
    );
    await resuming.idle();
    expect(reply).toMatchObject({ ok: true });
    expect(grants().map((grant) => [grant.kind, grant.client, grant.origin])).toEqual([
      ["budget", "dipo-tui", "cli"],
    ]);
  });
});

/** The deltas of the change-log entries of `type`, oldest first. */
function entries(type: string): Record<string, unknown>[] {
  return w.f.office
    .all<{ delta: string }>(
      "select delta from change_log where office_id = $office_id and type = $type order by seq",
      { type },
    )
    .map((row) => JSON.parse(row.delta) as Record<string, unknown>);
}

describe("an ambiguous-spec park resumed with its answer (DIPO-159; 0020)", () => {
  const QUESTION = "Which greeting should the CLI print?";

  /** A park `ambiguous-spec` whose question is stored, linked to it; its id. */
  function questionPark(): { parkId: number; question: string } {
    const parkId = park("ambiguous-spec", "In Progress", QUESTION);
    const question = w.f.t.ids.next("qst");
    w.f.office.immediate(() =>
      insertWorkerQuestion(w.f.office, {
        questionId: question,
        runId: w.f.run,
        agentId: w.f.agent,
        text: QUESTION,
        at: w.f.t.clock.now(),
        parkId,
      }),
    );
    return { parkId, question };
  }

  it("sends the question and the answer first, writes the answer as a resolved unknown in the lift, and closes the question", async () => {
    const { parkId, question } = questionPark();
    const reply = await resume(
      resumption({ parks: { contractMax: () => 9_000 } } as Partial<ResumptionOptions>),
      { note: "Print Hello, Ada!" },
    );
    expect(reply.result).toMatchObject({ to: "In Progress", run: w.f.run });
    // The lift carries the answer for the story's unknowns, with the office's R26 limit.
    expect(w.lifts).toHaveLength(1);
    expect(w.lifts[0]?.answer).toEqual({
      q: QUESTION,
      answer: "Print Hello, Ada!",
      contractMax: 9_000,
    });
    // The first message: feedback/answer.md with the question and the answer, no second note.
    const session = w.sessions[0] as HeldSession;
    expect(session.message).toContain(`Your question: ${QUESTION}`);
    expect(session.message).toContain("The maintainer's answer: Print Hello, Ada!");
    expect(session.message).not.toContain("Note from the maintainer");
    expect(first(session).startsWith("Print Hello")).toBe(false);
    // The question closed answered with the resume; the park keeps the answer as its note.
    expect(findQuestion(w.f.office, question)).toMatchObject({
      closedHow: "answered",
      answer: "Print Hello, Ada!",
      delivered: "on-resume",
    });
    expect(entries("question.closed")).toEqual([{ question, answer: "Print Hello, Ada!" }]);
    expect(parkRow(parkId)).toEqual({ resolved_how: "resume", resolved_note: "Print Hello, Ada!" });
    // The loop count stays (no grant), the run is active again.
    expect(grants()).toEqual([]);
    expect(findRun(w.f.office, w.f.run)?.endedAt).toBeNull();
  });

  it("resumes the park the same way through work.answer's question park resumer", async () => {
    const { question } = questionPark();
    const of = resumption();
    const run = findRun(w.f.office, w.f.run);
    const parked = openPark(w.f.office, w.key);
    if (run === null || parked === null) throw new Error("fixture changed");
    const resumed = await of.questionParks.resume(ctx(), run, parked, "Print Hello, Ada!");
    await of.idle();
    expect(resumed).toEqual({ run: w.f.run });
    expect(w.lifts[0]?.answer?.answer).toBe("Print Hello, Ada!");
    expect(findQuestion(w.f.office, question)?.closedHow).toBe("answered");
    expect(w.sessions).toHaveLength(1);
  });

  it("refuses a resume with no answer, naming dipo answer --text and dipo resume --note", async () => {
    const { question } = questionPark();
    const error = await refusal(resumption());
    expect(error.error.code).toBe("resume.noteRequired");
    expect(error.message).toContain(`dipo answer ${question} --text <answer>`);
    expect(error.message).toContain("dipo resume DIPO-1 --note <answer>");
    expect(w.lifts).toEqual([]);
    expect(findQuestion(w.f.office, question)?.closedAt).toBeNull();
  });

  it("delivers the answer without writing it when it would break R26, with an engine.notice", async () => {
    questionPark();
    w.answerError =
      "the story contract would be 12,040 characters with it, over the limit of 12000 (R26)";
    await resume(resumption(), { note: "Print Hello, Ada!" });
    const notices = entries("engine.notice").filter(
      (delta) => delta["code"] === "park.answerNotWritten",
    );
    expect(notices).toHaveLength(1);
    expect(String(notices[0]?.["text"])).toContain("(R26)");
    // The answer still reaches the worker.
    expect(w.sessions[0]?.message).toContain("The maintainer's answer: Print Hello, Ada!");
  });

  it("resumes with no note when the park's question was answered while its run was ending, the held answer going first", async () => {
    const { parkId, question } = questionPark();
    w.f.office.immediate(() => {
      closeQuestion(w.f.office, question, "answered", w.f.t.clock.now(), {
        text: "Print Hello, Ada!",
        decision: null,
        delivered: "on-resume",
      });
      sendFeedback(
        w.f.office,
        w.f.run,
        { source: "answer", text: workerAnswerText("Print Hello, Ada!") },
        { at: w.f.t.clock.now() },
      );
    });
    const reply = await resume(resumption());
    expect(reply.result.to).toBe("In Progress");
    expect(w.lifts[0]?.answer?.answer).toBe("Print Hello, Ada!");
    // The held answer goes with the first message once; no answer.md repeats it.
    expect(first(w.sessions[0])).toContain(workerAnswerText("Print Hello, Ada!"));
    expect(first(w.sessions[0])).not.toContain("The maintainer's answer:");
    expect(parkRow(parkId)?.resolved_how).toBe("resume");
  });

  it("expires every other open question of a park it resumes, and a budget park's carried question", async () => {
    const parkId = park("budget-exceeded", "In Progress", "turn cap reached");
    const question = w.f.t.ids.next("qst");
    w.f.office.immediate(() =>
      insertWorkerQuestion(w.f.office, {
        questionId: question,
        runId: w.f.run,
        agentId: w.f.agent,
        text: QUESTION,
        at: w.f.t.clock.now(),
        parkId,
      }),
    );
    await resume(resumption(), { budget: { share: 50 }, note: "One more go." }, ctx(true));
    expect(findQuestion(w.f.office, question)?.closedHow).toBe("expired");
    expect(entries("question.closed")).toEqual([{ question }]);
    expect(w.lifts[0]?.answer).toBeUndefined();
  });
});

describe("an ambiguous-spec park with no stored question (0020)", () => {
  it("needs the answer as its note, and sends the park's detail as the question with it", async () => {
    park("ambiguous-spec", "In Progress", "CLAUDE.md forbids the flag the story asks for");
    const refused = await refusal(resumption());
    expect(refused.error.code).toBe("resume.noteRequired");
    await resume(resumption(), { note: "Keep the flag; the story wins." });
    const session = w.sessions[0] as HeldSession;
    expect(session.message).toContain(
      "Your question: CLAUDE.md forbids the flag the story asks for",
    );
    expect(session.message).toContain("The maintainer's answer: Keep the flag; the story wins.");
    expect(session.message).not.toContain("Note from the maintainer");
  });
});

/** A plan limit's park: `worker-failed`, marked to resume by itself when the pause lifts. */
function planLimitPark(): number {
  const parkId = park("worker-failed", "In Progress", "plan limit until 2026-10-28T12:00:00.000Z");
  w.f.office.immediate(() =>
    w.f.office.run(
      "update parks set resume_on_lift = 1 where office_id = $office_id and park_id = $park",
      { park: parkId },
    ),
  );
  return parkId;
}

function liftedPark(parkId: number) {
  return { parkId, key: w.key, story: "DIPO-1" };
}

describe("the resume after the office's starts paused lifted (0020)", () => {
  it("resumes the park through the one resume path, as dipo, with no note and no grant", async () => {
    const parkId = planLimitPark();
    const of = resumption();
    expect(await of.resumeLifted(w.f.office.officeId as OfficeId, liftedPark(parkId))).toEqual({
      outcome: "resumed",
    });
    await of.idle();
    expect(parkRow(parkId)).toEqual({ resolved_how: "resume", resolved_note: null });
    expect(w.lifts).toHaveLength(1);
    expect(w.sessions).toHaveLength(1);
    expect(w.sessions[0]?.why).toBe(
      "dipo resumed it from worker-failed after the office's starts paused lifted",
    );
    // The first message is the park's detail as the last error (0020), and no maintainer note.
    expect(first(w.sessions[0])).toContain("plan limit until 2026-10-28T12:00:00.000Z");
    expect(first(w.sessions[0])).not.toContain("Note from the maintainer");
    expect(grants()).toEqual([]);
    const notice = entries("engine.notice").find(
      (data) => data["code"] === PARK_RESUME_NOTICES.resumed,
    );
    expect(notice?.["text"]).toContain("dipo resumed it after the office's starts paused lifted");
  });

  it("is tried again while the office's starts are paused, or while the worker has not exited", async () => {
    const parkId = planLimitPark();
    w.paused = {
      reason: "plan-limit",
      detail: "plan limit until later",
      since: 0,
      until: 1,
      lifts: "It lifts by itself.",
    };
    const of = resumption();
    expect(
      (await of.resumeLifted(w.f.office.officeId as OfficeId, liftedPark(parkId))).outcome,
    ).toBe("retry");
    w.paused = null;
    w.f.office.immediate(() =>
      w.f.office.run("update agents set ended_at = null where office_id = $office_id"),
    );
    expect(
      (await of.resumeLifted(w.f.office.officeId as OfficeId, liftedPark(parkId))).outcome,
    ).toBe("retry");
    expect(w.lifts).toEqual([]);
    expect(parkRow(parkId)?.resolved_how).toBeNull();
  });

  it("refuses, growing no cap, a park whose caps are used up", async () => {
    const parkId = planLimitPark();
    usage(60, 1_000);
    const outcome = await resumption().resumeLifted(
      w.f.office.officeId as OfficeId,
      liftedPark(parkId),
    );
    expect(outcome.outcome).toBe("refused");
    expect(grants()).toEqual([]);
    expect(parkRow(parkId)?.resolved_how).toBeNull();
  });

  it("leaves a park resumed or parked again meanwhile alone", async () => {
    const parkId = planLimitPark();
    expect(
      await resumption().resumeLifted(w.f.office.officeId as OfficeId, liftedPark(parkId + 1)),
    ).toEqual({ outcome: "resumed" });
    expect(w.lifts).toEqual([]);
    expect(parkRow(parkId)?.resolved_how).toBeNull();
  });
});
