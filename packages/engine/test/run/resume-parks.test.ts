// `work.resume` of a parked story by the 0020 matrix (DIPO-155): every resuming row returns to its
// lifecycle with the matrix's first message and session, the note lands on the resolved park, the
// refusals and the top-up rules answer their `resume.*` codes, every cap change is a recorded
// grant, a resume whose place is taken is queued, and a retry of the same request repeats nothing.
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
import { GitError } from "../../src/git/runner";
import { workerAnswerText } from "../../src/hooks/permissions";
import { closeQuestion, findQuestion, insertWorkerQuestion } from "../../src/hooks/questions";
import { HANDOFF_NOTE_MAX } from "../../src/prompts/handoff";
import {
  backstopSnapshotOf,
  createRunOutcomes,
  endRun,
  findRun,
  grantTotals,
  insertRun,
  MAINTAINER_RESUME_TAG,
  noteText,
  PARK_RESUME_MATRIX,
  parkActions,
  parkResumeRow,
  Places,
  type Resumption,
  type ResumptionOptions,
  type RunEnder,
  runCaps,
  runIntents,
  share,
  smallestShare,
  type UnparkBranchRequest,
} from "../../src/run";
import type { BackstopSnapshot } from "../../src/run/backstop";
import { storeFeedbackItems } from "../../src/run/feedback-items";
import { FIX_ROUND_TAG } from "../../src/run/fix-rounds";
import { recordIntent } from "../../src/run/intents";
import { openPark } from "../../src/run/park";
import { MAINTAINER_TAGS } from "../../src/run/pauses";
import type { NextSessionRequest } from "../../src/run/resume";
import { addStory } from "../../src/stories/keys";
import { encode } from "../../src/workers/claude-cli/encode";
import type { AdapterHold } from "../../src/workers/hold";
import type { Caps } from "../../src/workers/types";
import { insertClaim } from "../../src/worktree/records";
import { CRASH, crashAfterHandler } from "../commands/crash";
import { type IngestFixture, ingestFixture } from "../ingest/helpers";

/**
 * The first message a native resume of `request` sends (`RunResumer`): the caller's message, the
 * note in its template, then what waited. A handoff lists the note in its block instead.
 */
function first(request: NextSessionRequest | undefined): string {
  if (request === undefined) return "";
  return [
    request.message,
    request.note === undefined ? undefined : noteText(request.note),
    ...(request.held ?? []),
  ]
    .filter((part) => part !== undefined && part !== "")
    .join("\n\n");
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
  readonly sessions: NextSessionRequest[];
  readonly reviews: RunId[];
  readonly considered: RunId[];
  readonly ported: string[];
  hold: AdapterHold | null;
  snapshot: BackstopSnapshot | Error;
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
      worktree: join(dir, "trees", "DIPO-1"),
      slot: 1,
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
      reviewAllowance: 0,
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
  w = {
    dir,
    f,
    key,
    lifts: [],
    sessions: [],
    reviews: [],
    considered: [],
    ported: [],
    hold: null,
    snapshot: { head: "c".repeat(40), branch: "refs/heads/DIPO-1/x", stash: "", backlogStatus: "" },
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
          w.sessions.push(request);
          return { kind: "started", agent: f.t.ids.next("agt") as AgentId, resumed: true };
        },
      },
      caps: () => TIER_S,
      holds: { hold: () => w.hold as AdapterHold, adapterHeld: () => w.hold },
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
        snapshot: async () => {
          if (w.snapshot instanceof Error) throw w.snapshot;
          return w.snapshot;
        },
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
          prepare: async (_office, _run, parked) => {
            w.ported.push(`conflict:${parked.cause}`);
            return { message: "Conflict item: src/a.ts has conflict markers." };
          },
        }),
        slot: () => ({
          reenter: async () => {
            w.ported.push("slot");
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

/** Parks the story with `reason` and `cause` and ends its run; returns the park id. */
function park(reason: string, cause: string | null, from = "In Progress", detail = "x"): number {
  const { office, run, t } = w.f;
  const at = t.clock.now();
  office.immediate(() => {
    office.run(
      `insert into parks (office_id, park_id, key, story_id, run_id, reason, cause, from_state,
         detail, at)
       values ($office_id, (select coalesce(max(park_id), 0) + 1 from parks
         where office_id = $office_id), $key, 'DIPO-1', $run, $reason, $cause, $from, $detail, $at)`,
      { key: w.key, run, reason, cause, from, detail, at },
    );
    endRun(office, run, at, "parked");
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

describe("the resume matrix", () => {
  it("has a row for every 0020 reason and cause dipo parks with, the box parks refused", () => {
    expect(parkResumeRow("stopped", "maintainer")).toMatchObject({ note: "optional" });
    expect(parkResumeRow("interrupted", "build")).toMatchObject({ session: "developer" });
    expect(parkResumeRow("worker-failed", "build")).toMatchObject({ holdCheck: true });
    expect(parkResumeRow("worker-failed", "review")).toMatchObject({ session: "review" });
    expect(parkResumeRow("scope-violation", "tampered")).toEqual({
      kind: "refuse",
      code: "resume.notResumable",
    });
    expect(parkResumeRow("needs-permission", "build")).toMatchObject({ kind: "refuse" });
    // A question park resumes with its answer as the note (DIPO-159).
    expect(parkResumeRow("ambiguous-spec", "question")).toMatchObject({
      kind: "resume",
      note: "required",
      delta: "answer",
    });
    // The box parks are never resumable (the maintainer's decision).
    for (const cause of ["protected-file", "secret", "part-refused", "task-file"]) {
      expect(parkResumeRow("scope-violation", cause)).toEqual({
        kind: "refuse",
        code: "resume.notResumable",
        box: true,
      });
    }
  });

  it("offers work.resume in story.parked.actions only for a reason and cause it resumes", () => {
    expect(parkActions("stopped", all, "maintainer")).toContain("work.resume");
    expect(parkActions("budget-exceeded", all, "build")).toContain("work.resume");
    expect(parkActions("on-hold", all, null)).toContain("work.resume");
    expect(parkActions("scope-violation", all, "tampered")).not.toContain("work.resume");
    expect(parkActions("needs-permission", all, "build")).not.toContain("work.resume");
    expect(parkActions("ambiguous-spec", all, "question")).toEqual(
      expect.arrayContaining(["work.resume", "work.answer"]),
    );
    expect(parkActions("ambiguous-spec", all, "no-report")).not.toContain("work.answer");
  });
});

describe("work.resume of a park that needs no grant", () => {
  const rows: {
    reason: string;
    cause: string;
    note?: string;
    first: readonly string[];
    mode: "resume" | "handoff";
  }[] = [
    {
      reason: "stopped",
      cause: "maintainer",
      first: [
        "dipo resumed this session after its worker process ended (the maintainer stopped it).",
      ],
      mode: "resume",
    },
    {
      reason: "interrupted",
      cause: "build",
      first: ["(the worker host was lost)"],
      mode: "resume",
    },
    {
      reason: "worker-failed",
      cause: "build",
      note: "The flaky disk is replaced.",
      first: [
        "(the worker host was lost)",
        "Note from the maintainer: The flaky disk is replaced.",
      ],
      mode: "resume",
    },
    {
      reason: "verify-failing",
      cause: "refused",
      first: ["(the worker host was lost)"],
      mode: "resume",
    },
    {
      reason: "scope-violation",
      cause: "paths",
      note: "Keep to src/greet.ts.",
      first: [
        "dipo parked this story as scope-violation (paths), and the maintainer resumed it.\nthe worker host was lost",
        "Note from the maintainer: Keep to src/greet.ts.",
      ],
      mode: "resume",
    },
    {
      reason: "scope-violation",
      cause: "backstop",
      note: "I moved HEAD back by hand.",
      first: ["(backstop)", "Note from the maintainer: I moved HEAD back by hand."],
      mode: "handoff",
    },
    {
      reason: "scope-violation",
      cause: "hand-change",
      note: "That was me.",
      first: ["(hand-change)", "Note from the maintainer: That was me."],
      mode: "handoff",
    },
    {
      reason: "ambiguous-spec",
      cause: "no-report",
      note: "Report in the schema.",
      first: ["Note from the maintainer: Report in the schema."],
      mode: "handoff",
    },
  ];

  for (const row of rows) {
    it(`resumes ${row.reason} (${row.cause}) to In Progress with its first message`, async () => {
      const parkId = park(row.reason, row.cause, "In Progress", "the worker host was lost");
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
          worktree: join(w.dir, "trees", "DIPO-1"),
          to: "In Progress",
          // The resume's line in the implementation notes (0020 section 13, DIPO-154).
          line: `Resumed 2026-01-01 00:00 UTC; grants: none; note: ${row.note ?? "none"}`,
        },
      ]);
      expect(w.sessions).toHaveLength(1);
      const session = w.sessions[0] as NextSessionRequest;
      // The note goes to the session start apart from the delta (0020 section 3).
      expect(session.note).toBe(row.note);
      expect(session.mode).toBe(row.mode);
      for (const part of row.first) expect(first(session)).toContain(part);
      // Maintainer text never starts a message (0020 section 3).
      expect(first(session)?.startsWith(row.note ?? "\0")).toBe(false);
      // The note is a fact on the resolved park (migration 44); the run is active again.
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

  it("takes a new backstop snapshot for a git-state park and stores it as the baseline", async () => {
    park("scope-violation", "backstop");
    await resume(resumption(), { note: "Fine." });
    expect(backstopSnapshotOf(w.f.office, w.f.run)).toEqual(w.snapshot as BackstopSnapshot);
  });

  it("starts a fresh review, not a developer session, for a backstop park raised in review", async () => {
    park("scope-violation", "backstop", "In Review");
    const reply = await resume(resumption(), { note: "The review touched nothing." });
    expect(reply.result.to).toBe("In Review");
    expect(w.sessions).toEqual([]);
    expect(w.reviews).toEqual([w.f.run]);
    expect(findRun(w.f.office, w.f.run)?.waiting).toBe("review-resume");
  });
});

describe("work.resume refusals", () => {
  it("answers resume.notResumable naming dipo discard for tampered git links, and changes nothing", async () => {
    const parkId = park("scope-violation", "tampered");
    const error = await refusal(resumption(), { note: "please" });
    expect(error.error.code).toBe("resume.notResumable");
    expect(error.message).toContain("dipo discard DIPO-1");
    expect(w.lifts).toEqual([]);
    expect(parkRow(parkId)?.resolved_how).toBeNull();
    expect(runIntents(w.f.office, w.f.run)).toEqual([]);
  });

  for (const cause of ["protected-file", "secret", "part-refused", "task-file"]) {
    it(`refuses the box park scope-violation (${cause}) as never resumable, naming the decision and dipo discard`, async () => {
      park("scope-violation", cause);
      const error = await refusal(resumption(), { note: "please" });
      expect(error.error.code).toBe("resume.notResumable");
      expect(error.message).toContain("the maintainer's decision");
      expect(error.message).toContain("dipo discard DIPO-1");
      expect(w.lifts).toEqual([]);
    });
  }

  it("turns a backstop park whose git links changed into resume.notResumable", async () => {
    park("scope-violation", "backstop");
    w.snapshot = new GitError("git.worktreeTampered", "the worktree's git links changed");
    const error = await refusal(resumption(), { note: "please" });
    expect(error.error.code).toBe("resume.notResumable");
    expect(error.message).toContain("dipo discard DIPO-1");
    expect(w.lifts).toEqual([]);
  });

  for (const [reason, cause] of [
    ["verify-failing", "loops"],
    ["verify-failing", "ci"],
    ["verify-failing", "capped"],
    ["scope-violation", "paths"],
    ["scope-violation", "backstop"],
    ["review-blocked", "rounds"],
    ["conflict", "merge-in-progress"],
  ] as const) {
    it(`answers resume.noteRequired for ${reason} (${cause}) without a note`, async () => {
      park(reason, cause);
      const error = await refusal(resumption());
      expect(error.error.code).toBe("resume.noteRequired");
      expect(error.message).toContain("--note");
      expect(w.lifts).toEqual([]);
      expect(runIntents(w.f.office, w.f.run)).toEqual([]);
    });
  }

  it("refuses worker-failed while the adapter hold that caused it is set, naming the hold", async () => {
    park("worker-failed", "build");
    w.hold = {
      adapter: "claude-cli",
      check: "start-failed",
      detail: "claude exited at once",
      failures: [{ check: "start-failed", detail: "claude exited at once" }],
      since: 0,
    };
    const error = await refusal(resumption());
    expect(error.error.code).toBe("run.refused");
    expect(error.message).toContain("claude exited at once");
    w.hold = null;
    await resume(resumption());
    expect(w.sessions).toHaveLength(1);
  });

  it("answers resume.decisionRequired for needs-permission, naming dipo answer", async () => {
    park("needs-permission", "build");
    const error = await refusal(resumption());
    expect(error.error.code).toBe("resume.decisionRequired");
    expect(error.message).toContain("dipo answer");
  });

  it("answers run.hostAlive while the parked worker has not exited", async () => {
    park("stopped", "maintainer");
    w.f.office.immediate(() =>
      w.f.office.run("update agents set ended_at = null where office_id = $office_id"),
    );
    const error = await refusal(resumption());
    expect(error.error.code).toBe("run.hostAlive");
    expect(error.error.retryable).toBe(true);
  });

  it("answers scheduling.off while the daemon schedules no work", async () => {
    park("stopped", "maintainer");
    const error = await refusal(
      resumption({ parks: { scheduling: () => false } } as Partial<ResumptionOptions>),
    );
    expect(error.error.code).toBe("scheduling.off");
    expect(error.error.retryable).toBe(true);
  });

  it("answers resume.capReached naming --budget when the caps are used up", async () => {
    park("stopped", "maintainer");
    usage(60, 1_000);
    const error = await refusal(resumption());
    expect(error.error.code).toBe("resume.capReached");
    expect(error.message).toContain("--budget");
  });
});

describe("top-up of a budget-exceeded park (0020 section 4)", () => {
  it("answers resume.topUpRequired naming --budget and the cap that fired", async () => {
    park("budget-exceeded", "build", "In Progress", "turn cap reached: 61 of 60 turns");
    usage(61, 100_000);
    const error = await refusal(resumption(), { note: "more" });
    expect(error.error.code).toBe("resume.topUpRequired");
    expect(error.message).toContain("--budget +50%");
    expect(error.message).toContain("turn cap");
    expect(error.error.details).toMatchObject({ cap: "maxTurns" });
  });

  it("needs a note with the top-up, and a confirmation showing the caps before and after", async () => {
    park("budget-exceeded", "build");
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
    park("budget-exceeded", "build");
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
        // The caps before and after it are part of the grant (0020 section 4).
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
    park("budget-exceeded", "build");
    usage(80, 100_000);
    const error = await refusal(resumption(), { budget: { share: 10 }, note: "go" }, ctx(true));
    expect(error.error.code).toBe("resume.topUpTooSmall");
    // 80 turns used of 60: +34% of the starting 60 adds 21 turns, the fewest that leave the cap above
    // the 80 used; +33% adds 20, which leaves it reached.
    expect(error.error.details).toMatchObject({ cap: "maxTurns", smallestShare: 34 });
    expect(error.message).toContain("--budget +34%");
    expect(
      smallestShare(TIER_S, TIER_S, { budgetTokens: 0, turns: 80, elapsedMs: 0 }, "developer"),
    ).toBe(34);
  });

  it("sends the undelivered feedback of a fix round the caps stopped before its session first", async () => {
    // A fix round was queued with its items, then the pre-start cap check parked it (DIPO-205).
    const { office, run, t } = w.f;
    office.immediate(() => {
      const intentId = recordIntent(
        office,
        run,
        "steer",
        `${FIX_ROUND_TAG} ${JSON.stringify({ head: "e".repeat(40), advisories: [] })}`,
        t.clock.now(),
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
    park("budget-exceeded", "build", "In Review", "turn cap reached: 60 of 60 turns");
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
    const fix = runIntents(office, run).find((intent) => intent.detail.startsWith(FIX_ROUND_TAG));
    expect(fix?.outcome).toBe("started");
  });

  it("starts a fresh review, not a developer session, for a review-cause top-up", async () => {
    park("budget-exceeded", "review", "In Review");
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

describe("capped, conflicted and review-loop resumes (0020 decision 6b)", () => {
  it("records one loop grant and sends the last verify item first for verify-failing (loops)", async () => {
    park(
      "verify-failing",
      "loops",
      "In Progress",
      "verify failed 3 of 3 times. Verify failed at the verify step.",
    );
    await resume(resumption(), { note: "Use bun test --bail." });
    expect(grants().map((grant) => [grant.kind, grant.amount])).toEqual([["loop", "1"]]);
    const message = first(w.sessions[0]) ?? "";
    expect(message.indexOf("Verify failed at the verify step.")).toBeLessThan(
      message.indexOf("Note from the maintainer: Use bun test --bail."),
    );
  });

  it("records one ciAttempt grant and sends the last stored CI item first for verify-failing (ci)", async () => {
    const { office, run, t } = w.f;
    office.immediate(() =>
      storeFeedbackItems(office, run, {
        intentId: recordIntent(office, run, "steer", "fix-round {}", t.clock.now()),
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
    park("verify-failing", "ci", "In Review", "required checks were red on 2 pushed heads");
    await resume(resumption(), { note: "Run the linter." });
    expect(grants().map((grant) => [grant.kind, grant.amount])).toEqual([["ciAttempt", "1"]]);
    const message = first(w.sessions[0]) ?? "";
    expect(message).toContain("Required check ci-ok failed: lint.");
    expect(message.indexOf("lint.")).toBeLessThan(message.indexOf("Note from the maintainer"));
  });

  it("grows all three caps by half as one budget grant for verify-failing (capped), with no confirmation", async () => {
    park("verify-failing", "capped", "In Progress", "Verify failed at the verify step.");
    usage(60, 100_000);
    const reply = await resume(resumption(), { note: "Last push." });
    expect(reply.result.grants).toEqual([
      { kind: "budget", tokens: 150_000, turns: 30, minutes: 15 },
    ]);
    const message = first(w.sessions[0]) ?? "";
    expect(message.indexOf("Verify failed at the verify step.")).toBeLessThan(
      message.indexOf("Note from the maintainer: Last push."),
    );
  });

  it("returns review-blocked (rounds) to In Review and queues its fix round with one reviewRound grant", async () => {
    const parkId = park("review-blocked", "rounds", "In Review", "blocking: no test");
    const reply = await resume(resumption(), { note: "Add the test, then it passes." });
    expect(reply.result.to).toBe("In Review");
    expect(w.lifts[0]?.to).toBe("In Review");
    expect(w.sessions).toEqual([]);
    expect(w.considered).toEqual([w.f.run]);
    expect(grants().map((grant) => [grant.kind, grant.amount])).toEqual([["reviewRound", "1"]]);
    expect(findRun(w.f.office, w.f.run)?.endKind).toBe("reviewed");
    expect(parkRow(parkId)?.resolved_note).toBe("Add the test, then it passes.");
    // The note waits for the fix round's first message, after its findings.
    const held = runIntents(w.f.office, w.f.run).find((intent) =>
      intent.detail.startsWith("held-feedback "),
    );
    expect(held?.detail).toBe(
      "held-feedback Note from the maintainer: Add the test, then it passes.",
    );
  });

  it("continues a conflict (merge-in-progress) through the conflict hand-off with one conflictHandoff grant", async () => {
    park("conflict", "merge-in-progress");
    await resume(resumption(), { note: "Keep both sides." });
    expect(w.ported).toEqual(["conflict:merge-in-progress"]);
    expect(grants().map((grant) => [grant.kind, grant.amount])).toEqual([["conflictHandoff", "1"]]);
    const message = first(w.sessions[0]) ?? "";
    expect(message.indexOf("Conflict item")).toBeLessThan(
      message.indexOf("Note from the maintainer"),
    );
  });

  it("answers resume.notResumable for a conflict park while no conflict hand-off exists", async () => {
    park("conflict", "push-rejected");
    const error = await refusal(
      resumption({ parks: { conflicts: () => undefined } } as Partial<ResumptionOptions>),
      { note: "merge it" },
    );
    expect(error.error.code).toBe("resume.notResumable");
    expect(error.message).toContain("dipo discard DIPO-1");
  });

  it("re-enters the merge slot for conflict (slot-refused) without a model session", async () => {
    park("conflict", "slot-refused", "In Review");
    const reply = await resume(resumption(), { note: "The base is calm now." });
    expect(reply.result.to).toBe("In Review");
    expect(w.ported).toEqual(["slot"]);
    expect(w.sessions).toEqual([]);
    expect(w.reviews).toEqual([]);
  });

  it("opens a new story PR for stopped (pr-closed) without a model session", async () => {
    park("stopped", "pr-closed", "In Review");
    const reply = await resume(resumption());
    expect(reply.result.to).toBe("In Review");
    expect(w.ported).toEqual(["pr"]);
    expect(w.sessions).toEqual([]);
  });

  for (const [reason, cause] of [
    ["stopped", "review"],
    ["worker-failed", "review"],
  ] as const) {
    it(`starts a fresh reviewer session of the same round for ${reason} (${cause}), never sending the note`, async () => {
      const parkId = park(reason, cause, "In Review");
      await resume(resumption(), { note: "for the record" });
      expect(w.reviews).toEqual([w.f.run]);
      expect(w.sessions).toEqual([]);
      expect(grants()).toEqual([]);
      expect(parkRow(parkId)?.resolved_note).toBe("for the record");
    });
  }

  it("grows the reviewer cap that fired by 50% as a reviewCap grant for worker-failed (review-cap)", async () => {
    const { office, run, t } = w.f;
    const reviewer = t.ids.next("agt");
    office.immediate(() =>
      office.run(
        `insert into agents (office_id, agent_id, run_id, role, model, session_id, started_at,
           ended_at, end_reason)
         values ($office_id, $agent, $run, 'reviewer', 'opus', 'session-r', $at, $at, 'capped')`,
        { agent: reviewer, run, at: t.clock.now() },
      ),
    );
    usage(40, 10_000, reviewer);
    park("worker-failed", "review-cap", "In Review");
    const before = runCaps(office, findRun(office, run) as never);
    await resume(resumption());
    const after = runCaps(office, findRun(office, run) as never);
    expect(grants().map((grant) => [grant.kind, grant.amount])).toEqual([
      ["reviewCap", JSON.stringify({ turns: 20, minutes: 0 })],
    ]);
    expect((after.reviewMaxTurns ?? 0) - (before.reviewMaxTurns ?? 0)).toBe(20);
    expect(w.reviews).toEqual([run]);
  });
});

describe("no resume raises a cap without a recorded grant (0020 section 2, never silent)", () => {
  const resumable = Object.entries(PARK_RESUME_MATRIX).filter(([, row]) => row.kind === "resume");
  for (const [key, row] of resumable) {
    it(`${key}: every cap change is a run_grants row`, async () => {
      if (row.kind !== "resume") return;
      const [reason, cause] = key.includes("/") ? key.split("/") : [key, "build"];
      const from =
        row.session === "review" || row.session === "fix-round" ? "In Review" : "In Progress";
      park(reason as string, cause ?? null, from);
      if (row.topUp === true || row.grant === "budgetHalf") usage(60, 100_000);
      const office = w.f.office;
      const before = runCaps(office, findRun(office, w.f.run) as never);
      const grantsBefore = grantTotals(office, w.f.run);
      await resume(
        resumption(),
        { note: "go", ...(row.topUp === true ? { budget: { share: 50 } } : {}) },
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
      expect(after.loopCap - before.loopCap).toBe(added.loop);
      expect((after.reviewRoundCap ?? 0) - (before.reviewRoundCap ?? 0)).toBe(added.reviewRound);
      expect((after.ciCap ?? 0) - (before.ciCap ?? 0)).toBe(added.ciAttempt);
      expect((after.conflictCap ?? 0) - (before.conflictCap ?? 0)).toBe(added.conflictHandoff);
      expect((after.reviewMaxTurns ?? 0) - (before.reviewMaxTurns ?? 0)).toBe(
        added.reviewCap.turns,
      );
      expect((after.reviewMaxMinutes ?? 0) - (before.reviewMaxMinutes ?? 0)).toBe(
        added.reviewCap.minutes,
      );
      // A resume with no grant rule writes none.
      if (row.grant === undefined && row.topUp !== true) expect(grants()).toEqual([]);
      else expect(grants()).toHaveLength(1);
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
        worktree: join(w.dir, "trees", "DIPO-2"),
        slot: 2,
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
        worktree: join(w.dir, "trees", "DIPO-2"),
        base: "main",
        baseSha: "b".repeat(40),
        startSha: "b".repeat(40),
        claimSha: "d".repeat(40),
        reused: false,
        snapshot: { path: "/x", adminDir: "/x", commondir: "/x", gitdir: "/x", pointer: "/x" },
        firstFeedback: null,
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
      offices: { get: () => office, config: () => undefined },
      starters: { resume: (officeId, run) => resuming.startQueued(officeId, run) },
    });
    park("stopped", "maintainer");
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
    park("verify-failing", "loops");
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
    park("stopped", "maintainer");
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
    park("verify-failing", "loops");
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
    expect(grants().map((grant) => grant.kind)).toEqual(["loop"]);
    expect(await restarted.recoverParkResumes(w.f.office.officeId as OfficeId, w.f.office)).toBe(0);
    expect(w.sessions).toHaveLength(1);
  });
});

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
        w.sessions.push(request);
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
    park("verify-failing", "loops");
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
        grants: [{ kind: "loop", count: 1 }],
      },
    });
    expect([w.lifts.length, w.sessions.length, grants().length]).toEqual([1, 1, 1]);
  });

  it("gives a duplicate that arrives while the first runs the same reply, and resumes once", async () => {
    park("stopped", "maintainer");
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
    park("verify-failing", "loops");
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
    expect(done.result).toMatchObject({ to: "In Progress", grants: [{ kind: "loop", count: 1 }] });
    expect(w.lifts).toHaveLength(1);
    expect(w.sessions).toHaveLength(1);
    expect(grants()).toHaveLength(1);
  });

  it("writes nothing, starts nothing and answers story.notPausedOrParked when the park changed during the lift", async () => {
    const parkId = park("verify-failing", "loops");
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
    expect(error.error.code).toBe("story.notPausedOrParked");
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
    expect(again.error.code).toBe("story.notPausedOrParked");
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
    park("review-blocked", "rounds", "In Review");
    await resume(resumption(), { note: long });
    const held = runIntents(w.f.office, w.f.run).find((intent) =>
      intent.detail.startsWith("held-feedback "),
    );
    expect(held?.detail).toBe(`held-feedback ${noteText(long)}`);
    expect(held?.detail).toContain("[dipo: note cut, showing");
  });
});

describe("the client name of a top-up (0020 section 4, DIPO-155 review)", () => {
  it("records the client name the connection gave in engine.hello on the budget grant", async () => {
    park("budget-exceeded", "build");
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

describe("a question park resumed with its answer (DIPO-159; 0020 sections 2 and 7)", () => {
  const QUESTION = "Which greeting should the CLI print?";

  /** A park `ambiguous-spec` (question) whose question is stored, linked to it; its id. */
  function questionPark(): { parkId: number; question: string } {
    const parkId = park("ambiguous-spec", "question", "In Progress", QUESTION);
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
    const session = w.sessions[0] as NextSessionRequest;
    expect(session.message).toContain(`Your question: ${QUESTION}`);
    expect(session.message).toContain("The maintainer's answer: Print Hello, Ada!");
    expect(session.note).toBeUndefined();
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
      recordIntent(
        w.f.office,
        w.f.run,
        "steer",
        `${MAINTAINER_TAGS.held} ${workerAnswerText("Print Hello, Ada!")}`,
        w.f.t.clock.now(),
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
    const parkId = park("budget-exceeded", "build", "In Progress", "turn cap reached");
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

describe("the rule-conflict and no-report resumes (DIPO-159 AC #6; 0020 section 2)", () => {
  it("resumes ambiguous-spec (rule-conflict) with a required note, the conflict the worker named first", async () => {
    park(
      "ambiguous-spec",
      "rule-conflict",
      "In Progress",
      "CLAUDE.md forbids the flag the story asks for",
    );
    const refused = await refusal(resumption());
    expect(refused.error.code).toBe("resume.noteRequired");
    await resume(resumption(), { note: "Keep the flag; the story wins." });
    const session = w.sessions[0] as NextSessionRequest;
    const text = first(session);
    expect(text).toContain("CLAUDE.md forbids the flag the story asks for");
    expect(text.indexOf("CLAUDE.md forbids")).toBeLessThan(
      text.indexOf("Note from the maintainer: Keep the flag; the story wins."),
    );
  });

  it("resumes ambiguous-spec (no-report) only with a note, always in a handoff session", async () => {
    park("ambiguous-spec", "no-report");
    expect((await refusal(resumption())).error.code).toBe("resume.noteRequired");
    await resume(resumption(), { note: "Report in the schema." });
    expect(w.sessions[0]?.mode).toBe("handoff");
    expect(w.sessions[0]?.note).toBe("Report in the schema.");
  });
});
