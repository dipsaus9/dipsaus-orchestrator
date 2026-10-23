// The Claude Code CLI launch plan of a reviewer session on the Mac (0008 section 2, 0019 section 4,
// 0021 section 10). `plan` is pure: it turns a review WorkerSpec and the run's launch context into
// argv, an allowlisted environment, the run settings file and the first stdin line, and refuses
// anything it cannot launch safely.
//
// A developer session is never planned here (DIPO-240, 0021): it runs only in its story's box
// (`box-plan.ts`), with no run settings file, Bash sandbox, permission rules or hooks. What stays
// is the reviewer's: read-only tools on dipo's copy of the pushed commit, the web tools through
// dipo's web proxy (DIPO-292) with the fail-closed web gate hook (DIPO-164), and the relay of its
// other hooks to the worker host. `checkSpec` is shared with the box plan.
//
// A `session` (DIPO-310: the scan fallback, 0021 amendment of 2026-10-22) is planned here too, on
// the Mac with no box: an empty working directory dipo made, every tool off (`--tools ""` and a
// deny rule for each tool by name), no hooks, no MCP server, every plugin off, the closed sandbox
// and network of a reviewer, and its structured-output schema.

import { posix } from "node:path";

import { MODEL_UPSTREAM } from "../../box/model-proxy";
import type { OfficeConfig } from "../../config";
import { SRT_DEFAULT_HOME_WRITE_PATHS, SRT_DEFAULT_WRITE_PATHS } from "../../sandbox/policy";
import { PlanError } from "../types";
import type { LaunchPlan, WorkerKind, WorkerSpec } from "../types";
import { userMessageLine } from "./encode";
import { HOOK_BUNFIG_FILE, hookSettings, WEB_TOOLS } from "./hooks";
import { enabledPluginsSetting, type WorkerPlugins } from "./plugins";
import { DISABLE_SLASH_COMMANDS } from "./skills";

export const CLAUDE_CLI_ADAPTER_ID = "claude-cli";
/** Run settings file, in the run directory (0008 section 10). */
export const SETTINGS_FILE = "claude-settings.json";
/** Copy of the report schema passed on argv, in the run directory (0008 section 10). */
export const REPORT_SCHEMA_FILE = "report-schema.json";
/** The srt default write paths the run settings close, each with its reason (DIPO-98). */
export const CLOSED_WRITES_FILE = "sandbox-closed-writes.json";

/**
 * The flag that adds `stream_event` lines to the stream (DIPO-296): the live view reads each
 * message's final output count from them.
 */
export const INCLUDE_PARTIAL_MESSAGES = "--include-partial-messages";

// srt, the sandbox runtime under Claude Code's Bash sandbox, makes these paths writable for every
// sandboxed command unless the settings deny them (DIPO-98). A session writes only its run temp
// directories, so the run settings deny writes to each with `sandbox.filesystem.denyWrite`, which
// srt honours over its defaults (measured with srt 0.0.79 on macOS; Claude Code 2.1.301 bundles the
// same defaults). Keyed by srt's own lists, so a new default needs a decision here.
const CLOSED_HOME_WRITE_REASONS: Readonly<
  Record<(typeof SRT_DEFAULT_HOME_WRITE_PATHS)[number], string>
> = {
  ".claude/debug":
    "srt opens it for Claude Code's debug logs, but Claude Code writes them from its own process outside the sandbox, so no sandboxed command needs it; it lies in the maintainer's Claude Code configuration directory.",
  ".npm/_logs":
    "srt opens it for npm's debug logs. It is the maintainer's own npm log directory outside the sandbox, so a session's commands could leave files there that outlive the run; the session environment sets npm_config_logs_dir to the run temp directory, so npm, Claude Code's own start-up npm call included, logs there instead.",
};
const CLOSED_WRITE_REASONS: Readonly<Record<(typeof SRT_DEFAULT_WRITE_PATHS)[number], string>> = {
  "/tmp/claude":
    "srt's fallback temp directory, shared by every srt sandbox on the machine. Claude Code points its sandboxed commands at its own per-session temp directory and the run has its own temp directory, so a session never needs it; closed, its commands cannot leave files there for other sandboxes.",
  "/private/tmp/claude": "The same directory as /tmp/claude, as macOS resolves it.",
};

const CLOSED_WRITES_REASON =
  "srt, the sandbox runtime under Claude Code's Bash sandbox, makes these paths writable for every sandboxed command unless the settings deny them. A session writes only its run temp directories, so the run settings deny writes to each (claude-settings.json, sandbox.filesystem.denyWrite; DIPO-98).";

/** A path srt makes writable by default that the session sandbox closes again (DIPO-98). */
export interface ClosedWritePath {
  readonly path: string;
  readonly reason: string;
}

/** Every srt default write path, made absolute against `home`, with why a session may not write it. */
export function closedWritePaths(home: string): ClosedWritePath[] {
  return [
    ...SRT_DEFAULT_HOME_WRITE_PATHS.map((rel) => ({
      path: `${home}/${rel}`,
      reason: CLOSED_HOME_WRITE_REASONS[rel],
    })),
    ...SRT_DEFAULT_WRITE_PATHS.map((path) => ({ path, reason: CLOSED_WRITE_REASONS[path] })),
  ];
}

/**
 * Kinds this adapter plans: `implement` (D12, DIPO-15), only in a box (`box-plan.ts`), `review`
 * (0019 section 4, DIPO-145) and `session` (DIPO-310), on the Mac with `plan`.
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

/** Why `plan` refuses a developer session (DIPO-240, 0021). */
export const DEVELOPER_ON_MAC_REFUSED =
  "a developer session runs only in its story's box (0021); dipo plans no developer on the Mac";

/**
 * The only tools a `review` session may have (0021 section 10, DIPO-276): it reads the read-only
 * copy of the pushed commit and may search the web. No shell, no Edit or Write, and so no git or gh.
 */
export const REVIEW_TOOLS: readonly string[] = ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];

/**
 * The one host a reviewer reaches without its web proxy (DIPO-292): the model API the session
 * already uses, the only name in its `NO_PROXY`. Its Claude Code reaches the default model API
 * (the plan passes no base URL), the host of `MODEL_UPSTREAM`.
 */
export const MODEL_API_HOST = new URL(MODEL_UPSTREAM).hostname;

/** The proxy variables HTTP clients read, in either case. */
const PROXY_VARIABLE = /^(?:https?|no|all|ftp)_proxy$/i;

/** A reviewer's web proxy URL: plain http to a loopback port, nothing else (DIPO-292). */
const REVIEW_WEB_PROXY_URL = /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/;

/**
 * The MCP config file of a `review` session, in the run directory: no server. With
 * `--strict-mcp-config` the reviewer loads no MCP server, not even the office's (0019 section 4).
 */
export const EMPTY_MCP_CONFIG_FILE = "mcp-empty.json";
export const EMPTY_MCP_CONFIG = { mcpServers: {} } as const;

/**
 * The launch context a review `spec` is planned with (0019 section 4): no plugin the office allows
 * its workers, since `worker.plugins` does not apply to a reviewer, so every installed plugin is
 * switched off.
 */
export function kindContext(
  spec: Pick<WorkerSpec, "kind">,
  ctx: ClaudeLaunchContext,
): ClaudeLaunchContext {
  if ((spec.kind !== "review" && spec.kind !== "session") || ctx.plugins === undefined) return ctx;
  return { ...ctx, plugins: { ...ctx.plugins, allowed: [] } };
}

/** Variables passed through from the daemon's environment (0008 section 2). */
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

// Git verbs that write or reach the network (0014 section 3): the engine handles every one of them.
// The reviewer has no Bash, so these deny rules only keep its settings closed should a tool list
// ever grow one.
export const GIT_WRITE_VERBS = [
  "add",
  "am",
  "apply",
  "branch",
  "checkout",
  "cherry-pick",
  "clean",
  "commit",
  "commit-tree",
  "config",
  "fetch",
  "merge",
  "mv",
  "notes",
  "pull",
  "push",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "submodule",
  "switch",
  "symbolic-ref",
  "tag",
  "update-ref",
  "worktree",
] as const;

// Credential files under home and variables masked for sandboxed commands (0008 section 2).
const CREDENTIAL_FILES = [".ssh", ".aws", ".config/gh", ".gnupg", ".netrc"] as const;
const CREDENTIAL_VARIABLES = ["GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

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
  /** The worker host's socket, given to hooks as `DIPO_HOST_SOCKET`. */
  readonly hostSocket: string;
  /** The sandbox temp directory sandboxed commands may write. */
  readonly tmpDir: string;
  /**
   * The run's short temp root (DIPO-118): the session's `DIPO_TMP`, writable by sandboxed
   * commands. `claudeLaunchContext` always sets it; without it (the recordings capture) the
   * session gets no `DIPO_TMP` and the sandbox no extra write path.
   */
  readonly shortTmpDir?: string;
  /**
   * How to run this `dipo` (`selfCommand()`): the binary's `process.execPath`, or Bun with the
   * entry script when run from source. The hooks of the run settings file run `<it> hook <event>`
   * (0008 section 5), so they need no `PATH`. Required when the spec asks for the hook relay.
   */
  readonly hookCommand?: readonly [string, ...string[]];
  readonly sandbox: Pick<
    OfficeConfig["sandbox"],
    "toolchainReadPaths" | "allowRead" | "allowedDomains" | "allowLocalBinding"
  >;
  /**
   * The installed Claude Code plugins and `worker.plugins` (DIPO-108, 0008 amendment of
   * 2026-10-12): the run settings switch off every installed plugin the office does not name.
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

function expandHome(label: string, path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return absolute(label, `${home}/${path.slice(2)}`);
  return absolute(label, path);
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
  if (spec.kind === "session") {
    // Every tool off (0021 amendment of 2026-10-22, DIPO-310): no read, shell or web.
    if (spec.tools.allow.length > 0) {
      throw new PlanError(
        `a session runs with every tool off, not with ${spec.tools.allow.join(", ")} (DIPO-310)`,
      );
    }
    if (spec.hookRelay) throw new PlanError("a session runs with no hooks (DIPO-310)");
  } else if (spec.tools.allow.length === 0) {
    throw new PlanError("the role must allow at least one tool");
  }
  for (const tool of spec.tools.allow) {
    if (!TOOL_NAME.test(tool)) throw new PlanError(`not a tool name: ${tool}`);
    if (spec.kind === "review" && !REVIEW_TOOLS.includes(tool)) {
      throw new PlanError(
        `a review session may use only ${REVIEW_TOOLS.join(", ")}, not ${tool} (0019 section 4)`,
      );
    }
  }
  // A web tool without the hook that checks its URL or query for env values is never planned
  // (0020 section 11b): the check fails closed, and so does its absence.
  if (webTools(spec) && !spec.hookRelay) {
    throw new PlanError(
      `${WEB_TOOLS.join(" and ")} need the hook relay, which checks each URL and query for env values (0020 section 11b)`,
    );
  }
  if (spec.taskMessage.length === 0) throw new PlanError("the task message is empty");
  // A reviewer reads only dipo's read-only copy of the pushed commit (DIPO-276); a worker has none.
  if (spec.kind === "review" && spec.readOnlyDir === undefined) {
    throw new PlanError("a review session needs the read-only copy of the pushed commit");
  }
  if (spec.kind !== "review" && spec.readOnlyDir !== undefined) {
    throw new PlanError("only a review session reads a read-only copy");
  }
  // A reviewer's web fetches tunnel through dipo's web proxy, which checks the address at connect
  // time (DIPO-292): a review with a web tool and no proxy is never planned.
  if (spec.kind === "review" && webTools(spec) && spec.webProxy === undefined) {
    throw new PlanError(
      `a review session with ${WEB_TOOLS.join(" or ")} needs dipo's web proxy for its fetches (DIPO-292)`,
    );
  }
  if (spec.webProxy !== undefined) {
    if (spec.kind !== "review") {
      throw new PlanError("only a review session gets a web proxy of its own");
    }
    const port = REVIEW_WEB_PROXY_URL.exec(spec.webProxy)?.[2];
    if (port === undefined || Number(port) > 65_535) {
      throw new PlanError(
        `the reviewer's web proxy must be a plain http URL of a loopback port: ${spec.webProxy}`,
      );
    }
  }
}

/** True when the session has a web tool (`worker.web`, 0020 section 11b). */
function webTools(spec: Pick<WorkerSpec, "tools">): boolean {
  return spec.tools.allow.some((tool) => WEB_TOOLS.includes(tool));
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
  env.DIPO_HOST_SOCKET = absolute("hostSocket", ctx.hostSocket);
  // Set by the engine, never taken from the daemon's environment (DIPO_ is not allowlisted and
  // not an office tool variable).
  if (paths.shortTmp !== undefined) env.DIPO_TMP = paths.shortTmp;
  // Claude Code runs `npm root --global` at start, outside the sandbox, and npm would write a
  // debug log into <home>/.npm/_logs (DIPO-98).
  env.npm_config_logs_dir = `${tmp}/${NPM_LOGS_SUBDIR}`;
  // A reviewer's fetches, and every redirect they follow, tunnel through its web proxy; only the
  // model API goes direct (DIPO-292). Any other proxy variable, in either case, is dropped first:
  // an office tool variable such as `no_proxy` would otherwise send fetches around it.
  if (spec.webProxy !== undefined) {
    for (const name of Object.keys(env)) {
      if (PROXY_VARIABLE.test(name)) delete env[name];
    }
    env.HTTPS_PROXY = spec.webProxy;
    env.HTTP_PROXY = spec.webProxy;
    env.NO_PROXY = MODEL_API_HOST;
  }
  return env;
}

// A command with and without arguments.
function commands(command: string): string[] {
  return [`Bash(${command})`, `Bash(${command} *)`];
}

// Git global options that can come before the verb (`git -C <path> commit`, DIPO-204). Each
// takes a value, so the rule writes it as a wildcard.
const GIT_GLOBAL_OPTIONS = ["-C *", "-c *"];

// Each git write verb, bare and with arguments, plain and after each global option.
function gitWriteVerbRules(verb: string): string[] {
  return [
    ...commands(`git ${verb}`),
    ...GIT_GLOBAL_OPTIONS.flatMap((option) => commands(`git ${option} ${verb}`)),
  ];
}

interface Paths {
  readonly home: string;
  readonly workdir: string;
  /** The reviewer's read-only copy of the pushed commit (DIPO-276). */
  readonly copy: string;
  readonly main: string;
  readonly tmp: string;
  readonly shortTmp: string | undefined;
  readonly runDir: string;
}

/**
 * A reviewer's permission rules (0021 section 10): its tool list has no Edit, Write or Bash, and
 * the rules deny writes on its folder and on the copy as well. It reads only the copy, outside its
 * working directory, so the copy is an added directory of the run settings (DIPO-276). That is
 * never its project root: no project settings, hooks or MCP servers of the copy load. Claude Code
 * can still find a few things in an added directory, so these guards keep them inert rather than
 * the setting itself: skills and commands, by `--disable-slash-commands`; subagents, by no Agent
 * or Task tool; plugin keys of the copy's settings, by `enabledPlugins` false for every installed
 * plugin in the run settings and the refusal of any plugin `system/init` lists; its CLAUDE.md and
 * rules files, by `claudeMdExcludes` and the variable that would load them never being set.
 */
function permissions(spec: WorkerSpec, paths: Paths) {
  const { copy } = paths;
  const fileRules = (tool: "Edit" | "Write") => [
    // `//` anchors at the root (DIPO-193).
    `${tool}(/${paths.workdir}/.git)`,
    `${tool}(/${paths.workdir}/.git/**)`,
    `${tool}(/${paths.workdir}/backlog/**)`,
    `${tool}(/${paths.workdir}/.dipo/**)`,
    `${tool}(/${paths.workdir}/.claude/settings.json)`,
    `${tool}(/${paths.workdir}/.claude/settings.local.json)`,
    // These name the main checkout absolutely.
    `${tool}(/${paths.main}/.git/**)`,
    `${tool}(/${paths.main}/**)`,
  ];
  const deny = [
    ...fileRules("Edit"),
    ...fileRules("Write"),
    `Read(/${paths.workdir}/**/.env*)`,
    "Read(~/.ssh/**)",
    "Read(~/.aws/**)",
    "Read(~/.config/gh/**)",
    "Read(~/.gnupg/**)",
    "Read(~/.netrc)",
    ...GIT_WRITE_VERBS.flatMap(gitWriteVerbRules),
    ...commands("backlog"),
    ...commands("gh"),
    ...spec.tools.deny,
    `Edit(/${paths.workdir}/**)`,
    `Write(/${paths.workdir}/**)`,
    `Edit(/${copy}/**)`,
    `Write(/${copy}/**)`,
    `Read(/${copy}/**/.env*)`,
  ];
  return {
    allow: [`Read(/${copy}/**)`, ...WEB_TOOLS.filter((tool) => spec.tools.allow.includes(tool))],
    deny: unique(deny),
    additionalDirectories: [copy],
    blockReadsOutsideWorkingDirectories: true,
  };
}

/**
 * A reviewer's network (0019 section 4): closed, whatever the office allows, with no local
 * binding, since a reviewer installs and serves nothing; its web tools run outside the Bash
 * sandbox, through dipo's web proxy.
 */
const REVIEW_NETWORK = { allowedDomains: [], strictAllowlist: true, allowLocalBinding: false };

function sandbox(ctx: ClaudeLaunchContext, paths: Paths) {
  const { home, workdir, main, tmp, shortTmp, copy } = paths;
  const allowRead = unique([
    ...ctx.sandbox.toolchainReadPaths.map((path) =>
      expandHome("sandbox.toolchainReadPaths", path, home),
    ),
    ...ctx.sandbox.allowRead.map((path) => expandHome("sandbox.allowRead", path, home)),
  ]);
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      // A reviewer writes only the two temp roots, never the worktree or the copy.
      allowWrite: [tmp, ...(shortTmp === undefined ? [] : [shortTmp])],
      // The Keychain files stay closed even where an allowRead toolchain path re-opens part of home
      // (0008 amendment of 2026-10-13); a sandbox deny only, never a permission rule.
      denyRead: [`${home}/Library/Keychains`],
      denyWrite: [
        `${main}/.git`,
        `${workdir}/.git`,
        // The reviewer's own folder and its copy of the pushed commit (DIPO-276).
        workdir,
        copy,
        `${workdir}/backlog`,
        `${workdir}/.dipo`,
        `${workdir}/.claude/settings.json`,
        `${workdir}/.claude/settings.local.json`,
        // srt's default write paths (DIPO-98).
        ...closedWritePaths(home).map((closed) => closed.path),
      ],
      allowRead,
    },
    network: REVIEW_NETWORK,
    credentials: {
      files: CREDENTIAL_FILES.map((file) => ({ path: `${home}/${file}`, mode: "deny" })),
      envVars: CREDENTIAL_VARIABLES.map((name) => ({ name, mode: "deny" })),
    },
  };
}

/** The `hooks` block when the spec asks for the hook relay (0008 section 5), else none. */
function hooks(
  spec: WorkerSpec,
  ctx: ClaudeLaunchContext,
  paths: Paths,
): Record<string, unknown> | undefined {
  const { workdir, runDir } = paths;
  if (!spec.hookRelay) return undefined;
  const command = ctx.hookCommand;
  if (command === undefined) {
    throw new PlanError("the hook relay needs the dipo command the hooks run");
  }
  // Hooks run outside any sandbox: a command in a folder the session could reach is refused.
  for (const part of command) {
    const path = absolute("hookCommand", part);
    if (isInside(path, workdir)) {
      throw new PlanError(`the hook command ${path} must lie outside the worktree ${workdir}`, {
        path,
      });
    }
    if (isInside(path, paths.copy)) {
      throw new PlanError(`the hook command ${path} must lie outside the review copy`, { path });
    }
  }
  return hookSettings(command, runDir, webTools(spec));
}

/**
 * `enabledPlugins` false for every installed plugin the office does not name (DIPO-108). A plugin
 * hook runs outside any sandbox with the maintainer's credentials, and a SessionStart hook runs
 * before `system/init` could be checked, so the switch-off is in the settings, not only the parser.
 * A plugin list that could not be read refuses the plan: what cannot be named cannot be switched off.
 */
function plugins(ctx: ClaudeLaunchContext): Record<string, false> | undefined {
  if (ctx.plugins === undefined) return undefined;
  const { installed, allowed } = ctx.plugins;
  if (!Array.isArray(installed)) {
    throw new PlanError(
      `${(installed as { error: string }).error}; the run settings cannot switch Claude Code plugins off without it, so the run is refused (0008 amendment of 2026-10-12)`,
    );
  }
  return enabledPluginsSetting(installed, allowed);
}

/** The run settings file: rules, sandbox, hooks and git instruction switches (0008 section 2). */
function settings(spec: WorkerSpec, ctx: ClaudeLaunchContext, paths: Paths) {
  const hookBlock = hooks(spec, ctx, paths);
  const enabledPlugins = plugins(ctx);
  return {
    includeGitInstructions: false,
    // No CLAUDE.md, CLAUDE.local.md or rules file of the copy is meant to load (DIPO-276): the copy
    // is neither the working directory nor its parent, Claude Code loads those of an added directory
    // only with CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD (never passed), and they are excluded by
    // path here too.
    claudeMdExcludes: [`${paths.copy}/**`],
    attribution: { commit: "", pr: "" },
    permissions: permissions(spec, paths),
    sandbox: sandbox(ctx, paths),
    ...(hookBlock === undefined ? {} : { hooks: hookBlock }),
    ...(enabledPlugins === undefined ? {} : { enabledPlugins }),
  };
}

/**
 * Checks the run's temp roots and working directory against home and srt's closed write paths
 * (DIPO-98): none may be the root, hold home, lie under a closed path or hold one.
 */
function checkWritableDirs(
  dirs: readonly (readonly [string, string])[],
  home: string,
): ClosedWritePath[] {
  const closed = closedWritePaths(home);
  for (const [label, dir] of dirs) {
    if (dir === "/" || isInside(home, dir)) {
      throw new PlanError(
        `${label} ${dir} must not be the root or hold the home directory ${home}`,
        { path: dir },
      );
    }
    const under = closed.find((entry) => isInside(dir, entry.path));
    if (under !== undefined) {
      throw new PlanError(
        `${label} ${dir} must lie outside ${under.path}, which the session sandbox may not write`,
        { path: dir },
      );
    }
    const holds = closed.find((entry) => isInside(entry.path, dir));
    if (holds !== undefined) {
      throw new PlanError(
        `${label} ${dir} must not hold ${holds.path}, which the session sandbox may not write`,
        { path: dir },
      );
    }
  }
  return closed;
}

/**
 * The run settings of a `session` (DIPO-310): no tool (each denied by name as well), reads closed
 * outside its empty working directory, writes only to the run's temp roots, the reviewer's closed
 * network, no hooks, and every installed plugin off.
 */
function sessionSettings(ctx: ClaudeLaunchContext, paths: Paths) {
  const { home, workdir, main, tmp, shortTmp } = paths;
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
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: [tmp, ...(shortTmp === undefined ? [] : [shortTmp])],
        denyRead: [`${home}/Library/Keychains`],
        denyWrite: [
          workdir,
          main,
          `${main}/.git`,
          ...closedWritePaths(home).map((closed) => closed.path),
        ],
        allowRead: [],
      },
      network: REVIEW_NETWORK,
      credentials: {
        files: CREDENTIAL_FILES.map((file) => ({ path: `${home}/${file}`, mode: "deny" })),
        envVars: CREDENTIAL_VARIABLES.map((name) => ({ name, mode: "deny" })),
      },
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
  // A session never resumes: each fallback request is a new session (DIPO-310).
  if (spec.session.resume) throw new PlanError("a session is never resumed (DIPO-310)");
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
  const closed = checkWritableDirs(
    [
      ["workdir", workdir],
      ["tmpDir", tmp],
      ...(shortTmp === undefined ? [] : [["shortTmpDir", shortTmp] as const]),
    ],
    home,
  );
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
  const paths: Paths = { home, workdir, copy: workdir, main, tmp, shortTmp, runDir };
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
    // Every tool off (0021 amendment of 2026-10-22): an empty list, and each tool denied by name.
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
      {
        name: CLOSED_WRITES_FILE,
        content: `${JSON.stringify({ reason: CLOSED_WRITES_REASON, denyWrite: closed }, null, 2)}\n`,
      },
    ],
    stdin: [userMessageLine(spec.taskMessage)],
  };
}

/**
 * Pure: the launch plan of one Claude Code reviewer session or `session` on the Mac. Throws
 * `PlanError` when it cannot, and for a developer session, which runs only in its box
 * (`planInBox`).
 */
export function plan(spec: WorkerSpec, launch: ClaudeLaunchContext): LaunchPlan {
  checkSpec(spec);
  if (spec.kind === "session") return planSession(spec, launch);
  if (spec.kind !== "review" || spec.readOnlyDir === undefined) {
    throw new PlanError(DEVELOPER_ON_MAC_REFUSED);
  }
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
  if (isInside(workdir, main) || isInside(main, workdir)) {
    throw new PlanError(`the worktree ${workdir} must lie outside the main checkout ${main}`, {
      path: workdir,
    });
  }
  const copy = ruleSafe("readOnlyDir", absolute("readOnlyDir", spec.readOnlyDir));
  // A reviewer's working directory is outside its copy and holds no part of it, so Claude Code
  // finds no project settings, hooks or CLAUDE.md of the commit there or in its parents (0021
  // section 14); the copy is no checkout and no home either.
  for (const [label, other] of [
    ["working directory", workdir],
    ["main checkout", main],
    ["home directory", home],
    ["sandbox temp directory", tmp],
    ...(shortTmp === undefined ? [] : [["short temp root", shortTmp] as const]),
  ] as const) {
    if (isInside(copy, other) || isInside(other, copy)) {
      throw new PlanError(`the review copy ${copy} must lie outside the ${label} ${other}`, {
        path: copy,
      });
    }
  }
  const closed = closedWritePaths(home);
  for (const [label, dir] of [
    ["workdir", workdir],
    ["tmpDir", tmp],
    ...(shortTmp === undefined ? [] : [["shortTmpDir", shortTmp] as const]),
  ] as const) {
    if (dir === "/" || isInside(home, dir)) {
      throw new PlanError(
        `${label} ${dir} must not be the root or hold the home directory ${home}`,
        { path: dir },
      );
    }
    // Under a closed path the deny would win over the run's own write path; holding one, the
    // run's write path would reach around it, so neither is planned (DIPO-98).
    const under = closed.find((entry) => isInside(dir, entry.path));
    if (under !== undefined) {
      throw new PlanError(
        `${label} ${dir} must lie outside ${under.path}, which the session sandbox may not write`,
        { path: dir },
      );
    }
    const holds = closed.find((entry) => isInside(entry.path, dir));
    if (holds !== undefined) {
      throw new PlanError(
        `${label} ${dir} must not hold ${holds.path}, which the session sandbox may not write`,
        { path: dir },
      );
    }
  }
  // A reviewer gets the empty MCP config, never the office's (0019 section 4).
  const mcpConfig = `${runDir}/${EMPTY_MCP_CONFIG_FILE}`;
  for (const [label, path] of [
    ["runDir", runDir],
    ["systemFile", systemFile],
    ["mcpConfig", mcpConfig],
  ] as const) {
    if (isInside(path, workdir)) {
      throw new PlanError(`${label} ${path} must lie outside the worktree ${workdir}`);
    }
    if (isInside(path, copy)) {
      throw new PlanError(`${label} ${path} must lie outside the review copy ${copy}`);
    }
  }
  const paths: Paths = { home, workdir, copy, main, tmp, shortTmp, runDir };
  const reportSchema = JSON.stringify(spec.reportSchema);

  const argv: [string, ...string[]] = [
    claude,
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    // The `message_delta` stream events carry each message's real output count, which the live
    // view counts during a session (DIPO-296); recordings are captured with it (0017 section 2).
    INCLUDE_PARTIAL_MESSAGES,
    spec.session.resume ? "--resume" : "--session-id",
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
    "--tools",
    spec.tools.allow.join(","),
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
    // No session has skill grants yet (DIPO-116), so none loads a skill and no `/` message expands
    // one (DIPO-130).
    DISABLE_SLASH_COMMANDS,
    "--json-schema",
    reportSchema,
  ];

  return {
    argv,
    env: environment(spec, ctx, paths),
    cwd: workdir,
    files: [
      { name: SETTINGS_FILE, content: `${JSON.stringify(settings(spec, ctx, paths), null, 2)}\n` },
      { name: REPORT_SCHEMA_FILE, content: `${JSON.stringify(spec.reportSchema, null, 2)}\n` },
      { name: EMPTY_MCP_CONFIG_FILE, content: `${JSON.stringify(EMPTY_MCP_CONFIG)}\n` },
      // For people: which default write paths the settings close, and why.
      {
        name: CLOSED_WRITES_FILE,
        content: `${JSON.stringify({ reason: CLOSED_WRITES_REASON, denyWrite: closed }, null, 2)}\n`,
      },
      // Run from source, the hooks start Bun with this empty config (`hookCommandLine`).
      ...(spec.hookRelay && (ctx.hookCommand?.length ?? 0) > 1
        ? [{ name: HOOK_BUNFIG_FILE, content: "" }]
        : []),
    ],
    stdin: [userMessageLine(spec.taskMessage)],
  };
}
