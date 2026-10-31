// The scan fallback's `session` run (DIPO-310 criteria 1 and 2) on a fixture-built test database,
// with a scripted worker host whose event file holds Claude stream lines: no `claude` starts.
//
// - The run is kind `session`, role `scanner`, with no branch or story key; its usage is
//   stored under the office (`usage_totals`, `usage_daily`), so it counts in the office's usage.
// - The worker port plans it on the Mac in an empty folder dipo makes, with every tool off, the
//   fallback's schema and the spec's model, effort and turn cap; the folder goes after the run.
// - It holds no worker or reviewer place.
// - dipo stops it when its budget tokens pass the scan block's, and at its minute cap.

import { describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { type ChildExit, type ChildProcess, OfficeId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { WorkerHost } from "../../src/host/main";
import { HOST_PROTOCOL_VERSION, hostSocketPath, LAUNCH_FILE } from "../../src/host/protocol";
import type { HostStarter } from "../../src/run/launch";

import { HOST_LAUNCH_DEADLINE_MS } from "../../src/run/hosts";
import { OFFICE_DEFAULTS } from "../../src/config";
import type { OfficeHandle } from "../../src/db/office";
import type { OfficeGit } from "../../src/git/office";
import { placeHolders } from "../../src/run-state/places";
import { SESSION_FOLDER_PREFIX, SessionRuns } from "../../src/run/session-run";
import { recordWorkerHost, type LaunchedHost } from "../../src/records/worker-hosts";
import { SCAN_ANSWER_JSON_SCHEMA } from "../../src/scan/answer";
import { SCAN_MAX_TURNS, type ScanSessionRequest } from "../../src/scan/fallback";
import { claudeCliAdapter } from "../../src/workers/claude-cli/adapter";
import { encode } from "../../src/workers/claude-cli/encode";
import { type ClaudeParseState, initialState } from "../../src/workers/claude-cli/interpret";
import { plan, type ClaudeLaunchContext } from "../../src/workers/claude-cli/plan";
import { REPORT_JSON_SCHEMAS } from "../../src/workers/claude-cli/report-schema";
import { result as claudeResult } from "../../src/workers/claude-cli/result";
import { CLAUDE_LOCAL_SETTINGS } from "../../src/workers/claude-cli/settings-check";
import type { RunLaunchPaths, WorkerPort } from "../../src/workers/port";
import type { HostOp, LaunchPlan, ParseState } from "../../src/workers/types";
import { addOffice, openTestState, type TestState } from "../commands/helpers";
import { entriesAfter } from "../stories/helpers";

const MODEL = "claude-sonnet-5";
const ANSWER = { proposals: [] };

const line = (data: unknown) =>
  `${JSON.stringify({ t: 0, ch: "stdout", data: JSON.stringify(data) })}\n`;
const exitLine = (code: number) =>
  `${JSON.stringify({ t: 0, ch: "exit", data: JSON.stringify({ code, signal: null }) })}\n`;

const init = line({
  type: "system",
  subtype: "init",
  session_id: "session-s",
  model: MODEL,
  claude_code_version: "2.1.296",
  permissionMode: "default",
  tools: ["StructuredOutput"],
  apiKeySource: "none",
  cwd: "/tmp",
  plugins: [],
  skills: [],
});

const usageOf = (input: number, output: number) => ({
  [MODEL]: {
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  },
});

const assistant = (input: number) =>
  line({
    type: "assistant",
    message: {
      model: MODEL,
      id: "msg-1",
      type: "message",
      role: "assistant",
      content: [],
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 1,
      },
    },
    parent_tool_use_id: null,
    session_id: "session-s",
  });

const resultLine = line({
  type: "result",
  subtype: "success",
  session_id: "session-s",
  is_error: false,
  num_turns: 1,
  terminal_reason: "completed",
  permission_denials: [],
  structured_output: ANSWER,
  modelUsage: usageOf(1_200, 300),
});

interface World {
  readonly t: TestState;
  readonly office: OfficeHandle;
  readonly runs: SessionRuns;
  readonly plans: LaunchPlan[];
  readonly sent: HostOp[][];
  /** What the scripted host writes at its start. */
  lines: string;
  /** What it appends when it receives a stop. */
  onStop: string;
  eventFile: string;
  /** Starts the host instead of the scripted one. */
  startHost?: HostStarter["start"];
}

function world(t: TestState, dir: string): World {
  const office = addOffice(t);
  const tmpRoot = join(dir, "tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const git = {
    commonDir: join(dir, "repo", ".git"),
    mainWorktree: join(dir, "repo"),
  } as unknown as OfficeGit;
  const ctxOf = (paths: RunLaunchPaths): ClaudeLaunchContext => ({
    claudePath: "/opt/claude/bin/claude",
    home: join(dir, "home"),
    env: { PATH: "/usr/bin:/bin" },
    toolVariables: [],
    mainCheckout: paths.mainCheckout,
    runDir: paths.runDir,
    tmpDir: paths.tmpDir,
    shortTmpDir: paths.shortTmpDir,
  });
  const neverSpawn = (() => {
    throw new Error("no process starts in this test");
  }) as never;
  const w = {
    t,
    office,
    plans: [] as LaunchPlan[],
    sent: [] as HostOp[][],
    lines: "",
    onStop: "",
    eventFile: "",
  } as unknown as World;
  const worker: WorkerPort = {
    id: "claude-cli",
    reportSchema: REPORT_JSON_SCHEMAS,
    localSettings: CLAUDE_LOCAL_SETTINGS,
    adapter: (paths) => claudeCliAdapter(ctxOf(paths), { spawn: neverSpawn, clock: t.clock }),
    // The real plan of the session kind; the probe and settings checks are not run here.
    prepare: async (spec, paths) => ({ ok: true, plan: plan(spec, ctxOf(paths)) }),
    initialState: (spec) =>
      initialState({
        plannedModel: spec.model,
        ...(spec.kind === "session" ? { reportKind: "session" as const } : {}),
      }) as unknown as ParseState,
    encode,
    result: (state, exit) => claudeResult(state as unknown as ClaudeParseState, exit),
    sessionFacts: () => ({ contextTokens: null, contextWindow: null, lastReport: null }),
  };
  (w as { runs: SessionRuns }).runs = new SessionRuns({
    clock: t.clock,
    ids: t.ids,
    offices: { get: () => office, config: () => OFFICE_DEFAULTS },
    worker,
    git: () => git,
    hosts: {
      start: async (handle, started) => {
        if (w.startHost !== undefined) return w.startHost(handle, started);
        w.plans.push(started.plan);
        const runDir = join(started.officeDir, "runs", started.runId);
        const eventFile = join(runDir, "events.ndjson");
        mkdirSync(dirname(eventFile), { recursive: true });
        writeFileSync(eventFile, w.lines);
        w.eventFile = eventFile;
        const host: LaunchedHost = {
          pid: 4242,
          startTimeMs: 0,
          runId: started.runId,
          agentId: started.agentId,
          socketPath: join(dir, "host.sock"),
          protocolVersion: 1,
          runDir,
          eventFile,
          launchDeadline: t.clock.now() + HOST_LAUNCH_DEADLINE_MS,
        };
        recordWorkerHost(handle, host, t.clock);
        handle.immediate(() => started.record?.());
        return host;
      },
    },
    steering: {
      send: async (_office, _run, ops) => {
        w.sent.push([...ops]);
        appendFileSync(w.eventFile, w.onStop);
        return { ok: true };
      },
    },
    runtimeDir: join(dir, "runtime"),
    tmpRoot,
  });
  return w;
}

const request = (
  w: World,
  over: Partial<ScanSessionRequest["settings"]> = {},
): ScanSessionRequest => ({
  office: OfficeId.parse(w.office.officeId),
  handle: w.office,
  settings: {
    model: "sonnet",
    effort: "low",
    budgetTokens: 100_000,
    maxMinutes: 5,
    maxTurns: SCAN_MAX_TURNS,
    ...over,
  },
  systemFile: "# Scan contract\n",
  taskMessage: "<scan_request>\n- verify: unresolved\n</scan_request>",
  schema: SCAN_ANSWER_JSON_SCHEMA,
});

const withWorld = (fn: (w: World, dir: string) => Promise<void>) =>
  withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      await fn(world(t, dir), dir);
    } finally {
      t.state.close();
    }
  });

/** Waits, on the real clock, until `done` holds: the run's start does file I/O. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 2_000 && !done(); i++) await Bun.sleep(1);
  if (!done()) throw new Error("the condition never held");
}

const limit = (info: Record<string, unknown>) =>
  line({ type: "rate_limit_event", rate_limit_info: info, session_id: "session-s" });

/** The `run.ended` entries of the office stream, reduced to their kind and ending. */
function runEnds(office: OfficeHandle): { kind: string; ending: string }[] {
  return entriesAfter(office)
    .filter((entry) => entry.type === "run.ended")
    .map((entry) => {
      const { kind, ending } = entry.delta as { kind: string; ending: string };
      return { kind, ending };
    });
}

describe("a scan session run", () => {
  it("reports a plan limit with its reset time, and whether it is credits_required (0020)", () =>
    withWorld(async (w) => {
      w.lines = init + limit({ status: "rejected", resetsAt: 1_791_827_400 }) + exitLine(0);
      expect(await w.runs.run(request(w))).toMatchObject({
        kind: "plan-limit",
        resetsAt: 1_791_827_400_000,
      });
      w.lines = init + limit({ status: "rejected", errorCode: "credits_required" }) + exitLine(0);
      const credits = await w.runs.run(request(w));
      expect(credits).toMatchObject({ kind: "plan-limit", credits: true });
    }));

  it("is a session run of the office with its usage, its answer and no place held", () =>
    withWorld(async (w, dir) => {
      w.lines = init + resultLine + exitLine(0);
      const outcome = await w.runs.run(request(w));
      expect(outcome.kind).toBe("answered");
      expect(outcome.kind === "answered" && outcome.answer).toEqual(ANSWER);
      const run = w.office.get<Record<string, unknown>>(
        `select kind, key, story_id, branch, role, model, budget_limit, max_turns,
                max_minutes, ended_at, end_kind from runs where office_id = $office_id`,
      );
      expect(run).toMatchObject({
        kind: "session",
        key: null,
        story_id: null,
        branch: null,
        role: "scanner",
        model: "sonnet",
        budget_limit: 100_000,
        max_turns: 2,
        max_minutes: 5,
        end_kind: "done",
      });
      expect(run?.["ended_at"]).not.toBeNull();
      const usage = w.office.all<{ role: string; input: number; output: number }>(
        "select role, input, output from usage_totals where office_id = $office_id",
      );
      expect(usage).toEqual([{ role: "scanner", input: 1_200, output: 300 }]);
      const daily = w.office.all<{ role: string; input: number }>(
        "select role, input from usage_daily where office_id = $office_id",
      );
      expect(daily).toEqual([{ role: "scanner", input: 1_200 }]);
      expect(placeHolders(w.office)).toEqual({ worker: [], reviewer: [] });

      // The plan: the session kind on the Mac, in its own empty folder, every tool off.
      const launched = w.plans[0];
      expect(launched?.cwd).toContain(join("tmp", SESSION_FOLDER_PREFIX));
      expect(launched?.cwd.startsWith(join(dir, "repo"))).toBe(false);
      const tools = launched?.argv.indexOf("--tools") ?? -1;
      expect(launched?.argv[tools + 1]).toBe("");
      expect(launched?.argv[(launched?.argv.indexOf("--max-turns") ?? 0) + 1]).toBe("2");
      expect(launched?.argv[(launched?.argv.indexOf("--model") ?? 0) + 1]).toBe("sonnet");
      // Its folder is gone after the run.
      expect(existsSync(launched?.cwd ?? "")).toBe(false);
    }));

  it("is stopped when its budget tokens pass the scan block's", () =>
    withWorld(async (w) => {
      w.lines = init + assistant(5_000);
      w.onStop = exitLine(143);
      const pending = w.runs.run(request(w, { budgetTokens: 1_000 }));
      await until(() => w.sent.length === 1);
      // The poll reads the exit the stop wrote.
      w.t.clock.advance(1_000);
      const outcome = await pending;
      expect(w.sent).toHaveLength(1);
      expect(outcome.kind).toBe("failed");
      expect(outcome.kind === "failed" && outcome.reason).toBe(
        "dipo stopped it: its budget of 1000 tokens was reached",
      );
      expect(
        w.office.get<{ end_kind: string }>("select end_kind from runs where office_id = $office_id")
          ?.end_kind,
      ).toBe("dropped");
      // The end is on the office stream too (DIPO-397).
      expect(runEnds(w.office)).toEqual([{ kind: "session", ending: "dropped" }]);
    }));

  it("is stopped at daemon stop, so its caps hold after the daemon is gone", () =>
    withWorld(async (w) => {
      w.lines = init;
      w.onStop = exitLine(143);
      const pending = w.runs.run(request(w));
      await until(() => w.runs.liveRuns().length === 1);
      expect(w.sent).toHaveLength(0);
      await w.runs.stopAll();
      expect(w.sent).toHaveLength(1);
      // The poll reads the exit the stop wrote.
      w.t.clock.advance(1_000);
      const outcome = await pending;
      expect(outcome.kind === "failed" && outcome.reason).toBe(
        "dipo stopped it: the daemon stopped",
      );
      expect(w.runs.liveRuns()).toEqual([]);
      expect(runEnds(w.office)).toEqual([{ kind: "session", ending: "dropped" }]);
      // Nothing left to stop.
      await w.runs.stopAll();
      expect(w.sent).toHaveLength(1);
    }));

  it("is stopped at its minute cap", () =>
    withWorld(async (w) => {
      w.lines = init;
      w.onStop = exitLine(143);
      const pending = w.runs.run(request(w, { maxMinutes: 1 }));
      await until(
        () =>
          w.office.get("select 1 as x from ingest_cursors where office_id = $office_id") !== null,
      );
      expect(w.sent).toHaveLength(0);
      w.t.clock.advance(59_000);
      expect(w.sent).toHaveLength(0);
      w.t.clock.advance(1_000);
      await until(() => w.sent.length === 1);
      // The poll reads the exit the stop wrote.
      w.t.clock.advance(1_000);
      const outcome = await pending;
      expect(outcome.kind === "failed" && outcome.reason).toBe(
        "dipo stopped it: its time cap of 1 minutes was reached",
      );
    }));

  it("claims its host, so a session that outlives the host's launch deadline keeps running (DIPO-386)", () =>
    withWorld(async (w, dir) => {
      // A real worker host in this process on the test clock, with a 1 s launch deadline, and a
      // worker that runs until it is stopped.
      const worker = { stdinClosed: false, signals: [] as string[] };
      const { promise: exited, resolve: exit } = Promise.withResolvers<ChildExit>();
      const closers: (() => void)[] = [];
      const open = () =>
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            closers.push(() => controller.close());
          },
        });
      const child: ChildProcess = {
        pid: 9001,
        stdin: {
          write: () => {},
          end: () => {
            worker.stdinClosed = true;
          },
        },
        stdout: open(),
        stderr: open(),
        exited,
        kill: (signal) => {
          worker.signals.push(signal ?? "SIGTERM");
        },
      };
      let host: WorkerHost | null = null;
      w.startHost = async (handle, started) => {
        const runDir = join(started.officeDir, "runs", started.runId);
        mkdirSync(runDir, { recursive: true });
        const socket = hostSocketPath(join(dir, "rt"), started.runId);
        const launchDeadline = w.t.clock.now() + 1_000;
        writeFileSync(
          join(runDir, LAUNCH_FILE),
          JSON.stringify({
            version: 1,
            run: started.runId,
            agent: started.agentId,
            socket,
            deadline: launchDeadline,
            plan: { ...started.plan, stdin: [] },
          }),
          { mode: 0o600 },
        );
        host = WorkerHost.start({
          runId: started.runId,
          runDir,
          clock: w.t.clock,
          spawn: () => child,
          killGroup: () => {},
          pid: 4242,
        });
        const launched: LaunchedHost = {
          pid: 4242,
          startTimeMs: 0,
          runId: started.runId,
          agentId: started.agentId,
          socketPath: socket,
          protocolVersion: HOST_PROTOCOL_VERSION,
          runDir,
          eventFile: join(runDir, "events.ndjson"),
          launchDeadline,
        };
        recordWorkerHost(handle, launched, w.t.clock);
        handle.immediate(() => started.record?.());
        w.eventFile = launched.eventFile;
        return launched;
      };
      w.onStop = exitLine(143);
      const pending = w.runs.run(request(w));
      await until(() => w.runs.liveRuns().length === 1);
      // The daemon's claim reaches the host over its socket, before the deadline.
      await Bun.sleep(50);
      for (let i = 0; i < 80; i += 1) {
        w.t.clock.advance(25);
        await Bun.sleep(1);
      }
      // Two seconds on, past the deadline: the session's worker still runs.
      expect(worker.stdinClosed).toBe(false);
      expect(worker.signals).toEqual([]);
      expect(w.runs.liveRuns()).toHaveLength(1);
      await w.runs.stopAll();
      w.t.clock.advance(1_000);
      expect(await pending).toMatchObject({ kind: "failed" });
      for (const close of closers) close();
      exit({ code: 0, signal: null });
      await (host as WorkerHost | null)?.done;
    }));
});
