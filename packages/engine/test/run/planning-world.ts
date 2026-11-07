// A planning session (DIPO-447) on a fixture-built test database, with the real Claude worker port
// and a scripted worker host whose event file holds Claude stream lines: no `claude` and no box
// start. Each message the session gets on stdin appends one answer to the event file, and the
// model proxy's ledger counts each answer's tokens, as the proxy does for the session's box.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  type DeskItem,
  OfficeId,
  type PlanningProposal,
  RequestId,
  type RunId,
} from "@dipsaus-orchestrator/contract";

import { REVIEW_SESSION_DIR } from "../../src/box/review-box";
import type { BoxSession } from "../../src/box/workers";
import type { AsyncCommandContext } from "../../src/commands/registry";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import type { OfficeHandle } from "../../src/db/office";
import type { OfficeGit } from "../../src/git/office";
import { HOST_LAUNCH_DEADLINE_MS } from "../../src/run/hosts";
import { PlanningSessions, type PlanningSessionsDeps } from "../../src/run/planning-session";
import { AdapterPauses } from "../../src/run/starts-paused";
import { proxiedUsageLedger } from "../../src/records/proxied-usage";
import { type LaunchedHost, recordWorkerHost } from "../../src/records/worker-hosts";
import { claudeWorkerPort } from "../../src/workers/claude-cli/adapter";
import type { HostOp, LaunchPlan } from "../../src/workers/types";
import { FakeBoxes } from "../box/fake-boxes";
import { addOffice, type TestState } from "../commands/helpers";

export const PLANNING_MODEL = "claude-opus-5-5";
export const BASE_COMMIT = "b".repeat(40);
const BOX = "dipo-planning-test";

const line = (data: unknown) =>
  `${JSON.stringify({ t: 0, ch: "stdout", data: JSON.stringify(data) })}\n`;
export const exitLine = (code: number) =>
  `${JSON.stringify({ t: 0, ch: "exit", data: JSON.stringify({ code, signal: null }) })}\n`;

export const initLine = line({
  type: "system",
  subtype: "init",
  session_id: "session-p",
  model: PLANNING_MODEL,
  claude_code_version: "2.1.301",
  permissionMode: "bypassPermissions",
  tools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
  apiKeySource: "none",
  cwd: REVIEW_SESSION_DIR,
  plugins: [],
  skills: [],
});

/** The tokens of answer `n` (from 1), as the proxy reads them from the answer's usage. */
export const answerTokens = (n: number) => ({ input: 1_000 * n, output: 100 * n });

/** One answer of the session: its text and the turn's result. */
export function answerLines(n: number, text = `Answer ${n}.`): string {
  const { input, output } = answerTokens(n);
  return (
    line({
      type: "assistant",
      message: {
        model: PLANNING_MODEL,
        id: `msg-${n}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text }],
        usage: {
          input_tokens: input,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: output,
        },
      },
      parent_tool_use_id: null,
      session_id: "session-p",
    }) +
    line({
      type: "result",
      subtype: "success",
      session_id: "session-p",
      is_error: false,
      num_turns: 1,
      terminal_reason: "completed",
      permission_denials: [],
      modelUsage: {
        [PLANNING_MODEL]: {
          inputTokens: input,
          outputTokens: output,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      },
    })
  );
}

export interface PlanningWorld {
  readonly t: TestState;
  readonly office: OfficeHandle;
  readonly sessions: PlanningSessions;
  readonly plans: LaunchPlan[];
  /** Every op list sent to the session's host, in order. */
  readonly sent: HostOp[][];
  /** The planning boxes made, by their input, and the agents whose box was deleted. */
  readonly boxes: { readonly made: { commit: string; runId: string }[]; readonly ended: string[] };
  /** The answers the scripted worker gave. */
  answers: number;
  /** The office configuration in force. */
  config: OfficeConfig;
  /** The desk the first message lists. */
  desk: DeskItem[];
  eventFile: string;
  /** What the scripted host writes at its start: the init line and the first answer. */
  startLines: string;
  /** True while the scripted worker holds back its answers to messages. */
  holdAnswers: boolean;
  /** Gives the answer to the last message it held back. */
  release(): void;
  /** The text of answer `n` (from 1); `Answer n.` unless a test sets it (DIPO-450). */
  answerText: (n: number) => string;
  /** The offices the session held an aside of, in order (DIPO-452). */
  readonly ideas: string[];
}

/** What a test may give the world instead of its defaults. */
export interface PlanningWorldOptions {
  /** The office the session runs in; a new one by default. */
  readonly office?: OfficeHandle;
  /** The office's planning lane (DIPO-450); none by default. */
  readonly lane?: PlanningSessionsDeps["lane"];
  /** The office's Ready gate (DIPO-451); none by default. */
  readonly gate?: PlanningSessionsDeps["gate"];
  /** The context size at which the session continues in a fresh model session (DIPO-448). */
  readonly contextTokens?: number;
  /** The office's `.dipo/planning.md` at the base commit (DIPO-455); none by default. */
  readonly planningFile?: string;
}

/** The session's box as `BoxWorkers.planning` returns it. */
function planningBox(): BoxSession {
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

export function planningWorld(
  t: TestState,
  dir: string,
  options: PlanningWorldOptions = {},
): PlanningWorld {
  const office = options.office ?? addOffice(t);
  const officeId = OfficeId.parse(office.officeId);
  const home = join(dir, "home");
  const git = {
    commonDir: join(dir, "repo", ".git"),
    mainWorktree: join(dir, "repo"),
  } as unknown as OfficeGit;
  const w = {
    t,
    office,
    plans: [] as LaunchPlan[],
    sent: [] as HostOp[][],
    boxes: { made: [], ended: [] },
    answers: 0,
    config: OFFICE_DEFAULTS,
    desk: [],
    eventFile: "",
    startLines: "",
    holdAnswers: false,
    answerText: (n: number) => `Answer ${n}.`,
    ideas: [],
  } as unknown as PlanningWorld;
  let held: (() => void) | null = null;
  w.release = () => {
    held?.();
    held = null;
  };
  const holds = new AdapterPauses({ clock: t.clock, notify: () => {} });
  const worker = claudeWorkerPort({
    claudePath: join(home, ".local/bin/claude"),
    home,
    env: { PATH: "/usr/bin:/bin", HOME: home },
    spawn: () => {
      throw new Error("no process starts in this test");
    },
    clock: t.clock,
    holds,
    pluginFiles: { read: () => undefined, dirs: () => [] },
  });
  // The model proxy's ledger: each answer's tokens count against the session's run, as its box's
  // requests would.
  const ledger = proxiedUsageLedger({ owner: () => null, office: () => office, clock: t.clock });
  const answer = (run: string, agent: string) => {
    w.answers += 1;
    const { input, output } = answerTokens(w.answers);
    ledger.open(
      { office: officeId, run, agent },
      "opus",
    )({
      model: PLANNING_MODEL,
      input,
      output,
      cacheCreate: 0,
      cacheCreate5m: 0,
      cacheCreate1h: 0,
      cacheRead: 0,
    });
    return answerLines(w.answers, w.answerText(w.answers));
  };
  (w as { sessions: PlanningSessions }).sessions = new PlanningSessions({
    clock: t.clock,
    ids: t.ids,
    offices: {
      get: () => office,
      config: () => w.config,
    },
    worker,
    git: () => git,
    boxes: {
      planning: async (input) => {
        w.boxes.made.push({ commit: input.commit, runId: input.runId });
        return planningBox();
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
        writeFileSync(
          eventFile,
          w.startLines === "" ? initLine + answer(started.runId, started.agentId) : w.startLines,
        );
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
        return host;
      },
    },
    steering: {
      send: async (_office, run, ops) => {
        w.sent.push([...ops]);
        const agent =
          office.get<{ agent_id: string }>(
            "select agent_id from agents where office_id = $office_id and run_id = $run",
            { run },
          )?.agent_id ?? "";
        if (ops.some((op) => "closeStdin" in op)) appendFileSync(w.eventFile, exitLine(0));
        else if (ops.some((op) => "write" in op)) {
          const give = () => appendFileSync(w.eventFile, answer(run, agent));
          if (w.holdAnswers) held = give;
          else give();
        }
        return { ok: true };
      },
    },
    desk: () => w.desk,
    ...(options.lane === undefined ? {} : { lane: options.lane }),
    ...(options.gate === undefined ? {} : { gate: options.gate }),
    onIdea: (id) => w.ideas.push(id),
    baseCommit: async () => BASE_COMMIT,
    planningFile: async () => options.planningFile ?? null,
    ...(options.contextTokens === undefined ? {} : { contextTokens: options.contextTokens }),
    runtimeDir: join(dir, "runtime"),
    tmpRoot: join(dir, "tmp"),
  });
  mkdirSync(join(dir, "tmp"), { recursive: true });
  return w;
}

/** An async command context of `office`, as the executor hands one to a waiting handler. */
export function commandContext(w: PlanningWorld): AsyncCommandContext {
  return {
    office: w.office,
    clock: w.t.clock,
    ids: w.t.ids,
    requestId: RequestId.parse("01J9ZK5Q8W3V4X6Y7Z8A9B0C1D"),
    origin: "cli",
    now: w.t.clock.now(),
    stories: new Map(),
    commit: () => undefined,
  };
}

/** Waits, on the real clock, until `done` holds: the start does file I/O. */
export async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 2_000 && !done(); i++) await Bun.sleep(1);
  if (!done()) throw new Error("the condition never held");
}

/** The planning run's row. */
export function planningRun(office: OfficeHandle, run: RunId | string) {
  return office.get<{
    kind: string;
    role: string;
    story_id: string | null;
    key: string | null;
    branch: string | null;
    budget_limit: number;
    max_minutes: number | null;
    end_kind: string | null;
  }>(
    `select kind, role, story_id, key, branch, budget_limit, max_minutes, end_kind from runs
      where office_id = $office_id and run_id = $run`,
    { run },
  );
}

/** A new story a planning session proposes (DIPO-450). */
export const STORY_PROPOSAL = {
  kind: "story",
  title: "Export the stories as CSV",
  type: "feature",
  milestone: "m-3",
  tier: "M",
  storyLine:
    "As maintainer I want to export the stories as a CSV file so that I can share the backlog with people outside dipo.",
  context: "The export reads the base, as the queue does.",
  criteria: ["The export writes one CSV row per active story", "A Done story is left out of it"],
  references: ["packages/cli/src/export-command.ts", "docs/export.md"],
  testPlan: {
    entries: [
      { kind: "automated", check: "(unit) one CSV row per active story" },
      {
        kind: "manual",
        check: "Export the scratch repository's stories",
        expect: "One row per story opens in a spreadsheet",
      },
    ],
  },
  why: "The maintainer shares the backlog every week by hand.",
} as const satisfies PlanningProposal;

/** An answer that holds `values` as proposal blocks. */
export const blocksOf = (...values: unknown[]): string =>
  [
    "Here is what I propose.",
    ...values.map((value) => `\`\`\`dipo-proposal\n${JSON.stringify(value, null, 2)}\n\`\`\``),
    "Confirm, edit or decline each.",
  ].join("\n\n");
