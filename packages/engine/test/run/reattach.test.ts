// Re-attach after a daemon restart (DIPO-57), fast and local: a migrated state database with one
// claimed story run whose worker host is recorded, the real DIPO-45 ingestion of committed Claude
// recordings with run control and worker outcomes as its hooks, and a fake host (liveness probe,
// socket handshake, `exit.json`). A "previous daemon" ingests the first lines of a recording; the
// rest is written while it is down; then a new run control, worker outcomes and re-attach start
// on the same database, as after a restart. The run's next session is stubbed, except in the
// restart-window test of `RunResumer`.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { type OfficeId, StoryId, type WorkRef } from "@dipsaus-orchestrator/contract";
import { readRecording } from "@dipsaus-orchestrator/testkit";

import type { RunBoxes } from "../../src/box/lifetime";
import { BOX_RUN_FILE } from "../../src/box/workers";
import { contextPackOf, gitBlobId } from "../../src/context/pack";
import { BOX_CHANGES, BOX_VERIFY } from "../../src/prompts/handoff";
import { recordWorkerNotes } from "../../src/prompts/notes";
import { renderSystemFile } from "../../src/prompts/system";
import { openFeedbackOf } from "../../src/run/open-feedback";
import { parseFieldBlock } from "../../src/story-store/fields/block";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config/schema";
import type { HostClient } from "../../src/host/client";
import { EXIT_FILE, type HostExitFile, hostMarkerName, LAUNCH_FILE } from "../../src/host/protocol";
import { type IngestAdapter, Ingestor } from "../../src/ingest/ingestor";
import {
  type BranchPark,
  EVENT_FILE_CHANGED,
  FOLLOW_CHECK_MS,
  findRun,
  HOST_LOST_WHY,
  HOST_NEVER_STARTED,
  hostSocketSteering,
  insertRun,
  macSessionText,
  type NextSessionOutcome,
  type NextSessionRequest,
  OfficeIngest,
  REATTACH_NOTICES,
  recordGrant,
  RunControl,
  RunOutcomes,
  RunReattacher,
  RunResumer,
  runIntents,
  runTotals,
  noteText,
  STOP_AGAIN_DETAIL,
} from "../../src/run";
import { markIntentSent, recordIntent } from "../../src/run/intents";
import { activeSignals, markStuck, raiseSignal } from "../../src/run/signals";
import { workView } from "../../src/views/work";
import { promptPartsOf, promptTextsOf } from "../../src/prompts/parts";
import { recordWorkerHost, workerHostsOf } from "../../src/runs/worker-hosts";
import { addStory } from "../../src/stories/keys";
import { encode } from "../../src/workers/claude-cli/encode";
import {
  type ClaudeParseState,
  initialState,
  interpret,
} from "../../src/workers/claude-cli/interpret";
import { result as claudeResult } from "../../src/workers/claude-cli/result";
import { readTranscript } from "../../src/workers/claude-cli/transcript";
import { REPORT_JSON_SCHEMAS } from "../../src/workers/claude-cli/report-schema";
import { CLAUDE_LOCAL_SETTINGS } from "../../src/workers/claude-cli/settings-check";
import type { WorkerPort } from "../../src/workers/port";
import {
  type Caps,
  type HostOp,
  type ParseState,
  type ResumeCheck,
  type SessionRef,
  type WorkerAdapter,
} from "../../src/workers/types";
import { insertClaim } from "../../src/worktree/records";
import {
  appendLines,
  hostLines,
  type IngestFixture,
  ingestFixture,
  loggedEvents,
  seedTranscriptCursor,
  target,
} from "../ingest/helpers";
import { type HeldSession, withHeld } from "./held-session";
import { sendFeedback } from "../../src/run/feedback";
import { RECORDINGS_DIR } from "../workers/replay";
import { memoryWorkspace } from "../context/helpers";
import { plainTask } from "../prompts/helpers";

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
  readonly next: HeldSession[];
  nextOutcome: NextSessionOutcome;
  onNext: ((request: NextSessionRequest) => void) | null;
  /** The next session never returns, as when the daemon stops inside it. */
  hang: boolean;
  /** What the fake host is: alive or not, and whether its socket answers. */
  alive: boolean;
  answers: boolean;
  /** The fake host's start time as the probe reads it (DIPO-93). */
  startTimeMs: number;
  caps: Caps;
  /** The engine tokens re-attach connected with (DIPO-59). */
  readonly tokens: (string | null)[];
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
function daemon(
  options: Partial<
    Pick<
      ConstructorParameters<typeof RunReattacher>[0],
      "followCheckMs" | "boxRecord" | "steering" | "adapter"
    >
  > = {},
): Daemon {
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
      readTranscript,
    },
    ender: () => control,
    resumer: {
      next: async (request) => {
        w.next.push(withHeld(w.f.office, request, w.f.t.clock.now(), false));
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
      w.alive
        ? {
            pid,
            startTimeMs: w.startTimeMs,
            zombie: false,
            command: `/opt/dipo daemon worker-host ${w.f.run}`,
          }
        : null,
    connect: async (_socket, _run, token) => {
      w.tokens.push(token);
      return w.answers ? { ok: true, client: fakeClient() } : { ok: false, reason: "unreachable" };
    },
    ingest,
    control,
    outcomes,
    adapter: () => claude,
    initialState: () => START,
    caps: () => w.caps,
    ...options,
  });
  const made = { control, outcomes, ingest, reattacher };
  w.daemons.push(made);
  return made;
}

beforeEach(async () => {
  preparedSpecs.length = 0;
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
    startTimeMs: 0,
    caps: ROOMY,
    tokens: [],
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
      base: "main",
      baseSha: "b".repeat(40),
      startSha: "b".repeat(40),
      claimSha: "d".repeat(40),
      reused: false,
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

/** Sets the run's start budget: its caps count from the snapshot, not from the tier (DIPO-143). */
function startBudget(budgetTokens: number): void {
  w.f.office.run(
    "update runs set budget_limit = $budget where office_id = $office_id and run_id = $run",
    { budget: budgetTokens, run: w.f.run },
  );
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

  it("connects to a re-attached host as the engine, with its stored token (DIPO-59)", async () => {
    beforeRestart("success-single", 6, 20);
    const token = "e".repeat(64);
    w.f.office.immediate(() =>
      w.f.office.run(
        "update worker_hosts set engine_token = $token where office_id = $office_id and run_id = $run",
        { token, run: w.f.run },
      ),
    );
    const d = daemon();
    expect(await d.reattacher.reattach(w.f.office.officeId)).toEqual([
      { run: w.f.run, agent: w.f.agent, outcome: "steer" },
    ]);
    // Only a connection with the token may answer the run's hook calls after the restart.
    expect(w.tokens).toEqual([token]);
    expect(hostRow().engineToken).toBe(token);
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
    // The work view says so, so a client can refuse a steer before any text is typed (DIPO-352).
    expect(workView(w.f.office, w.f.run)?.followOnly).toBe(true);
    const carried = loggedEvents(w.f.office).find((event) => event.type === "work.observed");
    const data = carried?.data as { view?: { followOnly?: boolean } } | undefined;
    expect(data?.view?.followOnly).toBe(true);
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
    startBudget(10);
    beforeRestart("success-single", 6, 20);
    const d = daemon();
    await d.reattacher.reattach(w.f.office.officeId);
    await d.control.idle();
    expect(findRun(w.f.office, w.f.run)?.endedAt).not.toBeNull();
    expect(agentRow()).toEqual({ end_reason: "budget-exceeded", ended_at: null });
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
    expect(agentRow()?.end_reason).toBe("budget-exceeded");
    expect(agentRow()?.ended_at).not.toBeNull();
    expect(signals()).toEqual([]);
    expect(observed()).toEqual(["follow-only", "follow-only"]);
    expect(w.next).toEqual([]);
  });

  it("ingests what a followed host of a parked run wrote after the last poll before closing it out", async () => {
    w.answers = false;
    w.caps = { ...ROOMY, budgetTokens: 10 };
    startBudget(10);
    beforeRestart("success-single", 6, 20);
    // The liveness check comes before the next 1 s ingestion poll.
    const d = daemon({ followCheckMs: 500 });
    await d.reattacher.reattach(w.f.office.officeId);
    await d.control.idle();
    expect(findRun(w.f.office, w.f.run)?.endedAt).not.toBeNull();
    // The host writes its last lines, the exit line among them, and its exit file, then dies.
    appendLines(
      w.f.eventFile,
      hostLines(readRecording(join(RECORDINGS_DIR, "success-single"))).slice(20),
    );
    writeExitFile({ code: 0 });
    w.alive = false;
    w.f.t.clock.advance(500);
    for (let i = 0; i < 50 && hostRow().endedAt === null; i += 1) await Bun.sleep(1);
    expect(hostRow().processedOffset).toBe(statSync(w.f.eventFile).size);
    expect(hostRow().exitCode).toBe(0);
    expect(hostRow().endedAt).not.toBeNull();
    expect(agentRow()?.end_reason).toBe("budget-exceeded");
    expect(agentRow()?.ended_at).not.toBeNull();
    expect(signals()).toEqual([]);
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

  it("a dead host's usage the stream lacked is read from its transcript, once, before it is final (DIPO-134)", async () => {
    w.alive = false;
    beforeRestart("success-single", 6, 20);
    const transcript = join(w.dir, "session.jsonl");
    writeFileSync(transcript, `${message("msg-lost", 9, 11)}\n${message("msg-lost-2", 1, 2)}\n`);
    // An earlier binary's hook relay named the transcript (DIPO-134); no hook names one now.
    seedTranscriptCursor(
      w.f.office,
      { run: w.f.run, agent: w.f.agent },
      { path: transcript },
      w.f.t.clock.now(),
    );
    const stored = () =>
      w.f.office.get<{ input: number; output: number; messages: number; final: number }>(
        `select sum(t.input) as input, sum(t.output) as output, min(t.final) as final,
           (select count(*) from usage_messages m where m.office_id = t.office_id
              and m.message_id like 'msg-lost%') as messages
         from usage_totals t where t.office_id = $office_id and t.agent_id = $agent`,
        { agent: w.f.agent },
      );
    const d = daemon();
    await d.reattacher.reattach(w.f.office.officeId);
    await d.control.idle();
    expect(agentRow()?.end_reason).toBe("host-lost");
    const after = stored();
    expect(after?.messages).toBe(2);
    expect(after?.final).toBe(1);
    // The transcript's two messages are in the totals: their input and their output.
    const rows = w.f.office.get<{ input: number; output: number }>(
      `select sum(input) as input, sum(output) as output from usage_messages
       where office_id = $office_id and agent_id = $agent`,
      { agent: w.f.agent },
    );
    expect(after?.input).toBe(rows?.input ?? -1);
    expect(after?.output).toBeGreaterThanOrEqual(13);

    // A second restart reads the same transcript and adds nothing.
    const again = daemon();
    await again.reattacher.reattach(w.f.office.officeId);
    await again.control.idle();
    expect(stored()?.input).toBe(after?.input ?? -1);
    expect(stored()?.output).toBe(after?.output ?? -1);
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

  it("a dead host whose session cannot be resumed parks worker-failed (AC #4)", async () => {
    w.alive = false;
    w.nextOutcome = { kind: "notResumed", reason: "the transcript is gone" };
    beforeRestart("success-single", 6, 20);
    const d = daemon();
    await d.reattacher.reattach(w.f.office.officeId);
    await d.control.idle();
    expect(parks()).toEqual([
      ["worker-failed", `${HOST_LOST_WHY}; its session cannot be resumed: the transcript is gone`],
    ]);
    expect(findRun(w.f.office, w.f.run)?.ending).toBe("parked");
  });

  it("a dead host after the run's one resume parks worker-failed without another (AC #4)", async () => {
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
    expect(parks()[0]?.[0]).toBe("worker-failed");
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
    startBudget(10);
    beforeRestart("success-single", 6, 20);
    const d = daemon();
    await d.reattacher.reattach(w.f.office.officeId);
    await d.control.idle();
    expect(w.next).toEqual([]);
    // Over its caps after the catch-up: the stop sequence went to the host and the story parked.
    expect(w.sent).toEqual([encode({ kind: "stop" })]);
    expect(parks()[0]?.[0]).toBe("budget-exceeded");
  });

  it("counts the caps of a run resumed after a long park from its work, not its park (DIPO-75)", async () => {
    w.caps = { ...ROOMY, maxMinutes: 30 };
    // The run stood parked a day before an answer reopened it, then worked 5 more minutes.
    w.f.office.immediate(() =>
      w.f.office.run(
        "update runs set parked_ms = $parked where office_id = $office_id and run_id = $run",
        { parked: 24 * 60 * 60_000, run: w.f.run },
      ),
    );
    w.f.t.clock.advance(24 * 60 * 60_000 + 5 * 60_000);
    beforeRestart("success-single", 6, 20);
    const d = daemon();
    await d.reattacher.reattach(w.f.office.officeId);
    await d.control.idle();
    expect(d.control.isTracked(w.f.run)).toBe(true);
    expect(w.sent).toEqual([]);
    expect(parks()).toEqual([]);
  });

  it("an event file that changed while the daemon was down parks the run worker-failed (AC #7)", async () => {
    beforeRestart("success-single", 10, 10);
    truncateSync(w.f.eventFile, 10);
    const d = daemon();
    expect(await d.reattacher.reattach(w.f.office.officeId)).toEqual([
      { run: w.f.run, agent: w.f.agent, outcome: "fileChanged" },
    ]);
    await d.control.idle();
    expect(parks()).toEqual([["worker-failed", EVENT_FILE_CHANGED]]);
    expect(w.sent).toEqual([encode({ kind: "stop" })]);
  });

  it("a living developer on the Mac, with no box record, is stopped with a notice and parks worker-failed (DIPO-240)", async () => {
    beforeRestart("success-single", 6, 20);
    const asked: string[] = [];
    const d = daemon({
      boxRecord: (runDir) => {
        asked.push(runDir);
        return false;
      },
    });
    expect(await d.reattacher.reattach(w.f.office.officeId)).toEqual([
      { run: w.f.run, agent: w.f.agent, outcome: "macSession" },
      // The parked run's host still runs after the stop: followed until it exits (DIPO-93).
      { run: w.f.run, agent: w.f.agent, outcome: "followEnded" },
    ]);
    await d.control.idle();
    expect(asked).toEqual([w.dir]);
    const text = macSessionText({ story: "DIPO-1", runId: w.f.run });
    expect(parks()).toEqual([["worker-failed", text]]);
    expect(text).toContain("outside a box");
    expect(w.sent).toEqual([encode({ kind: "stop" })]);
    const notice = loggedEvents(w.f.office).find(
      (event) =>
        event.type === "engine.notice" &&
        (event.data as { code?: string }).code === REATTACH_NOTICES.macSession,
    );
    expect(notice?.data).toMatchObject({ level: "error", text });
  });

  it("a living developer in its box is followed as before (DIPO-240)", async () => {
    beforeRestart("success-single", 6, 20);
    const inBox = daemon({ boxRecord: () => true });
    expect(await inBox.reattacher.reattach(w.f.office.officeId)).toEqual([
      { run: w.f.run, agent: w.f.agent, outcome: "steer" },
    ]);
    expect(parks()).toEqual([]);
  });

  it("a living reviewer on the Mac is followed, never stopped as a Mac developer (DIPO-240)", async () => {
    beforeRestart("success-single", 6, 20);
    w.f.office.immediate(() =>
      w.f.office.run(
        "update agents set role = 'reviewer' where office_id = $office_id and agent_id = $agent",
        { agent: w.f.agent },
      ),
    );
    const d = daemon({ boxRecord: () => false });
    expect(await d.reattacher.reattach(w.f.office.officeId)).toEqual([
      { run: w.f.run, agent: w.f.agent, outcome: "steer" },
    ]);
    expect(parks()).toEqual([]);
  });

  it("an ingest.fileChanged report a previous daemon left parks the run worker-failed (AC #7)", async () => {
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
    expect(parks()).toEqual([["worker-failed", EVENT_FILE_CHANGED]]);
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

/** One assistant line of a worker transcript. */
const message = (id: string, input: number, output: number): string =>
  JSON.stringify({
    type: "assistant",
    message: {
      id,
      model: "claude-haiku-5-5",
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });

function countDaily(): number {
  return (
    w.f.office.get<{ n: number }>(
      "select count(*) as n from usage_daily where office_id = $office_id",
    )?.n ?? 0
  );
}

/** The specs the resumer's worker prepared, the last one being the session it started. */
const preparedSpecs: {
  readonly taskMessage: string;
  readonly systemFile: string;
  readonly caps: Caps;
  readonly model: string;
  readonly effort?: string;
}[] = [];

/** The real `RunResumer` on fakes: a resumable session, the given host starter and probe. */
function realResumer(
  hosts: ConstructorParameters<typeof RunResumer>[0]["hosts"],
  extra: Partial<
    Pick<
      ConstructorParameters<typeof RunResumer>[0],
      | "probe"
      | "hostExitWaitMs"
      | "ingest"
      | "story"
      | "handoff"
      | "workspace"
      | "git"
      | "boxes"
      | "boxSync"
    >
  > = {},
  canResume: (ref: SessionRef) => ResumeCheck = () => ({ ok: true }),
  config: OfficeConfig = OFFICE_DEFAULTS,
  /** The launch checks; by default a pass that records the spec. */
  prepare?: WorkerPort["prepare"],
): RunResumer {
  const worker: WorkerPort = {
    id: "claude-cli",
    reportSchema: REPORT_JSON_SCHEMAS,
    localSettings: CLAUDE_LOCAL_SETTINGS,
    adapter: () =>
      ({
        id: "claude-cli",
        probe: async () => ({ version: "2.1.0" }),
        canResume,
        interpret: claude.interpret,
      }) as unknown as WorkerAdapter,
    prepare:
      prepare ??
      (async (spec) => {
        preparedSpecs.push(spec);
        return {
          ok: true,
          plan: { argv: ["/bin/true"], env: {}, cwd: "/", files: [], stdin: [] },
        };
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
      config: () => config,
    },
    worker,
    // The branch tip a new session's workspace is read at; the workspace itself is a fake.
    git: () =>
      ({
        commonDir: join(w.dir, "git"),
        mainWorktree: w.dir,
        run: async <T>(fn: (session: unknown) => Promise<T>) =>
          fn({ repository: {}, ok: async () => `${"f".repeat(40)}\n` }),
      }) as unknown as ReturnType<NonNullable<ConstructorParameters<typeof RunResumer>[0]["git"]>>,
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

  it("the host signals end with the next session's agent, so one its first pass raises stays raised", async () => {
    beforeRestart("terminated", 0);
    w.f.office.immediate(() => {
      w.f.office.run(
        `update agents set ended_at = 1, end_reason = 'exited', session_id = 'session-1'
          where office_id = $office_id and agent_id = $agent`,
        { agent: w.f.agent },
      );
      // The restart's host signal.
      raiseSignal(w.f.office, w.f.run, "follow-only", 1);
    });
    const runDir = join(w.dir, "git", "dipo", "runs", w.f.run);
    mkdirSync(runDir, { recursive: true });
    copyFileSync(w.f.eventFile, join(runDir, "events.ndjson"));
    const resumer = realResumer(
      {
        start: async (office, options) => {
          const host = {
            pid: 4243,
            startTimeMs: 0,
            runId: options.runId,
            agentId: options.agentId,
            socketPath: join(w.dir, "host.sock"),
            protocolVersion: 1,
            runDir,
            eventFile: join(runDir, "events.ndjson"),
          };
          recordWorkerHost(office, host, w.f.t.clock, {
            ...(options.processedOffset === undefined
              ? {}
              : { processedOffset: options.processedOffset }),
            ...(options.record === undefined ? {} : { record: options.record }),
          });
          return host;
        },
      },
      {
        probe: async () => null,
        // The first pass, synchronous in `start`, raises a host signal again.
        ingest: {
          start: (office) => {
            office.immediate(() => raiseSignal(office, w.f.run, "follow-only", 2));
          },
        },
      },
    );
    const outcome = await resumer.next(nextRequest());
    expect(outcome.kind).toBe("started");
    expect(signals()).toEqual(["follow-only"]);
    const cleared = loggedEvents(w.f.office)
      .filter((event) => event.type === "work.observed")
      .map((event) => (event.data as { signal: string }).signal);
    expect(cleared).toEqual(["follow-only"]);
  });

  it("a new session clears the old session's no-output, so a resumed run is not stuck before its first line (DIPO-352)", async () => {
    beforeRestart("terminated", 0);
    w.f.office.immediate(() => {
      w.f.office.run(
        `update agents set ended_at = 1, end_reason = 'exited', session_id = 'session-1'
          where office_id = $office_id and agent_id = $agent`,
        { agent: w.f.agent },
      );
      // The old session went silent past the stall wait.
      markStuck(w.f.office, w.f.run, 1);
    });
    expect(signals()).toEqual(["no-output"]);
    const runDir = join(w.dir, "git", "dipo", "runs", w.f.run);
    mkdirSync(runDir, { recursive: true });
    copyFileSync(w.f.eventFile, join(runDir, "events.ndjson"));
    const resumer = realResumer(
      {
        start: async (office, options) => {
          const host = {
            pid: 4243,
            startTimeMs: 0,
            runId: options.runId,
            agentId: options.agentId,
            socketPath: join(w.dir, "host.sock"),
            protocolVersion: 1,
            runDir,
            eventFile: join(runDir, "events.ndjson"),
          };
          recordWorkerHost(office, host, w.f.t.clock, {
            ...(options.processedOffset === undefined
              ? {}
              : { processedOffset: options.processedOffset }),
            ...(options.record === undefined ? {} : { record: options.record }),
          });
          return host;
        },
      },
      { probe: async () => null, ingest: { start: () => {} } },
    );
    const outcome = await resumer.next(nextRequest());
    expect(outcome.kind).toBe("started");
    expect(signals()).toEqual([]);
    expect(observed()).toEqual(["no-output"]);
    expect(workView(w.f.office, w.f.run)?.health).not.toBe("stuck");
  });

  it("the resume check gets the previous session's version from agents.adapter_version (DIPO-101)", async () => {
    beforeRestart("terminated", 0);
    w.f.office.immediate(() =>
      w.f.office.run(
        `update agents set ended_at = 1, end_reason = 'exited', session_id = 'session-1',
           adapter_version = '2.0.9'
          where office_id = $office_id and agent_id = $agent`,
        { agent: w.f.agent },
      ),
    );
    const runDir = join(w.dir, "git", "dipo", "runs", w.f.run);
    mkdirSync(runDir, { recursive: true });
    copyFileSync(w.f.eventFile, join(runDir, "events.ndjson"));
    const seen: (string | null)[] = [];
    const resumer = realResumer(
      {
        start: async (office, options) => {
          const host = {
            pid: 4243,
            startTimeMs: 0,
            runId: options.runId,
            agentId: options.agentId,
            socketPath: join(w.dir, "host.sock"),
            protocolVersion: 1,
            runDir,
            eventFile: join(runDir, "events.ndjson"),
          };
          recordWorkerHost(office, host, w.f.t.clock, {
            ...(options.processedOffset === undefined
              ? {}
              : { processedOffset: options.processedOffset }),
            ...(options.record === undefined ? {} : { record: options.record }),
          });
          return host;
        },
      },
      { probe: async () => null },
      (ref) => {
        seen.push(ref.version);
        return { ok: true };
      },
    );
    const outcome = await resumer.next(nextRequest());
    expect(outcome.kind).toBe("started");
    expect(seen).toEqual(["2.0.9"]);
  });

  it("gives the CLI the developer's remaining turns and tokens, a reviewer's usage left out (0002)", async () => {
    beforeRestart("terminated", 0);
    const before = runTotals(w.f.office, w.f.run, 0, 0);
    w.f.office.immediate(() => {
      w.f.office.run(
        `update agents set ended_at = 1, end_reason = 'exited', session_id = 'session-1'
          where office_id = $office_id and agent_id = $agent`,
        { agent: w.f.agent },
      );
      // A reviewer of the same run spent 40 turns and 5,000 budget tokens: its own caps, not the story's.
      w.f.office.run(
        `insert into agents (office_id, agent_id, run_id, role, model, started_at, ended_at)
         values ($office_id, 'agt_reviewer', $run, 'reviewer', 'opus', 0, 0)`,
        { run: w.f.run },
      );
      w.f.office.run(
        `insert into usage_totals (office_id, run_id, agent_id, model, role, tier, input, turns,
           updated_at)
         values ($office_id, $run, 'agt_reviewer', 'opus', 'reviewer', 'M', 5000, 40, 0)`,
        { run: w.f.run },
      );
    });
    const used = runTotals(w.f.office, w.f.run, 0, 0);
    expect(used.turns).toBe(before.turns);
    expect(used.budgetTokens).toBe(before.budgetTokens);
    const runDir = join(w.dir, "git", "dipo", "runs", w.f.run);
    mkdirSync(runDir, { recursive: true });
    copyFileSync(w.f.eventFile, join(runDir, "events.ndjson"));
    const resumer = realResumer(
      {
        start: async (office, options) => {
          const host = {
            pid: 4243,
            startTimeMs: 0,
            runId: options.runId,
            agentId: options.agentId,
            socketPath: join(w.dir, "host.sock"),
            protocolVersion: 1,
            runDir,
            eventFile: join(runDir, "events.ndjson"),
          };
          recordWorkerHost(office, host, w.f.t.clock, {
            ...(options.processedOffset === undefined
              ? {}
              : { processedOffset: options.processedOffset }),
            ...(options.record === undefined ? {} : { record: options.record }),
          });
          return host;
        },
      },
      { probe: async () => null },
    );
    const outcome = await resumer.next(nextRequest());
    expect(outcome.kind).toBe("started");
    const caps = preparedSpecs.at(-1)?.caps;
    // The tier's turns and budget minus the developer's own; the reviewer's count against neither.
    expect(caps?.maxTurns).toBe(OFFICE_DEFAULTS.tiers.M.maxTurns - before.turns);
    expect(caps?.budgetTokens).toBe(ROOMY.budgetTokens - used.budgetTokens);
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

/** The previous daemon stopped between writing the host row and recording the spawned host. */
function makePending(): void {
  w.f.office.immediate(() =>
    w.f.office.run(
      `update worker_hosts set pending = 1, pid = 0, start_time_ms = 0
        where office_id = $office_id and run_id = $run`,
      { run: w.f.run },
    ),
  );
}

function endRunByHand(): void {
  w.f.office.immediate(() =>
    w.f.office.run(
      "update runs set ended_at = $at, end_kind = 'parked' where office_id = $office_id",
      { at: w.f.t.clock.now() },
    ),
  );
}

/** Stops one daemon's timers and followers, as its process ending would. */
function stopDaemon(d: Daemon): void {
  d.control.close();
  d.ingest.close();
  d.reattacher.close();
}

describe("re-attach gaps (DIPO-93)", () => {
  it("settles a pending host row by the host's PID marker and follows it; no second host starts (AC #3)", async () => {
    beforeRestart("success-single", 6, 20);
    makePending();
    writeFileSync(
      join(w.dir, hostMarkerName(w.f.agent)),
      JSON.stringify({ run: w.f.run, agent: w.f.agent, pid: 4343 }),
    );
    w.startTimeMs = w.f.t.clock.now();
    const d = daemon();
    expect(await d.reattacher.reattach(w.f.office.officeId)).toEqual([
      { run: w.f.run, agent: w.f.agent, outcome: "steer" },
    ]);
    expect(hostRow()).toMatchObject({ pending: false, pid: 4343, startTimeMs: w.startTimeMs });
    expect(d.control.isTracked(w.f.run)).toBe(true);
    expect(w.next).toEqual([]);
    expect(parks()).toEqual([]);
  });

  it("revokes a pending launch no host claimed: nothing ran, the story parks worker-failed (AC #3)", async () => {
    makePending();
    writeFileSync(join(w.dir, LAUNCH_FILE), JSON.stringify({ run: w.f.run, agent: w.f.agent }));
    const d = daemon();
    expect(await d.reattacher.reattach(w.f.office.officeId)).toEqual([
      { run: w.f.run, agent: w.f.agent, outcome: "neverStarted" },
    ]);
    await d.control.idle();
    expect(workerHostsOf(w.f.office, w.f.run)).toEqual([]);
    expect(existsSync(join(w.dir, LAUNCH_FILE))).toBe(false);
    expect(parks()).toEqual([["worker-failed", HOST_NEVER_STARTED]]);
    // Nothing to stop and no next session.
    expect(w.sent).toEqual([]);
    expect(w.next).toEqual([]);
  });

  it("closes out a dead host of an ended run with its exit.json after a second restart (AC #2)", async () => {
    beforeRestart("success-single", 6);
    endRunByHand();
    w.alive = false;
    writeExitFile({ code: 143, signal: "SIGTERM", signalInferred: true });
    const d = daemon();
    expect(await d.reattacher.reattach(w.f.office.officeId)).toEqual([
      { run: w.f.run, agent: w.f.agent, outcome: "closedOut" },
    ]);
    expect(hostRow()).toMatchObject({ exitCode: 143, exitSignal: "SIGTERM" });
    expect(hostRow().endedAt).not.toBeNull();
    expect(agentRow()?.end_reason).toBe("exited");
    expect(w.next).toEqual([]);
    // Closed for good: the next restart has nothing to do.
    stopDaemon(d);
    expect(await daemon().reattacher.reattach(w.f.office.officeId)).toEqual([]);
  });

  it("closes out a dead host of an ended run without exit.json as lost (AC #2)", async () => {
    beforeRestart("success-single", 6, 20);
    endRunByHand();
    w.alive = false;
    const d = daemon();
    expect(await d.reattacher.reattach(w.f.office.officeId)).toEqual([
      { run: w.f.run, agent: w.f.agent, outcome: "closedOut" },
    ]);
    expect(hostRow().endedAt).not.toBeNull();
    expect(agentRow()?.end_reason).toBe("host-lost");
    expect(w.next).toEqual([]);
  });

  it("reads the transcript of a followed host of an ended run that died without exit.json, once (DIPO-134)", async () => {
    beforeRestart("success-single", 6, 20);
    const transcript = join(w.dir, "session.jsonl");
    writeFileSync(transcript, `${message("msg-lost", 9, 11)}\n${message("msg-lost-2", 1, 2)}\n`);
    // An earlier binary's hook relay named the transcript (DIPO-134); no hook names one now.
    seedTranscriptCursor(
      w.f.office,
      { run: w.f.run, agent: w.f.agent },
      { path: transcript },
      w.f.t.clock.now(),
    );
    endRunByHand();
    w.alive = false;
    const d = daemon({ adapter: () => ({ ...claude, readTranscript }) });
    expect(await d.reattacher.reattach(w.f.office.officeId)).toEqual([
      { run: w.f.run, agent: w.f.agent, outcome: "closedOut" },
    ]);
    expect(agentRow()?.end_reason).toBe("host-lost");
    // The stream lacked both messages: each is stored once, with the transcript's numbers.
    const lost = w.f.office.all<{ message_id: string; input: number; output: number }>(
      `select message_id, input, output from usage_messages
        where office_id = $office_id and agent_id = $agent and message_id like 'msg-lost%'
        order by message_id`,
      { agent: w.f.agent },
    );
    expect(lost).toEqual([
      { message_id: "msg-lost", input: 9, output: 11 },
      { message_id: "msg-lost-2", input: 1, output: 2 },
    ]);
    const streamed =
      w.f.office.get<{ input: number }>(
        `select coalesce(sum(input), 0) as input from usage_messages
          where office_id = $office_id and agent_id = $agent and message_id not like 'msg-lost%'`,
        { agent: w.f.agent },
      )?.input ?? -1;
    const totals = w.f.office.get<{ input: number; final: number }>(
      `select sum(input) as input, min(final) as final from usage_totals
        where office_id = $office_id and agent_id = $agent`,
      { agent: w.f.agent },
    );
    expect(totals).toEqual({ input: streamed + 9 + 1, final: 1 });
    // The daily rollup holds it once too.
    const daily = w.f.office.get<{ input: number }>(
      "select sum(input) as input from usage_daily where office_id = $office_id",
    );
    expect(daily?.input).toBe(streamed + 9 + 1);
    // Closed for good: a later restart reads nothing again.
    stopDaemon(d);
    expect(
      await daemon({ adapter: () => ({ ...claude, readTranscript }) }).reattacher.reattach(
        w.f.office.officeId,
      ),
    ).toEqual([]);
    expect(
      w.f.office.get<{ input: number }>(
        "select sum(input) as input from usage_daily where office_id = $office_id",
      )?.input,
    ).toBe(streamed + 9 + 1);
  });

  it("follows a living host of an ended run across restarts until it exits, then closes it out (AC #2)", async () => {
    beforeRestart("success-single", 6, 20);
    endRunByHand();
    const first = daemon();
    expect(await first.reattacher.reattach(w.f.office.officeId)).toEqual([
      { run: w.f.run, agent: w.f.agent, outcome: "followEnded" },
    ]);
    stopDaemon(first);
    // A later restart still finds the open row and follows it again.
    const second = daemon();
    expect(await second.reattacher.reattach(w.f.office.officeId)).toEqual([
      { run: w.f.run, agent: w.f.agent, outcome: "followEnded" },
    ]);
    expect(await second.reattacher.reattach(w.f.office.officeId)).toEqual([]);
    expect(hostRow().endedAt).toBeNull();
    // The host ends: the rest of its lines with the exit, then exit.json.
    appendLines(
      w.f.eventFile,
      hostLines(readRecording(join(RECORDINGS_DIR, "success-single"))).slice(20),
    );
    writeExitFile();
    w.alive = false;
    w.f.t.clock.advance(FOLLOW_CHECK_MS);
    for (let i = 0; i < 50 && hostRow().endedAt === null; i += 1) await Bun.sleep(1);
    expect(hostRow().endedAt).not.toBeNull();
    expect(hostRow().exitCode).toBe(0);
    expect(agentRow()?.end_reason).toBe("exited");
    expect(w.next).toEqual([]);
  });

  it("a follow-only host after the restart is stopped by one verified SIGTERM (AC #1)", async () => {
    w.answers = false;
    w.startTimeMs = 1_767_225_600_000;
    w.f.office.immediate(() =>
      w.f.office.run(
        "update worker_hosts set start_time_ms = $start where office_id = $office_id",
        {
          start: w.startTimeMs,
        },
      ),
    );
    beforeRestart("success-single", 6, 20);
    const d = daemon();
    await d.reattacher.reattach(w.f.office.officeId);
    expect(hostRow().mode).toBe("follow");
    const signalled: [number, string][] = [];
    const steering = hostSocketSteering({
      clock: w.f.t.clock,
      probe: async (pid) => ({
        pid,
        startTimeMs: w.startTimeMs,
        zombie: false,
        command: `/opt/dipo daemon worker-host ${w.f.run}`,
      }),
      signal: (pid, signal) => {
        signalled.push([pid, signal]);
        return true;
      },
    });
    expect(await steering.send(w.f.office, w.f.run, encode({ kind: "stop" }))).toEqual({
      ok: true,
      via: "signal",
    });
    expect(signalled).toEqual([[4242, "SIGTERM"]]);
  });
});

/** The run ended with an ending intent in `state`, as reconcile or a park leaves it. */
function endedWith(state: "failed" | "sent"): void {
  endRunByHand();
  w.f.office.immediate(() => {
    const id = recordIntent(w.f.office, w.f.run, "stop", "reconciled", w.f.t.clock.now());
    markIntentSent(
      w.f.office,
      w.f.run,
      id,
      w.f.t.clock.now(),
      state === "failed" ? "the run's worker host is still being started" : null,
    );
  });
}

describe("a stop that did not reach the host before re-attach (DIPO-93)", () => {
  const recording = {
    send: async (_office: unknown, _run: unknown, ops: readonly HostOp[]) => {
      w.sent.push([...ops]);
      return { ok: true as const, via: "signal" as const };
    },
  };

  it("sends the stop again to a living host of a run whose stop failed, then follows it", async () => {
    beforeRestart("success-single", 6, 20);
    endedWith("failed");
    const d = daemon({ steering: recording });
    expect(await d.reattacher.reattach(w.f.office.officeId)).toEqual([
      { run: w.f.run, agent: w.f.agent, outcome: "stopAgain" },
    ]);
    expect(w.sent).toEqual([encode({ kind: "stop" })]);
    const last = runIntents(w.f.office, w.f.run).at(-1);
    expect(last).toMatchObject({ kind: "stop", state: "sent", detail: STOP_AGAIN_DETAIL });
    // Followed until it exits; the next restart does not send it again.
    stopDaemon(d);
    expect(await daemon({ steering: recording }).reattacher.reattach(w.f.office.officeId)).toEqual([
      { run: w.f.run, agent: w.f.agent, outcome: "followEnded" },
    ]);
    expect(w.sent).toHaveLength(1);
  });

  it("sends nothing when the stop that ended the run reached the host", async () => {
    beforeRestart("success-single", 6, 20);
    endedWith("sent");
    const d = daemon({ steering: recording });
    expect(await d.reattacher.reattach(w.f.office.officeId)).toEqual([
      { run: w.f.run, agent: w.f.agent, outcome: "followEnded" },
    ]);
    expect(w.sent).toEqual([]);
  });

  it("records the failed second stop, and still follows the host", async () => {
    beforeRestart("success-single", 6, 20);
    endedWith("failed");
    const d = daemon({
      steering: { send: async () => ({ ok: false as const, reason: "dipo sent no signal" }) },
    });
    expect(await d.reattacher.reattach(w.f.office.officeId)).toEqual([
      { run: w.f.run, agent: w.f.agent, outcome: "followEnded" },
    ]);
    expect(runIntents(w.f.office, w.f.run).at(-1)).toMatchObject({
      kind: "stop",
      state: "failed",
      detail: STOP_AGAIN_DETAIL,
    });
    expect(hostRow().endedAt).toBeNull();
  });
});

/** The run's first session with its pack, ready to be resumed. */
function firstSession(): void {
  beforeRestart("terminated", 0);
  w.f.office.immediate(() => {
    w.f.office.run(
      `update agents set ended_at = 1, end_reason = 'crashed', session_id = 'session-1'
        where office_id = $office_id and agent_id = $agent`,
      { agent: w.f.agent },
    );
  });
}

const hosts: Parameters<typeof realResumer>[0] = {
  start: async (office, options) => {
    const runDir = join(w.dir, "git", "dipo", "runs", options.runId);
    const host = {
      pid: 4243,
      startTimeMs: 0,
      runId: options.runId,
      agentId: options.agentId,
      socketPath: join(w.dir, "host.sock"),
      protocolVersion: 1,
      runDir,
      eventFile: join(runDir, "events.ndjson"),
    };
    recordWorkerHost(office, host, w.f.t.clock, {
      ...(options.processedOffset === undefined
        ? {}
        : { processedOffset: options.processedOffset }),
      ...(options.record === undefined ? {} : { record: options.record }),
    });
    return host;
  },
};

describe("the next session's caps (DIPO-143)", () => {
  it("counts a budget grant in what remains of the run's tokens, turns and minutes", async () => {
    firstSession();
    const { office, run } = w.f;
    const now = w.f.t.clock.now();
    office.immediate(() => {
      office.run(
        `update runs set budget_limit = 1000, max_turns = 50, max_minutes = 30
          where office_id = $office_id and run_id = $run`,
        { run },
      );
      recordGrant(office, run, {
        kind: "budget",
        amount: { tokens: 500, turns: 25, minutes: 15 },
        grantId: "grt_1",
        note: "more room",
        origin: "maintainer",
        client: null,
        at: now,
      });
    });
    const used = runTotals(office, run, now, now);
    const outcome = await realResumer(hosts, { probe: async () => null }).next({
      ...nextRequest(),
      startedAt: now,
    });
    expect(outcome).toMatchObject({ kind: "started" });
    // The start snapshot plus the grant, less what the run used; never the tier's caps.
    expect(preparedSpecs.at(-1)?.caps).toEqual({
      budgetTokens: 1500 - used.budgetTokens,
      maxTurns: 75 - used.turns,
      maxMinutes: 45,
    });
  });
});

/** The task message the session it started was sent. */
const sentText = (): string => preparedSpecs.at(-1)?.taskMessage ?? "";
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const storyOf = () => {
  const view = plainTask({ id: "DIPO-1", dependencies: [], references: ["src/new.ts"] });
  return {
    view,
    fields: parseFieldBlock(view.description).fields,
    taskFile: "backlog/tasks/dipo-1 - Story.md",
    dependencies: [],
  };
};
const handoff = async () => ({
  commits: "",
  criteria: null,
  verify: null,
  feedback: [],
  notes: null,
});
const workspace = () => memoryWorkspace({ "src/new.ts": "export const fresh = 1;\n" });

describe("the prompt parts of a resume and a handoff (DIPO-177)", () => {
  it("a resume records the task message it sent, under the resumed session's agent", async () => {
    firstSession();
    const outcome = await realResumer(hosts, {
      probe: async () => null,
      story: async () => storyOf(),
      handoff,
      workspace,
    }).next(nextRequest());
    expect(outcome).toMatchObject({ kind: "started", resumed: true });
    const agent = (outcome as { agent: string }).agent;
    const text = sentText();
    expect(promptPartsOf(w.f.office, w.f.run, agent)).toMatchObject([
      { name: "task", sha256: sha(text), bytes: Buffer.byteLength(text) },
    ]);
    expect(promptPartsOf(w.f.office, w.f.run, w.f.agent)).toEqual([]);
  });

  it("a handoff records its system file and its task message, under the new agent", async () => {
    firstSession();
    const outcome = await realResumer(
      hosts,
      {
        probe: async () => null,
        story: async () => storyOf(),
        handoff,
        workspace,
      },
      () => ({ ok: false, reason: "the context is too full" }),
    ).next(nextRequest());
    expect(outcome).toMatchObject({ kind: "started", resumed: false });
    const agent = (outcome as { agent: string }).agent;
    const system = readFileSync(preparedSpecs.at(-1)?.systemFile ?? "", "utf8");
    const text = sentText();
    expect(promptPartsOf(w.f.office, w.f.run, agent)).toMatchObject([
      { name: "system", sha256: sha(system), bytes: Buffer.byteLength(system) },
      { name: "task", sha256: sha(text), bytes: Buffer.byteLength(text) },
    ]);
  });
});

/** The state and outcome of the run's intents `ids`. */
function intentStates(ids: readonly number[]): (string | null)[][] {
  return runIntents(w.f.office, w.f.run)
    .filter((intent) => ids.includes(intent.intentId))
    .map((intent) => [intent.state, intent.outcome]);
}

describe("the held messages in the next session (0002, 0020)", () => {
  const PARKED = "dipo parked this story as by-maintainer, and the maintainer resumed it.";
  const STEER = "The maintainer says: mind the edge case.";
  const NOTE = noteText("/compact the tests first");

  /** A steer held while parked, then a resume's reason part and its note, in that order. */
  function holdResume(): number[] {
    const { office, run, t } = w.f;
    return office.immediate(() => [
      sendFeedback(
        office,
        run,
        { source: "steer", key: "req_s", text: STEER },
        { at: t.clock.now() },
      ).intentId,
      sendFeedback(
        office,
        run,
        { source: "park", key: "resume-1", text: PARKED },
        { at: t.clock.now() },
      ).intentId,
      sendFeedback(office, run, { source: "resume", text: NOTE }, { at: t.clock.now() }).intentId,
    ]);
  }

  it("a native resume sends the delta, then the findings, then the maintainer's words oldest first", async () => {
    firstSession();
    const ids = holdResume();
    const outcome = await realResumer(hosts, {
      probe: async () => null,
      story: async () => storyOf(),
      handoff,
      workspace,
    }).next(nextRequest());
    expect(outcome).toMatchObject({ kind: "started", resumed: true });
    const text = sentText();
    expect(text.split("\n\n").slice(-3)).toEqual([PARKED, STEER, NOTE]);
    expect(text.startsWith("dipo resumed this session")).toBe(true);
    // Delivered in the transaction that recorded the new agent.
    expect(intentStates(ids)).toEqual([
      ["resolved", "resumed"],
      ["resolved", "resumed"],
      ["resolved", "resumed"],
    ]);
  });

  it("a handoff sends the task message, then the held messages once, never starting with the note", async () => {
    firstSession();
    const ids = holdResume();
    const outcome = await realResumer(
      hosts,
      { probe: async () => null, story: async () => storyOf(), handoff, workspace },
      () => ({ ok: false, reason: "the context is too full" }),
    ).next(nextRequest());
    expect(outcome).toMatchObject({ kind: "started", resumed: false });
    const text = sentText();
    expect(text.split("Note from the maintainer: /compact the tests first")).toHaveLength(2);
    expect(text.startsWith("/")).toBe(false);
    expect(text.indexOf(PARKED)).toBeLessThan(text.indexOf(STEER));
    expect(text.indexOf(STEER)).toBeLessThan(text.indexOf(NOTE));
    expect(intentStates(ids).every(([state]) => state === "resolved")).toBe(true);
  });

  it("keeps the held messages when the session does not start", async () => {
    firstSession();
    const ids = holdResume();
    const outcome = await realResumer(
      hosts,
      { probe: async () => null, story: async () => storyOf(), handoff, workspace },
      () => ({ ok: false, reason: "the context is too full" }),
    ).next({ ...nextRequest(), requireResume: true });
    expect(outcome).toMatchObject({ kind: "notResumed" });
    expect(intentStates(ids)).toEqual([
      ["pending", null],
      ["pending", null],
      ["pending", null],
    ]);
  });
});

describe("the prompts of a box worker's next session (DIPO-272)", () => {
  it("a run directory with the box record gets the box contract and the box scope section", async () => {
    firstSession();
    const runDir = join(w.dir, "git", "dipo", "runs", w.f.run);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, BOX_RUN_FILE), JSON.stringify({ runId: w.f.run, box: "dipo-x" }));
    const outcome = await realResumer(
      hosts,
      { probe: async () => null, story: async () => storyOf(), handoff, workspace },
      () => ({ ok: false, reason: "the context is too full" }),
    ).next(nextRequest());
    expect(outcome).toMatchObject({ kind: "started", resumed: false });
    const system = readFileSync(preparedSpecs.at(-1)?.systemFile ?? "", "utf8");
    expect(system).toBe(renderSystemFile("implement-box", "developer"));
    const text = sentText();
    expect(text).toContain(
      "The paths the planner expects this story to change (a forecast, not a fence):",
    );
    expect(text).not.toContain("You may write only these paths");
  });

  it("starts the next session in the run's box when the box is there, and every session is a box session with box workers (DIPO-278)", async () => {
    firstSession();
    const asked: string[] = [];
    const boxes = {
      has: async (runId: string) => {
        asked.push(`has ${runId}`);
        return "ready" as const;
      },
    } as unknown as RunBoxes;
    const outcome = await realResumer(
      hosts,
      { probe: async () => null, story: async () => storyOf(), handoff, workspace, boxes },
      () => ({ ok: false, reason: "the context is too full" }),
    ).next(nextRequest());
    expect(outcome).toMatchObject({ kind: "started", resumed: false });
    expect(asked).toEqual([`has ${w.f.run}`]);
    // No box record in the run directory, yet the box contract: every developer is a box worker.
    const system = readFileSync(preparedSpecs.at(-1)?.systemFile ?? "", "utf8");
    expect(system).toBe(renderSystemFile("implement-box", "developer"));
  });

  it("starts nothing when a lost box cannot be rebuilt, and says why (DIPO-278)", async () => {
    firstSession();
    const boxes = { has: async () => "gone" as const } as unknown as RunBoxes;
    const outcome = await realResumer(
      hosts,
      { probe: async () => null, story: async () => storyOf(), handoff, workspace, boxes },
      () => ({ ok: false, reason: "the context is too full" }),
    ).next(nextRequest());
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" ? outcome.reason : "").toContain(
      "the run's box could not be made ready: the delivered parts of",
    );
  });
});

describe("the merges dipo made outside the box reach it before the worker (DIPO-324)", () => {
  it("copies them into the box after the box is ready and before the launch checks and the host", async () => {
    firstSession();
    const order: string[] = [];
    const before = preparedSpecs.length;
    const boxes = {
      has: async () => {
        order.push("box ready");
        return "ready" as const;
      },
    } as unknown as RunBoxes;
    const outcome = await realResumer(
      hosts,
      {
        probe: async () => null,
        story: async () => storyOf(),
        handoff,
        workspace,
        boxes,
        boxSync: async (_office, run) => {
          order.push(`copy ${run.runId} after ${preparedSpecs.length - before} launch checks`);
        },
      },
      () => ({ ok: false, reason: "the context is too full" }),
    ).next(nextRequest());
    expect(outcome).toMatchObject({ kind: "started" });
    expect(order).toEqual(["box ready", `copy ${w.f.run} after 0 launch checks`]);
    expect(preparedSpecs.length).toBe(before + 1);
  });

  it("starts no worker when the copy fails, and says why, so the caller parks the story", async () => {
    firstSession();
    const before = preparedSpecs.length;
    const boxes = { has: async () => "ready" as const } as unknown as RunBoxes;
    const outcome = await realResumer(
      hosts,
      {
        probe: async () => null,
        story: async () => storyOf(),
        handoff,
        workspace,
        boxes,
        boxSync: async () => {
          throw new Error("the box is gone");
        },
      },
      () => ({ ok: false, reason: "the context is too full" }),
    ).next(nextRequest());
    expect(outcome).toEqual({
      kind: "failed",
      reason: "dipo's merge on the story branch could not be copied into the box: the box is gone",
    });
    expect(preparedSpecs.length).toBe(before);
  });
});

const tooFull = () => ({ ok: false as const, reason: "the context is too full" });

describe("the prompt texts of a resume and a handoff (DIPO-137)", () => {
  const noPrompts: OfficeConfig = {
    ...OFFICE_DEFAULTS,
    privacy: { ...OFFICE_DEFAULTS.privacy, storePrompts: false },
  };
  const facts = { probe: async () => null, story: async () => storyOf(), handoff, workspace };

  it("a resume stores only its first message, under the resumed session's agent", async () => {
    firstSession();
    const outcome = await realResumer(hosts, facts).next(nextRequest());
    expect(outcome).toMatchObject({ kind: "started", resumed: true });
    const agent = (outcome as { agent: string }).agent;
    expect(promptTextsOf(w.f.office, w.f.run, agent)).toEqual([
      { part: "message", text: sentText() },
    ]);
    expect(promptTextsOf(w.f.office, w.f.run, w.f.agent)).toEqual([]);
  });

  it("a handoff stores its system file and its handoff message, under the new agent", async () => {
    firstSession();
    const outcome = await realResumer(hosts, facts, () => ({
      ok: false,
      reason: "the context is too full",
    })).next(nextRequest());
    expect(outcome).toMatchObject({ kind: "started", resumed: false });
    const agent = (outcome as { agent: string }).agent;
    expect(promptTextsOf(w.f.office, w.f.run, agent)).toEqual([
      { part: "system", text: readFileSync(preparedSpecs.at(-1)?.systemFile ?? "", "utf8") },
      { part: "message", text: sentText() },
    ]);
  });

  it("stores nothing with storePrompts off", async () => {
    firstSession();
    const resumed = await realResumer(hosts, facts, undefined, noPrompts).next(nextRequest());
    expect(resumed).toMatchObject({ kind: "started" });
    expect(w.f.office.all("select * from prompt_texts where office_id = $office_id")).toEqual([]);
    // The measurement is not the text: the parts are still recorded.
    expect(promptPartsOf(w.f.office, w.f.run, (resumed as { agent: string }).agent)).not.toEqual(
      [],
    );
  });
});

describe("a later session keeps the model and effort its run started with (DIPO-207)", () => {
  /** The office's tier M edited after the run started: another model, effort high. */
  const EDITED: OfficeConfig = {
    ...OFFICE_DEFAULTS,
    tiers: {
      ...OFFICE_DEFAULTS.tiers,
      M: { ...OFFICE_DEFAULTS.tiers.M, model: "opus", effort: "high" },
    },
  };

  /** The run's first developer agent crashed with `effort` recorded; the next session resumes. */
  async function resumeWith(effort: string | null) {
    beforeRestart("terminated", 0);
    w.f.office.immediate(() =>
      w.f.office.run(
        `update agents set end_reason = 'crashed', session_id = 'session-1', role = 'developer',
           effort = $effort where office_id = $office_id and agent_id = $agent`,
        { agent: w.f.agent, effort },
      ),
    );
    const runDir = join(w.dir, "git", "dipo", "runs", w.f.run);
    mkdirSync(runDir, { recursive: true });
    copyFileSync(w.f.eventFile, join(runDir, "events.ndjson"));
    const resumer = realResumer(
      {
        start: async (office, options) => {
          const host = {
            pid: 4243,
            startTimeMs: 0,
            runId: options.runId,
            agentId: options.agentId,
            socketPath: join(w.dir, "host.sock"),
            protocolVersion: 1,
            runDir,
            eventFile: join(runDir, "events.ndjson"),
          };
          recordWorkerHost(office, host, w.f.t.clock, {
            ...(options.processedOffset === undefined
              ? {}
              : { processedOffset: options.processedOffset }),
            ...(options.record === undefined ? {} : { record: options.record }),
          });
          return host;
        },
      },
      { probe: async () => null },
      () => ({ ok: true }),
      EDITED,
    );
    const outcome = await resumer.next(nextRequest());
    expect(outcome.kind).toBe("started");
    const agent = w.f.office.get<{ model: string; effort: string | null }>(
      `select model, effort from agents where office_id = $office_id and agent_id != $first
        and run_id = $run`,
      { first: w.f.agent, run: w.f.run },
    );
    return { spec: preparedSpecs.at(-1), agent };
  }

  it("resumes with the start model and effort after the tier was edited (AC #1, AC #4)", async () => {
    const { spec, agent } = await resumeWith("medium");
    expect(spec?.model).toBe("haiku");
    expect(spec?.effort).toBe("medium");
    expect(agent).toEqual({ model: "haiku", effort: "medium" });
  });

  it("uses the run's tier in force when the first developer agent has no effort (AC #3)", async () => {
    const { spec, agent } = await resumeWith(null);
    expect(spec?.model).toBe("haiku");
    expect(spec?.effort).toBe("high");
    expect(agent).toEqual({ model: "haiku", effort: "high" });
  });
});

/** A worktree git for the default handoff gather: no commits, no changes. */
const quietGit = () =>
  ({
    commonDir: join(w.dir, "git"),
    mainWorktree: w.dir,
    worktreeLocation: (path: string) => ({ kind: "worktree", workTree: path }),
    run: async <T>(fn: (session: { ok: () => Promise<string> }) => Promise<T>) =>
      fn({ ok: async () => "" }),
  }) as unknown as ReturnType<NonNullable<ConstructorParameters<typeof RunResumer>[0]["git"]>>;
const branchOf = () => findRun(w.f.office, w.f.run)?.branch ?? "";

/** 0019's `feedback_items` as DIPO-148's migration 43 makes it, when this database lacks it. */
function feedbackTable(): void {
  w.f.t.state.connection.exec(
    `create table if not exists feedback_items (
       office_id text not null, run_id text not null, item_id integer not null,
       source text not null, signature text not null, head_sha text not null,
       round integer not null, repeat integer not null, intent_id integer not null,
       sent_at integer, text text not null, created_at integer not null,
       primary key (office_id, run_id, item_id)) strict`,
  );
}

describe("the handoff of a new session: notes, open feedback and the context pack (DIPO-154)", () => {
  it("lists the run's open feedback items with their text, and adds the resume note and the stored notes", async () => {
    firstSession();
    feedbackTable();
    const { office, run } = w.f;
    const item = (id: number, source: string, text: string, at: number) =>
      office.run(
        `insert into feedback_items (office_id, run_id, item_id, source, signature, head_sha,
           round, repeat, intent_id, sent_at, text, created_at)
         values ($office_id, $run, $id, $source, $sig, $head, 1, 0, 1, $at, $text, $at)`,
        { run, id, source, sig: `sig-${id}`, head: "e".repeat(40), text, at },
      );
    office.immediate(() => {
      item(2, "ci", "Required check ci-ok failed on the pushed head.\njob log tail", 300);
      item(3, "review", "Blocking finding: greet.ts drops the name.", 400);
    });
    recordWorkerNotes(
      office,
      {
        branch: branchOf(),
        run,
        agent: w.f.agent,
        role: "developer",
        notes: "Next: the CI fix.",
      },
      w.f.t.clock,
    );
    const outcome = await realResumer(
      hosts,
      { probe: async () => null, story: async () => storyOf(), workspace, git: quietGit },
      tooFull,
    ).next(nextRequest());
    expect(outcome).toMatchObject({ kind: "started", resumed: false });
    expect(sentText()).toContain(
      [
        "Open feedback:",
        "- Required check ci-ok failed on the pushed head.",
        "- Blocking finding: greet.ts drops the name.",
        "Notes from the previous session:",
        "Next: the CI fix.",
        "Budget: 0 turns used, no turns limit; 0 minutes used, no minutes limit; 0 tokens used, 1,000,000 left.",
        "</handoff>",
      ].join("\n"),
    );
  });

  it("answers findings and rejects by an approval or override, and leaves failures listed (DIPO-342)", async () => {
    firstSession();
    feedbackTable();
    const { office, run } = w.f;
    const item = (id: number, source: string, text: string, at: number) =>
      office.run(
        `insert into feedback_items (office_id, run_id, item_id, source, signature, head_sha,
           round, repeat, intent_id, sent_at, text, created_at)
         values ($office_id, $run, $id, $source, $sig, $head, 1, 0, 1, $at, $text, $at)`,
        { run, id, source, sig: `sig-${id}`, head: "e".repeat(40), text, at },
      );
    const texts = () => openFeedbackOf(office, run).map((open) => open.text);
    office.immediate(() => {
      item(1, "ci", "Red CI on the head.", 10);
      item(2, "review", "Blocking finding: no test for the empty name.", 10);
      item(3, "reject", "The maintainer: keep the old flag.", 10);
      item(4, "conflict", "Conflict in src/greet.ts.", 10);
    });
    // dipo stores no verify result of its own, so nothing answers a failure yet.
    expect(texts()).toEqual([
      "Red CI on the head.",
      "Blocking finding: no test for the empty name.",
      "The maintainer: keep the old flag.",
      "Conflict in src/greet.ts.",
    ]);
    // An approval answers the findings and the reject, never a red CI item stored after it.
    office.immediate(() => {
      item(5, "ci", "Red CI on the next head.", 30);
      office.run(
        `insert into review_verdicts (office_id, gate_id, run_id, key, round, agent_id, model,
           commit_sha, code_tree_key, verdict, criteria, findings, summary, validation_notes,
           decided_at)
         values ($office_id, 'gat_1', $run, $key, 1, null, 'opus', $head, 't', 'approved', '[]',
           '[]', 'ok', '[]', 20)`,
        { run, key: w.work.key, head: "f".repeat(40) },
      );
    });
    expect(texts()).toEqual([
      "Red CI on the head.",
      "Conflict in src/greet.ts.",
      "Red CI on the next head.",
    ]);
    // A maintainer override past a blocked verdict answers a later finding too.
    office.immediate(() => {
      item(6, "review", "Blocking finding: the docs are stale.", 40);
      office.run(
        `insert into review_verdicts (office_id, gate_id, run_id, key, round, agent_id, model,
           commit_sha, code_tree_key, verdict, criteria, findings, summary, validation_notes,
           override_note, override_at, decided_at)
         values ($office_id, 'gat_2', $run, $key, 2, null, 'opus', $head, 't2', 'blocked', '[]',
           '[]', 'no', '[]', 'ship it', 50, 45)`,
        { run, key: w.work.key, head: "f".repeat(40) },
      );
    });
    expect(texts()).toEqual([
      "Red CI on the head.",
      "Conflict in src/greet.ts.",
      "Red CI on the next head.",
    ]);
  });

  it("records the context pack of a new session's task message, and none for a resume", async () => {
    firstSession();
    const facts = { probe: async () => null, story: async () => storyOf(), handoff, workspace };
    const resumed = await realResumer(hosts, facts).next(nextRequest());
    expect(resumed).toMatchObject({ kind: "started", resumed: true });
    expect(contextPackOf(w.f.office, branchOf())).toBeNull();

    const fresh = await realResumer(hosts, facts, tooFull).next(nextRequest());
    expect(fresh).toMatchObject({ kind: "started", resumed: false });
    const pack = contextPackOf(w.f.office, branchOf());
    // The head the pack read and the blob id of the scope file it holds (0014 section 10).
    expect(pack?.headSha).toBe("0".repeat(40));
    expect(pack?.blobIds).toEqual({
      "src/new.ts": gitBlobId(Buffer.from("export const fresh = 1;\n")),
    });
  });

  it("a box run's handoff says its changes are in the box and reads no worktree diff", async () => {
    firstSession();
    const runDir = join(w.dir, "git", "dipo", "runs", w.f.run);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, BOX_RUN_FILE), JSON.stringify({ runId: w.f.run, box: "dipo-x" }));
    const asked: string[][] = [];
    const git = () =>
      ({
        ...quietGit(),
        run: async <T>(
          fn: (session: { ok: (l: unknown, a: string[]) => Promise<string> }) => Promise<T>,
        ) =>
          fn({
            ok: async (_location, args) => {
              asked.push(args);
              return args[0] === "log" ? "abc1234 the first part" : " M reversed.ts";
            },
          }),
      }) as unknown as ReturnType<typeof quietGit>;
    const outcome = await realResumer(
      hosts,
      { probe: async () => null, story: async () => storyOf(), workspace, git },
      tooFull,
    ).next(nextRequest());
    expect(outcome).toMatchObject({ kind: "started", resumed: false });
    // The branch's commits, then its tip for the context pack: nothing of a worktree (DIPO-349).
    expect(asked.map((args) => args[0])).toEqual(["log", "rev-parse"]);
    expect(sentText()).toContain("Commits on this branch:\nabc1234 the first part\n");
    expect(sentText()).toContain(`Changes not delivered yet:\n${BOX_CHANGES}\n`);
    expect(sentText()).toContain(`Last verify result:\n${BOX_VERIFY}\n`);
  });
});
