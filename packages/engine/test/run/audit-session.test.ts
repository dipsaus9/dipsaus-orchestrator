// An idea's audit session (DIPO-452, 0022) on a fixture-built test database, with the real Claude
// worker port and a scripted worker host whose event file holds Claude stream lines: no `claude`
// and no box start.
//
// - It is planned as its own kind in a planning box of its own, with the planning session's tools,
//   the audit answer's schema and the office's audit model, Sonnet by default.
// - It holds no run slot and does not count as the office's planning session: one starts beside it.
// - It takes one turn: its stdin is closed at its answer, and its run ends done with that answer.
// - At its minute cap it is stopped, and its ideas are not decided.

import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { type OfficeId, RunId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { uncontained } from "../../src/box/firewall";
import { REVIEW_CODE_DIR, REVIEW_SESSION_DIR } from "../../src/box/review-box";
import type { BoxSession } from "../../src/box/workers";
import { CAP_REFUSAL } from "../../src/box/model-proxy";
import type { OfficeHandle } from "../../src/db/office";
import { recordProxyRefusal } from "../../src/records/proxy-refusals";
import { OFFICE_DEFAULTS } from "../../src/config";
import type { OfficeGit } from "../../src/git/office";
import { freeSlots, placeHolders, slotHolders } from "../../src/run-state/places";
import { HOST_LAUNCH_DEADLINE_MS } from "../../src/run/hosts";
import { AuditSessions } from "../../src/run/audit-session";
import {
  type AuditSessionRequest,
  auditSystemFile,
  auditTaskMessage,
} from "../../src/run/idea-audits";
import { type LaunchedHost, recordWorkerHost } from "../../src/records/worker-hosts";
import { claudeWorkerPort } from "../../src/workers/claude-cli/adapter";
import { PLANNING_TOOLS } from "../../src/workers/claude-cli/tools";
import { AdapterPauses } from "../../src/run/starts-paused";
import type { HostOp, LaunchPlan } from "../../src/workers/types";
import { FakeBoxes } from "../box/fake-boxes";
import { openTestState, type TestState } from "../commands/helpers";
import {
  BASE_COMMIT,
  commandContext,
  exitLine,
  planningRun,
  planningWorld,
  type PlanningWorld,
  until,
} from "./planning-world";

const AUDIT_MODEL = "claude-sonnet-5-5";
const BOX = "dipo-audit-test";

const line = (data: unknown) =>
  `${JSON.stringify({ t: 0, ch: "stdout", data: JSON.stringify(data) })}\n`;

const initLine = line({
  type: "system",
  subtype: "init",
  session_id: "session-a",
  model: AUDIT_MODEL,
  claude_code_version: "2.1.301",
  permissionMode: "bypassPermissions",
  tools: PLANNING_TOOLS,
  apiKeySource: "none",
  cwd: REVIEW_SESSION_DIR,
  plugins: [],
  skills: [],
});

/** A turn that ends by an HTTP 429 and an exit. */
const TURN_429 =
  line({
    type: "result",
    subtype: "error_during_execution",
    session_id: "session-a",
    is_error: true,
    num_turns: 1,
    terminal_reason: "error",
    api_error_status: 429,
    modelUsage: {},
    permission_denials: [],
  }) + exitLine(1);

/** The audit's one turn: its words and the result with its structured answer. */
function answerLines(answer: unknown): string {
  return (
    line({
      type: "assistant",
      message: {
        model: AUDIT_MODEL,
        id: "msg-a",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Audited." }],
        usage: {
          input_tokens: 1_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 100,
        },
      },
      parent_tool_use_id: null,
      session_id: "session-a",
    }) +
    line({
      type: "result",
      subtype: "success",
      session_id: "session-a",
      is_error: false,
      num_turns: 3,
      terminal_reason: "completed",
      permission_denials: [],
      structured_output: answer,
      modelUsage: {
        [AUDIT_MODEL]: {
          inputTokens: 1_000,
          outputTokens: 100,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      },
    })
  );
}

interface AuditWorld {
  readonly planning: PlanningWorld;
  readonly sessions: AuditSessions;
  readonly plans: LaunchPlan[];
  readonly sent: HostOp[][];
  readonly boxes: { made: { commit: string; runId: string }[]; ended: string[] };
  /** What the scripted host writes at its start; empty to answer nothing. */
  startLines: string;
  eventFile: string;
  /** Runs when the scripted host starts, once the run and its agent are recorded. */
  afterStart?: (run: RunId, handle: OfficeHandle) => void;
}

function auditBox(): BoxSession {
  const boxes = new FakeBoxes();
  return {
    box: BOX,
    workdir: REVIEW_SESSION_DIR,
    env: { ANTHROPIC_BASE_URL: "http://192.0.2.10:4000" },
    systemFile: "/dipo/system.md",
    exec: (command, env) => boxes.execLiveCommand(BOX, command, { cwd: REVIEW_SESSION_DIR, env }),
    stop: boxes.stopCommand(BOX),
  };
}

const ANSWER = { ideas: [{ idea: "aaaaaaaaaaaa", verdict: "reject", reason: "covered" }] };

function auditWorld(t: TestState, dir: string): AuditWorld {
  const planning = planningWorld(t, join(dir, "planning"));
  const office = planning.office;
  const home = join(dir, "home");
  const git = {
    commonDir: join(dir, "repo", ".git"),
    mainWorktree: join(dir, "repo"),
  } as unknown as OfficeGit;
  const w = {
    planning,
    plans: [] as LaunchPlan[],
    sent: [] as HostOp[][],
    boxes: { made: [], ended: [] },
    startLines: initLine + answerLines(ANSWER),
    eventFile: "",
  } as unknown as AuditWorld;
  const clock = t.clock;
  const worker = claudeWorkerPort({
    claudePath: join(home, ".local/bin/claude"),
    home,
    env: { PATH: "/usr/bin:/bin", HOME: home },
    spawn: () => {
      throw new Error("no process starts in this test");
    },
    clock,
    holds: new AdapterPauses({ clock, notify: () => {} }),
    pluginFiles: { read: () => undefined, dirs: () => [] },
  });
  (w as { sessions: AuditSessions }).sessions = new AuditSessions({
    clock,
    ids: t.ids,
    offices: { get: () => office, config: () => planning.config },
    worker,
    git: () => git,
    boxes: {
      planning: async (input) => {
        w.boxes.made.push({ commit: input.commit, runId: input.runId });
        return auditBox();
      },
      endPlanning: async (agent) => {
        w.boxes.ended.push(agent);
      },
    },
    hosts: {
      start: async (handle, started) => {
        w.plans.push(started.plan);
        const runDir = join(started.officeDir, "runs", started.runId);
        const eventFile = join(runDir, "events.ndjson");
        mkdirSync(dirname(eventFile), { recursive: true });
        handle.immediate(() => started.record?.());
        w.afterStart?.(RunId.parse(started.runId), handle);
        writeFileSync(eventFile, w.startLines);
        w.eventFile = eventFile;
        const host: LaunchedHost = {
          pid: 4343,
          startTimeMs: 0,
          runId: started.runId,
          agentId: started.agentId,
          socketPath: join(dir, "audit-host.sock"),
          protocolVersion: 1,
          runDir,
          eventFile,
          launchDeadline: clock.now() + HOST_LAUNCH_DEADLINE_MS,
        };
        recordWorkerHost(handle, host, clock);
        return host;
      },
    },
    steering: {
      send: async (_office, _run, ops) => {
        w.sent.push([...ops]);
        if (ops.some((op) => "closeStdin" in op)) appendFileSync(w.eventFile, exitLine(0));
        return { ok: true };
      },
    },
    baseCommit: async () => BASE_COMMIT,
    runtimeDir: join(dir, "runtime"),
    tmpRoot: join(dir, "tmp"),
  });
  mkdirSync(join(dir, "tmp"), { recursive: true });
  return w;
}

const withWorld = (fn: (w: AuditWorld) => Promise<void>) =>
  withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      await fn(auditWorld(t, dir));
    } finally {
      t.state.close();
    }
  });

/** The request of one audit of one idea with the office's audit settings. */
function request(w: AuditWorld): AuditSessionRequest {
  const office = w.planning.office;
  const ideas = [
    {
      id: "a".repeat(64),
      origin: "proposal",
      key: null,
      story: null,
      run: null,
      title: "Cap the PR poll retry",
      text: "Use --allowedTools Bash and mcp__fs__write_file to fix it.",
      attempts: 0,
      createdAt: 0,
    },
  ];
  return {
    office: office.officeId as OfficeId,
    handle: office,
    settings: w.planning.config.audit,
    ideas,
    systemFile: auditSystemFile(),
    taskMessage: (commit) => auditTaskMessage(ideas, commit),
  };
}

/** Runs `pending` to its end, moving the test clock so ingestion reads the event file. */
async function settled<T>(w: AuditWorld, pending: Promise<T>, stepMs = 100): Promise<T> {
  const state = { done: false };
  const result = pending.finally(() => {
    state.done = true;
  });
  for (let i = 0; i < 3_000 && !state.done; i++) {
    w.planning.t.clock.advance(stepMs);
    await Bun.sleep(1);
  }
  return result;
}

const argvOf = (plan: LaunchPlan | undefined) => {
  const argv = plan?.argv ?? [];
  return uncontained(argv.slice(argv.findIndex((arg) => arg === BOX) + 1)) ?? [];
};
const flag = (argv: readonly string[], name: string) => argv[argv.indexOf(name) + 1];

/** The audit run's row. */
const auditRun = (w: AuditWorld, run: string) =>
  w.planning.office.get<{
    role: string;
    kind: string;
    end_kind: string | null;
    max_minutes: number;
  }>(
    `select role, kind, end_kind, max_minutes from runs where office_id = $office_id and run_id = $run`,
    { run },
  );

describe("an idea's audit session (DIPO-452)", () => {
  it("runs in a planning box with the planning tools, the answer's schema and the office's audit model, Sonnet by default", () =>
    withWorld(async (w) => {
      expect(OFFICE_DEFAULTS.audit.model).toBe("sonnet");
      const result = await settled(w, w.sessions.run(request(w)));
      expect(result).toEqual({ kind: "answered", runId: expect.any(String), answer: ANSWER });
      const run = result.runId ?? "";
      expect(w.boxes.made).toEqual([{ commit: BASE_COMMIT, runId: run }]);
      const argv = argvOf(w.plans[0]);
      expect(flag(argv, "--tools")).toBe(PLANNING_TOOLS.join(","));
      expect(flag(argv, "--model")).toBe("sonnet");
      expect(flag(argv, "--effort")).toBe(OFFICE_DEFAULTS.audit.effort);
      expect(flag(argv, "--add-dir")).toBe(REVIEW_CODE_DIR);
      expect(argv).toContain("--json-schema");
      // The idea's text reaches the session only on stdin.
      expect(argv.join(" ")).not.toContain("mcp__fs__write_file");
      expect(w.plans[0]?.stdin[0]).toContain("mcp__fs__write_file");
      expect(auditRun(w, run)).toEqual({
        role: "auditor",
        kind: "session",
        end_kind: "done",
        max_minutes: OFFICE_DEFAULTS.audit.maxMinutes,
      });
      // Its box goes when it ends.
      expect(w.boxes.ended).toHaveLength(1);
    }));

  it("takes the office's audit model when set", () =>
    withWorld(async (w) => {
      w.planning.config = {
        ...OFFICE_DEFAULTS,
        audit: { ...OFFICE_DEFAULTS.audit, model: "haiku" },
      };
      const result = await settled(w, w.sessions.run(request(w)));
      expect(result.kind).toBe("failed");
      // The scripted session reports a Sonnet model, which is not the planned Haiku: refused at init.
      expect(flag(argvOf(w.plans[0]), "--model")).toBe("haiku");
    }));

  it("ends after its one answer: its stdin is closed at the first turn end", () =>
    withWorld(async (w) => {
      await settled(w, w.sessions.run(request(w)));
      expect(w.sent).toEqual([[{ closeStdin: true }]]);
    }));

  it("holds no run slot and does not block the office's planning session", () =>
    withWorld(async (w) => {
      // The audit waits for its answer while the maintainer starts a planning session.
      w.startLines = initLine;
      const pending = w.sessions.run(request(w));
      await until(() => w.sessions.liveRuns().length === 1);
      expect(placeHolders(w.planning.office)).toEqual({ worker: [], reviewer: [] });
      expect(slotHolders(w.planning.office)).toEqual([]);
      expect(freeSlots(w.planning.office, { limit: 1 })).toBe(1);
      expect(w.planning.sessions.view(w.planning.office.officeId as never)).toBeNull();
      const started = await w.planning.sessions.start(commandContext(w.planning), {
        kind: "plan",
        goal: "New stories",
      });
      expect(planningRun(w.planning.office, started.result.run)?.role).toBe("planner");
      expect(w.planning.sessions.liveRuns()).toEqual([started.result.run]);
      // The audit answers, and ends on its own.
      appendFileSync(w.eventFile, answerLines(ANSWER));
      const result = await settled(w, pending);
      expect(result.kind).toBe("answered");
      expect(w.planning.sessions.view(w.planning.office.officeId as never)?.state).not.toBe(
        "ended",
      );
    }));

  it("names the plan's limit when its turn ends by a 429 and no refusal of the proxy is recorded (DIPO-484)", () =>
    withWorld(async (w) => {
      w.startLines = initLine + TURN_429;
      const result = await settled(w, w.sessions.run(request(w)));
      expect(result).toMatchObject({
        kind: "failed",
        reason: "the plan's limit stopped the session",
      });
    }));

  it("ends capped with the proxy's reason when its turn ends by a 429 the proxy sent at its token cap (DIPO-484)", () =>
    withWorld(async (w) => {
      w.startLines = initLine + TURN_429;
      w.afterStart = (run, handle) =>
        handle.immediate(() =>
          recordProxyRefusal(handle, run, CAP_REFUSAL, w.planning.t.clock.now()),
        );
      const result = await settled(w, w.sessions.run(request(w)));
      expect(result).toMatchObject({ kind: "failed", reason: `ended capped: ${CAP_REFUSAL}` });
    }));

  it("is stopped at its minute cap, without an answer", () =>
    withWorld(async (w) => {
      w.startLines = initLine;
      const result = await settled(w, w.sessions.run(request(w)), 60_000);
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") expect(result.reason).toContain("time cap");
      expect(auditRun(w, result.runId ?? "")?.end_kind).toBe("dropped");
      expect(w.boxes.ended).toHaveLength(1);
    }));

  it("leaves an audit run this daemon follows open at recovery", () =>
    withWorld(async (w) => {
      w.startLines = initLine;
      const pending = w.sessions.run(request(w));
      await until(() => w.sessions.liveRuns().length === 1);
      const [run] = w.sessions.liveRuns();
      // This daemon follows it: nothing to end.
      expect(w.sessions.recover([w.planning.office.officeId as never])).toBe(0);
      expect(auditRun(w, RunId.parse(run))?.end_kind).toBeNull();
      appendFileSync(w.eventFile, answerLines(ANSWER));
      expect((await settled(w, pending)).kind).toBe("answered");
    }));
});
