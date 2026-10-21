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
import {
  REVIEW_REPORT_JSON_SCHEMA,
  WORKER_REPORT_JSON_SCHEMA,
} from "../../src/workers/claude-cli/report-schema";
import {
  APPROVAL_COMMAND,
  SELF_TEST_DENY_REASON,
  type SelfTestFs,
  type StandInRequest,
  type StartHostStandIn,
} from "../../src/workers/claude-cli/self-test";
import type { RunStep } from "../../src/workers/credential-check";
import type { WorkerSpec } from "../../src/workers/types";

export const HOME = "/home/maintainer";
export const MAIN = "/home/maintainer/code/shop";
export const WORKDIR = "/home/maintainer/code/shop.worktrees/DIPO-999";
export const ADMIN_DIR = `${MAIN}/.git/worktrees/DIPO-999`;
export const RUN_DIR = `${MAIN}/.git/dipo/runs/run-0001`;
export const TMP_DIR = "/tmp/dipo-run-0001";
/** The run's short temp root (DIPO-118), the worker's DIPO_TMP. */
export const SHORT_TMP_DIR = "/tmp/dipo-t-0123456789";
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

/** A reviewer session's folder in dipo's temp root (DIPO-276). */
export const REVIEW_FOLDER = "/tmp/dipo-review-run-0001-agt-0001";
/** The reviewer's working directory: an empty folder dipo made. */
export const REVIEW_SESSION = `${REVIEW_FOLDER}/session`;
/** The reviewer's read-only copy of the pushed commit. */
export const REVIEW_COPY = `${REVIEW_FOLDER}/dipo-box-code-abc123/code`;

/**
 * A reviewer's spec (0021 section 10, DIPO-276): kind review, an empty working directory, the
 * read-only copy, the read and web tools with the hook relay, the ReviewReport schema.
 */
export function reviewSpec(overrides: Partial<WorkerSpec> = {}): WorkerSpec {
  return spec({
    kind: "review",
    workdir: REVIEW_SESSION,
    readOnlyDir: REVIEW_COPY,
    model: "opus",
    effort: "high",
    caps: { budgetTokens: 200_000, maxTurns: 60, maxMinutes: 30 },
    systemFile: `${RUN_DIR}/system-review.md`,
    tools: { allow: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"], deny: [] },
    reportSchema: REVIEW_REPORT_JSON_SCHEMA,
    hookRelay: true,
    ...overrides,
  });
}

/** The context of a review launch: the hook relay's dipo command, which the web tools need. */
export function reviewContext(overrides: Partial<ClaudeLaunchContext> = {}): ClaudeLaunchContext {
  return context({ hookCommand: ["/opt/dipo/bin/dipo"], ...overrides });
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
    shortTmpDir: SHORT_TMP_DIR,
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
    if (path === this.failMkdir) throw new Error("EACCES: permission denied");
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

  /** Paths present but not followed (dangling symlinks, DIPO-98). */
  readonly dangling = new Set<string>();
  /** Directories the daemon user cannot write (DIPO-98). */
  readonly readOnlyDirs = new Set<string>();
  /** A path whose mkdir fails (DIPO-98). */
  failMkdir: string | null = null;

  async present(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path) || this.dangling.has(path);
  }

  async writableDir(path: string): Promise<boolean> {
    return this.dirs.has(path) && !this.readOnlyDirs.has(path);
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
 * `recording` with `skills: []` in every `system/init` (DIPO-130). Recordings captured before the
 * plan passed `--disable-slash-commands` list Claude Code's bundled skills (redacted); under the
 * flag a session lists none (recording `safety-slash-skill`, Claude Code 2.1.301), and the
 * adapter refuses one that does. Other lines pass through as they are.
 */
export function withoutSkills(recording: Recording): Recording {
  const lines = recording.lines.map((line) => {
    const data = line.data as { type?: string; subtype?: string };
    if (line.ch !== "stdout" || data.type !== "system" || data.subtype !== "init") return line;
    return { ...line, data: { ...data, skills: [] } };
  });
  return { ...recording, lines };
}

/**
 * The `safety-main-git` session rewritten so its Bash calls run `commands`, in order; Bash calls
 * past the list are dropped. Recordings redact tool inputs, so the exact-command check needs this.
 * Its `system/init` lists no skill, as under the plan's `--disable-slash-commands` (DIPO-130).
 */
export function selfTestSession(
  commands: readonly string[],
  options: SelfTestSessionOptions = {},
): Recording {
  const base = readRecording(
    join(import.meta.dir, "..", "recordings", "claude-cli", "safety-main-git"),
  );
  // The approval call (DIPO-231) follows the given commands; its tool result is dipo's deny.
  const withApproval = options.approval !== false;
  const all = withApproval ? [...commands, APPROVAL_COMMAND] : commands;
  const approvalAt = withApproval ? all.length - 1 : -1;
  const approvalResult = options.approvalResult ?? SELF_TEST_DENY_REASON;
  let seen = 0;
  let approvalId: string | null = null;
  const lines: RecordedLine[] = [];
  for (const line of base.lines) {
    const data = line.data as {
      type?: string;
      message?: { content?: Record<string, unknown>[] };
    };
    const content = data.type === "assistant" ? data.message?.content : undefined;
    if (line.ch === "stdout" && data.type === "user" && approvalId !== null) {
      const results = data.message?.content ?? [];
      if (results.some((block) => block["tool_use_id"] === approvalId)) {
        const replaced = results.map((block) =>
          block["tool_use_id"] === approvalId
            ? { ...block, content: approvalResult, is_error: true }
            : block,
        );
        lines.push({ ...line, data: { ...data, message: { ...data.message, content: replaced } } });
        if (options.cliDenied === true) {
          lines.push({
            t: line.t,
            ch: "stdout",
            data: {
              type: "system",
              subtype: "permission_denied",
              tool_name: "Bash",
              tool_use_id: approvalId,
              decision_reason_type: "mode",
              message: `${CLI_NO_APPROVAL_TEXT}: ${APPROVAL_COMMAND}`,
            },
          });
        }
        continue;
      }
    }
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
      const command = all[seen];
      if (seen === approvalAt) approvalId = String(block["id"]);
      seen += 1;
      if (command !== undefined) kept.push({ ...block, input: { command } });
    }
    if (kept.length === 0) continue;
    lines.push({ ...line, data: { ...data, message: { ...data.message, content: kept } } });
  }
  return withoutSkills({ ...base, lines });
}

export interface SelfTestSessionOptions {
  /** False leaves the approval call out (a session of the old, one-call shape). */
  readonly approval?: boolean;
  /** The tool result text of the approval call; dipo's self-test reason by default. */
  readonly approvalResult?: string;
  /** Adds the CLI's own `permission_denied` event with its no approval surface text. */
  readonly cliDenied?: boolean;
}

/** What the CLI's `permission_denied` text reads when it denies a call itself (DIPO-231). */
export const CLI_NO_APPROVAL_TEXT =
  "no approval surface in this session; permission request denied automatically";

/** A stand-in host for the self-test that records what was started and what reached it. */
export interface FakeStandIn {
  readonly start: StartHostStandIn;
  readonly started: { readonly socketPath: string; readonly run: string }[];
  readonly requests: StandInRequest[];
  stopped: number;
}

/**
 * A fake stand-in host (DIPO-231). By default the approval call's PermissionRequest has reached it
 * (`reached` false: nothing did); `failWith` makes it fail to listen.
 */
export function fakeStandIn(
  options: { readonly reached?: boolean; readonly failWith?: string } = {},
): FakeStandIn {
  const fake: FakeStandIn = {
    started: [],
    requests: options.reached === false ? [] : [{ tool: "Bash", command: APPROVAL_COMMAND }],
    stopped: 0,
    start: async (input) => {
      if (options.failWith !== undefined) throw new Error(options.failWith);
      fake.started.push(input);
      return {
        permissionRequests: fake.requests,
        stop: async () => {
          fake.stopped += 1;
        },
      };
    },
  };
  return fake;
}

/** The stand-in start function of a self-test whose approval call reached dipo. */
export function reachedStandIn(): StartHostStandIn {
  return fakeStandIn().start;
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

/** A review self-test's results (0019 section 4): the worktree refused too, the install failed. */
export const REVIEW_BLOCKED_RESULTS = `${BLOCKED_RESULTS}worktree blocked Operation not permitted\ninstall exit 1\n`;

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

/** A Claude plugin as `system/init` lists it (DIPO-108). */
export interface InitPlugin {
  readonly name: string;
  readonly source: string;
  readonly path: string;
}

/**
 * The plugins every live recording's `system/init` lists (redacted there): Claude Code's builtin
 * ones (DIPO-108 live runs, Claude Code 2.1.301; the redacted name lengths of the 2.1.296
 * recordings match).
 */
export const BUILTIN_PLUGINS = [
  "cc-plugin-agents-md@builtin",
  "cc-plugin-telemetry@builtin",
  "cc-plugin-plugin-authoring@builtin",
] as const;

/**
 * `recording` with its redacted `system/init` plugins named as the builtin ones they are, in
 * order. Only entries whose name is still redacted change, so a recording that names its plugins
 * (`withInitPlugins`) passes through as it is.
 */
export function withBuiltinPlugins(recording: Recording): Recording {
  const lines = recording.lines.map((line) => {
    const data = line.data as { type?: string; subtype?: string; plugins?: unknown };
    if (line.ch !== "stdout" || data.type !== "system" || data.subtype !== "init") return line;
    if (!Array.isArray(data.plugins)) return line;
    let redacted = 0;
    const plugins = data.plugins.map((entry: unknown) => {
      const name = (entry as { name?: unknown } | null)?.name;
      if (typeof name !== "string" || !name.startsWith("[redacted")) return entry;
      const id = BUILTIN_PLUGINS[redacted % BUILTIN_PLUGINS.length] ?? BUILTIN_PLUGINS[0];
      redacted += 1;
      return initPlugin(id);
    });
    return { ...line, data: { ...data, plugins } };
  });
  return { ...recording, lines };
}

/** A `system/init` plugin entry for `<name>@<marketplace>`. */
export function initPlugin(id: string): InitPlugin {
  const name = id.split("@")[0] ?? id;
  return { name, source: id, path: `${HOME}/.claude/plugins/cache/${name}` };
}

/**
 * `recording` with the `plugins` of every `system/init` replaced (DIPO-108): committed recordings
 * redact plugin names, so a test names the plugins a session listed.
 */
export function withInitPlugins(recording: Recording, ids: readonly string[]): Recording {
  const lines = recording.lines.map((line) => {
    const data = line.data as { type?: string; subtype?: string };
    if (line.ch !== "stdout" || data.type !== "system" || data.subtype !== "init") return line;
    return { ...line, data: { ...data, plugins: ids.map(initPlugin) } };
  });
  return { ...recording, lines };
}
