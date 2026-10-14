// Re-attach after a daemon restart (DIPO-57), fast and local: a migrated state database with one
// claimed story run whose worker host is recorded, the real DIPO-45 ingestion of committed Claude
// recordings with run control and worker outcomes as its hooks, and a fake host (liveness probe,
// socket handshake, `exit.json`). A "previous daemon" ingests the first lines of a recording; the
// rest is written while it is down; then a new run control, worker outcomes and re-attach start
// on the same database, as after a restart. The run's next session is stubbed, except in the
// restart-window test of `RunResumer`.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { type OfficeId, StoryId, type WorkRef } from "@dipsaus-orchestrator/contract";
import { readRecording } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config/schema";
import type { HostClient } from "../../src/host/client";
import { EXIT_FILE, type HostExitFile } from "../../src/host/protocol";
import { type IngestAdapter, Ingestor } from "../../src/ingest/ingestor";
import {
  type BranchPark,
  EVENT_FILE_CHANGED,
  FOLLOW_CHECK_MS,
  findRun,
  HOST_LOST_WHY,
  hostSocketSteering,
  insertRun,
  type NextSessionOutcome,
  type NextSessionRequest,
  OfficeIngest,
  RunControl,
  RunOutcomes,
  RunReattacher,
  RunResumer,
  runIntents,
} from "../../src/run";
import { activeSignals } from "../../src/run/signals";
import { recordWorkerHost, workerHostsOf } from "../../src/runs/worker-hosts";
import { addStory } from "../../src/stories/keys";
import { encode } from "../../src/workers/claude-cli/encode";
import {
  type ClaudeParseState,
  initialState,
  interpret,
} from "../../src/workers/claude-cli/interpret";
import { result as claudeResult } from "../../src/workers/claude-cli/result";
import type { WorkerPort } from "../../src/workers/port";
import type { Caps, HostOp, ParseState, WorkerAdapter } from "../../src/workers/types";
import { insertClaim } from "../../src/worktree/records";
import {
  appendLines,
  hostLines,
  type IngestFixture,
  ingestFixture,
  loggedEvents,
  target,
} from "../ingest/helpers";
import { RECORDINGS_DIR } from "../workers/replay";

const claude: IngestAdapter = {
  interpret: (line, state) =>
    interpret(line, state as unknown as ClaudeParseState) as unknown as {
      events: [];
      state: ParseState;
    },
};

const ROOMY: Caps = { budgetTokens: 1_000_000, maxTurns: 100, maxMinutes: 30 };
const START = initialState({ plannedModel: "haiku" }) as unknown as ParseState;

/** One daemon's run control, worker outcomes, ingestion and re-attach on the shared database. */
interface Daemon {
  readonly control: RunControl;
  readonly outcomes: RunOutcomes;
  readonly ingest: OfficeIngest;
  readonly reattacher: RunReattacher;
}

interface World {
  readonly dir: string;
  readonly f: IngestFixture;
  readonly work: WorkRef;
  readonly sent: HostOp[][];
  readonly next: NextSessionRequest[];
  nextOutcome: NextSessionOutcome;
  onNext: ((request: NextSessionRequest) => void) | null;
  /** The next session never returns, as when the daemon stops inside it. */
  hang: boolean;
  /** What the fake host is: alive or not, and whether its socket answers. */
  alive: boolean;
  answers: boolean;
  caps: Caps;
  readonly daemons: Daemon[];
}

let w: World;

const fakeClient = (): HostClient => ({
  version: 1,
  hostPid: 4242,
  request: async () => ({ ok: true }),
  status: async () => null,
  watch: async () => 0,
  closed: new Promise<void>(() => undefined),
  close: () => undefined,
});

/** A daemon (re)started on the shared database. */
function daemon(): Daemon {
  const { f } = w;
  const offices = { get: () => f.office };
  const steering = {
    send: async (_office: unknown, _run: unknown, ops: readonly HostOp[]) => {
      w.sent.push([...ops]);
      return { ok: true as const };
    },
  };
  let outcomes: RunOutcomes | null = null;
  const control = new RunControl({
    clock: f.t.clock,
    offices,
    writer: {
      write: async (): Promise<BranchPark> => ({
        commit: "c".repeat(40),
        lastGoodCommit: "a".repeat(40),
        from: "In Progress",
        pushed: true,
        pushError: null,
      }),
    },
    steering,
    encode,
    outcomes: () => outcomes ?? undefined,
  });
  outcomes = new RunOutcomes({
    clock: f.t.clock,
    offices,
    steering,
    encode,
    worker: {
      id: "claude-cli",
      result: (state, exit) => claudeResult(state as unknown as ClaudeParseState, exit),
    },
    ender: () => control,
    resumer: {
      next: async (request) => {
        w.next.push(request);
        w.onNext?.(request);
        if (w.hang) return new Promise<NextSessionOutcome>(() => undefined);
        return w.nextOutcome;
      },
    },
    caps: () => w.caps,
  });
  const ingest = new OfficeIngest({ clock: f.t.clock, pricing: () => null, hooks: control.hooks });
  const reattacher = new RunReattacher({
    clock: f.t.clock,
    offices,
    probe: async (pid) =>
      w.alive ? { pid, startTimeMs: 0, zombie: false, command: "dipo" } : null,
    connect: async () =>
      w.answers ? { ok: true, client: fakeClient() } : { ok: false, reason: "unreachable" },
    ingest,
    control,
    outcomes,
    adapter: () => claude,
    initialState: () => START,
    caps: () => w.caps,
  });
  const made = { control, outcomes, ingest, reattacher };
  w.daemons.push(made);
  return made;
}

beforeEach(async () => {
  const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "reattach-"));
  const f = await ingestFixture(dir);
  const { office, run } = f;
  const { key } = office.immediate(() =>
    addStory(office, f.t.ids, { story: StoryId.parse("DIPO-1") }, f.t.clock.now()),
  );
  w = {
    dir,
    f,
    work: { ...f.work, key },
    sent: [],
    next: [],
    nextOutcome: { kind: "started", agent: "agt_next" as never, resumed: true },
    onNext: null,
    hang: false,
    alive: true,
    answers: true,
    caps: ROOMY,
    daemons: [],
  };
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
      budgetLimit: ROOMY.budgetTokens,
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
  });
});

afterEach(() => {
  for (const d of w.daemons) {
    d.control.close();
    d.ingest.close();
    d.reattacher.close();
  }
  w.f.t.state.close();
  rmSync(w.dir, { recursive: true, force: true });
});

/**
 * The previous daemon ingested the first `before` lines of `name` (or none); the lines after it
 * up to `upTo` were written while it was down.
 */
function beforeRestart(name: string, before: number, upTo?: number): void {
  const lines = hostLines(readRecording(join(RECORDINGS_DIR, name)));
  appendLines(w.f.eventFile, lines.slice(0, before));
  const ingestor = new Ingestor({ office: w.f.office, clock: w.f.t.clock, pricing: null });
  ingestor.track(target(w.f, claude, START, { budgetLimit: ROOMY.budgetTokens }));
  ingestor.close();
  appendLines(w.f.eventFile, lines.slice(before, upTo ?? lines.length));
}

function writeExitFile(exit: Partial<HostExitFile> = {}): void {
  const record: HostExitFile = {
    run: w.f.run,
    code: 0,
    signal: null,
    finalOffset: statSync(w.f.eventFile).size,
    at: w.f.t.clock.now(),
    ...exit,
  };
  writeFileSync(join(w.dir, EXIT_FILE), `${JSON.stringify(record)}\n`);
}

function parks(): [string, string][] {
  return w.f.office
    .all<{ reason: string; detail: string }>(
      "select reason, detail from parks where office_id = $office_id order by park_id",
    )
    .map((row) => [row.reason, row.detail]);
}

function agentRow(agent: string = w.f.agent) {
  return w.f.office.get<{ end_reason: string | null; ended_at: number | null }>(
    "select end_reason, ended_at from agents where office_id = $office_id and agent_id = $agent",
    { agent },
  );
}

function observed(): string[] {
  return loggedEvents(w.f.office)
    .filter((event) => event.type === "work.observed")
    .map((event) => (event.data as { signal: string }).signal);
}

function signals(): string[] {
  return activeSignals(w.f.office, w.f.run).map((signal) => signal.signal);
}

function hostRow() {
  const host = workerHostsOf(w.f.office, w.f.run).at(-1);
  if (host === undefined) throw new Error("no host row");
  return host;
}

describe("re-attach (0006 decision 8)", () => {
  it("a living host that answers: catches up from the processed offset and follows with steering (AC #1)", async () => {
    beforeRestart("success-single", 6, 20);
    const offset = hostRow().processedOffset;
    expect(offset).toBeGreaterThan(0);
    const d = daemon();
    expect(await d.reattacher.reattach(w.f.office.officeId)).toEqual([
      { run: w.f.run, agent: w.f.agent, outcome: "steer" },
    ]);
    // Caught up to the end of the file, the stored output continuing what was there.
    expect(hostRow().processedOffset).toBe(statSync(w.f.eventFile).size);
    expect(hostRow().mode).toBe("steer");
    // The message written while the daemon was down is counted once.
    expect(
      w.f.office.all("select message_id from usage_messages where office_id = $office_id"),
    ).toEqual([{ message_id: "msg-1" }]);
    expect(d.control.isTracked(w.f.run)).toBe(true);
    expect(w.next).toEqual([]);
    // A second re-attach leaves the followed run alone.
    expect(await d.reattacher.reattach(w.f.office.officeId)).toEqual([]);
  });

  it("a living host whose socket is gone: follow-only, and steering fails with a message (AC #2)", async () => {
    w.answers = false;
    beforeRestart("success-single", 6, 20);
    const d = daemon();
    expect(await d.reattacher.reattach(w.f.office.officeId)).toEqual([
      { run: w.f.run, agent: w.f.agent, outcome: "follow" },
    ]);
    expect(hostRow().mode).toBe("follow");
    expect(signals()).toEqual(["follow-only"]);
    expect(observed()).toEqual(["follow-only"]);
    const notice = loggedEvents(w.f.office).find((event) => event.type === "engine.notice");
    expect((notice?.data as { code: string } | undefined)?.code).toBe("run.followOnly");
    const sent = await hostSocketSteering({ clock: w.f.t.clock }).send(w.f.office, w.f.run, [
      { closeStdin: true },
    ]);
    expect(sent.ok).toBe(false);
    expect(sent.ok ? "" : sent.reason).toContain("follow-only");
    // The tail goes on: the rest of the file, with the exit, ends the agent.
    appendLines(
      w.f.eventFile,
      hostLines(readRecording(join(RECORDINGS_DIR, "success-single"))).slice(20),
    );
    w.f.t.clock.advance(1_000);
    await d.control.idle();
    expect(agentRow()?.end_reason).toBe("exited");
  });

  it("notices a followed host that dies without an exit line, by its liveness on the tick", async () => {
    w.answers = false;
    beforeRestart("success-single", 6, 20);
    const d = daemon();
    await d.reattacher.reattach(w.f.office.officeId);
    // Still alive at the first check: nothing happens.
    w.f.t.clock.advance(FOLLOW_CHECK_MS);
    await Bun.sleep(1);
    expect(observed()).toEqual(["follow-only"]);
    // Killed later, with no exit line: the next check finds it lost.
    w.alive = false;
    w.f.t.clock.advance(FOLLOW_CHECK_MS);
    for (let i = 0; i < 50 && w.next.length === 0; i += 1) await Bun.sleep(1);
    await d.control.idle();
    expect(observed()).toEqual(["follow-only", "host-lost"]);
    expect(agentRow()?.end_reason).toBe("host-lost");
    expect(w.next.map((request) => request.requireResume)).toEqual([true]);
  });

  it("closes out a followed host that outlives its parked run once its process is gone", async () => {
    // Over its caps after the catch-up: the run parks while the follow-only host keeps running.
    w.answers = false;
    w.caps = { ...ROOMY, budgetTokens: 10 };
    beforeRestart("success-single", 6, 20);
    const d = daemon();
    await d.reattacher.reattach(w.f.office.officeId);
    await d.control.idle();
    expect(findRun(w.f.office, w.f.run)?.endedAt).not.toBeNull();
    expect(agentRow()).toEqual({ end_reason: "capped", ended_at: null });
    // Still alive at the first check after the park: nothing is closed yet.
    w.f.t.clock.advance(FOLLOW_CHECK_MS);
    await Bun.sleep(1);
    expect(hostRow().endedAt).toBeNull();
    expect(signals()).toEqual(["follow-only"]);
    // Killed later, with no exit line and no exit file: host, agent and signal end.
    w.alive = false;
    w.f.t.clock.advance(FOLLOW_CHECK_MS);
    for (let i = 0; i < 50 && hostRow().endedAt === null; i += 1) await Bun.sleep(1);
    expect(hostRow().endedAt).not.toBeNull();
    expect(agentRow()?.end_reason).toBe("capped");
    expect(agentRow()?.ended_at).not.toBeNull();
    expect(signals()).toEqual([]);
    expect(observed()).toEqual(["follow-only", "follow-only"]);
    expect(w.next).toEqual([]);
  });

  it("records the exit.json of a followed host whose agent exited, once its process is gone", async () => {
    w.answers = false;
    beforeRestart("success-single", 6, 20);
    const d = daemon();
    await d.reattacher.reattach(w.f.office.officeId);
    // The rest of the recording, with the exit line, ends the agent; the host lingers a moment.
    appendLines(
      w.f.eventFile,
      hostLines(readRecording(join(RECORDINGS_DIR, "success-single"))).slice(20),
    );
    w.f.t.clock.advance(1_000);
    await d.control.idle();
    expect(agentRow()?.end_reason).toBe("exited");
    expect(hostRow().endedAt).toBeNull();
    writeExitFile({ code: 0 });
    w.alive = false;
    w.f.t.clock.advance(FOLLOW_CHECK_MS);
    for (let i = 0; i < 50 && hostRow().endedAt === null; i += 1) await Bun.sleep(1);
    expect(hostRow().exitCode).toBe(0);
    expect(hostRow().endedAt).not.toBeNull();
    expect(signals()).not.toContain("follow-only");
  });

  it("a dead host with exit.json: the remaining events and the exit are processed (AC #3)", async () => {
    w.alive = false;
    beforeRestart("success-single", 6);
    writeExitFile();
    const d = daemon();
    expect(await d.reattacher.reattach(w.f.office.officeId)).toEqual([
      { run: w.f.run, agent: w.f.agent, outcome: "exited" },
    ]);
    await d.control.idle();
    expect(agentRow()?.end_reason).toBe("exited");
    expect(hostRow().exitCode).toBe(0);
    expect(hostRow().endedAt).not.toBeNull();
    expect(d.control.isTracked(w.f.run)).toBe(false);
    expect(w.next).toEqual([]);
  });

  it("an exit.json of an earlier host of the run does not count as this host's", async () => {
    w.alive = false;
    beforeRestart("success-single", 6, 20);
    // The earlier host's file ends where this host's lines start.
    writeExitFile({ finalOffset: 0 });
    const d = daemon();
    expect(await d.reattacher.reattach(w.f.office.officeId)).toEqual([
      { run: w.f.run, agent: w.f.agent, outcome: "hostLost" },
    ]);
  });

  it("a dead host without exit.json: host-lost, usage finalized, then one resume (AC #4, AC #9)", async () => {
    w.alive = false;
    beforeRestart("success-single", 6, 20);
    let finalAtNext: number[] = [];
    w.onNext = () => {
      finalAtNext = w.f.office
        .all<{ final: number }>(
          "select final from usage_totals where office_id = $office_id and agent_id = $agent",
          { agent: w.f.agent },
        )
        .map((row) => row.final);
    };
    const d = daemon();
    expect(await d.reattacher.reattach(w.f.office.officeId)).toEqual([
      { run: w.f.run, agent: w.f.agent, outcome: "hostLost" },
    ]);
    await d.control.idle();
    expect(observed()).toEqual(["host-lost"]);
    expect(agentRow()?.end_reason).toBe("host-lost");
    expect(w.next).toHaveLength(1);
    expect(w.next[0]?.mode).toBe("resume");
    expect(w.next[0]?.requireResume).toBe(true);
    expect(w.next[0]?.why).toBe(HOST_LOST_WHY);
    // The dead agent's usage was final before the resumed session started.
    expect(finalAtNext.length).toBeGreaterThan(0);
    expect(finalAtNext.every((final) => final === 1)).toBe(true);
    expect(countDaily()).toBeGreaterThan(0);
    expect(findRun(w.f.office, w.f.run)?.endedAt).toBeNull();
  });

  it("a dead host's leftover output is stored and sent as work.output, once (host-lost)", async () => {
    w.alive = false;
    beforeRestart("interrupt", 18, 28);
    const d = daemon();
    await d.reattacher.reattach(w.f.office.officeId);
    await d.control.idle();
    w.f.t.clock.advance(1_000);
    expectOutputSentOnce();
  });

  it("a steered host's output is sent as work.output contiguously, without duplicates", async () => {
    beforeRestart("interrupt", 18, 28);
    const d = daemon();
    await d.reattacher.reattach(w.f.office.officeId);
    w.f.t.clock.advance(1_000);
    await d.control.idle();
    expectOutputSentOnce();
  });

  it("a dead host whose session cannot be resumed parks interrupted (AC #4)", async () => {
    w.alive = false;
    w.nextOutcome = { kind: "notResumed", reason: "the transcript is gone" };
    beforeRestart("success-single", 6, 20);
    const d = daemon();
    await d.reattacher.reattach(w.f.office.officeId);
    await d.control.idle();
    expect(parks()).toEqual([
      ["interrupted", `${HOST_LOST_WHY}; its session cannot be resumed: the transcript is gone`],
    ]);
    expect(findRun(w.f.office, w.f.run)?.endKind).toBe("interrupted");
  });

  it("a dead host after the run's one resume parks interrupted without another (AC #4)", async () => {
    w.alive = false;
    w.f.office.immediate(() =>
      w.f.office.run(
        `insert into agents (office_id, agent_id, run_id, role, model, started_at, ended_at,
           end_reason)
         values ($office_id, 'agt_earlier', $run, 'developer', 'haiku', 0, 0, 'crashed')`,
        { run: w.f.run },
      ),
    );
    beforeRestart("success-single", 6, 20);
    const d = daemon();
    await d.reattacher.reattach(w.f.office.officeId);
    await d.control.idle();
    expect(w.next).toEqual([]);
    expect(parks()[0]?.[0]).toBe("interrupted");
    expect(parks()[0]?.[1]).toContain("one resume after a crash was used");
  });

  it("a restart while a lost host is decided decides it again (AC #4)", async () => {
    w.alive = false;
    beforeRestart("success-single", 6, 20);
    // The previous daemon recorded the loss but stopped before the resume started.
    w.f.office.immediate(() =>
      w.f.office.run(
        `update agents set ended_at = 1, end_reason = 'host-lost'
          where office_id = $office_id and agent_id = $agent`,
        { agent: w.f.agent },
      ),
    );
    const d = daemon();
    expect(await d.reattacher.reattach(w.f.office.officeId)).toEqual([]);
    expect(await d.outcomes.redispatch(w.f.office.officeId)).toBe(1);
    expect(w.next.map((request) => request.requireResume)).toEqual([true]);
  });

  it("never starts a session next to a living host, and checks the caps after the catch-up (AC #5, AC #6)", async () => {
    w.caps = { ...ROOMY, budgetTokens: 10 };
    beforeRestart("success-single", 6, 20);
    const d = daemon();
    await d.reattacher.reattach(w.f.office.officeId);
    await d.control.idle();
    expect(w.next).toEqual([]);
    // Over its caps after the catch-up: the stop sequence went to the host and the story parked.
    expect(w.sent).toEqual([encode({ kind: "stop" })]);
    expect(parks()[0]?.[0]).toBe("budget-exceeded");
  });

  it("an event file that changed while the daemon was down parks the run interrupted (AC #7)", async () => {
    beforeRestart("success-single", 10, 10);
    truncateSync(w.f.eventFile, 10);
    const d = daemon();
    expect(await d.reattacher.reattach(w.f.office.officeId)).toEqual([
      { run: w.f.run, agent: w.f.agent, outcome: "fileChanged" },
    ]);
    await d.control.idle();
    expect(parks()).toEqual([["interrupted", EVENT_FILE_CHANGED]]);
    expect(w.sent).toEqual([encode({ kind: "stop" })]);
  });

  it("an ingest.fileChanged report a previous daemon left parks the run interrupted (AC #7)", async () => {
    beforeRestart("success-single", 10, 10);
    w.f.office.immediate(() =>
      w.f.office.run(
        `update ingest_cursors set changed_at = 1, changed_detail = 'event file replaced'
          where office_id = $office_id and run_id = $run`,
        { run: w.f.run },
      ),
    );
    const d = daemon();
    await d.reattacher.reattach(w.f.office.officeId);
    await d.control.idle();
    expect(parks()).toEqual([["interrupted", EVENT_FILE_CHANGED]]);
  });
});

/** Every stored worker output chunk is covered by `work.output` entries exactly once, in order. */
function expectOutputSentOnce(): void {
  const chunks = w.f.office.all<{ from_offset: number; to_offset: number }>(
    `select from_offset, to_offset from output_chunks
      where office_id = $office_id and run_id = $run and source = 'worker' order by from_offset`,
    { run: w.f.run },
  );
  expect(chunks.length).toBeGreaterThan(0);
  const sent = loggedEvents(w.f.office)
    .filter((event) => event.type === "work.output")
    .map((event) => event.data as { from: number; to: number });
  expect(sent.length).toBeGreaterThan(0);
  expect(sent[0]?.from).toBe(chunks[0]?.from_offset);
  for (let i = 1; i < sent.length; i += 1) expect(sent[i]?.from).toBe(sent[i - 1]?.to);
  expect(sent.at(-1)?.to).toBe(chunks.at(-1)?.to_offset);
}

function countDaily(): number {
  return (
    w.f.office.get<{ n: number }>(
      "select count(*) as n from usage_daily where office_id = $office_id",
    )?.n ?? 0
  );
}

/** The real `RunResumer` on fakes: a resumable session, the given host starter and probe. */
function realResumer(
  hosts: ConstructorParameters<typeof RunResumer>[0]["hosts"],
  extra: Pick<ConstructorParameters<typeof RunResumer>[0], "probe" | "hostExitWaitMs"> = {},
): RunResumer {
  const worker: WorkerPort = {
    id: "claude-cli",
    adapter: () =>
      ({
        id: "claude-cli",
        probe: async () => ({ version: "2.1.0" }),
        canResume: () => ({ ok: true }),
        interpret: claude.interpret,
      }) as unknown as WorkerAdapter,
    prepare: async () => ({
      ok: true,
      plan: { argv: ["/bin/true"], env: {}, cwd: "/", files: [], stdin: [] },
    }),
    initialState: () => ({}),
    encode,
    result: (state, exit) => claudeResult(state as unknown as ClaudeParseState, exit),
    sessionFacts: () => ({ contextTokens: null, contextWindow: null, lastReport: null }),
  };
  return new RunResumer({
    clock: w.f.t.clock,
    ids: w.f.t.ids,
    offices: {
      get: () => w.f.office,
      config: () => OFFICE_DEFAULTS,
    },
    worker,
    git: () =>
      ({ commonDir: join(w.dir, "git"), mainWorktree: w.dir }) as unknown as ReturnType<
        NonNullable<ConstructorParameters<typeof RunResumer>[0]["git"]>
      >,
    story: async () => {
      throw new Error("no story read in this test");
    },
    runtimeDir: join(w.dir, "rt"),
    tmpRoot: join(w.dir, "tmp"),
    hosts,
    ingest: { start: () => undefined },
    control: { track: () => undefined },
    ...extra,
  });
}

/** The run's next session after a crash, as worker outcomes ask for it. */
function nextRequest(): NextSessionRequest {
  const run = findRun(w.f.office, w.f.run);
  if (run === null) throw new Error("no run");
  return {
    office: w.f.office.officeId as OfficeId,
    run,
    work: w.work,
    mode: "resume",
    why: "a crash",
    caps: ROOMY,
    startedAt: 0,
    snapshot: null,
  };
}

describe("restart windows of DIPO-51's review", () => {
  it("a stop while the next session's host starts: the new agent is recorded with its host, so the restart follows it (window 1)", async () => {
    w.alive = false;
    beforeRestart("terminated", 0);
    w.f.office.immediate(() =>
      w.f.office.run(
        `update agents set end_reason = 'crashed', session_id = 'session-1'
          where office_id = $office_id and agent_id = $agent`,
        { agent: w.f.agent },
      ),
    );
    // The resumer reads the run's event file in the run directory under the office's git dir.
    const runDir = join(w.dir, "git", "dipo", "runs", w.f.run);
    mkdirSync(runDir, { recursive: true });
    copyFileSync(w.f.eventFile, join(runDir, "events.ndjson"));
    const sizeBefore = statSync(w.f.eventFile).size;
    let recorded: string | null = null;
    const resumer = realResumer({
      // The host started and is recorded, then the daemon stops inside the await.
      start: (office, options) => {
        recordWorkerHost(
          office,
          {
            pid: 4243,
            startTimeMs: 0,
            runId: options.runId,
            agentId: options.agentId,
            socketPath: join(w.dir, "host.sock"),
            protocolVersion: 1,
            runDir,
            eventFile: join(runDir, "events.ndjson"),
          },
          w.f.t.clock,
          {
            ...(options.processedOffset === undefined
              ? {}
              : { processedOffset: options.processedOffset }),
            ...(options.record === undefined ? {} : { record: options.record }),
          },
        );
        recorded = options.agentId;
        return new Promise(() => undefined);
      },
    });
    void resumer.next(nextRequest());
    const wasRecorded = () => recorded !== null;
    for (let i = 0; i < 50 && !wasRecorded(); i += 1) await Bun.sleep(1);
    expect(recorded).not.toBeNull();
    // The new agent and its start offset were written with its host row.
    expect(agentRow(recorded as unknown as string)?.ended_at).toBeNull();
    expect(hostRow().agentId).toBe(recorded as unknown as string);
    expect(hostRow().processedOffset).toBe(sizeBefore);

    // The restart: redispatch starts no second session, and re-attach follows the new host.
    w.alive = true;
    w.answers = false;
    const d = daemon();
    expect(await d.outcomes.redispatch(w.f.office.officeId)).toBe(0);
    expect(w.next).toEqual([]);
    expect(await d.reattacher.reattach(w.f.office.officeId)).toEqual([
      { run: w.f.run, agent: recorded as unknown as string, outcome: "follow" },
    ]);
  });

  it("the next session waits for an earlier host of the run, then refuses with run.hostAlive (AC #5)", async () => {
    beforeRestart("terminated", 0);
    let starts = 0;
    const resumer = realResumer(
      {
        start: () => {
          starts += 1;
          return new Promise(() => undefined);
        },
      },
      {
        probe: async (pid) => ({ pid, startTimeMs: 0, zombie: false, command: "dipo" }),
        hostExitWaitMs: 0,
      },
    );
    w.f.office.immediate(() =>
      w.f.office.run(
        "update agents set session_id = 'session-1' where office_id = $office_id and agent_id = $agent",
        { agent: w.f.agent },
      ),
    );
    expect(await resumer.next(nextRequest())).toEqual({
      kind: "hostAlive",
      code: "run.hostAlive",
      pid: 4242,
    });
    expect(starts).toBe(0);
  });

  it("worker outcomes park a session refused with run.hostAlive, naming the code", async () => {
    w.alive = false;
    w.nextOutcome = { kind: "hostAlive", code: "run.hostAlive", pid: 4242 };
    beforeRestart("success-single", 6, 20);
    const d = daemon();
    await d.reattacher.reattach(w.f.office.officeId);
    await d.control.idle();
    expect(parks()[0]?.[0]).toBe("worker-failed");
    expect(parks()[0]?.[1]).toContain("run.hostAlive");
  });

  it("a host recorded without its agent (an older binary) is left to re-attach, never a second session (window 1)", async () => {
    beforeRestart("terminated", 0);
    w.f.office.immediate(() =>
      w.f.office.run(
        "update agents set end_reason = 'crashed' where office_id = $office_id and agent_id = $agent",
        { agent: w.f.agent },
      ),
    );
    const orphan = w.f.t.ids.next("agt");
    recordWorkerHost(
      w.f.office,
      {
        pid: 4243,
        startTimeMs: 0,
        runId: w.f.run,
        agentId: orphan,
        socketPath: join(w.dir, "host.sock"),
        protocolVersion: 1,
        runDir: w.dir,
        eventFile: w.f.eventFile,
      },
      w.f.t.clock,
    );
    w.f.t.clock.advance(1);
    const d = daemon();
    expect(await d.outcomes.redispatch(w.f.office.officeId)).toBe(0);
    expect(w.next).toEqual([]);
    w.answers = false;
    expect(await d.reattacher.reattach(w.f.office.officeId)).toEqual([
      { run: w.f.run, agent: orphan, outcome: "follow" },
    ]);
    // It starts where the earlier host's lines end, so nothing is ingested twice.
    expect(hostRow().processedOffset).toBe(statSync(w.f.eventFile).size);
  });

  it("a stop between the reassign's resolution and the next session decides by the tag (window 2)", async () => {
    // crash-zeroed: an execution error while the worker waits is a `reassign` `new-session:error`.
    // The first daemon's next session never returns: the daemon stops inside its await.
    w.hang = true;
    const first = daemon();
    first.control.track(w.f.office.officeId, {
      runId: w.f.run,
      work: w.work,
      caps: ROOMY,
      startedAt: w.f.t.clock.now(),
    });
    appendLines(w.f.eventFile, hostLines(readRecording(join(RECORDINGS_DIR, "crash-zeroed"))));
    first.ingest.attach(
      w.f.office,
      { runId: w.f.run, agentId: w.f.agent },
      target(w.f, claude, START, { budgetLimit: ROOMY.budgetTokens }),
      null,
    );
    for (let i = 0; i < 200 && w.next.length === 0; i += 1) await Bun.sleep(1);
    expect(w.next).toHaveLength(1);
    // At the window, the intent's resolution and the agent's end reason are both stored.
    expect(runIntents(w.f.office, w.f.run).map((intent) => [intent.kind, intent.outcome])).toEqual([
      ["reassign", "reassigned"],
    ]);
    expect(agentRow()?.end_reason).toBe("crashed");

    // The restart decides by the recorded decision: the resume, not the adapter's result.
    w.hang = false;
    const second = daemon();
    expect(await second.outcomes.redispatch(w.f.office.officeId)).toBe(1);
    expect(w.next).toHaveLength(2);
    expect(w.next[1]?.mode).toBe("resume");
    expect(w.next[1]?.why).toBe("a crash decided before the daemon restarted");
    expect(parks()).toEqual([]);
  });
});
