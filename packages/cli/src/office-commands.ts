// `dipo office` subcommands (0006 decision 4, DIPO-27): `open [path]` registers a repository,
// `forget` removes an office from the list, `reload-config` re-reads its configuration, `rescan`
// (DIPO-72) scans its run profile again and prints the diff. The office comes from
// `--office <id>`, else from the repository around the current directory. In a Backlog.md project
// that is not an office the CLI says so and, at a terminal, asks once whether to open it (0006
// open question 2); a script is never asked.

import {
  type OfficeId,
  OfficeId as OfficeIdSchema,
  officeForget,
  officeOpen,
  officeReloadConfig,
  officeRescan,
  scanFinished,
  StreamName,
} from "@dipsaus-orchestrator/contract";

import {
  type DaemonCommandDeps,
  type DaemonSession,
  engineFailure,
  REPLY_TIMEOUT_MS,
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
export type Act = (
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
export function parseOptions(args: readonly string[], allowYes: boolean): Parsed | string {
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
export async function withOffice(
  deps: OfficeCommandDeps,
  flag: OfficeId | null,
  act: Act,
  confirm: Confirm = async () => true,
  timeoutMs: number = REPLY_TIMEOUT_MS,
): Promise<number> {
  const target = await resolveTarget(deps, flag);
  if (target.kind === "exit") return target.code;
  let main: string;
  if (target.kind === "office") {
    // Asked before connecting, so the reply deadline never runs while a person decides.
    if (!(await confirm(target.office, target.main))) return 1;
    let unregistered = false;
    const code = await withDaemon(
      deps,
      async (session) => {
        const outcome = await act(session, target.office, target.main ?? undefined);
        if (outcome !== "unknown") return outcome;
        if (target.main === null) {
          deps.writeError(`dipo: office.unknown: there is no office ${target.office}.`);
          return 1;
        }
        unregistered = true;
        return 1;
      },
      timeoutMs,
    );
    if (!unregistered || target.main === null) return code;
    main = target.main;
  } else {
    main = target.main;
  }

  deps.writeError(`dipo: ${NOT_AN_OFFICE}`);
  if (!deps.workspace.interactive) return 1;
  const answer = await deps.workspace.ask(`Open ${main} as an office now? [y/N] `);
  if (!YES.test(answer)) return 1;
  return withDaemon(
    deps,
    async (session) => {
      const opened = await session.command(officeOpen, { path: main });
      if (!opened.ok) return engineFailure(deps, opened.error);
      printOpened(deps, main, opened.result, opened.changed);
      if (!(await confirm(opened.result.office, main))) return 1;
      const outcome = await act(session, opened.result.office, main);
      return outcome === "unknown" ? 1 : outcome;
    },
    timeoutMs,
  );
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

/** How long `office rescan` waits for its scan: a fetch, a story index pass and the scan. */
export const RESCAN_TIMEOUT_MS = 120_000;

type ScanFinished = ReturnType<typeof scanFinished.data.parse>;

/**
 * Subscribes to the office stream for `scan.finished` from a rescan, then sends `office.rescan`
 * and resolves with that event's data, or with the command's failure.
 */
async function rescanAndWait(
  session: DaemonSession,
  office: OfficeId,
): Promise<
  | { readonly ok: true; readonly data: ScanFinished }
  | { readonly ok: false; readonly code: string; readonly message: string }
> {
  const finished = Promise.withResolvers<ScanFinished>();
  const live = Promise.withResolvers<void>();
  const subscription = session.subscribe(StreamName.parse(`office:${office}`), {
    filter: [scanFinished.type],
    onEvent: (event) => {
      if (event.type !== scanFinished.type) return;
      const data = scanFinished.data.safeParse(event.data);
      if (data.success && data.data.trigger === "rescan") finished.resolve(data.data);
    },
    onCaughtUp: () => live.resolve(),
    onEnded: (error) => {
      const failed = new Error(`${error.code}: ${error.message}`);
      live.reject(failed);
      finished.reject(failed);
    },
  });
  try {
    // Subscribed before the command, so the scan's event cannot be missed.
    await live.promise;
    const outcome = await session.command(officeRescan, {}, { office });
    if (!outcome.ok) return { ok: false, code: outcome.error.code, message: outcome.error.message };
    return { ok: true, data: await finished.promise };
  } finally {
    subscription.unsubscribe();
  }
}

function printScan(deps: OfficeCommandDeps, office: OfficeId, data: ScanFinished): number {
  const deviations = data.deviations ?? [];
  for (const warning of data.warnings) {
    if (!deviations.includes(warning)) deps.writeError(`dipo: warning: ${warning}`);
  }
  if (data.error !== undefined) {
    deps.writeError(`dipo: the rescan of office ${office} failed: ${data.error}`);
    return 1;
  }
  deps.writeLine(`office ${office}: rescanned, conformance ${data.level ?? "unknown"}`);
  const diff = data.diff ?? [];
  if (diff.length === 0) {
    deps.writeLine("no changes since the previous profile");
  } else {
    deps.writeLine("changes since the previous profile:");
    for (const line of diff) deps.writeLine(`  ${line}`);
  }
  if (deviations.length === 0) {
    deps.writeLine("no deviations from the script standard");
  } else {
    deps.writeLine("deviations from the script standard:");
    for (const deviation of deviations) deps.writeLine(`  - ${deviation}`);
  }
  return 0;
}

async function rescanCommand(args: readonly string[], deps: OfficeCommandDeps): Promise<number> {
  const options = parseOptions(args, false);
  if (typeof options === "string") return usage(deps, `office rescan: ${options}`);
  return withOffice(
    deps,
    options.office,
    async (session, office) => {
      const outcome = await rescanAndWait(session, office);
      if (!outcome.ok) {
        if (outcome.code === "office.unknown") return "unknown";
        deps.writeError(`dipo: ${outcome.code}: ${outcome.message}`);
        return 1;
      }
      return printScan(deps, office, outcome.data);
    },
    undefined,
    RESCAN_TIMEOUT_MS,
  );
}

export const OFFICE_SUBCOMMANDS: ReadonlyMap<string, Subcommand> = new Map<string, Subcommand>([
  ["open", openCommand],
  ["forget", forgetCommand],
  ["reload-config", reloadConfigCommand],
  ["rescan", rescanCommand],
]);
