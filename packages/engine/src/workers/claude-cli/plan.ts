// The Claude Code CLI launch plan (0008 section 2, 0014 sections 1 and 5). `plan` is pure: it
// turns a WorkerSpec and the run's launch context into argv, an allowlisted environment, the run
// settings file and the first stdin line, and refuses anything it cannot launch safely.

import { posix } from "node:path";

import type { OfficeConfig } from "../../config";
import { SRT_DEFAULT_HOME_WRITE_PATHS, SRT_DEFAULT_WRITE_PATHS } from "../../sandbox/policy";
import { PlanError } from "../types";
import type { LaunchPlan, WorkerKind, WorkerSpec } from "../types";
import { userMessageLine } from "./encode";
import {
  DEFAULT_PERMISSION_WAIT_SECONDS,
  HOOK_BUNFIG_FILE,
  hookSettings,
  WEB_TOOLS,
} from "./hooks";
import { enabledPluginsSetting, type WorkerPlugins } from "./plugins";
import {
  PREVIEW_SAFE_CHAIN_ROUTE,
  SAFE_CHAIN_SHELL_DIR,
  safeChainShellFiles,
  safeChainShellPath,
  SHELL_SNAPSHOTS_DIR,
  type SafeChainLaunch,
  type SafeChainRoute,
} from "./safe-chain";
import { DISABLE_SLASH_COMMANDS } from "./skills";

export const CLAUDE_CLI_ADAPTER_ID = "claude-cli";
/** Run settings file, in the run directory (0008 section 10). */
export const SETTINGS_FILE = "claude-settings.json";
/** Copy of the report schema passed on argv, in the run directory (0008 section 10). */
export const REPORT_SCHEMA_FILE = "report-schema.json";
/** The srt default write paths the run settings close, each with its reason (DIPO-98). */
export const CLOSED_WRITES_FILE = "sandbox-closed-writes.json";

// srt, the sandbox runtime under Claude Code's Bash sandbox, makes these paths writable for every
// sandboxed command unless the settings deny them (DIPO-98). A worker writes only its worktree and
// its run temp directory, so the run settings deny writes to each with `sandbox.filesystem.denyWrite`,
// which srt honours over its defaults (measured with srt 0.0.79 on macOS; Claude Code 2.1.301
// bundles the same defaults). Keyed by srt's own lists, so a new default needs a decision here.
const CLOSED_HOME_WRITE_REASONS: Readonly<
  Record<(typeof SRT_DEFAULT_HOME_WRITE_PATHS)[number], string>
> = {
  ".claude/debug":
    "srt opens it for Claude Code's debug logs, but Claude Code writes them from its own process outside the sandbox, so no sandboxed command needs it; it lies in the maintainer's Claude Code configuration directory.",
  ".npm/_logs":
    "srt opens it for npm's debug logs. It is the maintainer's own npm log directory outside the sandbox, so worker code could leave files there that outlive the run; the worker environment sets npm_config_logs_dir to the run temp directory, so npm, Claude Code's own start-up npm call included, logs there instead.",
};
const CLOSED_WRITE_REASONS: Readonly<Record<(typeof SRT_DEFAULT_WRITE_PATHS)[number], string>> = {
  "/tmp/claude":
    "srt's fallback temp directory, shared by every srt sandbox on the machine. Claude Code points its sandboxed commands at its own per-session temp directory and the run has its own temp directory, so a worker never needs it; closed, worker code cannot leave files there for other sandboxes.",
  "/private/tmp/claude": "The same directory as /tmp/claude, as macOS resolves it.",
};

const CLOSED_WRITES_REASON =
  "srt, the sandbox runtime under Claude Code's Bash sandbox, makes these paths writable for every sandboxed command unless the settings deny them. A worker writes only its worktree and its run temp directory, so the run settings deny writes to each (claude-settings.json, sandbox.filesystem.denyWrite; DIPO-98).";

/** A path srt makes writable by default that the worker sandbox closes again (DIPO-98). */
export interface ClosedWritePath {
  readonly path: string;
  readonly reason: string;
}

/** Every srt default write path, made absolute against `home`, with why the worker may not write it. */
export function closedWritePaths(home: string): ClosedWritePath[] {
  return [
    ...SRT_DEFAULT_HOME_WRITE_PATHS.map((rel) => ({
      path: `${home}/${rel}`,
      reason: CLOSED_HOME_WRITE_REASONS[rel],
    })),
    ...SRT_DEFAULT_WRITE_PATHS.map((path) => ({ path, reason: CLOSED_WRITE_REASONS[path] })),
  ];
}

/** Kinds this adapter plans: `implement` (D12, DIPO-15) and `review` (0019 section 4, DIPO-145). */
export const PLANNED_KINDS: readonly WorkerKind[] = ["implement", "review"];

/**
 * The only tools a `review` session may have (0019 section 4, option B): it reads the worktree and
 * runs read-only commands in the sandbox. No Edit or Write, and no WebSearch or WebFetch.
 */
export const REVIEW_TOOLS: readonly string[] = ["Read", "Glob", "Grep", "Bash"];

/**
 * The MCP config file of a `review` session, in the run directory: no server. With
 * `--strict-mcp-config` the reviewer loads no MCP server, not even the office's (0019 section 4).
 */
export const EMPTY_MCP_CONFIG_FILE = "mcp-empty.json";
export const EMPTY_MCP_CONFIG = { mcpServers: {} } as const;

/**
 * The launch context a `spec` is planned with. A `review` session (0019 section 4) runs with no
 * Safe-Chain proxy, since a reviewer installs nothing, and with no plugin the office allows its
 * workers: `worker.plugins` does not apply, so every installed plugin is switched off. With the
 * official Safe-Chain install it keeps the PATH `detectSafeChain` built (`reviewShell`), so bun
 * resolves in the reviewer sandbox, and closes the CLI's shell snapshot (DIPO-250).
 */
export function kindContext(
  spec: Pick<WorkerSpec, "kind">,
  ctx: ClaudeLaunchContext,
): ClaudeLaunchContext {
  if (spec.kind !== "review") return ctx;
  const { safeChain, ...without } = ctx;
  const rest: ClaudeLaunchContext =
    safeChain === undefined ? without : { ...without, reviewShell: { path: safeChain.path } };
  return rest.plugins === undefined ? rest : { ...rest, plugins: { ...rest.plugins, allowed: [] } };
}

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
  /**
   * The run's short temp root (DIPO-118): the worker's `DIPO_TMP`, writable by sandboxed commands
   * and the one place they may bind and reach Unix sockets.
   * `claudeLaunchContext` always sets it; without it (the recordings capture) the worker gets no
   * `DIPO_TMP`, and the sandbox no extra write path and no Unix sockets.
   */
  readonly shortTmpDir?: string;
  /** The office `mcp.json`, when the office has one. */
  readonly mcpConfig?: string;
  /**
   * How to run this `dipo` (`selfCommand()`): the binary's `process.execPath`, or Bun with the
   * entry script when run from source. The hooks of the run settings file run `<it> hook <event>`
   * (0008 section 5), so they need no `PATH`. Required when the spec asks for the hook relay.
   */
  readonly hookCommand?: readonly [string, ...string[]];
  /**
   * `timeouts.permissionWaitSeconds` (0008 section 5): how long the `PermissionRequest` hook may
   * wait for the maintainer; its hook timeout is 30 s above it. 300 by default.
   */
  readonly permissionWaitSeconds?: number;
  /**
   * The official Safe-Chain install found at launch (DIPO-82, DIPO-84), absent when there is none.
   * Then Claude Code's shell is the wrapper in `shellDir` (`<runDir>/safe-chain` for a run; its
   * self-test reuses the run's), the sandbox may read the wrapper directory, the shell snapshot
   * and the proxy directory are read-denied, and the sandbox network is only `route.port`, dipo's
   * Safe-Chain proxy. Without `route` (the dry run) the plan shows placeholders.
   */
  readonly safeChain?: SafeChainLaunch & {
    readonly shellDir: string;
    readonly route?: SafeChainRoute;
  };
  /**
   * Set by `kindContext` for a review session on a machine with the official Safe-Chain install
   * (DIPO-250): the worker PATH `detectSafeChain` built, which the reviewer gets as its PATH, and
   * with it the CLI's shell snapshot is read-denied. A reviewer has no Safe-Chain shell, proxy or install.
   */
  readonly reviewShell?: { readonly path: string };
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
  if (!UUID.test(spec.session.id)) {
    throw new PlanError(`session id must be a UUID: ${spec.session.id}`);
  }
  if (!Number.isInteger(spec.caps.maxTurns) || spec.caps.maxTurns <= 0) {
    throw new PlanError(`maxTurns must be a positive integer: ${spec.caps.maxTurns}`);
  }
  if (spec.tools.allow.length === 0) throw new PlanError("the role must allow at least one tool");
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
}

/** True when the session has a web tool (`worker.web`, 0020 section 11b). */
function webTools(spec: Pick<WorkerSpec, "tools">): boolean {
  return spec.tools.allow.some((tool) => WEB_TOOLS.includes(tool));
}

/** Where npm writes its debug logs in a worker run: the run temp directory (DIPO-98). */
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
  // not an office tool variable): tests the worker runs keep their temp files and sockets here.
  if (paths.shortTmp !== undefined) env.DIPO_TMP = paths.shortTmp;
  // Claude Code runs `npm root --global` at start, outside the sandbox, and npm would write a
  // debug log into <home>/.npm/_logs; every npm the worker runs inherits this too (DIPO-98).
  env.npm_config_logs_dir = `${tmp}/${NPM_LOGS_SUBDIR}`;
  if (ctx.safeChain !== undefined) {
    env.CLAUDE_CODE_SHELL = safeChainShellPath(ctx.safeChain.shellDir, ctx.safeChain);
  } else if (ctx.reviewShell !== undefined) {
    env.PATH = ctx.reviewShell.path;
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
  readonly main: string;
  readonly tmp: string;
  readonly shortTmp: string | undefined;
  readonly runDir: string;
}

function permissions(spec: WorkerSpec, paths: Paths) {
  const fileRules = (tool: "Edit" | "Write") => [
    // `//` anchors at the root. `./` would follow the shell's current directory, so after a `cd`
    // it would stop covering the worktree root (DIPO-193).
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
    // With the hook relay the Bash check refuses every gh call but the help forms (DIPO-195): a deny
    // rule cannot carve them out, and Bash(gh *) would deny `gh pr view --help` too.
    ...(spec.hookRelay ? [] : commands("gh")),
    ...spec.tools.deny,
  ];
  // A reviewer is read-only (0019 section 4): its tool list has no Edit or Write, and the rules
  // deny both on the whole worktree as well.
  const review = spec.kind === "review";
  if (review) deny.push(`Edit(/${paths.workdir}/**)`, `Write(/${paths.workdir}/**)`);
  return {
    // `Bash` needs an allow rule: under `--permission-prompts none` the permission layer denies
    // every Bash call without one (0008 amendment of 2026-10-12, recording
    // `safety-bash-prompts-none`). The deny rules above, the read block, the sandbox and the
    // backstop stay the boundary.
    // With `worker.web` the two web tools are allowed too: under `--permission-prompts none` a
    // call nothing allows is denied (0020 section 11b). The `PreToolUse` hook is their check.
    allow: review
      ? [`Read(/${paths.workdir}/**)`, "Bash"]
      : [
          `Read(/${paths.workdir}/**)`,
          `Edit(/${paths.workdir}/**)`,
          `Write(/${paths.workdir}/**)`,
          "Bash",
          ...WEB_TOOLS.filter((tool) => spec.tools.allow.includes(tool)),
        ],
    deny: unique(deny),
    blockReadsOutsideWorkingDirectories: true,
  };
}

/** The run's Safe-Chain proxy, or the dry run's placeholders. */
function safeChainRoute(ctx: ClaudeLaunchContext): SafeChainRoute {
  return ctx.safeChain?.route ?? PREVIEW_SAFE_CHAIN_ROUTE;
}

/** The office's network: closed unless it allows domains (0008 section 2). */
function closedNetwork(ctx: ClaudeLaunchContext) {
  return {
    allowedDomains: unique(ctx.sandbox.allowedDomains),
    strictAllowlist: true,
    allowLocalBinding: ctx.sandbox.allowLocalBinding,
  };
}

/**
 * With Safe-Chain (DIPO-84): the sandbox's HTTP proxy is dipo's Safe-Chain proxy, so every request
 * a command makes through it reaches only the registries Safe-Chain checks, and Claude Code's own
 * SOCKS proxy allows no domain. Local binding stays off: it would let worker code reach every local
 * port. An office that allows domains or local binding cannot run with it; dipo refuses rather
 * than route that traffic around Safe-Chain or drop the setting.
 */
function safeChainNetwork(ctx: ClaudeLaunchContext) {
  if (ctx.sandbox.allowedDomains.length > 0) {
    throw new PlanError(
      `sandbox.allowedDomains (${ctx.sandbox.allowedDomains.join(", ")}) cannot be used while Safe-Chain is installed: worker network goes only through dipo's Safe-Chain proxy to the package registries; remove the setting from .dipo/office.yaml`,
    );
  }
  if (ctx.sandbox.allowLocalBinding) {
    throw new PlanError(
      "sandbox.allowLocalBinding cannot be true while Safe-Chain is installed: worker code would reach every local port, Safe-Chain's own proxy included; remove the setting from .dipo/office.yaml",
    );
  }
  return {
    allowedDomains: [],
    strictAllowlist: true,
    allowLocalBinding: false,
    httpProxyPort: safeChainRoute(ctx).port,
  };
}

/**
 * A reviewer's network (0019 section 4): closed, whatever the office allows its workers, with no
 * Safe-Chain proxy and no local binding, since a reviewer installs and serves nothing.
 */
const REVIEW_NETWORK = { allowedDomains: [], strictAllowlist: true, allowLocalBinding: false };

function sandbox(spec: WorkerSpec, ctx: ClaudeLaunchContext, paths: Paths) {
  const { home, workdir, main, tmp, shortTmp } = paths;
  const review = spec.kind === "review";
  // The toolchain read list, not the install caches: the worker must reach `~/.bun/bin` to run bun.
  const allowRead = unique([
    ...ctx.sandbox.toolchainReadPaths.map((path) =>
      expandHome("sandbox.toolchainReadPaths", path, home),
    ),
    ...ctx.sandbox.allowRead.map((path) => expandHome("sandbox.allowRead", path, home)),
    // The shell wrapper and the proxy's CA bundle (DIPO-84); nothing of `~/.safe-chain`.
    ...(ctx.safeChain === undefined ? [] : [ctx.safeChain.shellDir]),
  ]);
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      // The short temp root is the only write path added for tests (DIPO-118). A reviewer writes
      // only the two temp roots, never the worktree (0019 section 4).
      allowWrite: [
        ...(review ? [] : [workdir]),
        tmp,
        ...(shortTmp === undefined ? [] : [shortTmp]),
      ],
      // The Keychain files stay closed even where an allowRead toolchain path re-opens part of home
      // (0008 amendment of 2026-10-13); a sandbox deny only, never a permission rule.
      // With Safe-Chain the shell snapshot stays closed too: its functions would replace the
      // wrapper's environment (DIPO-82); and the parent of every Safe-Chain proxy directory, with
      // their CA keys (DIPO-84).
      denyRead: [
        `${home}/Library/Keychains`,
        ...(ctx.safeChain !== undefined
          ? [`${home}/${SHELL_SNAPSHOTS_DIR}`, posix.dirname(safeChainRoute(ctx).dir)]
          : ctx.reviewShell !== undefined
            ? [`${home}/${SHELL_SNAPSHOTS_DIR}`]
            : []),
      ],
      denyWrite: [
        `${main}/.git`,
        `${workdir}/.git`,
        // The story worktree itself for a reviewer (0019 section 4).
        ...(review ? [workdir] : []),
        `${workdir}/backlog`,
        `${workdir}/.dipo`,
        `${workdir}/.claude/settings.json`,
        `${workdir}/.claude/settings.local.json`,
        // srt's default write paths (DIPO-98), with or without Safe-Chain.
        ...closedWritePaths(home).map((closed) => closed.path),
      ],
      allowRead,
    },
    network: review
      ? REVIEW_NETWORK
      : {
          ...(ctx.safeChain === undefined ? closedNetwork(ctx) : safeChainNetwork(ctx)),
          // A test daemon binds its socket under DIPO_TMP. macOS filters Unix sockets by path, so
          // only sockets under the run's own short temp root open (bind and connect); Linux
          // cannot filter them by path, so there they stay closed (DIPO-118).
          ...(shortTmp === undefined ? {} : { allowUnixSockets: [shortTmp] }),
        },
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
  workdir: string,
  runDir: string,
): Record<string, unknown> | undefined {
  if (!spec.hookRelay) return undefined;
  const command = ctx.hookCommand;
  if (command === undefined) {
    throw new PlanError("the hook relay needs the dipo command the hooks run");
  }
  // Hooks run outside the sandbox: a command the worker could rewrite would run its code there.
  for (const part of command) {
    const path = absolute("hookCommand", part);
    if (isInside(path, workdir)) {
      throw new PlanError(`the hook command ${path} must lie outside the worktree ${workdir}`, {
        path,
      });
    }
  }
  const wait = ctx.permissionWaitSeconds ?? DEFAULT_PERMISSION_WAIT_SECONDS;
  if (!Number.isInteger(wait) || wait <= 0 || wait > MAX_PERMISSION_WAIT_SECONDS) {
    throw new PlanError(
      `permissionWaitSeconds must be a whole number from 1 to ${MAX_PERMISSION_WAIT_SECONDS}: ${wait}`,
    );
  }
  return hookSettings(command, wait, runDir, webTools(spec));
}

/** The largest `timeouts.permissionWaitSeconds` the relay accepts (`dipo hook --wait`): one hour. */
export const MAX_PERMISSION_WAIT_SECONDS = 3_600;

/**
 * `enabledPlugins` false for every installed plugin the office does not name (DIPO-108). A plugin
 * hook runs outside the sandbox with the maintainer's credentials, and a SessionStart hook runs
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
  const hookBlock = hooks(spec, ctx, paths.workdir, paths.runDir);
  const enabledPlugins = plugins(ctx);
  return {
    includeGitInstructions: false,
    attribution: { commit: "", pr: "" },
    permissions: permissions(spec, paths),
    sandbox: sandbox(spec, ctx, paths),
    ...(hookBlock === undefined ? {} : { hooks: hookBlock }),
    ...(enabledPlugins === undefined ? {} : { enabledPlugins }),
  };
}

/** Pure: the launch plan for one Claude Code worker. Throws `PlanError` when it cannot. */
export function plan(spec: WorkerSpec, launch: ClaudeLaunchContext): LaunchPlan {
  checkSpec(spec);
  const ctx = kindContext(spec, launch);
  const review = spec.kind === "review";
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
        `${label} ${dir} must lie outside ${under.path}, which the worker sandbox may not write`,
        { path: dir },
      );
    }
    const holds = closed.find((entry) => isInside(entry.path, dir));
    if (holds !== undefined) {
      throw new PlanError(
        `${label} ${dir} must not hold ${holds.path}, which the worker sandbox may not write`,
        { path: dir },
      );
    }
  }
  // A reviewer gets the empty MCP config, never the office's (0019 section 4).
  const mcpConfig = review
    ? `${runDir}/${EMPTY_MCP_CONFIG_FILE}`
    : ctx.mcpConfig === undefined
      ? undefined
      : absolute("mcpConfig", ctx.mcpConfig);
  // The Safe-Chain wrapper also runs outside the sandbox (Claude Code's shell snapshot), so the
  // worker must not be able to change it.
  const shellDir =
    ctx.safeChain === undefined
      ? undefined
      : absolute("safeChain.shellDir", ctx.safeChain.shellDir);
  for (const [label, path] of [
    ["runDir", runDir],
    ["systemFile", systemFile],
    ["mcpConfig", mcpConfig],
    ["safeChain.shellDir", shellDir],
  ] as const) {
    if (path !== undefined && isInside(path, workdir)) {
      throw new PlanError(`${label} ${path} must lie outside the worktree ${workdir}`);
    }
  }
  const paths: Paths = { home, workdir, main, tmp, shortTmp, runDir };
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
      ...(review
        ? [{ name: EMPTY_MCP_CONFIG_FILE, content: `${JSON.stringify(EMPTY_MCP_CONFIG)}\n` }]
        : []),
      // For `dipo run --dry-run` and people: which default write paths the settings close, and why.
      {
        name: CLOSED_WRITES_FILE,
        content: `${JSON.stringify({ reason: CLOSED_WRITES_REASON, denyWrite: closed }, null, 2)}\n`,
      },
      // Run from source, the hooks start Bun with this empty config (`hookCommandLine`).
      ...(spec.hookRelay && (ctx.hookCommand?.length ?? 0) > 1
        ? [{ name: HOOK_BUNFIG_FILE, content: "" }]
        : []),
      // The Safe-Chain shell wrapper and its init file (DIPO-82); a self-test, whose run
      // directory differs, uses the run's.
      ...(ctx.safeChain !== undefined && shellDir === `${runDir}/${SAFE_CHAIN_SHELL_DIR}`
        ? safeChainShellFiles(ctx.safeChain, shellDir, { tmpDir: tmp, route: safeChainRoute(ctx) })
        : []),
    ],
    stdin: [userMessageLine(spec.taskMessage)],
  };
}
