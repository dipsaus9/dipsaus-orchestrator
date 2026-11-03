// The Claude Code CLI launch plan of a `session` on the Mac (DIPO-310: the scan fallback). `plan`
// is pure: it turns a session's WorkerSpec and the launch context into argv, an allowlisted
// environment, the run settings file and the first stdin line, and refuses anything it cannot
// launch safely: an empty working directory dipo made, every tool off (`--tools ""` and a deny rule
// for each tool by name), so it reads, writes, runs and fetches nothing, no hooks, no MCP server,
// every plugin off, and its structured-output schema. It has no Bash sandbox: with no tool there is
// no command for one to hold (0008).
//
// A developer or reviewer session is never planned here (DIPO-240, DIPO-347): each runs only in a
// box (`box-plan.ts`, 0008). `checkSpec` is shared with the box plan.

import { posix } from "node:path";

import { PlanError } from "../types";
import type { LaunchPlan, WorkerKind, WorkerSpec } from "../types";
import { userMessageLine } from "./encode";
import { enabledPluginsSetting, type WorkerPlugins } from "./plugins";
import { DISABLE_SLASH_COMMANDS } from "./skills";

export const CLAUDE_CLI_ADAPTER_ID = "claude-cli";
/** Run settings file, in the run directory (0008). */
export const SETTINGS_FILE = "claude-settings.json";
/** Copy of the report schema passed on argv, in the run directory (0008). */
export const REPORT_SCHEMA_FILE = "report-schema.json";

/**
 * The flag that adds `stream_event` lines to the stream (DIPO-296): the live view reads each
 * message's final output count from them.
 */
export const INCLUDE_PARTIAL_MESSAGES = "--include-partial-messages";

/**
 * Kinds this adapter plans: `implement` and `review` (0002), only in a box
 * (`box-plan.ts`), and `session` (DIPO-310), on the Mac with `plan`.
 */
export const PLANNED_KINDS: readonly WorkerKind[] = ["implement", "review", "session"];

/**
 * The tools a `session` denies by name, on top of `--tools ""` (DIPO-310): every built-in tool
 * that reads, writes, runs or fetches, so a CLI that ignored the empty tool list still has none.
 */
export const SESSION_DENIED_TOOLS: readonly string[] = [
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "NotebookRead",
  "Glob",
  "Grep",
  "LS",
  "Bash",
  "BashOutput",
  "KillShell",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "Skill",
  "SlashCommand",
  "TodoWrite",
  "ExitPlanMode",
];

/** Why `plan` refuses a developer session (DIPO-240, 0008). */
export const DEVELOPER_ON_MAC_REFUSED =
  "a developer session runs only in its story's box (0008); dipo plans no developer on the Mac";

/** Why `plan` refuses a reviewer session (DIPO-347, 0002). */
export const REVIEWER_ON_MAC_REFUSED =
  "a reviewer session runs only in a read-only box of its own (0002); dipo plans no reviewer on the Mac";

/**
 * The MCP config file of a `session`, in the run directory: no server. With `--strict-mcp-config`
 * the session loads no MCP server, not even the office's.
 */
export const EMPTY_MCP_CONFIG_FILE = "mcp-empty.json";
export const EMPTY_MCP_CONFIG = { mcpServers: {} } as const;

/**
 * The launch context a `session` spec is planned with: every installed plugin is switched off.
 */
export function kindContext(
  spec: Pick<WorkerSpec, "kind">,
  ctx: ClaudeLaunchContext,
): ClaudeLaunchContext {
  if ((spec.kind !== "review" && spec.kind !== "session") || ctx.plugins === undefined) return ctx;
  return { ...ctx, plugins: { ...ctx.plugins, allowed: [] } };
}

/** Variables passed through from the daemon's environment (0008). */
export const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "TMPDIR"] as const;

// Names an office may never declare as tool variables: API keys and tokens that would move a
// session off the Max login or hand it a credential, the engine's own variables, and variables that
// change how processes start (loader, Node and shell startup) or where git resolves its repository.
const REFUSED_TOOL_VARIABLE = /^(?:ANTHROPIC_|CLAUDE_|AWS_|DIPO_|LD_|DYLD_|GIT_)/;
const REFUSED_TOOL_VARIABLES = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
  "NODE_OPTIONS",
  "BASH_ENV",
  "ENV",
]);
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the daemon knows about this run and machine; every path is absolute. */
export interface ClaudeLaunchContext {
  /** The `claude` binary the daemon resolved at start (DIPO-70), never a bare name. */
  readonly claudePath: string;
  /** The maintainer's home directory; `~` in office paths expands against it. */
  readonly home: string;
  /** The daemon's environment; only allowlisted names are taken from it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Tool variables the office declares, passed through when set. */
  readonly toolVariables: readonly string[];
  /** The repository's main checkout. The worktree must lie outside it. */
  readonly mainCheckout: string;
  /** The run directory the host writes the plan's files into. */
  readonly runDir: string;
  /** The run's temp directory; npm's debug logs go under it. */
  readonly tmpDir: string;
  /**
   * The run's short temp root (DIPO-118): the session's `DIPO_TMP`. `claudeLaunchContext` always
   * sets it; without it (the recordings capture) the session gets no `DIPO_TMP`.
   */
  readonly shortTmpDir?: string;
  /**
   * The installed Claude Code plugins and the ones a session may load, none in a run (DIPO-108,
   * 0008): the run settings switch off every installed plugin not allowed.
   * `claudeLaunchContext` always sets it; without it (the recordings capture) the run settings
   * carry no `enabledPlugins`.
   */
  readonly plugins?: WorkerPlugins;
}

function absolute(label: string, path: string): string {
  if (!posix.isAbsolute(path)) throw new PlanError(`${label} must be an absolute path: ${path}`);
  const normal = posix.normalize(path);
  return normal.length > 1 && normal.endsWith("/") ? normal.slice(0, -1) : normal;
}

// Characters with a meaning in permission rules or globs. Claude Code documents no escaping for
// them, so a path holding one is refused rather than written into a rule that matches less.
const RULE_SPECIAL = /[*?[\]{}()\\!]/;

function ruleSafe(label: string, path: string): string {
  const character = [...path].find(
    (char) => char.charCodeAt(0) < 0x20 || char === "\u007f" || RULE_SPECIAL.test(char),
  );
  if (character !== undefined) {
    throw new PlanError(`${label} holds a character with a meaning in permission rules: ${path}`, {
      path,
      character,
    });
  }
  return path;
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

/** A flag value that cannot be read as another flag. */
export function flagValue(label: string, value: string): string {
  if (value.length === 0 || value.startsWith("-")) {
    throw new PlanError(
      `${label} must be a non-empty value that does not start with "-": ${value}`,
    );
  }
  return value;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Refuses a spec this adapter cannot plan (kind, session id, turn cap, tools, task message). */
export function checkSpec(spec: WorkerSpec): void {
  if (!PLANNED_KINDS.includes(spec.kind)) {
    throw new PlanError(
      `the ${CLAUDE_CLI_ADAPTER_ID} adapter cannot plan worker kind "${spec.kind}"; it plans ${PLANNED_KINDS.join(", ")}`,
    );
  }
  if (!UUID.test(spec.session.id)) {
    throw new PlanError(`session id must be a UUID: ${spec.session.id}`);
  }
  if (!Number.isInteger(spec.caps.maxTurns) || spec.caps.maxTurns <= 0) {
    throw new PlanError(`maxTurns must be a positive integer: ${spec.caps.maxTurns}`);
  }
  // `web` is the developer's alone: the developer always has the web (0008). A session runs with
  // every tool off (DIPO-310) and the reviewer has its own tool set (0002), so neither takes it.
  if (spec.kind === "session" && spec.web === true) {
    throw new PlanError("a session runs with every tool off, the web too (DIPO-310)");
  }
  if (spec.kind === "review" && spec.web === true) {
    throw new PlanError("a review session has its own tools (0002); web is the developer's switch");
  }
  if (spec.taskMessage.length === 0) throw new PlanError("the task message is empty");
}

/** Where npm writes its debug logs in a session: the run temp directory (DIPO-98). */
export const NPM_LOGS_SUBDIR = "npm-logs";
// npm's log settings, which only dipo sets: an office value could point them back into home.
const NPM_LOG_VARIABLE = /^npm_config_logs[-_]/i;

function environment(spec: WorkerSpec, ctx: ClaudeLaunchContext, paths: Paths) {
  const { home, tmp } = paths;
  const env: Record<string, string> = {};
  for (const name of ctx.toolVariables) {
    if (!VARIABLE_NAME.test(name)) throw new PlanError(`not a variable name: ${name}`);
    if (
      REFUSED_TOOL_VARIABLE.test(name) ||
      REFUSED_TOOL_VARIABLES.has(name) ||
      NPM_LOG_VARIABLE.test(name)
    ) {
      throw new PlanError(`tool variable ${name} may not reach a worker`);
    }
  }
  for (const name of unique([...ENV_ALLOWLIST, ...ctx.toolVariables]).toSorted()) {
    const value = ctx.env[name];
    if (value !== undefined) env[name] = value;
  }
  // Every path in the plan expands against the same home.
  env.HOME = home;
  env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = "1";
  env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
  env.DIPO_RUN = spec.run;
  // Set by the engine, never taken from the daemon's environment (DIPO_ is not allowlisted and
  // not an office tool variable).
  if (paths.shortTmp !== undefined) env.DIPO_TMP = paths.shortTmp;
  // Claude Code runs `npm root --global` at start, and npm would write a debug log into
  // <home>/.npm/_logs (DIPO-98).
  env.npm_config_logs_dir = `${tmp}/${NPM_LOGS_SUBDIR}`;
  return env;
}

interface Paths {
  readonly home: string;
  readonly workdir: string;
  readonly main: string;
  readonly tmp: string;
  readonly shortTmp: string | undefined;
  readonly runDir: string;
}

/**
 * `enabledPlugins` false for every installed plugin the office does not name (DIPO-108). A plugin
 * hook runs with the maintainer's credentials, and a SessionStart hook runs before `system/init`
 * could be checked, so the switch-off is in the settings, not only the parser.
 * A plugin list that could not be read refuses the plan: what cannot be named cannot be switched off.
 */
function plugins(ctx: ClaudeLaunchContext): Record<string, false> | undefined {
  if (ctx.plugins === undefined) return undefined;
  const { installed, allowed } = ctx.plugins;
  if (!Array.isArray(installed)) {
    throw new PlanError(
      `${(installed as { error: string }).error}; the run settings cannot switch Claude Code plugins off without it, so the run is refused (0008)`,
    );
  }
  return enabledPluginsSetting(installed, allowed);
}

/**
 * Checks the session's working directory: it may not be the root or hold home, so the project
 * settings and CLAUDE.md of the folder it runs in are never the maintainer's own.
 */
function checkWorkdir(workdir: string, home: string): void {
  if (workdir === "/" || isInside(home, workdir)) {
    throw new PlanError(
      `workdir ${workdir} must not be the root or hold the home directory ${home}`,
      { path: workdir },
    );
  }
}

/**
 * The run settings of a `session` (DIPO-310): no tool (each denied by name as well), reads closed
 * outside its empty working directory, no hooks, and every installed plugin off.
 */
function sessionSettings(ctx: ClaudeLaunchContext, paths: Paths) {
  const { main } = paths;
  const enabledPlugins = plugins(ctx);
  return {
    includeGitInstructions: false,
    claudeMdExcludes: [`${main}/**`],
    attribution: { commit: "", pr: "" },
    permissions: {
      allow: [],
      deny: [...SESSION_DENIED_TOOLS],
      blockReadsOutsideWorkingDirectories: true,
    },
    ...(enabledPlugins === undefined ? {} : { enabledPlugins }),
  };
}

/**
 * Pure: the launch plan of one `session` on the Mac (DIPO-310): no worktree, branch or box, every
 * tool off, one turn plus the CLI's schema retry as the spec's turn cap, the spec's schema as the
 * structured output, the task message as the first message.
 */
function planSession(spec: WorkerSpec, launch: ClaudeLaunchContext): LaunchPlan {
  const ctx = kindContext(spec, launch);
  const claude = absolute("claudePath", ctx.claudePath);
  const home = absolute("home", ctx.home);
  const workdir = ruleSafe("workdir", absolute("workdir", spec.workdir));
  const main = ruleSafe("mainCheckout", absolute("mainCheckout", ctx.mainCheckout));
  const runDir = absolute("runDir", ctx.runDir);
  const tmp = absolute("tmpDir", ctx.tmpDir);
  const shortTmp =
    ctx.shortTmpDir === undefined ? undefined : absolute("shortTmpDir", ctx.shortTmpDir);
  const systemFile = absolute("systemFile", spec.systemFile);
  // Its working directory holds nothing of the repository, so no project settings, hooks or
  // CLAUDE.md of the repository load from it or its parents.
  if (isInside(workdir, main) || isInside(main, workdir)) {
    throw new PlanError(
      `a session's folder ${workdir} must lie outside the main checkout ${main}`,
      {
        path: workdir,
      },
    );
  }
  checkWorkdir(workdir, home);
  const mcpConfig = `${runDir}/${EMPTY_MCP_CONFIG_FILE}`;
  for (const [label, path] of [
    ["runDir", runDir],
    ["systemFile", systemFile],
    ["mcpConfig", mcpConfig],
  ] as const) {
    if (isInside(path, workdir)) {
      throw new PlanError(`${label} ${path} must lie outside the session's folder ${workdir}`);
    }
  }
  const paths: Paths = { home, workdir, main, tmp, shortTmp, runDir };
  const argv: [string, ...string[]] = [
    claude,
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    INCLUDE_PARTIAL_MESSAGES,
    "--session-id",
    spec.session.id,
    "--model",
    flagValue("model", spec.model),
    "--effort",
    flagValue("effort", spec.effort),
    "--max-turns",
    String(spec.caps.maxTurns),
    "--permission-mode",
    "default",
    "--permission-prompts",
    "none",
    // Every tool off (0008): an empty list, and each tool denied by name.
    "--tools",
    "",
    "--settings",
    `${runDir}/${SETTINGS_FILE}`,
    "--setting-sources",
    "project,local",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfig,
    "--append-system-prompt-file",
    systemFile,
    "--exclude-dynamic-system-prompt-sections",
    DISABLE_SLASH_COMMANDS,
    "--json-schema",
    JSON.stringify(spec.reportSchema),
  ];
  return {
    argv,
    env: environment(spec, ctx, paths),
    cwd: workdir,
    files: [
      {
        name: SETTINGS_FILE,
        content: `${JSON.stringify(sessionSettings(ctx, paths), null, 2)}\n`,
      },
      { name: REPORT_SCHEMA_FILE, content: `${JSON.stringify(spec.reportSchema, null, 2)}\n` },
      { name: EMPTY_MCP_CONFIG_FILE, content: `${JSON.stringify(EMPTY_MCP_CONFIG)}\n` },
    ],
    stdin: [userMessageLine(spec.taskMessage)],
  };
}

/**
 * Pure: the launch plan of one Claude Code `session` on the Mac. Throws `PlanError` when it
 * cannot, and for a developer or reviewer session, which runs only in a box (`planInBox`).
 */
export function plan(spec: WorkerSpec, launch: ClaudeLaunchContext): LaunchPlan {
  checkSpec(spec);
  if (spec.kind === "session") return planSession(spec, launch);
  throw new PlanError(spec.kind === "review" ? REVIEWER_ON_MAC_REFUSED : DEVELOPER_ON_MAC_REFUSED);
}
