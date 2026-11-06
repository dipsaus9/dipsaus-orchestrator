// The office's run slots and each story's worker and reviewer places (DIPO-142, 0002), fast and
// local: slot counting from open story runs and their agents' roles (session runs left out) against
// `caps.parallelRuns`, the office's start order, a maintainer resume queued while every slot is
// taken and started when one frees, and the office's starts paused, which keeps every waiting
// session waiting and never parks it (0020).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { type OfficeId, type RunId, StoryId } from "@dipsaus-orchestrator/contract";

import { runningStoryCount, sessionRunCount } from "../../src/overview";
import { insertPark } from "../run/park-fixture";
import { createRunOutcomes, type RunEnder, RunControl, type UnparkWriter } from "../../src/run";
import {
  claimPlace,
  freeSlots,
  type PlaceStart,
  placeHolders,
  Places,
  placeTaken,
  reopen,
  slotHolders,
  stopAtInReview,
  START_KINDS,
  startOrder,
  waitForPlace,
  waitingStarts,
} from "../../src/run-state";
import { activeRuns, endRun, findRun, hasActiveRun, runIntents } from "../../src/records";
import { type HeldSession, withHeld } from "../run/held-session";
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
} from "../run/rounds-helpers";
import { backlogLayout } from "../story-store/backlog";

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
/** The slot check with the limit `limit` and nothing else counted. */
const taken = (what: PlaceStart, limit: number) => placeTaken(w.office, what, { limit });

/** A story run that worked and stands open at In Review, its developer agent ended. */
function inReview(story: string): StoryRun {
  const s = storyRun(w, { story });
  addAgent(w, s.run, "developer", false);
  write(() => stopAtInReview(w.office, s.run, now()));
  return s;
}

describe("counting (0002)", () => {
  it("leaves session runs out of the places while activeRuns and hasActiveRun count them", () => {
    const session = sessionRun(w);
    expect(activeRuns(w.office).map((run) => run.runId)).toEqual([session]);
    expect(hasActiveRun(w.office)).toBe(true);
    expect(holderIds()).toEqual({ worker: [], reviewer: [] });
    expect(taken(pickup, 1)).toBeNull();

    // A developer session holds its story's worker place and a slot; the session run holds none.
    const a = storyRun(w, { story: "DIPO-1" });
    addAgent(w, a.run, "developer", true);
    expect(activeRuns(w.office)).toHaveLength(2);
    expect(holderIds()).toEqual({ worker: ["DIPO-1"], reviewer: [] });
    expect(taken(pickup, 1)).toBe(
      "the office runs at most 1 story at once (caps.parallelRuns in .dipo/office.yaml); running: DIPO-1",
    );
    expect(taken(pickup, 2)).toBeNull();
  });

  it("counts the stories holding a slot for the summary, in review included, and sessions apart (DIPO-446)", () => {
    for (const story of ["DIPO-1", "DIPO-2"]) {
      const s = storyRun(w, { story });
      addAgent(w, s.run, "developer", true);
    }
    // A run open at In Review holds its slot only with the review loop's cap, as a story run starts with it.
    const reviewing = storyRun(w, { story: "DIPO-3", reviewRoundCap: 3 });
    addAgent(w, reviewing.run, "developer", false);
    write(() => stopAtInReview(w.office, reviewing.run, now()));
    sessionRun(w);
    expect(runningStoryCount(w.office)).toBe(3);
    expect(sessionRunCount(w.office)).toBe(1);
  });

  it("holds three worker places and three reviewer places at limit 3; a fourth pickup waits, naming the limit", () => {
    const developers = ["DIPO-1", "DIPO-2", "DIPO-3"].map((story) => {
      const s = storyRun(w, { story });
      addAgent(w, s.run, "developer", true);
      return s;
    });
    expect(holderIds()).toEqual({ worker: ["DIPO-1", "DIPO-2", "DIPO-3"], reviewer: [] });
    const full =
      "the office runs at most 3 stories at once (caps.parallelRuns in .dipo/office.yaml); running: DIPO-1, DIPO-2, DIPO-3";
    expect(taken(pickup, 3)).toBe(full);

    // Each story's review runs in its own reviewer place: three reviewers at once.
    for (const s of developers) {
      write(() => stopAtInReview(w.office, s.run, now()));
      write(() => reopen(w.office, findRun(w.office, s.run)!, now(), { kind: "review" }));
      write(() => claimPlace(w.office, s.run, now()));
      addAgent(w, s.run, "reviewer", true, "opus");
    }
    expect(holderIds()).toEqual({ worker: [], reviewer: ["DIPO-1", "DIPO-2", "DIPO-3"] });
    expect(taken(pickup, 3)).toBe(full);
    expect(taken(pickup, 4)).toBeNull();
  });

  it("keeps a story's slot from its developer to its own review, so the review never waits for another story", () => {
    const a = storyRun(w, { story: "DIPO-1" });
    const developer = addAgent(w, a.run, "developer", true);
    const b = storyRun(w, { story: "DIPO-2" });
    addAgent(w, b.run, "developer", true);
    // DIPO-1 reaches In Review and waits for its review: it holds its slot (`reviewing`).
    endAgent(w, developer);
    write(() => stopAtInReview(w.office, a.run, now()));
    expect(slotHolders(w.office, [a.run]).map((run) => run.story)).toEqual(["DIPO-2", "DIPO-1"]);
    expect(placeTaken(w.office, pickup, { limit: 2, reviewing: [a.run] })).toContain(
      "running: DIPO-2, DIPO-1",
    );
    // Its review starts in its own slot, though every slot is held.
    const review = start("review", a.run, now());
    expect(placeTaken(w.office, review, { limit: 2, reviewing: [a.run] })).toBeNull();
    expect(placeTaken(w.office, review, { limit: 1, reviewing: [a.run] })).toBeNull();
  });

  it("counts a starting session and a run held between sessions, from the agent's role", () => {
    // Claimed, its session starting: no agent yet.
    storyRun(w, { story: "DIPO-1" });
    expect(holderIds().worker).toEqual(["DIPO-1"]);

    // A review reopened on a run open at In Review waits and holds no place; once it takes the
    // reviewer place it holds that one, before and while its reviewer agent runs.
    const b = inReview("DIPO-2");
    expect(holderIds()).toEqual({ worker: ["DIPO-1"], reviewer: [] });
    write(() => reopen(w.office, findRun(w.office, b.run)!, now(), { kind: "review" }));
    expect(holderIds()).toEqual({ worker: ["DIPO-1"], reviewer: [] });
    expect(waitingStarts(w.office).map((waiting) => [waiting.kind, waiting.runId])).toEqual([
      ["review", b.run],
    ]);
    // The waiting review holds its story's slot already.
    expect(slotHolders(w.office).map((run) => run.story)).toEqual(["DIPO-1", "DIPO-2"]);
    write(() => claimPlace(w.office, b.run, now()));
    expect(holderIds()).toEqual({ worker: ["DIPO-1"], reviewer: ["DIPO-2"] });
    addAgent(w, b.run, "reviewer", true, "opus");
    expect(holderIds()).toEqual({ worker: ["DIPO-1"], reviewer: ["DIPO-2"] });
    // A worker and a reviewer of two stories hold two slots.
    expect(taken(pickup, 2)).toContain("running: DIPO-1, DIPO-2");
    expect(taken(pickup, 3)).toBeNull();
  });

  it("counts the slots a new pickup could take: the limit less running, starting and waiting stories (DIPO-440)", () => {
    expect(freeSlots(w.office, { limit: 3 })).toBe(3);
    storyRun(w, { story: "DIPO-1" });
    expect(freeSlots(w.office, { limit: 3 })).toBe(2);
    expect(freeSlots(w.office, { limit: 3, starting: ["DIPO-2"] })).toBe(1);
    const waiting = start("resume", "run_w", 1);
    expect(freeSlots(w.office, { limit: 3, starting: ["DIPO-2"], waiting: [waiting] })).toBe(0);
    expect(freeSlots(w.office, { limit: 1, starting: ["DIPO-2"] })).toBe(0);
  });
});

/** A start of `kind` for the run id `run`, waiting since `since`. */
function start(kind: PlaceStart["kind"], run: string, since: number): PlaceStart {
  return { kind, runId: run as RunId, since };
}

describe("start order (0002)", () => {
  it("starts maintainer resumes, then conflict hand-offs and fix rounds, then pickups", () => {
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
    write(() => reopen(w.office, findRun(w.office, c.run)!, now(), { kind: "fix" }));
    expect(holderIds().worker).toEqual([]);
    expect(taken(pickup, 1)).toBe(
      "the office runs at most 1 story at once (caps.parallelRuns in .dipo/office.yaml); waiting first: DIPO-3",
    );
    expect(taken({ kind: START_KINDS.resume, runId: null, since: now() }, 1)).toBeNull();
    // With a second slot the pickup goes too: a waiting start counts against the same limit.
    expect(taken(pickup, 2)).toBeNull();
  });
});

describe("a resume that finds its place taken (0020)", () => {
  const DETAIL = "the worker host was lost";
  const sessions: HeldSession[] = [];
  const lifting: UnparkWriter = {
    lift: async () => ({ commit: null, pushed: true, pushError: null }),
  };

  /** Story DIPO-5 parked `worker-failed`; returns its run. */
  function parked(): { s: StoryRun } {
    const s = storyRun(w, { story: "DIPO-5" });
    addAgent(w, s.run, "developer", false);
    const at = now();
    write(() => {
      insertPark(w.office, {
        parkId: 1,
        key: s.key,
        story: "DIPO-5",
        runId: s.run,
        reason: "worker-failed",
        detail: DETAIL,
        at,
      });
      endRun(w.office, s.run, at, "parked");
    });
    return { s };
  }

  it("is accepted and waits, then starts first when a slot frees", async () => {
    sessions.length = 0;
    // DIPO-4's developer holds the office's one slot.
    const busy = storyRun(w, { story: "DIPO-4" });
    const developer = addAgent(w, busy.run, "developer", true);
    const { s } = parked();
    // A fix round of DIPO-6 waits for the worker place too, from before the resume.
    const fix = inReview("DIPO-6");
    write(() => reopen(w.office, findRun(w.office, fix.run)!, now(), { kind: "fix" }));
    w.t.clock.advance(MINUTE);

    let places: Places | null = null;
    const started: string[] = [];
    const { resumption } = createRunOutcomes(
      {
        stories: backlogLayout,
        clock: w.t.clock,
        offices: { get: () => w.office },
        steering: { send: async () => ({ ok: true }) },
        encode,
        worker: { id: "claude-cli", result: () => ({}) as never },
        ender: () => ({ isTracked: () => false }) as unknown as RunEnder,
        resumer: {
          next: async (request) => {
            sessions.push(withHeld(w.office, request, w.t.clock.now()));
            started.push(request.run.story ?? "");
            return { kind: "started", agent: "agt_next" as never };
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
      limit: () => 1,
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
    write(() => stopAtInReview(w.office, busy.run, now()));
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
    write(() => stopAtInReview(w.office, s.run, now()));
    expect(await places.drain(officeId())).toBe(1);
    expect(started).toEqual(["DIPO-5", "DIPO-6"]);
    places.close();
  });
});

describe("the office's starts paused keeps every waiting session waiting (0020)", () => {
  it("starts no waiting session while paused, never parks it, and starts it once the pause lifted", async () => {
    const fix = inReview("DIPO-8");
    write(() => reopen(w.office, findRun(w.office, fix.run)!, now(), { kind: "fix" }));
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

function world(limit?: number) {
  const started: string[] = [];
  const control = new RunControl({
    stories: backlogLayout,
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
    ...(limit === undefined ? {} : { limit: () => limit }),
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
      expect(findRun(w.office, fix.run)).toMatchObject({ ending: "parked" });
      expect(findRun(w.office, conflict.run)).toMatchObject({ ending: "parked" });
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

describe("the drain fills the office's free slots (0002)", () => {
  it("starts waiting rounds in start order while a slot is free and the rest when one frees", async () => {
    const busy = storyRun(w, { story: "DIPO-1" });
    const developer = addAgent(w, busy.run, "developer", true);
    waitingAs("DIPO-2", "fix", 1);
    w.t.clock.advance(1);
    waitingAs("DIPO-3", "conflict", 1);
    w.t.clock.advance(1);
    waitingAs("DIPO-4", "fix", 1);
    const x = world(3);
    try {
      expect(await x.places.drain(officeId())).toBe(2);
      expect(x.started).toEqual(["fix DIPO-2", "conflict DIPO-3"]);
      // DIPO-4 still waits, and goes before any pickup.
      expect(x.places.slotTaken(officeId(), pickup)).toBe(
        "the office runs at most 3 stories at once (caps.parallelRuns in .dipo/office.yaml); running: DIPO-1, DIPO-2, DIPO-3; waiting first: DIPO-4",
      );
      expect(await x.places.drain(officeId())).toBe(0);
      endAgent(w, developer);
      write(() => stopAtInReview(w.office, busy.run, now()));
      expect(x.places.slotTaken(officeId(), pickup)).toContain("waiting first: DIPO-4");
      expect(await x.places.drain(officeId())).toBe(1);
      expect(x.started).toEqual(["fix DIPO-2", "conflict DIPO-3", "fix DIPO-4"]);
    } finally {
      x.close();
    }
  });

  it("counts a pickup that is starting against the limit until its release", async () => {
    const x = world(1);
    try {
      const release = x.places.reservePickup(officeId(), "run_x" as RunId, "DIPO-9");
      expect(x.places.pickupsStarting(officeId())).toEqual(["DIPO-9"]);
      expect(x.places.slotTaken(officeId(), pickup)).toContain("running: DIPO-9");
      release();
      expect(x.places.slotTaken(officeId(), pickup)).toBeNull();
      await x.places.idle();
    } finally {
      x.close();
    }
  });
});
