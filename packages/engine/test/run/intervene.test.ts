// `work.steer` (DIPO-163; 0020, 0008): run control and the resumption on a migrated state database
// with one claimed story run, a steering fake that records the host ops, a fake next session and
// the real places. The commands run through the executor, as a client sends them.

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

import { insertPark } from "./park-fixture";
import { executeCommand } from "../../src/commands/execute";
import { CRASH, crashAfterHandler } from "../commands/crash";
import { stateOfficeDirectory } from "../../src/commands/offices";
import { buildRegistry } from "../../src/commands/registry";
import { MemoryRequestTable } from "../../src/commands/requests";
import {
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
import { Places } from "../../src/run/places";
import { reopen, type RoundKind } from "../../src/run/rounds";
import { addStory } from "../../src/stories/keys";
import { encode } from "../../src/workers/claude-cli/encode";
import type { Caps, HostOp } from "../../src/workers/types";
import { insertClaim } from "../../src/worktree/records";
import { ingestFixture, type IngestFixture } from "../ingest/helpers";
import { type HeldSession, withHeld } from "./held-session";

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
  readonly sessions: HeldSession[];
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
  const sessions: HeldSession[] = [];
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
        return { kind: "feedback", source: "report-gate", text: held.text };
      },
      summarize: async () => undefined,
    },
  });
  const ender = { isTracked: () => false } as unknown as RunEnder;
  const places = new Places({
    clock: f.t.clock,
    offices: { get: () => f.office },
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
          sessions.push(withHeld(f.office, request, f.t.clock.now()));
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
      base: "main",
      baseSha: "b".repeat(40),
      startSha: "b".repeat(40),
      claimSha: "d".repeat(40),
      reused: false,
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

function command(name: string, args: object, id?: string, crash = false): Promise<CommandReply> {
  requests += 1;
  const deps = {
    registry: buildRegistry([w.control.feature, w.resumption.feature]),
    offices: stateOfficeDirectory(w.f.t.state),
    clock: w.f.t.clock,
    ids: w.f.t.ids,
    softwareRequests: new MemoryRequestTable(w.f.t.clock),
  };
  return executeCommand(
    // A crash after the handler's commits and before the requests row (DIPO-168 in DIPO-155).
    crash ? crashAfterHandler(deps, name) : deps,
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

const steer = (text: string, id?: string, crash = false) =>
  command("work.steer", { story: "DIPO-1", text }, id, crash);
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

/** Parks the story at the current time and ends its run with `endKind`. */
function park(endKind = "blocked"): void {
  const { office, run, t } = w.f;
  const at = t.clock.now();
  office.immediate(() => {
    insertPark(office, {
      parkId: 1,
      key: w.work.key,
      story: "DIPO-1",
      runId: run,
      reason: "ambiguous-spec",
      detail: "x",
      at,
    });
    endRun(office, run, at, endKind);
  });
}

/** Reopens the ended run for a round, as the review or the fix round does (`reopen`). */
function reopenFor(kind: RoundKind): void {
  const { office, run, t } = w.f;
  const stored = findRun(office, run);
  if (stored === null) throw new Error("no run");
  office.immediate(() => reopen(office, stored, t.clock.now(), { kind }));
}

describe("registration", () => {
  it("registers work.steer with since 1, on the waiting command path, and no pause", () => {
    const registry = buildRegistry([w.control.feature]);
    const names = registry.commandDefinitions().map((definition) => definition.name);
    expect(names).toContain("work.steer");
    expect(names).not.toContain("work.pause");
    expect(names).not.toContain("work.stop");
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

  it("sends no second message when a crash before the requests row makes the retry run the handler again", async () => {
    const id = "01J9ZK5Q8W3V4X6Y7Z00000003";
    const crashed = await steer("Use the helper.", id, true);
    expect(crashed.ok ? null : crashed.error.message).toContain(CRASH);
    expect(w.sent).toHaveLength(1);
    expect(ok(await steer("Use the helper.", id))).toEqual({
      run: w.f.run,
      delivered: "next-turn",
    });
    expect(w.sent).toHaveLength(1);
    expect(steers()).toHaveLength(1);
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

  it("sends a held steer with a developer session whose run last ran a review (a CI park while In Review, DIPO-362)", async () => {
    park("in-review");
    expect(ok(await steer("Mind the edge case.")).delivered).toBe("on-resume");
    // The run's last phase is the review; a reviewer is launched apart and reads no held message
    // (0002), so the next session the resumer starts is the developer's, which gets it.
    reopenFor("review");
    exitWorker();
    expect(await startSession()).toBe(true);
    expect(w.sessions).toHaveLength(1);
    expect(w.sessions[0]?.message).toContain("The maintainer says: Mind the edge case.");
    expect(steers().map((s) => s.state)).toEqual(["resolved"]);
  });

  it("sends a held steer with the developer session's first message (reopened for a fix round)", async () => {
    park("in-review");
    expect(ok(await steer("Mind the edge case.")).delivered).toBe("on-resume");
    reopenFor("fix");
    exitWorker();
    expect(await startSession()).toBe(true);
    expect(w.sessions[0]?.message).toContain("The maintainer says: Mind the edge case.");
    expect(steers().map((s) => s.state)).toEqual(["resolved"]);
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
    },
    { mode: "resume", why: "a test resume" },
  );
}
