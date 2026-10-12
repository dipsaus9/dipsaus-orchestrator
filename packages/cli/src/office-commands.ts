// `dipo office` subcommands (0006 decision 4, DIPO-27): `open [path]` registers a repository,
// `forget` removes an office from the list, `reload-config` re-reads its configuration. The office
// comes from `--office <id>`, else from the repository around the current directory. In a
// Backlog.md project that is not an office the CLI says so and, at a terminal, asks once whether
// to open it (0006 open question 2); a script is never asked.

import {
  type OfficeId,
  OfficeId as OfficeIdSchema,
  officeForget,
  officeOpen,
  officeReloadConfig,
} from "@dipsaus-orchestrator/contract";

import {
  type DaemonCommandDeps,
  type DaemonSession,
  engineFailure,
  usage,
  withDaemon,
} from "./daemon-commands";
import { absolute, type Workspace } from "./workspace";

export interface OfficeCommandDeps extends DaemonCommandDeps {
  readonly workspace: Workspace;
}

type Subcommand = (args: readonly string[], deps: OfficeCommandDeps) => Promise<number>;

export const NOT_AN_OFFICE = "not an office, run `dipo office open`";

const YES = /^\s*y(es)?\s*$/i;

const at = (path: string | undefined): string => (path === undefined ? "" : ` at ${path}`);

/**
 * What an office subcommand does once it has an office. `from` is the main worktree the office was
 * resolved from, sent so the daemon checks it is the office's registered path; "unknown" when the
 * daemon has no such office there.
 */
type Act = (
  session: DaemonSession,
  office: OfficeId,
  from: string | undefined,
) => Promise<number | "unknown">;

/** Asks the person before the command is sent; false stops it. `path` is null with `--office`. */
type Confirm = (office: OfficeId, path: string | null) => Promise<boolean>;

type Target =
  | { readonly kind: "office"; readonly office: OfficeId; readonly main: string | null }
  | { readonly kind: "unregistered"; readonly main: string }
  | { readonly kind: "exit"; readonly code: number };

interface Parsed {
  readonly office: OfficeId | null;
  readonly yes: boolean;
}

/** Parses `[--office <id>]` and, when allowed, `[--yes]`; a string is a usage error. */
function parseOptions(args: readonly string[], allowYes: boolean): Parsed | string {
  let office: OfficeId | null = null;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--office") {
      const parsed = OfficeIdSchema.safeParse(args[i + 1]);
      if (!parsed.success) return "--office needs an office id (off_...)";
      office = parsed.data;
      i += 1;
    } else if (arg === "--yes" && allowYes) {
      yes = true;
    } else {
      return `unknown argument ${JSON.stringify(arg)}`;
    }
  }
  return { office, yes };
}

/** The office from `--office`, else from the marker of the repository around the current directory. */
async function resolveTarget(deps: OfficeCommandDeps, flag: OfficeId | null): Promise<Target> {
  if (flag !== null) return { kind: "office", office: flag, main: null };
  const { workspace } = deps;
  const location = await workspace.locate(workspace.cwd);
  if (location === null) {
    deps.writeError(
      `dipo: ${workspace.cwd} is not inside a git repository; pass --office <id> or run this in an office.`,
    );
    return { kind: "exit", code: 1 };
  }
  const office = workspace.readOfficeId(location.commonDir);
  if (office !== null) return { kind: "office", office, main: location.mainWorktree };
  if (!workspace.isBacklogProject(location.mainWorktree)) {
    deps.writeError(
      `dipo: ${location.mainWorktree} is not a Backlog.md project; pass --office <id> or run this in an office.`,
    );
    return { kind: "exit", code: 1 };
  }
  return { kind: "unregistered", main: location.mainWorktree };
}

function printOpened(
  deps: OfficeCommandDeps,
  path: string,
  result: { office: OfficeId; registered: boolean; warnings?: string[] | undefined },
  changed: boolean,
): void {
  for (const warning of result.warnings ?? []) deps.writeError(`dipo: warning: ${warning}`);
  if (result.registered) deps.writeLine(`opened ${path} as office ${result.office}`);
  else if (changed) deps.writeLine(`reopened office ${result.office} at ${path}`);
  else deps.writeLine(`${path} is already office ${result.office}`);
}

/**
 * Resolves the office and runs `act`. A Backlog.md project that is not a registered office gets
 * "not an office, run `dipo office open`" and, at a terminal, one question whether to open it.
 */
async function withOffice(
  deps: OfficeCommandDeps,
  flag: OfficeId | null,
  act: Act,
  confirm: Confirm = async () => true,
): Promise<number> {
  const target = await resolveTarget(deps, flag);
  if (target.kind === "exit") return target.code;
  let main: string;
  if (target.kind === "office") {
    // Asked before connecting, so the reply deadline never runs while a person decides.
    if (!(await confirm(target.office, target.main))) return 1;
    let unregistered = false;
    const code = await withDaemon(deps, async (session) => {
      const outcome = await act(session, target.office, target.main ?? undefined);
      if (outcome !== "unknown") return outcome;
      if (target.main === null) {
        deps.writeError(`dipo: office.unknown: there is no office ${target.office}.`);
        return 1;
      }
      unregistered = true;
      return 1;
    });
    if (!unregistered || target.main === null) return code;
    main = target.main;
  } else {
    main = target.main;
  }

  deps.writeError(`dipo: ${NOT_AN_OFFICE}`);
  if (!deps.workspace.interactive) return 1;
  const answer = await deps.workspace.ask(`Open ${main} as an office now? [y/N] `);
  if (!YES.test(answer)) return 1;
  return withDaemon(deps, async (session) => {
    const opened = await session.command(officeOpen, { path: main });
    if (!opened.ok) return engineFailure(deps, opened.error);
    printOpened(deps, main, opened.result, opened.changed);
    if (!(await confirm(opened.result.office, main))) return 1;
    const outcome = await act(session, opened.result.office, main);
    return outcome === "unknown" ? 1 : outcome;
  });
}

async function openCommand(args: readonly string[], deps: OfficeCommandDeps): Promise<number> {
  if (args.length > 1 || (args[0] ?? "").startsWith("-")) {
    return usage(deps, "office open takes one optional path");
  }
  const path = absolute(deps.workspace, args[0] ?? ".");
  return withDaemon(deps, async (session) => {
    const opened = await session.command(officeOpen, { path });
    if (!opened.ok) return engineFailure(deps, opened.error);
    printOpened(deps, path, opened.result, opened.changed);
    return 0;
  });
}

async function forgetCommand(args: readonly string[], deps: OfficeCommandDeps): Promise<number> {
  const options = parseOptions(args, true);
  if (typeof options === "string") return usage(deps, `office forget: ${options}`);
  // `office.forget` has `confirm: true`: every client asks first (0005 section 4).
  const confirm: Confirm = async (office, path) => {
    const named = path === null ? `office ${office}` : `the office at ${path}`;
    if (options.yes) return true;
    if (!deps.workspace.interactive) {
      deps.writeError(
        `dipo: forgetting ${named} needs confirmation; run it at a terminal or pass --yes.`,
      );
      return false;
    }
    const answer = await deps.workspace.ask(
      `Forget ${named}? Its repository and history are kept, and \`dipo office open\` brings it back. [y/N] `,
    );
    if (YES.test(answer)) return true;
    deps.writeLine("nothing forgotten");
    return false;
  };
  const forget: Act = async (session, office, from) => {
    const outcome = await session.command(officeForget, {
      office,
      ...(from === undefined ? {} : { from }),
    });
    if (!outcome.ok) {
      return outcome.error.code === "office.unknown"
        ? "unknown"
        : engineFailure(deps, outcome.error);
    }
    deps.writeLine(
      outcome.changed
        ? `forgot office ${office}${at(outcome.result.path)}`
        : `office ${office}${at(outcome.result.path)} was already forgotten`,
    );
    return 0;
  };
  return withOffice(deps, options.office, forget, confirm);
}

async function reloadConfigCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
  const options = parseOptions(args, false);
  if (typeof options === "string") return usage(deps, `office reload-config: ${options}`);
  return withOffice(deps, options.office, async (session, office, from) => {
    const outcome = await session.command(officeReloadConfig, {
      office,
      ...(from === undefined ? {} : { from }),
    });
    if (!outcome.ok) {
      return outcome.error.code === "office.unknown"
        ? "unknown"
        : engineFailure(deps, outcome.error);
    }
    const { valid, errors, configHash } = outcome.result;
    if (valid) {
      deps.writeLine(
        `office ${office}: configuration valid${configHash === undefined ? "" : ` (${configHash.slice(0, 12)})`}`,
      );
      return 0;
    }
    deps.writeLine(
      `office ${office}: configuration invalid; new runs are refused until it is fixed`,
    );
    for (const error of errors) deps.writeLine(`  ${error.message}`);
    if (configHash !== undefined) {
      deps.writeLine(
        `  running work keeps the previous configuration (${configHash.slice(0, 12)})`,
      );
    }
    return 1;
  });
}

export const OFFICE_SUBCOMMANDS: ReadonlyMap<string, Subcommand> = new Map<string, Subcommand>([
  ["open", openCommand],
  ["forget", forgetCommand],
  ["reload-config", reloadConfigCommand],
]);
