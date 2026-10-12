// The Claude Code CLI launch plan (0008 section 2, 0014 sections 1 and 5). `plan` is pure: it
// turns a WorkerSpec and the run's launch context into argv, an allowlisted environment, the run
// settings file and the first stdin line, and refuses anything it cannot launch safely.

import { posix } from "node:path";

import type { OfficeConfig } from "../../config";
import { PlanError } from "../types";
import type { LaunchPlan, WorkerKind, WorkerSpec } from "../types";
import { userMessageLine } from "./encode";

export const CLAUDE_CLI_ADAPTER_ID = "claude-cli";
/** Run settings file, in the run directory (0008 section 10). */
export const SETTINGS_FILE = "claude-settings.json";
/** Copy of the report schema passed on argv, in the run directory (0008 section 10). */
export const REPORT_SCHEMA_FILE = "report-schema.json";

/** Kinds this adapter plans. M0 plans only `implement` (D12, DIPO-15). */
export const PLANNED_KINDS: readonly WorkerKind[] = ["implement"];

/** Variables passed through from the daemon's environment (0008 section 2). */
export const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "TMPDIR"] as const;

// Names an office may never declare as tool variables: API keys and tokens that would move a
// worker off the Max login or hand it a credential, the engine's own variables, and variables that
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
// Bash rules match the command text only (`sh -c`, aliases and scripts get past them), so they
// guide the model and stop the obvious forms. The real boundary is the sandbox `denyWrite` on
// `<main>/.git` and `<worktree>/.git` plus the closed network (0008 section 2).
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
  /** The office `mcp.json`, when the office has one. */
  readonly mcpConfig?: string;
  readonly sandbox: Pick<
    OfficeConfig["sandbox"],
    "toolchainPaths" | "allowRead" | "allowedDomains" | "allowLocalBinding"
  >;
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
  const control = [...path].some((char) => char.charCodeAt(0) < 0x20 || char === "\u007f");
  if (control || RULE_SPECIAL.test(path)) {
    throw new PlanError(`${label} holds a character with a meaning in permission rules: ${path}`);
  }
  return path;
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

function flagValue(label: string, value: string): string {
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

function checkSpec(spec: WorkerSpec): void {
  if (!PLANNED_KINDS.includes(spec.kind)) {
    throw new PlanError(
      `the ${CLAUDE_CLI_ADAPTER_ID} adapter cannot plan worker kind "${spec.kind}"; it plans ${PLANNED_KINDS.join(", ")}`,
    );
  }
  if (spec.hookRelay) {
    throw new PlanError(
      "hook relay is not available yet: the run settings file registers no hooks",
    );
  }
  if (!UUID.test(spec.session.id)) {
    throw new PlanError(`session id must be a UUID: ${spec.session.id}`);
  }
  if (!Number.isInteger(spec.caps.maxTurns) || spec.caps.maxTurns <= 0) {
    throw new PlanError(`maxTurns must be a positive integer: ${spec.caps.maxTurns}`);
  }
  if (spec.tools.allow.length === 0) throw new PlanError("the role must allow at least one tool");
  for (const tool of spec.tools.allow) {
    if (!TOOL_NAME.test(tool)) throw new PlanError(`not a tool name: ${tool}`);
  }
  if (spec.taskMessage.length === 0) throw new PlanError("the task message is empty");
}

function environment(spec: WorkerSpec, ctx: ClaudeLaunchContext, home: string) {
  const env: Record<string, string> = {};
  for (const name of ctx.toolVariables) {
    if (!VARIABLE_NAME.test(name)) throw new PlanError(`not a variable name: ${name}`);
    if (REFUSED_TOOL_VARIABLE.test(name) || REFUSED_TOOL_VARIABLES.has(name)) {
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
  return env;
}

// A command with and without arguments.
function commands(command: string): string[] {
  return [`Bash(${command})`, `Bash(${command} *)`];
}

interface Paths {
  readonly home: string;
  readonly workdir: string;
  readonly main: string;
  readonly tmp: string;
}

function permissions(spec: WorkerSpec, paths: Paths) {
  const fileRules = (tool: "Edit" | "Write") => [
    `${tool}(./.git)`,
    `${tool}(./.git/**)`,
    `${tool}(./backlog/**)`,
    `${tool}(./.dipo/**)`,
    `${tool}(./.claude/settings.json)`,
    `${tool}(./.claude/settings.local.json)`,
    // `//` anchors at the root, so these name the main checkout absolutely.
    `${tool}(/${paths.main}/.git/**)`,
    `${tool}(/${paths.main}/**)`,
  ];
  const deny = [
    ...fileRules("Edit"),
    ...fileRules("Write"),
    "Read(./**/.env*)",
    "Read(~/.ssh/**)",
    "Read(~/.aws/**)",
    "Read(~/.config/gh/**)",
    "Read(~/.gnupg/**)",
    "Read(~/.netrc)",
    ...GIT_WRITE_VERBS.flatMap((verb) => commands(`git ${verb}`)),
    ...commands("backlog"),
    ...commands("gh"),
    ...spec.tools.deny,
  ];
  return {
    // `Bash` needs an allow rule: under `--permission-prompts none` the permission layer denies
    // every Bash call without one (0008 amendment of 2026-10-12, recording
    // `safety-bash-prompts-none`). The deny rules above, the read block, the sandbox and the
    // backstop stay the boundary.
    allow: ["Read(./**)", "Edit(./**)", "Write(./**)", "Bash"],
    deny: unique(deny),
    blockReadsOutsideWorkingDirectories: true,
  };
}

function sandbox(ctx: ClaudeLaunchContext, paths: Paths) {
  const { home, workdir, main, tmp } = paths;
  const allowRead = unique([
    ...ctx.sandbox.toolchainPaths.map((path) => expandHome("sandbox.toolchainPaths", path, home)),
    ...ctx.sandbox.allowRead.map((path) => expandHome("sandbox.allowRead", path, home)),
  ]);
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      allowWrite: [workdir, tmp],
      denyWrite: [
        `${main}/.git`,
        `${workdir}/.git`,
        `${workdir}/backlog`,
        `${workdir}/.dipo`,
        `${workdir}/.claude/settings.json`,
        `${workdir}/.claude/settings.local.json`,
      ],
      allowRead,
    },
    network: {
      allowedDomains: unique(ctx.sandbox.allowedDomains),
      strictAllowlist: true,
      allowLocalBinding: ctx.sandbox.allowLocalBinding,
    },
    credentials: {
      files: CREDENTIAL_FILES.map((file) => ({ path: `${home}/${file}`, mode: "deny" })),
      envVars: CREDENTIAL_VARIABLES.map((name) => ({ name, mode: "deny" })),
    },
  };
}

/** The run settings file: rules, sandbox and git instruction switches (0008 section 2). */
function settings(spec: WorkerSpec, ctx: ClaudeLaunchContext, paths: Paths) {
  return {
    includeGitInstructions: false,
    attribution: { commit: "", pr: "" },
    permissions: permissions(spec, paths),
    sandbox: sandbox(ctx, paths),
  };
}

/** Pure: the launch plan for one Claude Code worker. Throws `PlanError` when it cannot. */
export function plan(spec: WorkerSpec, ctx: ClaudeLaunchContext): LaunchPlan {
  checkSpec(spec);
  const claude = absolute("claudePath", ctx.claudePath);
  const home = absolute("home", ctx.home);
  const workdir = ruleSafe("workdir", absolute("workdir", spec.workdir));
  const main = ruleSafe("mainCheckout", absolute("mainCheckout", ctx.mainCheckout));
  const runDir = absolute("runDir", ctx.runDir);
  const tmp = absolute("tmpDir", ctx.tmpDir);
  const systemFile = absolute("systemFile", spec.systemFile);
  if (isInside(workdir, main) || isInside(main, workdir)) {
    throw new PlanError(`the worktree ${workdir} must lie outside the main checkout ${main}`);
  }
  for (const [label, dir] of [
    ["workdir", workdir],
    ["tmpDir", tmp],
  ] as const) {
    if (dir === "/" || isInside(home, dir)) {
      throw new PlanError(
        `${label} ${dir} must not be the root or hold the home directory ${home}`,
      );
    }
  }
  const mcpConfig = ctx.mcpConfig === undefined ? undefined : absolute("mcpConfig", ctx.mcpConfig);
  for (const [label, path] of [
    ["runDir", runDir],
    ["systemFile", systemFile],
    ["mcpConfig", mcpConfig],
  ] as const) {
    if (path !== undefined && isInside(path, workdir)) {
      throw new PlanError(`${label} ${path} must lie outside the worktree ${workdir}`);
    }
  }
  const paths: Paths = { home, workdir, main, tmp };
  const reportSchema = JSON.stringify(spec.reportSchema);

  const argv: [string, ...string[]] = [
    claude,
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
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
    ...(mcpConfig === undefined ? [] : ["--mcp-config", mcpConfig]),
    "--append-system-prompt-file",
    systemFile,
    "--exclude-dynamic-system-prompt-sections",
    "--json-schema",
    reportSchema,
  ];

  return {
    argv,
    env: environment(spec, ctx, home),
    cwd: workdir,
    files: [
      { name: SETTINGS_FILE, content: `${JSON.stringify(settings(spec, ctx, paths), null, 2)}\n` },
      { name: REPORT_SCHEMA_FILE, content: `${JSON.stringify(spec.reportSchema, null, 2)}\n` },
    ],
    stdin: [userMessageLine(spec.taskMessage)],
  };
}
