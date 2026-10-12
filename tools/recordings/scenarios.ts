// The live scenarios of 0017 section 2 that `recordings:capture` runs, plus the 0008 live checks
// (DIPO-41 AC #9). Every scenario runs on the `greeter` fixture with the cheapest model the launch
// plan allows. Prompts are small and fixed; only their size and hash reach `meta.json`.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Envelope } from "./format";
import { isRecord } from "./format";

/** Paths of one capture, all absolute and inside the capture's temp directory. */
export interface CapturePaths {
  readonly root: string;
  /** The fixture's main checkout. */
  readonly main: string;
  /** The linked worktree the worker runs in. */
  readonly workdir: string;
  readonly runDir: string;
}

export type TurnText = string | ((paths: CapturePaths) => string);

/** What the capture does in the middle of the first turn. */
export type MidTurn =
  | { readonly kind: "signal"; readonly signal: "SIGINT"; readonly afterDeltas: number }
  | { readonly kind: "pause"; readonly afterDeltas: number };

export interface Scenario {
  readonly name: string;
  readonly fixture: string;
  readonly model: string;
  readonly effort: string;
  readonly maxTurns: number;
  readonly tools: readonly string[];
  /** User messages: the first goes in through the launch plan, each next one after a result. */
  readonly turns: readonly TurnText[];
  readonly midTurn?: MidTurn;
  /** Turns of a second process started with `--resume` on the same session. */
  readonly resumeTurns?: readonly TurnText[];
  readonly expected: string;
  /** Checks on disk and on the raw stream in memory; only the findings are stored. */
  readonly verify?: (
    paths: CapturePaths,
    raw: readonly Envelope[],
  ) => Promise<Record<string, unknown>>;
  readonly timeoutMs: number;
}

export const SYSTEM_PROMPT = [
  "You are a worker in a synthetic fixture repository used to record Claude Code output.",
  "Follow the task exactly, keep replies short and never work around a denied or failed call.",
  "End every turn with the structured report.",
  "",
].join("\n");

function report(status: "done" | "blocked", summary: string, subject: string, extra = ""): string {
  const met = status === "done";
  return (
    `Return the report with status "${status}", criteria [{"n": 1, "met": ${met}, "evidence": "fixture"}], ` +
    `summary "${summary}" and commitSubject "${subject}"${extra}.`
  );
}

const LONG_TEXT =
  "Do not use any tool. Write the numbers from one to three hundred in English words, one per line. ";

const PROBE_FILE = "dipo-probe";

function perlWrite(path: string, mode: ">" | ">>" = ">"): string {
  return `perl -e 'open(my $f, "${mode}", "${path}") or die "write failed: $!\\n"; print $f "probe\\n"; close $f; print "written\\n"'`;
}

const SANDBOX_OBJECT = "dipo-sandbox-probe";

async function gitText(
  cwd: string,
  args: string[],
  stdin?: string,
): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  const out = await new Response(proc.stdout).text();
  return { ok: (await proc.exited) === 0, out: out.trim() };
}

/** For each Bash tool call: whether it errored and how, read from the raw stream in memory. */
function bashOutcomes(raw: readonly Envelope[]): { isError: boolean; kind: string }[] {
  const outcomes: { isError: boolean; kind: string }[] = [];
  for (const line of raw) {
    if (line.ch !== "stdout" || !isRecord(line.data) || line.data.type !== "user") continue;
    const message = line.data.message;
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      const text = JSON.stringify(block.content ?? "");
      const kind = /operation not permitted|read-only file system/i.test(text)
        ? "os-denied"
        : /permission|not allowed|denied/i.test(text)
          ? "permission-denied"
          : /written/.test(text)
            ? "written"
            : "other";
      outcomes.push({ isError: block.is_error === true, kind });
    }
  }
  return outcomes;
}

/** AC #9 go/no-go: does the sandbox `denyWrite` on `<main>/.git` beat the shared-`.git` allowance? */
async function verifyMainGit(
  paths: CapturePaths,
  raw: readonly Envelope[],
): Promise<Record<string, unknown>> {
  const pointer = readFileSync(join(paths.workdir, ".git"), "utf8");
  const expectedPointer = `gitdir: ${join(paths.main, ".git", "worktrees", "story")}\n`;
  const object = await gitText(paths.main, ["hash-object", "--stdin"], `${SANDBOX_OBJECT}\n`);
  const objectWritten = (await gitText(paths.main, ["cat-file", "-e", object.out])).ok;
  const findings = {
    mainGitFileWritten: existsSync(join(paths.main, ".git", PROBE_FILE)),
    worktreeAdminFileWritten: existsSync(
      join(paths.main, ".git", "worktrees", "story", PROBE_FILE),
    ),
    refWritten: existsSync(join(paths.main, ".git", "refs", "heads", PROBE_FILE)),
    objectWritten,
    pointerChanged: pointer !== expectedPointer,
    controlWrittenInWorktree: existsSync(join(paths.workdir, `${PROBE_FILE}.txt`)),
    bashResults: bashOutcomes(raw),
  };
  const blocked =
    !findings.mainGitFileWritten &&
    !findings.worktreeAdminFileWritten &&
    !findings.refWritten &&
    !findings.objectWritten &&
    !findings.pointerChanged;
  return {
    ...findings,
    denyWriteHolds: blocked && findings.controlWrittenInWorktree,
    conclusive: findings.controlWrittenInWorktree,
  };
}

export const SCENARIOS: readonly Scenario[] = [
  {
    name: "success-single",
    fixture: "greeter",
    model: "haiku",
    effort: "low",
    maxTurns: 5,
    tools: ["Read"],
    turns: [
      `Do not use any tool. ${report("done", "Nothing to change.", "chore: record success")}`,
    ],
    expected:
      "One turn, result success with a done report; run completes, usage stored, story advances.",
    timeoutMs: 180_000,
  },
  {
    name: "success-tools-subagent",
    fixture: "greeter",
    model: "haiku",
    effort: "low",
    maxTurns: 10,
    tools: ["Read", "Glob", "Agent"],
    turns: [
      "In one assistant message make two tool calls in parallel: Read the file notes.txt, and use the Agent tool " +
        'to start one general-purpose subagent with the prompt "Read README.md and reply with its first line only." ' +
        report(
          "done",
          "Read the notes and the README.",
          "chore: record tools",
          " once both calls returned",
        ),
    ],
    expected:
      "Tool events, parent_tool_use_id on subagent messages, usage deduplicated by message id, subagent usage in modelUsage; done report.",
    timeoutMs: 300_000,
  },
  {
    name: "max-turns",
    fixture: "greeter",
    model: "haiku",
    effort: "low",
    maxTurns: 1,
    tools: ["Read"],
    turns: [
      `Read notes.txt with the Read tool first. Then ${report("done", "Read the notes.", "chore: record max turns")}`,
      `Do not use any tool. ${report("done", "Second message.", "chore: record max turns again")}`,
    ],
    expected:
      "First turn ends error_max_turns (CLI backstop): outcome capped, park budget-exceeded with the turn cap named. A second queued message gets its own --max-turns limit.",
    timeoutMs: 180_000,
  },
  {
    name: "permission-denied",
    fixture: "greeter",
    model: "haiku",
    effort: "low",
    maxTurns: 5,
    tools: ["Read", "Write"],
    turns: [
      'Use the Write tool to create the file ../outside.txt with the content "x". If the call is denied, do not retry. ' +
        report(
          "blocked",
          "The write was denied.",
          "chore: record denial",
          ' and question "May I write outside the worktree?"',
        ),
    ],
    expected:
      "--permission-prompts none denies the write outside the worktree: system/permission_denied and result permission_denials reach the engine as a denied signal.",
    timeoutMs: 180_000,
  },
  {
    name: "interrupt",
    fixture: "greeter",
    model: "haiku",
    effort: "low",
    maxTurns: 5,
    tools: ["Read"],
    turns: [
      `${LONG_TEXT}${report("done", "Counted.", "chore: record interrupt")}`,
      `Do not use any tool. ${report("done", "After the interrupt.", "chore: record interrupt again")}`,
    ],
    midTurn: { kind: "signal", signal: "SIGINT", afterDeltas: 10 },
    expected:
      "SIGINT mid-turn in stream-json input; the recording shows whether the turn ends with a result and the process stays alive for the next message.",
    timeoutMs: 180_000,
  },
  {
    name: "pause-now",
    fixture: "greeter",
    model: "haiku",
    effort: "low",
    maxTurns: 5,
    tools: ["Read"],
    turns: [
      `${LONG_TEXT}${report("done", "Counted.", "chore: record pause")}`,
      `Do not use any tool. ${report("done", "After the pause.", "chore: record pause again")}`,
    ],
    midTurn: { kind: "pause", afterDeltas: 10 },
    expected:
      'work.pause: a priority "now" user message mid-turn interrupts the turn; each turn in streaming input carries its own structured_output.',
    timeoutMs: 180_000,
  },
  {
    name: "resume",
    fixture: "greeter",
    model: "haiku",
    effort: "low",
    maxTurns: 5,
    tools: ["Read"],
    turns: [
      `Remember the word tangerine. Do not use any tool. ${report("done", "First session.", "chore: record resume")}`,
    ],
    resumeTurns: [
      `Do not use any tool. ${report("done", "Resumed session.", "chore: record resume again")}`,
    ],
    expected:
      "Live pair: run, then --resume on the same session id. Resumed totals include earlier spend and must not be double counted.",
    timeoutMs: 240_000,
  },
  {
    name: "worker-park-ambiguous",
    fixture: "greeter",
    model: "haiku",
    effort: "low",
    maxTurns: 5,
    tools: ["Read"],
    turns: [
      "Read README.md. The story does not say which greeting the CLI should print, so do not change anything. " +
        report(
          "blocked",
          "The greeting is unclear.",
          "chore: record question",
          ' and question exactly "Which greeting should the CLI print: hello or hi?"',
        ),
    ],
    expected:
      "Report status blocked with a fixture-controlled question: question.asked; with no answer within timeouts.questionWaitMinutes the story parks ambiguous-spec with the question as detail.",
    timeoutMs: 180_000,
  },
  {
    name: "safety-main-git",
    fixture: "greeter",
    model: "haiku",
    effort: "low",
    maxTurns: 12,
    tools: ["Bash"],
    turns: [
      (paths) =>
        [
          "This is a sandbox test in a disposable fixture repository. Run each command below with the Bash tool exactly as written,",
          "one Bash call per command, in this order. Do not retry, change or work around any command that fails.",
          `1. ${perlWrite(join(paths.main, ".git", PROBE_FILE))}`,
          `2. ${perlWrite(join(paths.main, ".git", "worktrees", "story", PROBE_FILE))}`,
          `3. ${perlWrite(join(paths.main, ".git", "refs", "heads", PROBE_FILE))}`,
          `4. echo ${SANDBOX_OBJECT} | git hash-object -w --stdin`,
          `5. ${perlWrite(join(paths.workdir, ".git"), ">>")}`,
          `6. ${perlWrite(join(paths.workdir, `${PROBE_FILE}.txt`))}`,
          report("done", "Ran the probes.", "chore: record sandbox probes"),
        ].join("\n"),
    ],
    expected:
      "0008 option (a) go/no-go: sandboxed writes to <main>/.git, its worktree admin directory, refs, objects and the <worktree>/.git pointer fail; the control write inside the worktree succeeds.",
    verify: verifyMainGit,
    timeoutMs: 300_000,
  },
];

export function findScenario(name: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.name === name);
}

export function turnText(turn: TurnText, paths: CapturePaths): string {
  return typeof turn === "string" ? turn : turn(paths);
}
