// Shared fixtures for the launch check tests (DIPO-43): a `Spawn` that answers `claude --version`
// and `claude auth status` from fixed text, and a spec and context on absolute fake paths. The
// self-test fixtures went with the Mac worker path (DIPO-240).

import type { Spawn, SpawnOptions } from "@dipsaus-orchestrator/contract";

import {
  FakeProcess,
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
import type { WorkerSpec } from "../../src/workers/types";

export const HOME = "/home/maintainer";
export const MAIN = "/home/maintainer/code/shop";
export const WORKDIR = "/home/maintainer/code/shop.worktrees/DIPO-999";
export const RUN_DIR = `${MAIN}/.git/dipo/runs/run-0001`;
export const TMP_DIR = "/tmp/dipo-run-0001";
/** The run's short temp root (DIPO-118), the worker's DIPO_TMP. */
export const SHORT_TMP_DIR = "/tmp/dipo-t-0123456789";

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
/** The reviewer's own web proxy listener on loopback (DIPO-292); a stand-in port. */
export const REVIEW_WEB_PROXY = "http://127.0.0.1:1";

/**
 * A reviewer's spec (0021 section 10, DIPO-276): kind review, an empty working directory, the
 * read-only copy, the read and web tools with the hook relay and its web proxy (DIPO-292), the
 * ReviewReport schema.
 */
export function reviewSpec(overrides: Partial<WorkerSpec> = {}): WorkerSpec {
  return spec({
    kind: "review",
    workdir: REVIEW_SESSION,
    readOnlyDir: REVIEW_COPY,
    webProxy: REVIEW_WEB_PROXY,
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
    throw new Error("no claude -p session runs in the launch checks");
  };
  return { spawn, calls };
}

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
