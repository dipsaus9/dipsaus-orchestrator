// Resuming a `needs-permission` park (DIPO-75), fast and local: a migrated state database with one
// claimed story run parked `needs-permission` with its question, worker outcomes with a fake unpark
// writer and a fake next session. It covers the parked time (`runs.parked_ms`: the time cap after a
// long park, two parks of one run each counted once, `run_outcomes.minutes`) and a resume a
// restart interrupted, which `redispatch` finishes from its `park-resume` intent. The real path on
// git and the Backlog CLI runs in park-resume.ci.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { type RunId, StoryId, type StoryKey } from "@dipsaus-orchestrator/contract";

import { findQuestion, insertParkQuestion } from "../../src/hooks/questions";
import {
  capsStartedAt,
  endRun,
  findRun,
  firedCap,
  insertRun,
  openPark,
  RunOutcomes,
  type RunEnder,
  runIntents,
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
const ACTION = "docker ps";

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

/** Parks the run `needs-permission` at the current time with its question; returns both ids. */
function park(): { parkId: number; question: string } {
  const { office, run, t } = w.f;
  const at = t.clock.now();
  const question = t.ids.next("qst");
  let parkId = 0;
  office.immediate(() => {
    office.run(
      `insert into parks (office_id, park_id, key, story_id, run_id, reason, from_state, detail, at)
       values ($office_id, (select coalesce(max(park_id), 0) + 1 from parks
         where office_id = $office_id), $key, 'DIPO-1', $run, 'needs-permission', 'In Progress',
         $detail, $at)`,
      { key: w.key, run, detail: `Bash: ${ACTION}`, at },
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
      action: ACTION,
      text: `Bash(${ACTION})`,
      at,
    });
  });
  return { parkId, question };
}

function outcomes(unpark: UnparkWriter): RunOutcomes {
  const { f } = w;
  const ender = { isTracked: () => false } as unknown as RunEnder;
  return new RunOutcomes({
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
        { ...first, reason: "needs-permission", detail: "x" },
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
        { ...second, reason: "needs-permission", detail: "x" },
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
    expect(outcome?.parkReasons).toEqual(["needs-permission", "needs-permission"]);
  });

  it("starts the resumed session with its caps counting from the work, after a long park", async () => {
    const { run, t } = w.f;
    const started = t.clock.now();
    t.clock.advance(10 * MINUTE);
    const { parkId, question } = park();
    t.clock.advance(24 * 60 * MINUTE);
    const result = await outcomes(lifting).resumePark(w.f.office.officeId as never, run, {
      parkId,
      question,
      decision: "allow",
      text: "",
    });
    expect(result).toEqual({ kind: "started" });
    const session = w.sessions[0];
    expect(t.clock.now() - (session?.startedAt ?? 0)).toBe(10 * MINUTE);
    expect(session?.startedAt).toBe(started + 24 * 60 * MINUTE);
    expect(session?.message).toContain(ACTION);
  });
});

describe("a resume a restart interrupted", () => {
  it("is finished by redispatch from its intent: lifted, reopened, answered and resumed once", async () => {
    const { office, run } = w.f;
    const { parkId, question } = park();
    // The daemon stops while the park is being lifted on the branch.
    const stuck: UnparkWriter = { lift: () => new Promise(() => undefined) };
    void outcomes(stuck).resumePark(office.officeId as never, run, {
      parkId,
      question,
      decision: "deny",
      text: "use the fake",
    });
    await Bun.sleep(0);
    const [intent] = runIntents(office, run);
    expect(intent).toMatchObject({ kind: "answer", state: "pending", resolvedAt: null });
    expect(openPark(office, w.key)?.parkId).toBe(parkId);
    expect(findRun(office, run)?.endedAt).not.toBeNull();
    expect(findQuestion(office, question)?.closedAt).toBeNull();

    // The next daemon: redispatch rolls the resume forward.
    const restarted = outcomes(lifting);
    await restarted.redispatch(office.officeId as never);
    expect(w.lifts).toHaveLength(1);
    expect(openPark(office, w.key)).toBeNull();
    expect(findRun(office, run)?.endedAt).toBeNull();
    expect(findQuestion(office, question)).toMatchObject({
      closedHow: "answered",
      decision: "deny",
      answer: "use the fake",
    });
    expect(w.sessions).toHaveLength(1);
    expect(w.sessions[0]?.message).toContain(`Do it without ${ACTION}.`);
    expect(runIntents(office, run).find((i) => i.kind === "answer")).toMatchObject({
      outcome: "resumed",
    });
    // A second restart does nothing more.
    await outcomes(lifting).redispatch(office.officeId as never);
    expect(w.sessions).toHaveLength(1);
  });

  it("starts the session of a reopened run whose session never started", async () => {
    const { office, run } = w.f;
    const { parkId, question } = park();
    // The reopen committed, then the daemon stopped before the session started.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = new RunOutcomes({
      clock: w.f.t.clock,
      offices: { get: () => office },
      steering: { send: async () => ({ ok: true }) },
      encode,
      worker: { id: "claude-cli", result: () => ({}) as never },
      ender: () => ({ isTracked: () => false }) as unknown as RunEnder,
      resumer: { next: () => held.then(() => new Promise(() => undefined)) },
      caps: () => CAPS,
      unpark: lifting,
    });
    void first.resumePark(office.officeId as never, run, {
      parkId,
      question,
      decision: "allow",
      text: "",
    });
    for (let i = 0; i < 20 && findRun(office, run)?.endedAt !== null; i++) await Bun.sleep(0);
    expect(findRun(office, run)?.endedAt).toBeNull();
    expect(runIntents(office, run).find((i) => i.kind === "answer")?.state).toBe("sent");

    await outcomes(lifting).redispatch(office.officeId as never);
    expect(w.lifts).toHaveLength(1);
    expect(w.sessions).toHaveLength(1);
    expect(runIntents(office, run).find((i) => i.kind === "answer")?.outcome).toBe("resumed");
    release();
  });

  it("drops the intent and leaves the question answerable when the park ended meanwhile", async () => {
    const { office, run } = w.f;
    const { parkId, question } = park();
    void outcomes({ lift: () => new Promise(() => undefined) }).resumePark(
      office.officeId as never,
      run,
      { parkId, question, decision: "allow", text: "" },
    );
    await Bun.sleep(0);
    office.immediate(() =>
      office.run(
        `update parks set resolved_at = 1, resolved_how = 'reconcile' where office_id = $office_id`,
      ),
    );
    await outcomes(lifting).redispatch(office.officeId as never);
    expect(w.lifts).toEqual([]);
    expect(w.sessions).toEqual([]);
    expect(runIntents(office, run).find((i) => i.kind === "answer")?.outcome).toBe("abandoned");
    expect(findRun(office, run as RunId)?.endedAt).not.toBeNull();
  });
});
