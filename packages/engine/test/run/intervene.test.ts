// `work.steer`, `work.pause` and the resume of a paused run (DIPO-163; 0020 section 9, 0008 section
// 6): run control and the resumption on a migrated state database with one claimed story run, a
// steering fake that records the host ops, a fake next session and the real places. The commands
// run through the executor, as a client sends them.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  type CommandReply,
  type OfficeId,
  RequestId,
  type RunId,
  StoryId,
  type WorkRef,
} from "@dipsaus-orchestrator/contract";

import { executeCommand } from "../../src/commands/execute";
import { stateOfficeDirectory } from "../../src/commands/offices";
import { buildRegistry } from "../../src/commands/registry";
import { MemoryRequestTable } from "../../src/commands/requests";
import {
  CAP_TICK_MS,
  createRunOutcomes,
  endRun,
  findRun,
  insertRun,
  RunControl,
  runIntents,
  type Resumption,
  type RunOutcomes,
  type RunEnder,
} from "../../src/run";
import { runTotals } from "../../src/run/caps";
import { PAUSE_CLOSE_MS, openPause, pausedMs } from "../../src/run/pauses";
import { placeHolders, Places } from "../../src/run/places";
import type { NextSessionRequest } from "../../src/run/resume";
import { addStory } from "../../src/stories/keys";
import { workView } from "../../src/views/work";
import { encode } from "../../src/workers/claude-cli/encode";
import type { Caps, HostOp, WorkerEvent } from "../../src/workers/types";
import { insertClaim } from "../../src/worktree/records";
import { ingestFixture, type IngestFixture, loggedEvents } from "../ingest/helpers";
import { SCRIPTS } from "../workers/scripts";

const CAPS: Caps = { budgetTokens: 1_000_000, maxTurns: 100, maxMinutes: 30 };

interface World {
  readonly dir: string;
  readonly f: IngestFixture;
  readonly control: RunControl;
  readonly resumption: Resumption;
  readonly outcomes: RunOutcomes;
  readonly places: Places;
  readonly work: WorkRef;
  readonly sent: HostOp[][];
  readonly sessions: NextSessionRequest[];
  /** The state of the newest intent when ops went out. */
  readonly stateAtSend: (string | undefined)[];
  finisher: { text: string; gate: Promise<void>; entered: () => void } | null;
}

let w: World;
let requests = 0;

beforeEach(async () => {
  const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "intervene-"));
  const f = await ingestFixture(dir);
  const sent: HostOp[][] = [];
  const stateAtSend: (string | undefined)[] = [];
  const sessions: NextSessionRequest[] = [];
  const world = { dir, f, sent, sessions, stateAtSend, finisher: null } as unknown as World;
  const steering = {
    send: async (_office: unknown, runId: string, ops: readonly HostOp[]) => {
      sent.push([...ops]);
      stateAtSend.push(runIntents(f.office, runId as RunId).at(-1)?.state);
      return { ok: true } as const;
    },
  };
  const control = new RunControl({
    clock: f.t.clock,
    offices: { get: () => f.office },
    writer: { write: async () => Promise.reject(new Error("no park expected")) },
    steering,
    encode,
    finisher: {
      afterTurn: async () => {
        const held = world.finisher;
        if (held === null) return { kind: "continue" };
        held.entered();
        await held.gate;
        return { kind: "feedback", text: held.text };
      },
      summarize: async () => undefined,
    },
  });
  const ender = { isTracked: () => false } as unknown as RunEnder;
  const places = new Places({
    clock: f.t.clock,
    offices: { get: () => f.office, config: () => undefined },
    starters: {},
  });
  const { outcomes, resumption } = createRunOutcomes(
    {
      clock: f.t.clock,
      offices: { get: () => f.office },
      steering,
      encode,
      worker: { id: "claude-cli", result: () => ({ outcome: "done", resumable: true }) as never },
      ender: () => ender,
      resumer: {
        next: async (request) => {
          sessions.push(request);
          return { kind: "started", agent: "agt_x" as never, resumed: true };
        },
      },
      caps: () => CAPS,
    },
    { places: () => places },
  );
  Object.assign(world, { control, resumption, places, outcomes });
  w = world;
  const { office, run } = f;
  const { key } = office.immediate(() =>
    addStory(office, f.t.ids, { story: StoryId.parse("DIPO-1") }, f.t.clock.now()),
  );
  (world as { work: WorkRef }).work = { ...f.work, key };
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
      `insert into agents (office_id, agent_id, run_id, role, model, session_id, started_at)
       values ($office_id, $agent, $run, 'developer', 'haiku', 'session-1', $at)`,
      { agent: f.agent, run, at: f.t.clock.now() },
    );
  });
});

afterEach(() => {
  w.control.close();
  w.places.close();
  w.f.t.state.close();
  rmSync(w.dir, { recursive: true, force: true });
});

function track(): void {
  w.control.track(w.f.office.officeId, {
    runId: w.f.run,
    work: w.work,
    caps: CAPS,
    startedAt: w.f.t.clock.now(),
  });
}

function command(name: string, args: object, id?: string): Promise<CommandReply> {
  requests += 1;
  return executeCommand(
    {
      registry: buildRegistry([w.control.feature, w.resumption.feature]),
      offices: stateOfficeDirectory(w.f.t.state),
      clock: w.f.t.clock,
      ids: w.f.t.ids,
      softwareRequests: new MemoryRequestTable(w.f.t.clock),
    },
    {
      requestId: RequestId.parse(
        id ?? `01J9ZK5Q8W3V4X6Y7Z${(70_000 + requests).toString().padStart(8, "0")}`,
      ),
      name,
      args,
      origin: "cli",
      confirmed: true,
      office: w.f.office.officeId as OfficeId,
    },
  );
}

function ok(reply: CommandReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
  return reply.result as Record<string, unknown>;
}

function failure(reply: CommandReply): string {
  if (reply.ok) throw new Error("expected an error");
  return reply.error.code;
}

const steer = (text: string, id?: string) => command("work.steer", { story: "DIPO-1", text }, id);
const pause = () => command("work.pause", { story: "DIPO-1" });
const resume = (note?: string) =>
  command("work.resume", { story: "DIPO-1", ...(note === undefined ? {} : { note }) });

/** The live developer session exits (the 10 minutes closed its stdin). */
function exitWorker(): void {
  w.f.office.immediate(() =>
    w.f.office.run(
      `update agents set ended_at = $at, end_reason = 'exited'
        where office_id = $office_id and agent_id = $agent`,
      { agent: w.f.agent, at: w.f.t.clock.now() },
    ),
  );
}

function steers(): { state: string; detail: string }[] {
  return runIntents(w.f.office, w.f.run)
    .filter((intent) => intent.kind === "steer")
    .map((intent) => ({ state: intent.state, detail: intent.detail }));
}

/** Parks the story at the current time and ends its run. */
function park(): void {
  const { office, run, t } = w.f;
  const at = t.clock.now();
  office.immediate(() => {
    office.run(
      `insert into parks (office_id, park_id, key, story_id, run_id, reason, from_state, detail, at)
       values ($office_id, 1, $key, 'DIPO-1', $run, 'ambiguous-spec', 'In Progress', 'x', $at)`,
      { key: w.work.key, run, at },
    );
    endRun(office, run, at, "blocked");
  });
}

describe("registration", () => {
  it("registers work.steer and work.pause with since 1, on the waiting command path", () => {
    const registry = buildRegistry([w.control.feature]);
    const found = registry
      .commandDefinitions()
      .filter((definition) => ["work.steer", "work.pause"].includes(definition.name));
    expect(found.map((definition) => [definition.name, definition.since])).toEqual(
      expect.arrayContaining([
        ["work.steer", 1],
        ["work.pause", 1],
      ]),
    );
    expect(found).toHaveLength(2);
  });
});

describe("work.steer", () => {
  it("stores the steer first and sends one next-priority message wrapped in the steer template", async () => {
    const result = ok(await steer("Use the existing helper."));
    expect(result).toEqual({ run: w.f.run, delivered: "next-turn" });
    expect(w.stateAtSend).toEqual(["pending"]);
    expect(w.sent).toEqual([
      encode({ kind: "steer", text: "The maintainer says: Use the existing helper." }),
    ]);
    const [op] = w.sent[0] ?? [];
    expect(JSON.parse((op as { write: string }).write)).toMatchObject({ priority: "next" });
    expect(steers().map((s) => s.state)).toEqual(["sent"]);
  });

  it("does not send a steer twice when a retry after a crash runs the handler again", async () => {
    const id = "01J9ZK5Q8W3V4X6Y7Z00000002";
    expect(ok(await steer("Use the helper.", id))).toEqual({
      run: w.f.run,
      delivered: "next-turn",
    });
    expect(ok(await steer("Use the helper.", id))).toEqual({
      run: w.f.run,
      delivered: "next-turn",
    });
    expect(w.sent).toHaveLength(1);
    expect(steers()).toHaveLength(1);
  });

  it("stores a steer to a paused story once, keyed by its request, and answers on-resume", async () => {
    track();
    ok(await pause());
    w.sent.length = 0;
    const id = "01J9ZK5Q8W3V4X6Y7Z00000001";
    expect(ok(await steer("Try the other approach.", id))).toEqual({
      run: w.f.run,
      delivered: "on-resume",
    });
    expect(ok(await steer("Try the other approach.", id))).toEqual({
      run: w.f.run,
      delivered: "on-resume",
    });
    expect(w.sent).toEqual([]);
    expect(steers()).toEqual([
      { state: "pending", detail: `maintainer-steer ${id} Try the other approach.` },
    ]);
  });

  it("stores a steer to a parked story and sends it with the first message on resume", async () => {
    park();
    expect(ok(await steer("Mind the edge case."))).toEqual({
      run: w.f.run,
      delivered: "on-resume",
    });
    expect(w.sent).toEqual([]);
    expect(steers().map((s) => s.state)).toEqual(["pending"]);
    // The next session of the run carries it as its first message, once.
    w.f.office.immediate(() =>
      w.f.office.run("update runs set ended_at = null where office_id = $office_id"),
    );
    exitWorker();
    const started = await startSession();
    expect(started).toBe(true);
    expect(w.sessions[0]?.message).toContain("The maintainer says: Mind the edge case.");
    expect(steers().map((s) => s.state)).toEqual(["resolved"]);
  });

  it("keeps a held steer out of a reviewer session's first message (0002)", async () => {
    park();
    expect(ok(await steer("Mind the edge case.")).delivered).toBe("on-resume");
    w.f.office.immediate(() =>
      w.f.office.run("update runs set ended_at = null where office_id = $office_id"),
    );
    exitWorker();
    w.f.office.immediate(() =>
      w.f.office.run("update agents set role = 'reviewer' where office_id = $office_id"),
    );
    w.f.office.immediate(() =>
      w.f.office.run("update runs set role = 'reviewer' where office_id = $office_id"),
    );
    await startSession();
    expect(w.sessions[0]?.message ?? "").not.toContain("Mind the edge case.");
    expect(steers().map((s) => s.state)).toEqual(["pending"]);
  });

  it("answers story.notRunning for a story with neither a run nor a park", async () => {
    w.f.office.immediate(() =>
      w.f.office.run(
        "update runs set ended_at = 1, end_kind = 'done' where office_id = $office_id",
      ),
    );
    expect(failure(await steer("hello"))).toBe("story.notRunning");
  });

  it("answers story.notSteerable when the live session is its reviewer", async () => {
    w.f.office.immediate(() =>
      w.f.office.run("update agents set role = 'reviewer' where office_id = $office_id"),
    );
    expect(failure(await steer("hello"))).toBe("story.notSteerable");
    expect(w.sent).toEqual([]);
    expect(steers()).toEqual([]);
  });

  it("answers story.notSteerable for a follow-only host", async () => {
    w.f.office.immediate(() =>
      w.f.office.run(
        "update worker_hosts set mode = 'follow' where office_id = $office_id and run_id = $run",
        { run: w.f.run },
      ),
    );
    expect(failure(await steer("hello"))).toBe("story.notSteerable");
    expect(failure(await pause())).toBe("story.notSteerable");
    expect(w.sent).toEqual([]);
  });
});

/** Starts the next session of the run through the outcomes' session starts (a crash resume). */
async function startSession(): Promise<boolean> {
  const run = findRun(w.f.office, w.f.run);
  if (run === null) throw new Error("no run");
  return await w.outcomes.parts.sessions.next(
    w.f.office,
    run,
    {
      office: w.f.office.officeId as OfficeId,
      runId: w.f.run,
      work: w.work,
      caps: CAPS,
      startedAt: w.f.t.clock.now(),
      snapshot: null,
    },
    { mode: "resume", why: "a test resume" },
  );
}

describe("work.pause", () => {
  it("stores a pause intent, sends a now-priority message and keeps the run, claim and place", async () => {
    track();
    expect(ok(await pause())).toEqual({ run: w.f.run });
    expect(w.stateAtSend).toEqual(["pending"]);
    const [op] = w.sent[0] ?? [];
    expect(JSON.parse((op as { write: string }).write)).toMatchObject({ priority: "now" });
    expect(w.sent).toEqual([encode({ kind: "pause" })]);
    expect(openPause(w.f.office, w.f.run)).not.toBeNull();
    // Still In Progress: the run is open, its claim live, its place held, its health paused.
    expect(findRun(w.f.office, w.f.run)?.endedAt).toBeNull();
    expect(
      w.f.office.get<{ released_at: number | null }>(
        "select released_at from claims where office_id = $office_id",
      )?.released_at,
    ).toBeNull();
    expect(placeHolders(w.f.office).worker.map((run) => run.runId)).toEqual([w.f.run]);
    expect(workView(w.f.office, w.f.run)?.health).toBe("paused");
    const progress = loggedEvents(w.f.office).filter((event) => event.type === "work.progress");
    expect(progress).toHaveLength(1);
  });

  it("answers again with its run when the story is paused already", async () => {
    track();
    ok(await pause());
    w.sent.length = 0;
    expect(ok(await pause())).toEqual({ run: w.f.run });
    expect(w.sent).toEqual([]);
  });

  it("answers story.notSteerable for a reviewer session", async () => {
    w.f.office.immediate(() =>
      w.f.office.run("update agents set role = 'reviewer' where office_id = $office_id"),
    );
    expect(failure(await pause())).toBe("story.notSteerable");
  });

  it("closes stdin after 10 minutes, and the exited worker frees the place but not the claim", async () => {
    track();
    ok(await pause());
    w.sent.length = 0;
    // The story's 10 minutes (0020 section 9).
    expect(PAUSE_CLOSE_MS).toBe(10 * 60_000);
    const minutes = PAUSE_CLOSE_MS / CAP_TICK_MS;
    for (let minute = 1; minute < minutes; minute++) w.f.t.clock.advance(CAP_TICK_MS);
    expect(w.sent).toEqual([]);
    w.f.t.clock.advance(CAP_TICK_MS);
    expect(w.sent).toEqual([[{ closeStdin: true }]]);
    // More ticks send it no more.
    w.f.t.clock.advance(CAP_TICK_MS * 3);
    expect(w.sent).toEqual([[{ closeStdin: true }]]);

    exitWorker();
    expect(placeHolders(w.f.office).worker).toEqual([]);
    expect(findRun(w.f.office, w.f.run)?.endedAt).toBeNull();
    expect(
      w.f.office.get(
        "select 1 as c from claims where office_id = $office_id and released_at is null",
      ),
    ).not.toBeNull();
    // Paused, not lost, though its worker is gone.
    expect(workView(w.f.office, w.f.run)?.health).toBe("paused");
    // The exit explains itself by the pause: the run stays paused.
    expect(openPause(w.f.office, w.f.run)).not.toBeNull();
  });

  it("leaves the paused time out of the minute cap", async () => {
    track();
    const start = w.f.t.clock.now();
    w.f.t.clock.advance(5 * 60_000);
    ok(await pause());
    w.f.t.clock.advance(20 * 60_000);
    const now = w.f.t.clock.now();
    expect(pausedMs(w.f.office, w.f.run, now)).toBe(20 * 60_000);
    expect(runTotals(w.f.office, w.f.run, start, now).elapsedMs).toBe(5 * 60_000);
    // Resuming ends the pause; the time that followed counts again.
    exitWorker();
    ok(await resume());
    w.f.t.clock.advance(2 * 60_000);
    const later = w.f.t.clock.now();
    expect(runTotals(w.f.office, w.f.run, start, later).elapsedMs).toBe(7 * 60_000);
  });

  it("holds a verify feedback that arrives after the pause until the first message after resume", async () => {
    track();
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    const { promise: entered, resolve: enter } = Promise.withResolvers<void>();
    w.finisher = { text: "verify failed: lint", gate, entered: enter };
    w.control.onWorkerEvents(w.f.run, [SCRIPTS["done"]?.at(-1) as WorkerEvent]);
    await entered;
    // The pause arrives while the engine runs verify.
    ok(await pause());
    w.sent.length = 0;
    open();
    await w.control.idle();
    // No message reached the paused worker: the next worker turn waits for the resume.
    expect(w.sent).toEqual([]);
    expect(steers()).toEqual([{ state: "pending", detail: "held-feedback verify failed: lint" }]);

    ok(await resume());
    expect(w.sent).toHaveLength(1);
    const [op] = w.sent[0] ?? [];
    const text = (JSON.parse((op as { write: string }).write) as { message: unknown }).message;
    expect(JSON.stringify(text)).toContain("continue");
    expect(JSON.stringify(text)).toContain("verify failed: lint");
    // The held item is carried by the resume message (the second steer row).
    expect(steers().map((s) => s.state)).toEqual(["resolved", "sent"]);
  });
});

describe("work.resume of a paused run", () => {
  it("continues a worker that still lives with one message, steers included", async () => {
    track();
    ok(await pause());
    ok(await steer("Prefer small commits."));
    w.sent.length = 0;
    const result = ok(await resume());
    expect(result).toMatchObject({ to: "In Progress", run: w.f.run });
    expect(openPause(w.f.office, w.f.run)).toBeNull();
    expect(w.sent).toHaveLength(1);
    expect(JSON.stringify(w.sent[0])).toContain("The maintainer says: Prefer small commits.");
    expect(w.sessions).toEqual([]);
    expect(workView(w.f.office, w.f.run)?.health).not.toBe("paused");
  });

  it("starts the next session with the native session once the worker exited, with the waiting steer", async () => {
    track();
    ok(await pause());
    ok(await steer("Prefer small commits."));
    exitWorker();
    const result = ok(await resume("Carry on."));
    expect(result).toMatchObject({ to: "In Progress", run: w.f.run });
    expect(result["queued"]).toBeUndefined();
    expect(w.sessions).toHaveLength(1);
    expect(w.sessions[0]?.mode).toBe("resume");
    expect(w.sessions[0]?.message).toContain("The maintainer says: Prefer small commits.");
    expect(w.sessions[0]?.message).toContain("The maintainer says: Carry on.");
    expect(openPause(w.f.office, w.f.run)).toBeNull();
  });

  it("queues the resume when the worker place is taken, and starts it once the place frees", async () => {
    track();
    w.f.t.clock.advance(1_000);
    ok(await pause());
    exitWorker();
    // Another story's run holds the worker place with a live session.
    const other = w.f.t.ids.next("run") as RunId;
    const { office } = w.f;
    const key = office.immediate(
      () => addStory(office, w.f.t.ids, { story: StoryId.parse("DIPO-2") }, w.f.t.clock.now()).key,
    );
    office.immediate(() => {
      insertRun(office, {
        runId: other,
        kind: "story",
        key,
        story: "DIPO-2",
        tier: "M",
        role: "developer",
        model: "haiku",
        startSha: "b".repeat(40),
        branch: "DIPO-2/x",
        worktree: join(w.dir, "trees", "DIPO-2"),
        slot: 2,
        budgetUnit: "tokens",
        budgetLimit: CAPS.budgetTokens,
        loopCap: 3,
        reviewRoundCap: null,
        configHash: "h",
        overrideKeys: null,
        runProfileId: null,
        startedAt: w.f.t.clock.now(),
      });
      insertClaim(office, {
        runId: other,
        key,
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
        claimedAt: w.f.t.clock.now(),
      });
      office.run(
        `insert into agents (office_id, agent_id, run_id, role, model, session_id, started_at)
         values ($office_id, 'agt_other', $run, 'developer', 'haiku', 's2', $at)`,
        { run: other, at: w.f.t.clock.now() },
      );
    });

    const result = ok(await resume());
    expect(result).toMatchObject({ to: "In Progress", queued: true });
    expect(w.sessions).toEqual([]);
    expect(findRun(office, w.f.run)?.waiting).toBe("resume");
    expect(openPause(office, w.f.run)).toBeNull();

    // The other session ends: the place frees and the places start the queued resume.
    office.immediate(() => {
      office.run(
        "update agents set ended_at = $at where office_id = $office_id and agent_id = 'agt_other'",
        {
          at: w.f.t.clock.now(),
        },
      );
      endRun(office, other, w.f.t.clock.now(), "in-review");
    });
    const starting = new Places({
      clock: w.f.t.clock,
      offices: { get: () => office, config: () => undefined },
      starters: { resume: (officeId, run) => w.resumption.startQueued(officeId, run) },
    });
    try {
      expect(await starting.drain(office.officeId as OfficeId)).toBe(1);
    } finally {
      starting.close();
    }
    expect(w.sessions).toHaveLength(1);
    expect(w.sessions[0]?.mode).toBe("resume");
    expect(findRun(office, w.f.run)?.waiting).toBeNull();
  });

  it("answers story.notPausedOrParked for a story that is not paused", async () => {
    expect(failure(await resume())).toBe("story.notPausedOrParked");
  });
});
