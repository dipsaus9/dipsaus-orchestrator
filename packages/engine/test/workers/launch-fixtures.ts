// Shared fixtures for the launch check tests (DIPO-43): a `Spawn` that answers `claude --version`
// and `claude auth status` from fixed text and replays a recording for the self-test session, an
// in-memory file system for the self-test, and a spec and context on absolute fake paths.

import type { Spawn, SpawnOptions } from "@dipsaus-orchestrator/contract";
import { join } from "node:path";

import {
  FakeProcess,
  fakeSpawn,
  readRecording,
  type ManualClock,
  type RecordedLine,
  type Recording,
} from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config";
import type { ClaudeLaunchContext } from "../../src/workers/claude-cli/plan";
import { WORKER_REPORT_JSON_SCHEMA } from "../../src/workers/claude-cli/report-schema";
import type { SelfTestFs } from "../../src/workers/claude-cli/self-test";
import type { RunStep } from "../../src/workers/credential-check";
import type { WorkerSpec } from "../../src/workers/types";

export const HOME = "/home/maintainer";
export const MAIN = "/home/maintainer/code/shop";
export const WORKDIR = "/home/maintainer/code/shop.worktrees/DIPO-999";
export const ADMIN_DIR = `${MAIN}/.git/worktrees/DIPO-999`;
export const RUN_DIR = `${MAIN}/.git/dipo/runs/run-0001`;
export const TMP_DIR = "/tmp/dipo-run-0001";
export const POINTER = `gitdir: ${ADMIN_DIR}\n`;
export const SELF_TEST_SESSION = "7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

export function spec(overrides: Partial<WorkerSpec> = {}): WorkerSpec {
  return {
    run: "run-0001",
    agent: "agt-0001",
    kind: "implement",
    workdir: WORKDIR,
    model: "sonnet",
    effort: "medium",
    caps: { budgetTokens: 800_000, maxTurns: 120, maxMinutes: 60 },
    systemFile: `${RUN_DIR}/system.md`,
    taskMessage: "<story>DIPO-999 Add a greeting</story>",
    tools: { allow: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"], deny: [] },
    session: { id: "0e6f3f4c-5b8d-4c1e-9a2b-3c4d5e6f7a8b", resume: false },
    reportSchema: WORKER_REPORT_JSON_SCHEMA,
    hookRelay: false,
    ...overrides,
  };
}

export function context(overrides: Partial<ClaudeLaunchContext> = {}): ClaudeLaunchContext {
  return {
    claudePath: `${HOME}/.local/bin/claude`,
    home: HOME,
    env: { PATH: "/usr/bin:/bin", HOME, ANTHROPIC_API_KEY: "sk-ant-api03-not-a-real-key" },
    toolVariables: [],
    mainCheckout: MAIN,
    runDir: RUN_DIR,
    hostSocket: `${RUN_DIR}/host.sock`,
    tmpDir: TMP_DIR,
    sandbox: OFFICE_DEFAULTS.sandbox,
    ...overrides,
  };
}

/** A process that prints `stdout` and exits with `code`. */
export function textProcess(clock: ManualClock, stdout: string, code = 0): FakeProcess {
  const lines: RecordedLine[] = [
    { t: 1, ch: "stdout", data: stdout },
    { t: 2, ch: "exit", data: { code, signal: null } },
  ];
  return new FakeProcess({ lines, clock });
}

export interface ScriptedClaude {
  readonly spawn: Spawn;
  readonly calls: SpawnOptions[];
}

export interface ScriptedClaudeOptions {
  readonly version?: string;
  readonly auth?: string;
  /** Replayed for each `claude -p` (the self-test session). */
  readonly session?: Recording;
  /** Called when the self-test session starts, to play what its command writes. */
  readonly onSession?: (options: SpawnOptions) => void;
}

/** `claude --version`, `claude auth status` and `claude -p` as fakes. */
export function scriptedClaude(clock: ManualClock, options: ScriptedClaudeOptions): ScriptedClaude {
  const calls: SpawnOptions[] = [];
  const spawn: Spawn = (spawnOptions) => {
    calls.push(spawnOptions);
    const args = spawnOptions.cmd.slice(1);
    if (args[0] === "--version") {
      return textProcess(clock, `${options.version ?? "2.1.296"} (Claude Code)\n`);
    }
    if (args[0] === "auth") {
      return textProcess(
        clock,
        options.auth ?? '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}\n',
      );
    }
    if (options.session === undefined) throw new Error("no session recording for claude -p");
    options.onSession?.(spawnOptions);
    return fakeSpawn(options.session, clock).spawn(spawnOptions);
  };
  return { spawn, calls };
}

/** An in-memory file system holding the worktree pointer. */
export class MemoryFs implements SelfTestFs {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
  readonly removed: string[] = [];

  constructor(pointer: string | null = POINTER) {
    if (pointer !== null) this.files.set(`${WORKDIR}/.git`, pointer);
  }

  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }

  /** Paths written as executable (the Safe-Chain wrapper, DIPO-82). */
  readonly executableWrites = new Set<string>();

  async writeText(path: string, text: string, executable?: boolean): Promise<void> {
    this.files.set(path, text);
    if (executable === true) this.executableWrites.add(path);
  }

  async readText(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }

  /** Directories removed because they were empty (the npm-logs probe, DIPO-98). */
  readonly removedDirs: string[] = [];

  async removeEmptyDir(path: string): Promise<void> {
    const prefix = `${path}/`;
    const busy =
      [...this.files.keys()].some((file) => file.startsWith(prefix)) ||
      [...this.dirs].some((dir) => dir.startsWith(prefix));
    if (busy || !this.dirs.has(path)) return;
    this.dirs.delete(path);
    this.removedDirs.push(path);
  }

  async remove(path: string): Promise<void> {
    this.removed.push(path);
    this.files.delete(path);
  }

  /** Directories removed with everything in them (the Safe-Chain install probe, DIPO-84). */
  readonly removedTrees: string[] = [];

  async removeTree(path: string): Promise<void> {
    this.removedTrees.push(path);
    this.dirs.delete(path);
    for (const file of this.files.keys()) {
      if (file.startsWith(`${path}/`)) this.files.delete(file);
    }
  }

  /** Symlink targets by path; any other path resolves to itself. */
  readonly links = new Map<string, string>();
  /** Executable files; `perl` and `gh` in /usr/bin by default. */
  readonly executables = new Set<string>(TOOLS_ON_PATH);

  async realpath(path: string): Promise<string | null> {
    return this.links.get(path) ?? path;
  }

  async isExecutableFile(path: string): Promise<boolean> {
    return this.executables.has(path);
  }
}

export const TOOLS = { perl: "/usr/bin/perl", gh: "/usr/bin/gh" } as const;
const TOOLS_ON_PATH = [TOOLS.perl, TOOLS.gh];

/**
 * The `safety-main-git` session rewritten so its Bash calls run `commands`, in order; Bash calls
 * past the list are dropped. Recordings redact tool inputs, so the exact-command check needs this.
 */
export function selfTestSession(commands: readonly string[]): Recording {
  const base = readRecording(
    join(import.meta.dir, "..", "recordings", "claude-cli", "safety-main-git"),
  );
  let seen = 0;
  const lines: RecordedLine[] = [];
  for (const line of base.lines) {
    const data = line.data as { type?: string; message?: { content?: Record<string, unknown>[] } };
    const content = data.type === "assistant" ? data.message?.content : undefined;
    if (line.ch !== "stdout" || content === undefined) {
      lines.push(line);
      continue;
    }
    const kept: Record<string, unknown>[] = [];
    for (const block of content) {
      if (block["type"] !== "tool_use" || block["name"] !== "Bash") {
        kept.push(block);
        continue;
      }
      const command = commands[seen];
      seen += 1;
      if (command !== undefined) kept.push({ ...block, input: { command } });
    }
    if (kept.length === 0) continue;
    lines.push({ ...line, data: { ...data, message: { ...data.message, content: kept } } });
  }
  return { ...base, lines };
}

/** What the self-test command writes when the sandbox blocks every forbidden write. */
export const BLOCKED_RESULTS = [
  "control written",
  "main-git blocked Operation not permitted",
  "worktree-admin blocked Operation not permitted",
  "refs blocked Operation not permitted",
  "objects blocked Operation not permitted",
  "pointer blocked Operation not permitted",
  "npm-logs blocked Operation not permitted",
  "",
].join("\n");

/**
 * A step runner for the engine credential check. A number is the program's exit code, printed
 * in the marker line by a wrapper that exits 0; `{ wrapperExit }` is a wrapper that failed before
 * the program ran and printed nothing.
 */
export function credentialSteps(
  code: number | "startFailed" | { readonly wrapperExit: number } = 1,
): {
  readonly runStep: RunStep;
  readonly commands: (readonly string[])[];
} {
  const commands: (readonly string[])[] = [];
  const runStep: RunStep = async (request) => {
    commands.push(request.command);
    if (code === "startFailed") return { outcome: "startFailed", reason: "srt is missing" };
    const empty = { text: "", truncated: false };
    const ran = typeof code === "number";
    return {
      outcome: "exited",
      code: ran ? 0 : code.wrapperExit,
      signal: null,
      timedOut: false,
      stdout: ran ? { text: `dipo-credential-exit ${code}\n`, truncated: false } : empty,
      stderr: empty,
      warnings: [],
    };
  };
  return { runStep, commands };
}
