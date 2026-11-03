// Where a maintainer steer was lost, and that it now reaches the developer (DIPO-412).
//
// The M1 hand tests of 2026-11-01 lost two of two steers, each `sent` and never resolved. The live
// probe (Claude Code 2.1.316, Haiku) showed what Claude Code does with a priority-`next` message:
// one that comes while a tool call runs is read right after the call, in the same turn; one that
// comes after the turn's last tool call is read only after the turn's result, as the first
// message of a new turn. The path from `work.steer` to the worker's stdin is whole: the real host
// writes every later line to the worker (below), and `container exec --interactive` forwards it
// (`box-plan.test.ts`, and the opt-in `real-box.box.test.ts`). The steer was lost after that: run
// control took the done report of the turn that ended before the session read the steer, ran
// verify and commit and closed stdin, so the turn the steer started was never taken, and nothing
// marked a steer read or carried an unread one to a next session.
//
// The first test runs that path for real: `work.steer` through the executor, run control's real
// host steering over the socket of a real worker host in this process, whose worker is a real
// process (`queue-worker.ts`) that takes queued messages as Claude Code does, and the real
// ingestion with the Claude parser. The others drive run control's events directly.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  type CommandReply,
  type OfficeId,
  RequestId,
  StoryId,
  type WorkRef,
} from "@dipsaus-orchestrator/contract";

import { executeCommand } from "../../src/commands/execute";
import { stateOfficeDirectory } from "../../src/commands/offices";
import { buildRegistry } from "../../src/commands/registry";
import { MemoryRequestTable } from "../../src/commands/requests";
import { WorkerHost } from "../../src/host/main";
import { LAUNCH_FILE, type HostLaunch } from "../../src/host/protocol";
import { type IngestAdapter, Ingestor } from "../../src/ingest/ingestor";
import { systemClock } from "../../src/platform/clock";
import { systemSpawn } from "../../src/platform/process";
import { endRun, insertRun, runIntents } from "../../src/records";
import { addStory } from "../../src/records/story-keys";
import { RunControl } from "../../src/run";
import { STEER_READ_WAIT_MS } from "../../src/run/control-types";
import { heldFeedback } from "../../src/run/feedback";
import { hostSocketSteering } from "../../src/run/hosts";
import { steerText } from "../../src/run/intervene";
import { encode, userMessageLine } from "../../src/workers/claude-cli/encode";
import { initialState, interpret } from "../../src/workers/claude-cli/interpret";
import type { HostOp, ParseState, WorkerEvent, WorkerReport } from "../../src/workers/types";
import { insertClaim } from "../../src/worktree/records";
import { ingestFixture, type IngestFixture, loggedEvents, target } from "../ingest/helpers";
import { backlogLayout } from "../story-store/backlog";

const QUEUE_WORKER = resolve(import.meta.dir, "../host/fixtures/queue-worker.ts");

const claude: IngestAdapter = {
  interpret: (line, state) =>
    interpret(line, state as unknown as ReturnType<typeof initialState>) as unknown as {
      events: [];
      state: ParseState;
    },
};

interface World {
  readonly dir: string;
  readonly f: IngestFixture;
  readonly work: WorkRef;
  /** The summary of every report the finisher took, in order. */
  readonly taken: string[];
  /** Ops sent by the steering fake of the event-driven tests. */
  readonly sent: HostOp[][];
}

let w: World;
let requests = 0;
const hosts: WorkerHost[] = [];

beforeEach(async () => {
  const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "steer412-"));
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
      budgetLimit: 1_000_000,
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
    // The live developer session the steer goes to.
    office.run(
      `insert into agents (office_id, agent_id, run_id, role, model, session_id, started_at)
       values ($office_id, $agent, $run, 'developer', 'haiku', 'session-412', $at)`,
      { agent: f.agent, run, at: f.t.clock.now() },
    );
  });
  w = { dir, f, work: { ...f.work, key }, taken: [], sent: [] };
});

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    host.terminate();
    await host.done.catch(() => undefined);
  }
  w.f.t.state.close();
  rmSync(w.dir, { recursive: true, force: true });
});

/**
 * Run control with a finisher that takes each done report and ends the run at In Review; with
 * `gate` the finisher waits for it, as verify and commit take their time.
 */
function control(
  steering: ConstructorParameters<typeof RunControl>[0]["steering"],
  options: {
    readonly caps?: { budgetTokens: number; maxTurns: number; maxMinutes: number };
    readonly startedAt?: number;
    readonly gate?: Promise<void>;
    readonly entered?: () => void;
  } = {},
): RunControl {
  const made = new RunControl({
    stories: backlogLayout,
    clock: w.f.t.clock,
    offices: { get: () => w.f.office },
    writer: { write: async () => Promise.reject(new Error("no park expected")) },
    steering,
    encode,
    finisher: {
      afterTurn: async (ctx) => {
        w.taken.push(ctx.report?.summary ?? "(no report)");
        options.entered?.();
        await options.gate;
        return { kind: "ended" };
      },
      summarize: async () => undefined,
    },
  });
  made.track(w.f.office.officeId, {
    runId: w.f.run,
    work: w.work,
    caps: options.caps ?? { budgetTokens: 1_000_000, maxTurns: 90, maxMinutes: 45 },
    startedAt: options.startedAt ?? w.f.t.clock.now(),
  });
  return made;
}

async function steer(made: RunControl, text: string): Promise<CommandReply> {
  requests += 1;
  return await executeCommand(
    {
      registry: buildRegistry([made.feature]),
      offices: stateOfficeDirectory(w.f.t.state),
      clock: w.f.t.clock,
      ids: w.f.t.ids,
      softwareRequests: new MemoryRequestTable(w.f.t.clock),
    },
    {
      requestId: RequestId.parse(
        `01J9ZK5Q8W3V4X6Y7Z${(41_200 + requests).toString().padStart(8, "0")}`,
      ),
      name: "work.steer",
      args: { story: "DIPO-1", text },
      origin: "cli",
      confirmed: true,
      office: w.f.office.officeId as OfficeId,
    },
  );
}

function steerStates(): [string, string | null][] {
  return runIntents(w.f.office, w.f.run)
    .filter((intent) => intent.kind === "steer")
    .map((intent) => [intent.state, intent.outcome]);
}

function noticeCodes(): string[] {
  return loggedEvents(w.f.office)
    .filter((event) => event.type === "engine.notice")
    .map((event) => (event.data as { code: string }).code)
    .filter((code) => code.startsWith("run."));
}

describe("a steer through the real worker host to a session that queues it (AC #1)", () => {
  it("reaches the worker's stdin after its first message, is read in its turn or right after it, and the turn it starts decides", async () => {
    const { dir, f } = w;
    const gates = join(dir, "gates");
    mkdirSync(gates);
    const launch: HostLaunch = {
      version: 1,
      run: f.run,
      agent: f.agent,
      socket: join(dir, "host.sock"),
      deadline: systemClock.now() + 3_600_000,
      plan: {
        argv: [process.execPath, QUEUE_WORKER],
        env: { QUEUE_GATES: gates, PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
        cwd: dir,
        files: [],
        stdin: [userMessageLine("The task.")],
      },
    };
    writeFileSync(join(dir, LAUNCH_FILE), JSON.stringify(launch), { mode: 0o600 });
    const host = WorkerHost.start({
      runId: f.run,
      runDir: dir,
      clock: systemClock,
      spawn: systemSpawn,
      killGroup: () => {},
      pid: process.pid,
    });
    hosts.push(host);

    const made = control(hostSocketSteering({ clock: systemClock }));
    // Every event the ingestion passes hand run control, kept for the checks below.
    const events: WorkerEvent[] = [];
    const hooks = made.hooks;
    const watching = new Ingestor({
      office: f.office,
      clock: f.t.clock,
      hooks: {
        ...hooks,
        onWorkerEvents: (run, agent, list) => {
          events.push(...list);
          hooks.onWorkerEvents?.(run, agent, list);
        },
      },
    });
    watching.track(
      target(f, claude, initialState({ plannedModel: "haiku" }) as unknown as ParseState),
    );
    const pass = async (what: string, check: () => boolean): Promise<void> => {
      const end = performance.now() + 15_000;
      for (;;) {
        watching.pass(f.run, f.agent);
        await made.idle();
        if (check()) return;
        if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(10);
      }
    };
    let exited = false;
    void host.done.then(() => {
      exited = true;
    });
    try {
      const read = () => events.flatMap((event) => (event.t === "messageRead" ? [event.text] : []));
      await pass("the Bash call", () =>
        events.some((event) => event.t === "activity" && event.tool === "Bash"),
      );

      // Steer A while the Bash call runs: written to the worker's stdin after its first line.
      const a = await steer(made, "Add a JSDoc.");
      expect(a.ok ? a.result : a.error).toEqual({ run: f.run, delivered: "next-turn" });
      expect(steerStates()).toEqual([["sent", null]]);
      writeFileSync(join(gates, "tool-done"), "");
      await pass("steer A read", () => read().includes(steerText("Add a JSDoc.")));
      // Read in the running turn: resolved read, with a notice for `dipo watch`.
      expect(steerStates()).toEqual([["resolved", "read"]]);

      // Steer B after the turn's last tool call: the session reads it only after the result.
      const b = await steer(made, "Also test it.");
      expect(b.ok).toBe(true);
      writeFileSync(join(gates, "answer"), "");
      await pass("the run's end at In Review", () => w.taken.length > 0);
      // The In Review end closed the worker's stdin through the host, so it exits.
      await pass("the worker's exit", () => exited);

      // Turn 1 waits and the turn B started decides; a finisher that took turn 1's report
      // (A only) and closed stdin would never take turn B (DIPO-412).
      expect(w.taken).toEqual([`read: ${steerText("Also test it.")}`]);
      expect(read()).toEqual(["The task.", steerText("Add a JSDoc."), steerText("Also test it.")]);
      expect(
        events.filter((event) => event.t === "turn").map((event) => event.report?.summary),
      ).toEqual([
        `read: The task. | ${steerText("Add a JSDoc.")}`,
        `read: ${steerText("Also test it.")}`,
      ]);
      expect(steerStates()).toEqual([
        ["resolved", "read"],
        ["resolved", "read"],
      ]);
      expect(noticeCodes()).toEqual(["run.steerRead", "run.steerAwaited", "run.steerRead"]);
    } finally {
      watching.close();
      made.close();
    }
  }, 30_000);
});

/** A steering fake that records the ops. */
function recording(): ConstructorParameters<typeof RunControl>[0]["steering"] {
  return {
    send: async (_office, _run, ops) => {
      w.sent.push([...ops]);
      return { ok: true };
    },
  };
}

const report = (summary: string): WorkerReport => ({
  status: "done",
  criteria: [{ n: 1, met: true, evidence: "the test" }],
  summary,
  commitSubject: "Do the story",
});

const doneTurn = (summary: string): WorkerEvent => ({
  t: "turn",
  report: report(summary),
  totals: {},
  numTurns: 2,
  terminal: "completed",
});

describe("a done turn while a steer is unread (AC #1, #3)", () => {
  it("is taken after all when the session reads no steer within the wait, and the steer goes with the next session", async () => {
    const made = control(recording());
    try {
      const reply = await steer(made, "Add a JSDoc.");
      expect(reply.ok).toBe(true);
      made.onWorkerEvents(w.f.run, [doneTurn("turn 1")]);
      await made.idle();
      expect(w.taken).toEqual([]);
      w.f.t.clock.advance(STEER_READ_WAIT_MS);
      await made.idle();
      expect(w.taken).toEqual(["turn 1"]);
      // Unread, so the run's next developer session carries it.
      expect(steerStates()).toEqual([["sent", null]]);
      expect(heldFeedback(w.f.office, w.f.run)).toMatchObject({
        texts: [steerText("Add a JSDoc.")],
        unread: 1,
      });
    } finally {
      made.close();
    }
  });

  it("is taken before the exit when the worker exits first", async () => {
    const made = control(recording());
    try {
      expect((await steer(made, "Add a JSDoc.")).ok).toBe(true);
      made.onWorkerEvents(w.f.run, [doneTurn("turn 1")]);
      made.onEnded(w.f.run);
      await made.idle();
      expect(w.taken).toEqual(["turn 1"]);
      expect(heldFeedback(w.f.office, w.f.run).unread).toBe(1);
    } finally {
      made.close();
    }
  });

  it("is taken at once when every steer was read before it", async () => {
    const made = control(recording());
    try {
      expect((await steer(made, "Add a JSDoc.")).ok).toBe(true);
      made.onWorkerEvents(w.f.run, [
        { t: "messageRead", text: steerText("Add a JSDoc.") },
        doneTurn("turn 1"),
      ]);
      await made.idle();
      expect(w.taken).toEqual(["turn 1"]);
      expect(steerStates()).toEqual([["resolved", "read"]]);
      expect(noticeCodes()).toEqual(["run.steerRead"]);
    } finally {
      made.close();
    }
  });
});

/**
 * A steer's replay exactly as Claude Code 2.1.316 printed it (live, Haiku, 2026-11-01), for the
 * steer `work.steer` sends as "add a JSDoc." (review of DIPO-412).
 */
const REAL_REPLAY =
  '{"type":"user","message":{"role":"user","content":"The maintainer says: add a JSDoc."},"session_id":"be169cce-4001-4803-8d82-a538b1dbe0ca","parent_tool_use_id":null,"uuid":"c06eac8c-0bce-4070-9f23-4f028fe74a7e","timestamp":"2026-11-01T18:38:24.010Z","isReplay":true}';

describe("the review of DIPO-412", () => {
  it("reads the steer in a real replayed line of Claude Code 2.1.316", async () => {
    const made = control(recording());
    try {
      expect((await steer(made, "add a JSDoc.")).ok).toBe(true);
      const step = interpret(
        { t: 0, ch: "stdout", data: REAL_REPLAY },
        initialState({ plannedModel: "haiku" }),
      );
      expect(step.events).toEqual([{ t: "messageRead", text: steerText("add a JSDoc.") }]);
      made.onWorkerEvents(w.f.run, step.events);
      expect(steerStates()).toEqual([["resolved", "read"]]);
    } finally {
      made.close();
    }
  });

  it("holds a steer sent while verify and commit run for the next session, and closes it with a notice when the run goes Done", async () => {
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    const { promise: entered, resolve: enter } = Promise.withResolvers<void>();
    const made = control(recording(), { gate, entered: enter });
    try {
      made.onWorkerEvents(w.f.run, [doneTurn("turn 1")]);
      await entered;
      const reply = await steer(made, "Add a JSDoc.");
      // Nothing reaches the idle session, which would start a turn with it during the commit.
      expect(reply.ok ? reply.result : reply.error).toEqual({
        run: w.f.run,
        delivered: "on-resume",
      });
      expect(w.sent).toEqual([]);
      open();
      await made.idle();
      expect(w.sent).toEqual([[{ closeStdin: true }]]);
      // A next developer session (a fix round) would carry it.
      expect(heldFeedback(w.f.office, w.f.run).texts).toEqual([steerText("Add a JSDoc.")]);
      // The run goes Done instead: the steer ends unread, with a notice for `dipo watch`.
      w.f.office.immediate(() => endRun(w.f.office, w.f.run, w.f.t.clock.now(), "done"));
      expect(steerStates()).toEqual([["resolved", "unread"]]);
      expect(noticeCodes()).toEqual(["run.steerUnread"]);
    } finally {
      open();
      made.close();
    }
  });

  it("lets the exit decide, not the held report, when the worker exits after it read the steer", async () => {
    const made = control(recording());
    try {
      expect((await steer(made, "Add a JSDoc.")).ok).toBe(true);
      made.onWorkerEvents(w.f.run, [
        doneTurn("turn 1"),
        // Read after the result: the steer's turn began and edits the tree.
        { t: "messageRead", text: steerText("Add a JSDoc.") },
      ]);
      made.onEnded(w.f.run);
      await made.idle();
      // Turn 1's report is not committed with the steer turn's half-made edits.
      expect(w.taken).toEqual([]);
      expect(steerStates()).toEqual([["resolved", "read"]]);
    } finally {
      made.close();
    }
  });

  it("takes the held report on the capped done path when a cap fires while no steer was read", async () => {
    const at = w.f.t.clock.now();
    const made = control(recording(), {
      caps: { budgetTokens: 1_000_000, maxTurns: 90, maxMinutes: 1 },
      // A minute of the run's one-minute cap is used up once the turn is held.
      startedAt: at - 60_000,
    });
    try {
      expect((await steer(made, "Add a JSDoc.")).ok).toBe(true);
      made.onWorkerEvents(w.f.run, [doneTurn("turn 1")]);
      await made.idle();
      expect(w.taken).toEqual([]);
      // The minute cap fires as the turn waits, before the wait ends.
      expect(made.checkCaps(w.f.run)).toBe(true);
      await made.idle();
      // As a done report on a crossing turn (DIPO-205): verify and commit, no cap park.
      expect(w.taken).toEqual(["turn 1"]);
      // No cap park: the run ended at In Review, closing stdin after the steer it sent.
      expect(w.sent.at(-1)).toEqual([{ closeStdin: true }]);
    } finally {
      made.close();
    }
  });
});
