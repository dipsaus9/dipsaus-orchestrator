// Answering a `needs-permission` park (DIPO-75; 0008 sections 5 and 8): the `needs-permission`
// recording (captured live, see `needs-permission.ts`) replayed through the
// real ingestion and the Claude CLI parser into run control, which parks the story and stores the
// park's permission question; `work.answer` through the executor with a fake park resumer; allow
// once against the permission wait with exact, prefix, glob and other-tool requests.

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
import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import type { ParkResumer } from "../../src/hooks/park-answers";
import { OFFICE_CONFIG_FILE, parkAnswerMessage } from "../../src/hooks/park-questions";
import { PermissionAsks } from "../../src/hooks/permissions";
import {
  answeredParkQuestion,
  findQuestion,
  openQuestions,
  type StoredQuestion,
} from "../../src/hooks/questions";
import { appendEntries } from "../../src/changelog/log";
import type { HookEvent } from "../../src/hooks/types";
import { type IngestAdapter, Ingestor } from "../../src/ingest/ingestor";
import {
  type BranchPark,
  insertRun,
  openPark,
  type ResumeParkOutcome,
  type ResumeParkRequest,
  RunControl,
} from "../../src/run";
import { addStory } from "../../src/stories/keys";
import { encode } from "../../src/workers/claude-cli/encode";
import { initialState, interpret } from "../../src/workers/claude-cli/interpret";
import type { HostOp, ParseState } from "../../src/workers/types";
import { insertClaim } from "../../src/worktree/records";
import {
  appendLines,
  hostLines,
  type IngestFixture,
  ingestFixture,
  loggedEvents,
  target,
} from "../ingest/helpers";
import { needsPermissionRecording, reportedPermission } from "./needs-permission";

const claude: IngestAdapter = {
  interpret: (line, state) =>
    interpret(line, state as unknown as ReturnType<typeof initialState>) as unknown as {
      events: [];
      state: ParseState;
    },
};

const RECORDING = needsPermissionRecording();
const PERMISSION = reportedPermission(RECORDING);

type PermissionRequest = Extract<HookEvent, { kind: "permissionRequest" }>;

interface World {
  readonly dir: string;
  readonly f: IngestFixture;
  readonly control: RunControl;
  readonly asks: PermissionAsks;
  readonly sent: HostOp[][];
  readonly resumes: { run: string; request: ResumeParkRequest }[];
  readonly work: WorkRef;
  config: OfficeConfig;
  /** Whether a TUI is connected (DIPO-279); none by default, so questions park. */
  tui: boolean;
  scheduling: boolean;
  /** What the fake resumer answers; it records the answer first for `started` and `notStarted`. */
  resume: ResumeParkOutcome["kind"];
  ingestor: Ingestor | null;
}

let w: World;

beforeEach(async () => {
  const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "park-answers-"));
  const f = await ingestFixture(dir);
  const sent: HostOp[][] = [];
  const resumes: World["resumes"] = [];
  const world = {
    dir,
    f,
    sent,
    resumes,
    config: OFFICE_DEFAULTS,
    tui: false,
    scheduling: true,
    resume: "started",
    ingestor: null,
  } as unknown as World;
  const steering = {
    send: async (_office: unknown, _run: unknown, ops: readonly HostOp[]) => {
      sent.push([...ops]);
      return { ok: true as const };
    },
  };
  const control = new RunControl({
    clock: f.t.clock,
    ids: f.t.ids,
    offices: { get: () => f.office, config: () => world.config },
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
  });
  const parks: ParkResumer = {
    resume: async (_office, run, asked) => {
      resumes.push({ run, request: asked });
      const kind = world.resume;
      if (kind === "started" || kind === "notStarted") {
        // As the real resumer: the answer is recorded in the transaction that reopens the run.
        const at = f.t.clock.now();
        f.office.immediate(() =>
          appendEntries(
            f.office,
            answeredParkQuestion(f.office, asked.question, asked.decision, asked.text, at),
            { at },
          ),
        );
      }
      return kind === "failed" ? { kind, reason: "the Backlog CLI exited 1" } : { kind };
    },
  };
  const asks = new PermissionAsks({
    clock: f.t.clock,
    ids: f.t.ids,
    offices: { get: () => f.office, config: () => world.config },
    steering,
    encode,
    presence: { tuiConnected: () => world.tui },
    parks,
    scheduling: () => world.scheduling,
  });
  Object.assign(world, { control, asks });
  const { office, run } = f;
  const { key } = office.immediate(() =>
    addStory(office, f.t.ids, { story: StoryId.parse("DIPO-1") }, f.t.clock.now()),
  );
  const work = { ...f.work, key };
  (f as { work: WorkRef }).work = work;
  (world as { work: WorkRef }).work = work;
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
  });
  w = world;
});

afterEach(async () => {
  await w.asks.idle();
  w.asks.close();
  w.ingestor?.close();
  w.control.close();
  w.f.t.state.close();
  rmSync(w.dir, { recursive: true, force: true });
});

/** Replays the `needs-permission` recording with run control and the permission wait as hooks. */
async function replayPark(): Promise<StoredQuestion> {
  const { f, control, asks } = w;
  control.track(f.office.officeId, {
    runId: f.run,
    work: w.work,
    caps: { budgetTokens: 1_000_000, maxTurns: 100, maxMinutes: 30 },
    startedAt: f.t.clock.now(),
  });
  appendLines(f.eventFile, hostLines(RECORDING));
  const hooks = control.hooks;
  const ingestor = new Ingestor({
    office: f.office,
    clock: f.t.clock,
    pricing: null,
    hooks: {
      ...hooks,
      onWorkerEvents: (run, agent, events) => {
        hooks.onWorkerEvents?.(run, agent, events);
        asks.onWorkerEvents(f.office, run, agent, events);
      },
      onEnded: (run, agent, end) => {
        hooks.onEnded?.(run, agent, end);
        asks.onEnded(f.office, run);
      },
    },
  });
  w.ingestor = ingestor;
  ingestor.track(
    target(f, claude, initialState({ plannedModel: "haiku" }) as unknown as ParseState),
  );
  await control.idle();
  await asks.idle();
  const [question] = openQuestions(f.office).filter((open) => open.parkId !== null);
  if (question === undefined) throw new Error("the park stored no question");
  return question;
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
        `01J9ZK5Q8W3V4X6Y7Z${(90_000 + requests).toString().padStart(8, "0")}`,
      ),
      name: "work.answer",
      args,
      origin: "cli",
      confirmed: false,
      office: w.f.office.officeId as OfficeId,
    },
  );
}

let hookIds = 10_000;
/** A permission request of the resumed session, as ingestion hands it to the permission wait. */
function request(tool: string, exact: string | undefined): unknown {
  hookIds += 1;
  const hook: PermissionRequest = {
    kind: "permissionRequest",
    id: hookIds,
    tool,
    input: exact ?? "",
    ...(exact === undefined ? {} : { exact }),
  };
  const before = w.sent.length;
  w.asks.request(w.f.office, w.f.run as RunId, w.f.agent, hook);
  return w.sent.slice(before);
}

async function decisionOf(sent: unknown): Promise<string> {
  await w.asks.idle();
  const ops = sent as HostOp[][];
  const op = ops[0]?.[0] as { output: string } | undefined;
  if (op === undefined) return "none";
  if (op.output === "") return "no decision";
  const parsed = JSON.parse(op.output) as {
    hookSpecificOutput: { decision: { behavior: string } };
  };
  return parsed.hookSpecificOutput.decision.behavior;
}

function parkReasons(): string[] {
  return w.f.office
    .all<{ reason: string }>(
      "select reason from parks where office_id = $office_id and resolved_at is null",
    )
    .map((row) => row.reason);
}

describe("the live needs-permission replay", () => {
  it("parks needs-permission with a permission question naming the recorded tool and action (AC #1)", async () => {
    const question = await replayPark();
    expect(parkReasons()).toEqual(["needs-permission"]);
    const park = openPark(w.f.office, w.work.key);
    expect(park?.detail).toBe(`${PERMISSION.tool}: ${PERMISSION.action}`);
    expect(question).toMatchObject({
      kind: "permission",
      tool: PERMISSION.tool,
      input: PERMISSION.action,
      hook: null,
      parkId: park?.parkId,
      closedAt: null,
    });
    expect(question.text).toStartWith(`${PERMISSION.tool}(${PERMISSION.action})`);
    const asked = loggedEvents(w.f.office).filter((event) => event.type === "question.asked");
    expect(asked.map((event) => (event.data as { question: string }).question)).toContain(
      question.questionId,
    );
    expect((asked.at(-1)?.data as { work: { story: string } } | undefined)?.work.story).toBe(
      "DIPO-1",
    );
    // The worker's exit was ingested after the park: the park's question still waits.
    const agent = w.f.office.get<{ ended_at: number | null }>(
      "select ended_at from agents where office_id = $office_id and agent_id = $agent",
      { agent: w.f.agent },
    );
    expect(agent?.ended_at).not.toBeNull();
    expect(findQuestion(w.f.office, question.questionId)?.closedAt).toBeNull();
    // The park offers work.answer.
    const parked = loggedEvents(w.f.office).find((event) => event.type === "story.parked");
    expect((parked?.data as { reason: string } | undefined)?.reason).toBe("needs-permission");
  });

  it("without a TUI the request gets no decision at once and the story parks with the question (DIPO-279)", async () => {
    // A permission request while no TUI is connected: no live question, the call is denied.
    expect(await decisionOf(request(PERMISSION.tool, PERMISSION.action))).toBe("no decision");
    expect(openQuestions(w.f.office)).toEqual([]);
    // The worker then reports blocked with what it needs (the recording): the story parks with it.
    const question = await replayPark();
    expect(parkReasons()).toEqual(["needs-permission"]);
    expect(openQuestions(w.f.office).map((open) => open.questionId)).toEqual([question.questionId]);
    expect(question).toMatchObject({
      hook: null,
      parkId: openPark(w.f.office, w.work.key)?.parkId,
    });
  });

  it("needs a decision: without one the answer fails with args.invalid and the question waits (AC #7)", async () => {
    const question = await replayPark();
    const reply = await answer({ question: question.questionId, text: "go ahead" });
    expect(reply).toMatchObject({ ok: false, error: { code: "args.invalid" } });
    expect(w.resumes).toEqual([]);
    expect(findQuestion(w.f.office, question.questionId)?.closedAt).toBeNull();
    expect(parkReasons()).toEqual(["needs-permission"]);
  });

  it("allow once resumes the run and allows only the first request with the exact tool and command (AC #2)", async () => {
    const question = await replayPark();
    const reply = await answer({ question: question.questionId, text: "", decision: "allow" });
    expect(reply).toMatchObject({
      ok: true,
      result: { question: question.questionId, delivered: "on-resume", run: w.f.run },
    });
    expect(w.resumes).toHaveLength(1);
    const resumed = w.resumes[0];
    expect(resumed?.run).toBe(w.f.run);
    expect(resumed?.request.parkId).toBe(question.parkId ?? -1);
    expect(resumed?.request).toEqual({
      parkId: question.parkId ?? -1,
      question: question.questionId,
      decision: "allow",
      text: "",
    });
    expect(findQuestion(w.f.office, question.questionId)).toMatchObject({
      closedHow: "answered",
      decision: "allow",
      allowUsedAt: null,
    });
    expect(
      loggedEvents(w.f.office)
        .filter((event) => event.type === "question.closed")
        .map((event) => event.data),
    ).toContainEqual({ question: question.questionId, answer: "allow" });

    const { tool, action } = PERMISSION;
    // Never a prefix, an extension, a glob, other whitespace, or another tool.
    expect(await decisionOf(request(tool, action.slice(0, -1)))).toBe("no decision");
    expect(await decisionOf(request(tool, `${action} -a`))).toBe("no decision");
    expect(await decisionOf(request(tool, `${action} `))).toBe("no decision");
    expect(await decisionOf(request(tool, `${action.slice(0, -1)}*`))).toBe("no decision");
    expect(await decisionOf(request(tool, action.toUpperCase()))).toBe("no decision");
    expect(await decisionOf(request("Write", action))).toBe("no decision");
    expect(await decisionOf(request(tool, undefined))).toBe("no decision");
    // The exact call is allowed, once.
    expect(await decisionOf(request(tool, action))).toBe("allow");
    expect(findQuestion(w.f.office, question.questionId)?.allowUsedAt).not.toBeNull();
    expect(await decisionOf(request(tool, action))).toBe("no decision");
    // Nothing became a rule: no other question, no config change.
    expect(w.config).toBe(OFFICE_DEFAULTS);
    expect(openQuestions(w.f.office)).toEqual([]);
  });

  it("deny resumes the run with 'do it without <action>' and allows nothing (AC #2)", async () => {
    const question = await replayPark();
    const reply = await answer({
      question: question.questionId,
      text: "use the fixture instead",
      decision: "deny",
    });
    expect(reply).toMatchObject({ ok: true, result: { delivered: "on-resume", run: w.f.run } });
    const message = parkAnswerMessage(PERMISSION, "deny", w.resumes[0]?.request.text ?? "");
    expect(w.resumes[0]?.request.decision).toBe("deny");
    expect(message).toContain(`Do it without ${PERMISSION.action}.`);
    expect(message).toContain("use the fixture instead");
    expect(findQuestion(w.f.office, question.questionId)?.decision).toBe("deny");
    expect(await decisionOf(request(PERMISSION.tool, PERMISSION.action))).toBe("no decision");
  });

  it("a session that did not start still closes the answer, without a run in the result", async () => {
    const question = await replayPark();
    w.resume = "notStarted";
    const reply = await answer({ question: question.questionId, text: "", decision: "deny" });
    expect(reply).toMatchObject({ ok: true, result: { delivered: "on-resume" } });
    expect((reply as { result: Record<string, unknown> }).result["run"]).toBeUndefined();
  });

  it("refuses while the parked worker has not exited, while scheduling is off, and when lifting fails; the question waits", async () => {
    const question = await replayPark();
    w.resume = "busy";
    expect(
      await answer({ question: question.questionId, text: "", decision: "allow" }),
    ).toMatchObject({ ok: false, error: { code: "run.hostAlive", retryable: true } });
    w.resume = "failed";
    expect(
      await answer({ question: question.questionId, text: "", decision: "allow" }),
    ).toMatchObject({ ok: false, error: { code: "internal" } });
    w.resume = "started";
    w.scheduling = false;
    expect(
      await answer({ question: question.questionId, text: "", decision: "allow" }),
    ).toMatchObject({ ok: false, error: { code: "scheduling.off", retryable: true } });
    expect(findQuestion(w.f.office, question.questionId)?.closedAt).toBeNull();
    expect(parkReasons()).toEqual(["needs-permission"]);
  });
});

describe("a story parked for another reason (AC #4)", () => {
  it("fails naming the park reason when the park's own park was replaced, and the story stays Parked", async () => {
    const question = await replayPark();
    const office = w.f.office;
    office.immediate(() => {
      office.run(
        `update parks set resolved_at = 1, resolved_how = 'reconcile'
          where office_id = $office_id and park_id = $park`,
        { park: question.parkId },
      );
      office.run(
        `insert into parks (office_id, park_id, key, story_id, run_id, reason, from_state, detail,
           at)
         values ($office_id, 99, $key, 'DIPO-1', $run, 'stopped', 'In Progress', 'by hand', 1)`,
        { key: w.work.key, run: w.f.run },
      );
    });
    const reply = await answer({ question: question.questionId, text: "", decision: "allow" });
    expect(reply).toMatchObject({
      ok: false,
      error: { code: "question.closed", details: { reason: "stopped", questionOpen: false } },
    });
    expect((reply as { error: { message: string } }).error.message).toContain("parked stopped");
    // The question of the replaced park can never resume the story: it is closed now.
    expect(findQuestion(w.f.office, question.questionId)?.closedHow).toBe("expired");
    expect((reply as { error: { message: string } }).error.message).toContain("is now closed");
    expect(w.resumes).toEqual([]);
    expect(parkReasons()).toEqual(["stopped"]);
  });

  it("fails naming the reason for a waiting hook question of a story parked budget-exceeded", async () => {
    w.tui = true;
    w.f.office.immediate(() =>
      w.f.office.run(
        `insert into agents (office_id, agent_id, run_id, role, model, session_id, started_at)
         values ($office_id, $agent, $run, 'developer', 'haiku', 'session-1', 0)`,
        { agent: w.f.agent, run: w.f.run },
      ),
    );
    // A live permission wait, then the run parks for its budget before the worker exits.
    request("Bash", "curl https://example.com");
    const [waiting] = openQuestions(w.f.office);
    expect(waiting?.hook).not.toBeNull();
    const office = w.f.office;
    office.immediate(() =>
      office.run(
        `insert into parks (office_id, park_id, key, story_id, run_id, reason, from_state, detail,
           at)
         values ($office_id, 1, $key, 'DIPO-1', $run, 'budget-exceeded', 'In Progress',
           'token budget reached', 1)`,
        { key: w.work.key, run: w.f.run },
      ),
    );
    const before = w.sent.length;
    const reply = await answer({ question: waiting?.questionId, text: "", decision: "allow" });
    expect(reply).toMatchObject({
      ok: false,
      error: {
        code: "question.closed",
        details: { reason: "budget-exceeded", questionOpen: true },
      },
    });
    expect((reply as { error: { message: string } }).error.message).toContain(
      "parked budget-exceeded",
    );
    expect(w.sent.length).toBe(before);
    // The hook question stays open until its worker exits, and the refusal says so.
    expect(findQuestion(w.f.office, waiting?.questionId ?? "")?.closedAt).toBeNull();
    expect((reply as { error: { message: string } }).error.message).toContain(
      "stays open until its worker exits",
    );
    expect(parkReasons()).toEqual(["budget-exceeded"]);
  });

  it("expires a park's question at office load once its park ended, and keeps one whose park is open", async () => {
    const question = await replayPark();
    w.asks.close();
    const step = buildRegistry([w.asks.feature])
      .loadSteps()
      .find((candidate) => candidate.name === "expire open permission questions");
    const run = () =>
      step?.run({
        officeId: w.f.office.officeId as OfficeId,
        office: w.f.office,
        path: w.dir,
        commonDir: w.dir,
        config: OFFICE_DEFAULTS,
        clock: w.f.t.clock,
        ids: w.f.t.ids,
      });
    await run();
    expect(findQuestion(w.f.office, question.questionId)?.closedAt).toBeNull();
    w.f.office.immediate(() =>
      w.f.office.run(
        `update parks set resolved_at = 1, resolved_how = 'drop' where office_id = $office_id`,
      ),
    );
    await run();
    expect(findQuestion(w.f.office, question.questionId)?.closedHow).toBe("expired");
  });
});

describe("a sandbox-bound action (AC #3)", () => {
  it("says so in the park's question, points to office config, and allow once changes no sandbox", async () => {
    const question = await replayPark();
    // `docker ps` reaches a daemon socket, which the worker's sandbox closes.
    expect(question.text).toContain("Sandbox-bound");
    expect(question.text).toContain("cannot lift a sandbox block");
    expect(question.text).toContain(OFFICE_CONFIG_FILE);
    expect(question.text).toContain("sandbox.allowedDomains");
    const reply = await answer({ question: question.questionId, text: "", decision: "allow" });
    expect(reply).toMatchObject({ ok: true });
    // The resume carries only the park, the question and the answer: no sandbox or config.
    expect(Object.keys(w.resumes[0]?.request ?? {}).toSorted()).toEqual([
      "decision",
      "parkId",
      "question",
      "text",
    ]);
    expect(parkAnswerMessage(PERMISSION, "allow", "")).toContain(
      "nothing about the sandbox changed",
    );
    expect(w.config.sandbox.allowedDomains).toEqual(OFFICE_DEFAULTS.sandbox.allowedDomains);
    // The only effect is one hook allow for the exact call.
    const allowed = request(PERMISSION.tool, PERMISSION.action) as HostOp[][];
    expect(await decisionOf(allowed)).toBe("allow");
    expect(allowed).toHaveLength(1);
    expect(allowed[0]).toHaveLength(1);
  });
});
