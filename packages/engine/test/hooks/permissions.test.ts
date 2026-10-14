// The permission wait (DIPO-59 AC #4 to #7 and #9; 0008 section 5): the `permission-wait`
// scenario replayed through the real ingestion and the Claude CLI parser into `PermissionAsks`, on
// a migrated state database and the manual clock, with a fake presence and a steering fake that
// records what reaches the worker host. Until the maintainer captures `permission-wait` live
// (AC #8), the scenario is `permission-denied` with a `PermissionRequest` hook line put before the
// denial, as 0017 allows for a derived recording.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type ChildExit,
  type ChildProcess,
  type CommandReply,
  type Spawn,
  type OfficeId,
  type OfficeSnapshot,
  RequestId,
  StoryId,
  type StoryKey,
} from "@dipsaus-orchestrator/contract";
import { readRecording } from "@dipsaus-orchestrator/testkit";

import { executeCommand } from "../../src/commands/execute";
import { stateOfficeDirectory } from "../../src/commands/offices";
import { buildRegistry } from "../../src/commands/registry";
import { MemoryRequestTable } from "../../src/commands/requests";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import { findQuestion, openQuestions } from "../../src/hooks/questions";
import { PermissionAsks, type Presence } from "../../src/hooks/permissions";
import { connectHost } from "../../src/host/client";
import { WorkerHost } from "../../src/host/main";
import { type HostLaunch, LAUNCH_FILE } from "../../src/host/protocol";
import { relayHookPayload } from "../../src/host/relay";
import { systemClock } from "../../src/platform/clock";
import { hostSocketSteering } from "../../src/run/hosts";
import { HOST_WAIT_MARGIN_SECONDS } from "../../src/workers/claude-cli/hooks";
import { type IngestAdapter, Ingestor } from "../../src/ingest/ingestor";
import { insertRun } from "../../src/run";
import { addStory } from "../../src/stories/keys";
import { detail, snapshot } from "../../src/views/feature";
import { workView } from "../../src/views/work";
import { encode } from "../../src/workers/claude-cli/encode";
import { initialState, interpret } from "../../src/workers/claude-cli/interpret";
import type { HostLine, HostOp, ParseState } from "../../src/workers/types";
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
    interpret(line, state as unknown as ReturnType<typeof initialState>) as unknown as {
      events: [];
      state: ParseState;
    },
};

const WAIT_SECONDS = OFFICE_DEFAULTS.timeouts.permissionWaitSeconds;

/** The `permission-wait` scenario's host lines, split after the `PermissionRequest` hook line. */
function scenario(): { before: HostLine[]; after: HostLine[] } {
  const live = join(RECORDINGS_DIR, "permission-wait");
  if (existsSync(join(live, "meta.json"))) {
    const lines = hostLines(readRecording(live));
    const at = lines.findIndex(
      (line) => line.ch === "hook" && line.data.includes('"PermissionRequest"'),
    );
    return { before: lines.slice(0, at + 1), after: lines.slice(at + 1) };
  }
  const lines = hostLines(readRecording(join(RECORDINGS_DIR, "permission-denied")));
  const at = lines.findIndex((line) => line.data.includes('"permission_denied"'));
  const denial = lines[at] as HostLine;
  const hook: HostLine = {
    t: denial.t - 1,
    ch: "hook",
    data: JSON.stringify({
      session_id: "session-1",
      hook_event_name: "PermissionRequest",
      tool_name: "Write",
      tool_input: { file_path: "${ROOT}/repo.worktrees/outside.txt", content: "x" },
    }),
  };
  return { before: [...lines.slice(0, at), hook], after: lines.slice(at) };
}

interface World {
  readonly dir: string;
  readonly f: IngestFixture;
  readonly asks: PermissionAsks;
  readonly sent: HostOp[][];
  readonly key: StoryKey;
  config: OfficeConfig;
  connected: boolean;
  lastRequestAt: number | null;
  ending: boolean;
  ingestor: Ingestor | null;
}

let w: World;

beforeEach(async () => {
  const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "permission-"));
  const f = await ingestFixture(dir);
  const sent: HostOp[][] = [];
  const world = {
    dir,
    f,
    sent,
    config: OFFICE_DEFAULTS,
    connected: true,
    lastRequestAt: f.t.clock.now(),
    ending: false,
    ingestor: null,
  } as unknown as World;
  const presence: Presence = {
    connected: () => world.connected,
    lastRequestAt: () => world.lastRequestAt,
  };
  (world as { asks: PermissionAsks }).asks = new PermissionAsks({
    clock: f.t.clock,
    ids: f.t.ids,
    offices: { get: () => f.office, config: () => world.config },
    steering: {
      send: async (_office, _run, ops) => {
        sent.push([...ops]);
        return { ok: true };
      },
    },
    encode,
    presence,
    ending: () => world.ending,
  });
  const { office } = f;
  const { key } = office.immediate(() =>
    addStory(office, f.t.ids, { story: StoryId.parse("DIPO-1") }, f.t.clock.now()),
  );
  (world as { key: StoryKey }).key = key;
  (f as { work: unknown }).work = { ...f.work, key };
  office.immediate(() =>
    insertRun(office, {
      runId: f.run,
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
      budgetLimit: 1_000_000,
      loopCap: 3,
      reviewRoundCap: null,
      configHash: "h",
      overrideKeys: null,
      runProfileId: null,
      startedAt: f.t.clock.now(),
    }),
  );
  w = world;
});

afterEach(async () => {
  await w.asks.idle();
  w.asks.close();
  w.ingestor?.close();
  w.f.t.state.close();
  rmSync(w.dir, { recursive: true, force: true });
});

/** Ingests `lines` with the permission wait hearing every pass and the exit. */
async function ingest(lines: readonly HostLine[]): Promise<void> {
  appendLines(w.f.eventFile, lines);
  if (w.ingestor === null) {
    const office = w.f.office;
    w.ingestor = new Ingestor({
      office,
      clock: w.f.t.clock,
      pricing: null,
      hooks: {
        onWorkerEvents: (run, agent, events) => w.asks.onWorkerEvents(office, run, agent, events),
        onEnded: (run) => w.asks.onEnded(office, run),
      },
    });
    w.ingestor.track(
      target(w.f, claude, initialState({ plannedModel: "haiku" }) as unknown as ParseState),
    );
  } else {
    w.ingestor.pass(w.f.run, w.f.agent);
  }
  await w.asks.idle();
}

let requests = 0;
function answer(args: Record<string, unknown>): Promise<CommandReply> {
  requests += 1;
  return executeCommand(
    {
      registry: buildRegistry([w.asks.feature]),
      offices: stateOfficeDirectory(w.f.t.state),
      clock: w.f.t.clock,
      ids: w.f.t.ids,
      softwareRequests: new MemoryRequestTable(w.f.t.clock),
    },
    {
      requestId: RequestId.parse(
        `01J9ZK5Q8W3V4X6Y7Z${(70_000 + requests).toString().padStart(8, "0")}`,
      ),
      name: "work.answer",
      args,
      origin: "cli",
      confirmed: false,
      office: w.f.office.officeId as OfficeId,
    },
  );
}

function types(): string[] {
  return loggedEvents(w.f.office).map((event) => event.type);
}

function hookId(): number {
  return openQuestions(w.f.office)[0]?.hook ?? -1;
}

function outputOf(ops: readonly HostOp[] | undefined): unknown {
  const op = ops?.[0] as { hookReply: number; output: string } | undefined;
  return op === undefined ? undefined : op.output === "" ? "" : JSON.parse(op.output);
}

describe("permission wait with the maintainer present (AC #4, #6, #7)", () => {
  it("asks with question.asked and input-wait, stores the question, and an allow passes the call", async () => {
    const { before, after } = scenario();
    await ingest(before);
    const asked = loggedEvents(w.f.office).filter((event) => event.type === "question.asked");
    expect(asked).toHaveLength(1);
    const view = asked[0]?.data as { question: string; kind: string; text: string };
    expect(view.kind).toBe("permission");
    expect(view.text).toStartWith("Write(");
    expect(
      loggedEvents(w.f.office).find((event) => event.type === "work.observed")?.data,
    ).toMatchObject({ signal: "input-wait" });
    expect(w.sent).toEqual([]);
    // In office.snapshot and story.detail, and the run's health is asking.
    const snap = w.f.office.deferred(() => snapshot(w.f.office)) as OfficeSnapshot;
    expect(snap.questions.map((q) => String(q.question))).toEqual([view.question]);
    expect(w.f.office.deferred(() => workView(w.f.office, w.f.run))?.health).toBe("asking");
    const story = w.f.office.deferred(() => detail(w.f.office, w.key));
    expect(story.questions?.map((q) => String(q.question))).toEqual([view.question]);
    const hook = hookId();
    expect(hook).toBeGreaterThan(0);

    const reply = await answer({ question: view.question, text: "", decision: "allow" });
    expect(reply).toMatchObject({
      ok: true,
      result: { question: view.question, delivered: "now" },
    });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]?.[0]).toMatchObject({ hookReply: hook });
    expect(outputOf(w.sent[0])).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
    const closed = loggedEvents(w.f.office).filter((event) => event.type === "question.closed");
    expect(closed.map((event) => event.data)).toEqual([
      { question: view.question, answer: "allow" },
    ]);
    expect(
      loggedEvents(w.f.office).filter(
        (event) =>
          event.type === "work.observed" &&
          (event.data as { clearedAt?: string }).clearedAt !== undefined,
      ),
    ).toHaveLength(1);
    expect(findQuestion(w.f.office, view.question)).toMatchObject({
      closedHow: "answered",
      decision: "allow",
    });
    expect((w.f.office.deferred(() => snapshot(w.f.office)) as OfficeSnapshot).questions).toEqual(
      [],
    );

    // The rest of the run: the worker continues and exits; nothing more is sent.
    await ingest(after);
    expect(w.sent).toHaveLength(1);
  });

  it("denies the call once timeouts.permissionWaitSeconds pass without an answer", async () => {
    await ingest(scenario().before);
    const [question] = openQuestions(w.f.office);
    w.f.t.clock.advance(WAIT_SECONDS * 1000 - 1);
    expect(w.sent).toEqual([]);
    w.f.t.clock.advance(1);
    await w.asks.idle();
    expect(outputOf(w.sent[0])).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: `The maintainer did not answer within ${WAIT_SECONDS} s.`,
        },
      },
    });
    expect(findQuestion(w.f.office, question?.questionId ?? "")?.closedHow).toBe("timeout");
    expect(types()).toContain("question.closed");
    // A late answer finds the question closed.
    const late = await answer({ question: question?.questionId, text: "", decision: "allow" });
    expect(late).toMatchObject({ ok: false, error: { code: "question.closed" } });
  });

  it("closes an open question when the worker exits, and an office load expires a stale one", async () => {
    const { before, after } = scenario();
    await ingest(before);
    await ingest(after);
    expect(openQuestions(w.f.office)).toEqual([]);
    const all = w.f.office.all<{ closed_how: string }>(
      "select closed_how from questions where office_id = $office_id",
    );
    expect(all).toEqual([{ closed_how: "ended" }]);
  });
});

describe("work.answer on a permission question (AC #7, #9)", () => {
  it("fails with args.invalid without a decision; an empty text is fine; a deny's text is the reason", async () => {
    await ingest(scenario().before);
    const [question] = openQuestions(w.f.office);
    const id = question?.questionId;
    const missing = await answer({ question: id, text: "Please do" });
    expect(missing).toMatchObject({ ok: false, error: { code: "args.invalid" } });
    // `text` stays required by the schema.
    const noText = await answer({ question: id, decision: "deny" });
    expect(noText).toMatchObject({ ok: false, error: { code: "args.invalid" } });
    expect(w.sent).toEqual([]);
    const denied = await answer({
      question: id,
      text: "Write inside the worktree.",
      decision: "deny",
    });
    expect(denied).toMatchObject({ ok: true, result: { delivered: "now" } });
    expect(outputOf(w.sent[0])).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "Write inside the worktree." },
      },
    });
    expect(findQuestion(w.f.office, id ?? "")).toMatchObject({
      answer: "Write inside the worktree.",
      decision: "deny",
    });
    const again = await answer({ question: id, text: "", decision: "allow" });
    expect(again).toMatchObject({ ok: false, error: { code: "question.closed" } });
    const unknown = await answer({
      question: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D",
      text: "",
      decision: "allow",
    });
    expect(unknown).toMatchObject({ ok: false, error: { code: "question.closed" } });
  });
});

describe("no decision at once (AC #5)", () => {
  const cases: [string, () => void][] = [
    ["no client is connected", () => (w.connected = false)],
    [
      "no command or read came within presentMinutes",
      () => (w.lastRequestAt = w.f.t.clock.now() - 11 * 60_000),
    ],
    [
      "permissions.ask is never",
      () =>
        (w.config = {
          ...OFFICE_DEFAULTS,
          permissions: { ...OFFICE_DEFAULTS.permissions, ask: "never" },
        }),
    ],
    ["the run is being ended", () => (w.ending = true)],
  ];
  for (const [why, arrange] of cases) {
    it(`returns no decision when ${why}`, async () => {
      arrange();
      await ingest(scenario().before);
      expect(w.sent).toHaveLength(1);
      expect(outputOf(w.sent[0])).toBe("");
      expect(openQuestions(w.f.office)).toEqual([]);
      expect(types()).not.toContain("question.asked");
    });
  }

  it("expires questions a previous daemon left open at office load", async () => {
    await ingest(scenario().before);
    expect(openQuestions(w.f.office)).toHaveLength(1);
    w.asks.close();
    const step = buildRegistry([w.asks.feature])
      .loadSteps()
      .find((candidate) => candidate.name === "expire open permission questions");
    await step?.run({
      officeId: w.f.office.officeId as OfficeId,
      office: w.f.office,
      path: w.dir,
      commonDir: w.dir,
      config: OFFICE_DEFAULTS,
      clock: w.f.t.clock,
      ids: w.f.t.ids,
    });
    expect(openQuestions(w.f.office)).toEqual([]);
    expect(
      w.f.office.get<{ closed_how: string }>(
        "select closed_how from questions where office_id = $office_id",
      ),
    ).toEqual({ closed_how: "expired" });
  });
});

/** A worker that runs until `end` is called. */
function heldWorker(): { spawn: Spawn; end: () => void } {
  let end!: () => void;
  const exited = new Promise<ChildExit>((resolve) => {
    end = () => resolve({ code: 0, signal: null });
  });
  const closed = () =>
    new ReadableStream<Uint8Array>({
      async start(controller) {
        await exited;
        controller.close();
      },
    });
  const child: ChildProcess = {
    pid: 4242,
    stdin: { write: () => 0, end: () => undefined } as unknown as ChildProcess["stdin"],
    stdout: closed(),
    stderr: closed(),
    exited,
    kill: () => undefined,
  };
  return { spawn: () => child, end };
}

describe("the timeout against the real worker host (DIPO-59 review)", () => {
  it("delivers the engine's timeout deny with its reason before the host gives up, and raises no notice", async () => {
    const { f } = w;
    // The fixture's worker host row names `<dir>/host.sock` and `<dir>/events.ndjson`.
    const launch: HostLaunch = {
      version: 1,
      run: f.run,
      agent: f.agent,
      socket: join(w.dir, "host.sock"),
      plan: { argv: ["/usr/local/bin/claude", "-p"], env: {}, cwd: w.dir, files: [], stdin: [] },
    };
    writeFileSync(join(w.dir, LAUNCH_FILE), JSON.stringify(launch), { mode: 0o600 });
    const worker = heldWorker();
    const host = WorkerHost.start({
      runId: f.run,
      runDir: w.dir,
      clock: f.t.clock,
      spawn: worker.spawn,
      killGroup: () => undefined,
      pid: 777,
    });
    const steering = hostSocketSteering({ clock: systemClock });
    const asks = new PermissionAsks({
      clock: f.t.clock,
      ids: f.t.ids,
      offices: { get: () => f.office, config: () => OFFICE_DEFAULTS },
      steering,
      encode,
      presence: { connected: () => true, lastRequestAt: () => f.t.clock.now() },
    });
    try {
      const engine = await connectHost(launch.socket, {
        runId: f.run,
        clock: systemClock,
        timeoutMs: 2000,
      });
      if (!engine.ok) throw new Error("no engine connection");
      await engine.client.watch(() => undefined);
      // `dipo hook PermissionRequest --wait <permissionWaitSeconds + margin>`.
      const call = relayHookPayload({
        socketPath: launch.socket,
        runId: f.run,
        payload: JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Write" }),
        waitMs: (WAIT_SECONDS + HOST_WAIT_MARGIN_SECONDS) * 1000,
        clock: systemClock,
        timeoutMs: 2000,
      });
      for (let i = 0; i < 200 && host.pendingHooks.length === 0; i++) await Bun.sleep(5);
      const office = f.office;
      const ingestor = new Ingestor({
        office,
        clock: f.t.clock,
        pricing: null,
        hooks: {
          onWorkerEvents: (run, agent, events) => asks.onWorkerEvents(office, run, agent, events),
        },
      });
      ingestor.track(
        target(f, claude, initialState({ plannedModel: "haiku" }) as unknown as ParseState),
      );
      ingestor.close();
      expect(openQuestions(office)).toHaveLength(1);

      f.t.clock.advance(WAIT_SECONDS * 1000);
      await asks.idle();
      const output = await call;
      expect(JSON.parse(output ?? "{}")).toEqual({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "deny",
            message: `The maintainer did not answer within ${WAIT_SECONDS} s.`,
          },
        },
      });
      expect(types()).not.toContain("engine.notice");
      engine.client.close();
    } finally {
      asks.close();
      worker.end();
      await host.done;
    }
  });
});
