// The office's worker and reviewer places (DIPO-142, 0019 section 12), fast and local: place
// counting from open story runs and their agents' roles (session runs left out), the start order of
// each place, a maintainer resume queued while its place is taken and started when it frees, and
// the office's starts paused, which keeps every waiting session waiting and never parks it (0020).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { type OfficeId, type RunId, StoryId } from "@dipsaus-orchestrator/contract";

import {
  activeRuns,
  claimPlace,
  createRunOutcomes,
  endRun,
  findRun,
  hasActiveRun,
  IN_REVIEW_END,
  type PlaceStart,
  placeHolders,
  Places,
  placeTaken,
  reopenForRound,
  type RunEnder,
  RunControl,
  runIntents,
  START_KINDS,
  startOrder,
  type UnparkWriter,
  waitForPlace,
  waitingStarts,
} from "../../src/run";
import type { NextSessionRequest } from "../../src/run/resume";
import { workView } from "../../src/views/work";
import { encode } from "../../src/workers/claude-cli/encode";
import { countRows } from "../commands/helpers";
import { loggedEvents } from "../ingest/helpers";
import {
  addAgent,
  addUsage,
  endAgent,
  MINUTE,
  type RoundsWorld,
  roundsWorld,
  sessionRun,
  storyRun,
  type StoryRun,
} from "./rounds-helpers";

let w: RoundsWorld;

beforeEach(async () => {
  w = await roundsWorld("places-");
});

afterEach(() => w.close());

const now = (): number => w.t.clock.now();
const write = <T>(fn: () => T): T => w.office.immediate(fn);
const officeId = (): OfficeId => w.office.officeId as OfficeId;
const holderIds = () => {
  const holders = placeHolders(w.office);
  return {
    worker: holders.worker.map((run) => run.story),
    reviewer: holders.reviewer.map((run) => run.story),
  };
};
const pickup: PlaceStart = { kind: START_KINDS.pickup, runId: null, since: 0 };

/** A story run that worked and ended at In Review, its developer agent ended. */
function inReview(story: string): StoryRun {
  const s = storyRun(w, { story });
  addAgent(w, s.run, "developer", false);
  write(() => endRun(w.office, s.run, now(), IN_REVIEW_END));
  return s;
}

describe("counting (0019 section 12)", () => {
  it("leaves session runs out of the places while activeRuns and hasActiveRun count them", () => {
    const session = sessionRun(w);
    expect(activeRuns(w.office).map((run) => run.runId)).toEqual([session]);
    expect(hasActiveRun(w.office)).toBe(true);
    expect(holderIds()).toEqual({ worker: [], reviewer: [] });
    expect(placeTaken(w.office, pickup)).toBeNull();

    // A developer session holds the worker place; the session run still holds none.
    const a = storyRun(w, { story: "DIPO-1" });
    addAgent(w, a.run, "developer", true);
    expect(activeRuns(w.office)).toHaveLength(2);
    expect(holderIds()).toEqual({ worker: ["DIPO-1"], reviewer: [] });
    expect(placeTaken(w.office, pickup)).toContain("held by DIPO-1");
  });

  it("counts a starting session and a run held between sessions, from the agent's role", () => {
    // Claimed, its session starting: no agent yet.
    storyRun(w, { story: "DIPO-1" });
    expect(holderIds().worker).toEqual(["DIPO-1"]);

    // A review reopened on a run ended at In Review waits and holds no place; once it takes the
    // reviewer place it holds that one, before and while its reviewer agent runs.
    const b = inReview("DIPO-2");
    expect(holderIds()).toEqual({ worker: ["DIPO-1"], reviewer: [] });
    write(() => reopenForRound(w.office, findRun(w.office, b.run)!, "review", now()));
    expect(holderIds()).toEqual({ worker: ["DIPO-1"], reviewer: [] });
    expect(waitingStarts(w.office).map((waiting) => [waiting.kind, waiting.runId])).toEqual([
      ["review", b.run],
    ]);
    write(() => claimPlace(w.office, b.run, now()));
    expect(holderIds()).toEqual({ worker: ["DIPO-1"], reviewer: ["DIPO-2"] });
    addAgent(w, b.run, "reviewer", true, "opus");
    expect(holderIds()).toEqual({ worker: ["DIPO-1"], reviewer: ["DIPO-2"] });
    // A reviewer next to a worker takes no worker place.
    expect(placeTaken(w.office, { kind: START_KINDS.review, runId: null, since: 0 })).toContain(
      "reviewer place is held by DIPO-2",
    );
  });
});

/** A start of `kind` for the run id `run`, waiting since `since`. */
function start(kind: PlaceStart["kind"], run: string, since: number): PlaceStart {
  return { kind, runId: run as RunId, since };
}

describe("start order (0019 section 12)", () => {
  it("starts maintainer resumes, then conflict hand-offs and fix rounds, then pickups in the worker place", () => {
    const order = startOrder([
      { ...pickup, since: -1 },
      start("fix", "run_c", 1),
      start("resume", "run_r", 5),
      start("conflict", "run_k", 0),
      start("resume", "run_q", 2),
    ]);
    expect(order.map((s): string => s.runId ?? "pickup")).toEqual([
      "run_q",
      "run_r",
      "run_k",
      "run_c",
      "pickup",
    ]);
  });

  it("starts maintainer resumes of a review, then pending reviews oldest In Review first", () => {
    const order = startOrder([
      start("review", "run_3", 3),
      start("review-resume", "run_9", 9),
      start("review", "run_1", 1),
    ]);
    expect(order.map((s): string | null => s.runId)).toEqual(["run_9", "run_1", "run_3"]);
  });

  it("puts a waiting fix round ahead of a pickup, but not ahead of a maintainer resume", () => {
    const c = inReview("DIPO-3");
    write(() => reopenForRound(w.office, findRun(w.office, c.run)!, "fix", now()));
    expect(holderIds().worker).toEqual([]);
    expect(placeTaken(w.office, pickup)).toBe("DIPO-3 waits for the office's worker place first");
    expect(
      placeTaken(w.office, { kind: START_KINDS.resume, runId: null, since: now() }),
    ).toBeNull();
  });
});

describe("a resume that finds its place taken (0020 section 1)", () => {
  const DETAIL = "the worker host was lost";
  const sessions: NextSessionRequest[] = [];
  const lifting: UnparkWriter = {
    lift: async () => ({ commit: null, pushed: true, pushError: null }),
  };

  /** Story DIPO-5 parked `worker-failed`; returns its run. */
  function parked(): { s: StoryRun } {
    const s = storyRun(w, { story: "DIPO-5" });
    addAgent(w, s.run, "developer", false);
    const at = now();
    write(() => {
      w.office.run(
        `insert into parks (office_id, park_id, key, story_id, run_id, reason, from_state, detail,
           at)
         values ($office_id, 1, $key, 'DIPO-5', $run, 'worker-failed', 'In Progress', $detail, $at)`,
        { key: s.key, run: s.run, detail: DETAIL, at },
      );
      endRun(w.office, s.run, at, "interrupted");
    });
    return { s };
  }

  it("is accepted and waits, then starts first when the worker place frees", async () => {
    sessions.length = 0;
    // DIPO-4's developer holds the worker place.
    const busy = storyRun(w, { story: "DIPO-4" });
    const developer = addAgent(w, busy.run, "developer", true);
    const { s } = parked();
    // A fix round of DIPO-6 waits for the worker place too, from before the resume.
    const fix = inReview("DIPO-6");
    write(() => reopenForRound(w.office, findRun(w.office, fix.run)!, "fix", now()));
    w.t.clock.advance(MINUTE);

    let places: Places | null = null;
    const started: string[] = [];
    const { resumption } = createRunOutcomes(
      {
        clock: w.t.clock,
        offices: { get: () => w.office },
        steering: { send: async () => ({ ok: true }) },
        encode,
        worker: { id: "claude-cli", result: () => ({}) as never },
        ender: () => ({ isTracked: () => false }) as unknown as RunEnder,
        resumer: {
          next: async (request) => {
            sessions.push(request);
            started.push(request.run.story ?? "");
            return { kind: "started", agent: "agt_next" as never, resumed: true };
          },
        },
        caps: () => ({ budgetTokens: 1_000_000, maxTurns: 100, maxMinutes: 60 }),
        unpark: lifting,
      },
      { places: () => places ?? undefined },
    );
    places = new Places({
      clock: w.t.clock,
      offices: { get: () => w.office },
      starters: {
        resume: (office, run) => resumption.startQueued(office, run),
        fix: async (_office, run) => {
          started.push(run.story ?? "");
          return true;
        },
      },
    });

    const reply = await resumption.resumeCommand(
      {
        office: w.office,
        clock: w.t.clock,
        ids: w.t.ids,
        requestId: "req_resume",
        origin: "cli",
        confirmed: false,
        now: now(),
        stories: { get: () => ({ story: "DIPO-5", key: s.key }) },
        commit: () => {},
      } as never,
      { story: StoryId.parse("DIPO-5") },
    );
    expect(reply.result).toMatchObject({ to: "In Progress", queued: true });
    await places.idle();
    expect(sessions).toEqual([]);
    expect(findRun(w.office, s.run)).toMatchObject({ endedAt: null, waiting: "resume" });
    expect(runIntents(w.office, s.run).find((i) => i.kind === "answer")?.state).toBe("sent");
    expect(
      loggedEvents(w.office)
        .filter((event) => event.type === "engine.notice")
        .map((event) => (event.data as { code: string }).code),
    ).toContain("run.queued");
    // Nothing starts while DIPO-4 holds the place.
    expect(await places.drain(officeId())).toBe(0);

    // DIPO-4's session ends 50 seconds later: the resume goes before the older fix round.
    w.t.clock.advance(50_000);
    endAgent(w, developer);
    write(() => endRun(w.office, busy.run, now(), IN_REVIEW_END));
    expect(await places.drain(officeId())).toBe(1);
    expect(started).toEqual(["DIPO-5"]);
    expect(sessions[0]?.message).toContain(DETAIL);
    const resumed = findRun(w.office, s.run);
    expect(resumed?.waiting).toBeNull();
    // The wait for the place is no developer time: the park, then the 50 seconds in line.
    expect(resumed?.parkedMs).toBe(MINUTE + 50_000);
    expect(runIntents(w.office, s.run).find((i) => i.kind === "answer")?.outcome).toBe("resumed");

    // The resumed session holds the place, so the fix round still waits; it starts once that
    // session ends too.
    addAgent(w, s.run, "developer", true);
    expect(await places.drain(officeId())).toBe(0);
    write(() => endRun(w.office, s.run, now(), IN_REVIEW_END));
    expect(await places.drain(officeId())).toBe(1);
    expect(started).toEqual(["DIPO-5", "DIPO-6"]);
    places.close();
  });
});

describe("the office's starts paused keeps every waiting session waiting (0020)", () => {
  it("starts no waiting session while paused, never parks it, and starts it once the pause lifted", async () => {
    const fix = inReview("DIPO-8");
    write(() => reopenForRound(w.office, findRun(w.office, fix.run)!, "fix", now()));
    let paused: string | null = "the office's starts are paused (plan limit until later)";
    const started: string[] = [];
    const places = new Places({
      clock: w.t.clock,
      offices: { get: () => w.office },
      startsPaused: () => paused,
      starters: {
        fix: async (_office, run) => {
          started.push(run.story ?? "");
          return true;
        },
      },
    });
    try {
      expect(await places.drain(officeId())).toBe(0);
      expect(started).toEqual([]);
      expect(
        places.blocked(officeId(), { kind: START_KINDS.fix, runId: fix.run, since: now() }),
      ).toBe(paused);
      expect(findRun(w.office, fix.run)).toMatchObject({ endedAt: null, waiting: "fix" });
      expect(workView(w.office, fix.run)?.health).not.toBe("lost");
      expect(countRows(w.office, "parks")).toBe(0);

      // The pause lifts: the place's tick drains again and the fix round takes the worker place.
      paused = null;
      w.t.clock.advance(MINUTE);
      await places.idle();
      expect(started).toEqual(["DIPO-8"]);
      expect(findRun(w.office, fix.run)?.waiting).toBeNull();
      expect(countRows(w.office, "parks")).toBe(0);
    } finally {
      places.close();
    }
  });
});

/** A story run that used `turns` of its 100 turns, waiting for the worker place as `kind`. */
function waitingAs(story: string, kind: "fix" | "conflict", turns: number): StoryRun {
  const s = storyRun(w, { story });
  const agent = addAgent(w, s.run, "developer", false);
  addUsage(w, s.run, agent, "developer", { turns, tokens: 10 });
  write(() => waitForPlace(w.office, s.run, kind, now()));
  return s;
}

function world() {
  const started: string[] = [];
  const control = new RunControl({
    clock: w.t.clock,
    offices: { get: () => w.office },
    writer: {
      write: async () => ({
        commit: "c".repeat(40),
        lastGoodCommit: "a".repeat(40),
        from: "In Progress",
        pushed: true,
        pushError: null,
      }),
    },
    steering: { send: async () => ({ ok: true }) },
    encode,
  });
  const places = new Places({
    clock: w.t.clock,
    offices: { get: () => w.office },
    park: (office, run, work, ending) => control.park(office, run, work, ending),
    starters: {
      fix: async (_office, run) => {
        started.push(`fix ${run.story}`);
        return true;
      },
      conflict: async (_office, run) => {
        started.push(`conflict ${run.story}`);
        return true;
      },
    },
  });
  return { started, places, close: () => (places.close(), control.close()) };
}

const parksOf = () =>
  w.office.all<{ story_id: string; reason: string; detail: string }>(
    "select story_id, reason, detail from parks where office_id = $office_id order by park_id",
  );

describe("the pre-start cap check (DIPO-205)", () => {
  it("parks a capped run's fix wait and conflict wait budget-exceeded and never calls the starter", async () => {
    const fix = waitingAs("DIPO-8", "fix", 100);
    w.t.clock.advance(1);
    const conflict = waitingAs("DIPO-9", "conflict", 100);
    const x = world();
    try {
      expect(await x.places.drain(officeId())).toBe(0);
      expect(await x.places.drain(officeId())).toBe(0);
      expect(x.started).toEqual([]);
      expect(parksOf()).toEqual([
        {
          story_id: "DIPO-8",
          reason: "budget-exceeded",
          detail: "turn cap reached: 100 of 100 turns",
        },
        {
          story_id: "DIPO-9",
          reason: "budget-exceeded",
          detail: "turn cap reached: 100 of 100 turns",
        },
      ]);
      expect(findRun(w.office, fix.run)).toMatchObject({ endKind: "capped" });
      expect(findRun(w.office, conflict.run)).toMatchObject({ endKind: "capped" });
      expect(runIntents(w.office, fix.run).map((i) => [i.kind, i.state])).toEqual([
        ["cap", "resolved"],
      ]);
    } finally {
      x.close();
    }
  });

  it("starts a run under its caps through its starter", async () => {
    waitingAs("DIPO-8", "fix", 99);
    const x = world();
    try {
      expect(await x.places.drain(officeId())).toBe(1);
      expect(x.started).toEqual(["fix DIPO-8"]);
      expect(parksOf()).toEqual([]);
    } finally {
      x.close();
    }
  });
});
