// The parked time of a resumed run (DIPO-75, DIPO-344), fast and local: a migrated state database
// with one claimed story run parked `worker-failed`, worker outcomes with a fake unpark writer and a
// fake next session. It covers `runs.parked_ms`: the time cap after a long park, two parks of one
// run each counted once, and `run_outcomes.minutes`.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { StoryId, type StoryKey } from "@dipsaus-orchestrator/contract";

import { insertPark } from "./park-fixture";
import type { AsyncCommandContext } from "../../src/commands/registry";
import {
  capsStartedAt,
  endRun,
  findRun,
  firedCap,
  insertRun,
  createRunOutcomes,
  type Resumption,
  type RunOutcomes,
  type RunEnder,
  runOutcome,
  runTotals,
  type UnparkBranchRequest,
  type UnparkWriter,
} from "../../src/run";
import type { NextSessionRequest } from "../../src/run/resume";
import { reopenParkedRun } from "../../src/run/park";
import { addStory } from "../../src/stories/keys";
import { encode } from "../../src/workers/claude-cli/encode";
import type { Caps } from "../../src/workers/types";
import { insertClaim } from "../../src/worktree/records";
import { type IngestFixture, ingestFixture } from "../ingest/helpers";

const CAPS: Caps = { budgetTokens: 1_000_000, maxTurns: 100, maxMinutes: 30 };
const MINUTE = 60_000;

interface World {
  readonly dir: string;
  readonly f: IngestFixture;
  readonly key: StoryKey;
  readonly lifts: UnparkBranchRequest[];
  readonly sessions: NextSessionRequest[];
}

let w: World;

beforeEach(async () => {
  const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "park-resume-"));
  const f = await ingestFixture(dir);
  const { office, run } = f;
  const { key } = office.immediate(() =>
    addStory(office, f.t.ids, { story: StoryId.parse("DIPO-1") }, f.t.clock.now()),
  );
  const worktree = join(dir, "trees", "DIPO-1");
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
      worktree,
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
      worktree,
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
       values ($office_id, $agent, $run, 'developer', 'haiku', 'session-1', $at, $at, 'blocked')`,
      { agent: f.agent, run, at: f.t.clock.now() },
    );
  });
  w = { dir, f, key, lifts: [], sessions: [] };
});

afterEach(() => {
  w.f.t.state.close();
  rmSync(w.dir, { recursive: true, force: true });
});

/** Parks the run `worker-failed` at the current time; returns the park id. */
function park(): { parkId: number } {
  const { office, run, t } = w.f;
  const at = t.clock.now();
  let parkId = 0;
  office.immediate(() => {
    insertPark(office, {
      key: w.key,
      story: "DIPO-1",
      runId: run,
      reason: "worker-failed",
      detail: "the worker host was lost",
      at,
    });
    parkId = office.get<{ id: number }>(
      "select max(park_id) as id from parks where office_id = $office_id",
    )?.id as number;
    endRun(office, run, at, "interrupted");
  });
  return { parkId };
}

function built(unpark: UnparkWriter): { outcomes: RunOutcomes; resumption: Resumption } {
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
        return { kind: "started", agent: "agt_x" as never, resumed: true };
      },
    },
    caps: () => CAPS,
    unpark,
  });
}

function context(): AsyncCommandContext {
  return {
    office: w.f.office,
    clock: w.f.t.clock,
    ids: w.f.t.ids,
    requestId: "req_1",
    origin: "cli",
    confirmed: false,
    now: w.f.t.clock.now(),
    stories: { get: () => ({ story: "DIPO-1", key: w.key }) },
    commit: () => {},
  } as unknown as AsyncCommandContext;
}
const resumptionOf = (unpark: UnparkWriter): Resumption => built(unpark).resumption;

const lifting: UnparkWriter = {
  lift: async (_office, request) => {
    w.lifts.push(request);
    return { commit: null, pushed: true, pushError: null };
  },
};

describe("parked time (runs.parked_ms)", () => {
  it("counts each parked span once over two parks, in the caps and in run_outcomes.minutes", () => {
    const { office, run, t } = w.f;
    const started = t.clock.now();
    t.clock.advance(10 * MINUTE); // worked 10 min
    const first = park();
    t.clock.advance(5 * 60 * MINUTE); // parked 5 h
    office.immediate(() =>
      reopenParkedRun(
        office,
        { ...first, reason: "worker-failed", detail: "x" },
        findRun(office, run)!,
        "In Progress",
        t.clock.now(),
      ),
    );
    expect(findRun(office, run)?.parkedMs).toBe(5 * 60 * MINUTE);
    t.clock.advance(7 * MINUTE); // worked 7 min
    const second = park();
    t.clock.advance(2 * 60 * MINUTE); // parked 2 h
    office.immediate(() =>
      reopenParkedRun(
        office,
        { ...second, reason: "worker-failed", detail: "x" },
        findRun(office, run)!,
        "In Progress",
        t.clock.now(),
      ),
    );
    const reopened = findRun(office, run);
    expect(reopened?.parkedMs).toBe(7 * 60 * MINUTE);
    expect(reopened?.endedAt).toBeNull();
    // The caps count 17 minutes of work, not 7 h 17 min: no time cap at 30 minutes.
    const from = capsStartedAt(reopened!, started);
    expect(t.clock.now() - from).toBe(17 * MINUTE);
    expect(firedCap(CAPS, runTotals(office, run, from, t.clock.now()))).toBeNull();
    // Without the parked time the 30-minute cap would have fired.
    expect(firedCap(CAPS, runTotals(office, run, started, t.clock.now()))?.cap).toBe("maxMinutes");
    t.clock.advance(3 * MINUTE);
    office.immediate(() => endRun(office, run, t.clock.now(), "in-review"));
    const outcome = runOutcome(office, run);
    expect(outcome?.minutes).toBe(20);
    expect(outcome?.parkReasons).toEqual(["worker-failed", "worker-failed"]);
  });

  it("starts the resumed session with its caps counting from the work, after a long park", async () => {
    const { run, t } = w.f;
    const started = t.clock.now();
    t.clock.advance(10 * MINUTE);
    park();
    t.clock.advance(24 * 60 * MINUTE);
    const resuming = resumptionOf(lifting);
    const reply = await resuming.resumeCommand(context(), { story: StoryId.parse("DIPO-1") });
    expect(reply.result).toMatchObject({ to: "In Progress", run });
    await resuming.idle();
    expect(w.lifts).toHaveLength(1);
    const session = w.sessions[0];
    expect(t.clock.now() - (session?.startedAt ?? 0)).toBe(10 * MINUTE);
    expect(session?.startedAt).toBe(started + 24 * 60 * MINUTE);
    expect(session?.message).toContain("the worker host was lost");
  });
});
