// Office init (0010 sections 2, 6 and 11; 0012 section 2; DIPO-36): `office.init { office }`
// prepares an office's backlog for the 0012 lifecycle through the planning lane. It reads the base
// in the engine's backlog worktree, records the settings it is about to change in
// `backlog_config_previous`, journals one `init` operation per step that differs on the base, and
// flushes the lane: the steps become commits on one engine branch and one backlog PR, which DIPO-35
// opens and checks and GitHub's auto-merge merges once its checks pass (0002).
//
// Init is target-state: a step already true on the base is not journaled, and a step already open
// in the journal with the same target is not journaled again, so a second run adds no commits. It
// never writes `.dipo/office.yaml`: without it the built-in defaults apply (DIPO-15 D9).
//
// `officeStatusesReady(office)` reads `backlog/config.yml` on the base (the one Backlog.md file the
// engine reads directly, 0010 section 1) and returns a refusal naming `dipo office init` while
// `In Review` or `Parked` is missing; `work.run` (DIPO-48) refuses runs with it. The load step
// `office.statuses` raises the same as an `engine.notice` when the office loads.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type Clock, type OfficeId, officeInit } from "@dipsaus-orchestrator/contract";

import { allEntries, type JournalEntry, OPEN_STATES } from "../../backlog/lane/journal";
import { type FlushReport, LaneFlushError, type OfficeLane } from "../../backlog/lane/lane";
import { listAll } from "../../backlog/list";
import { BacklogParseError } from "../../backlog/plain";
import { openPrs } from "../../backlog/pr/records";
import { type BacklogCli, BacklogCommandError, BacklogRefusedError } from "../../backlog/runner";
import { appendEntries, type NewEntry } from "../../changelog/log";
import { CommandError } from "../../commands/errors";
import type { OfficeDirectory } from "../../commands/offices";
import type { CommandOutcome, FeatureModule } from "../../commands/registry";
import type { OfficeHandle } from "../../db/office";
import type { GitSession, OfficeGit } from "../../git/office";
import { GitError } from "../../git/runner";

import {
  configGet,
  DIPO_GITIGNORE,
  INIT_KIND,
  type InitTarget,
  OFFICE_SETTINGS,
  STEP_SUBJECTS,
} from "./ops";
import { recordPrevious, settingValue, type SettingValue } from "./previous";
import {
  CONFIG_FILE,
  DEFAULT_STATUS,
  LEGACY_STATUS,
  LIFECYCLE_STATUSES,
  readStatuses,
  statusesRefusal,
  targetStatuses,
} from "./statuses";

/** The load step that raises the missing-statuses notice. */
export const STATUSES_STEP = "office.statuses";

/** `engine.notice` codes of office init. */
export const INIT_NOTICES = {
  statusesMissing: "office.statusesMissing",
  leftAlone: "office.init.leftAlone",
} as const;

/** What office init read on the base before it journals anything. */
export interface BaseState {
  /** The `statuses` of `backlog/config.yml`, or the reason they could not be read. */
  readonly statuses:
    | { readonly ok: true; readonly list: readonly string[] }
    | {
        readonly ok: false;
        readonly reason: string;
      };
  /** `config get` output of `defaultStatus` and each office setting. */
  readonly settings: Readonly<Record<string, string>>;
  /** Every active task with its status, as `task list --plain` groups them. */
  readonly tasks: readonly { readonly id: string; readonly status: string }[];
  /** Local branches and the remote's branches, by short name. */
  readonly branches: readonly string[];
  /** True when `.dipo/.gitignore` exists on the base. */
  readonly gitignore: boolean;
}

/** The steps init journals and the settings it records first. */
export interface InitPlan {
  readonly targets: readonly InitTarget[];
  /** The base's value of every setting a step changes. */
  readonly previous: Readonly<Record<string, SettingValue>>;
  /** `To Do` tasks left alone because a branch <ID>/... exists for each. */
  readonly leftAlone: readonly string[];
}

/**
 * True when a branch other than the base carries the story: its frozen branch `<ID>/<slug>` (0012
 * F15) exists locally or on the remote, whatever its slug became since.
 */
function hasOwnBranch(id: string, branches: readonly string[]): boolean {
  const prefix = `${id.toUpperCase()}/`;
  return branches.some((branch) => branch.toUpperCase().startsWith(prefix));
}

/** Plans init from the base. Pure. */
export function planInit(base: BaseState): InitPlan {
  const targets: InitTarget[] = [];
  const previous: Record<string, SettingValue> = {};

  const todo = base.tasks.filter((task) => task.status === LEGACY_STATUS).map((task) => task.id);
  const leftAlone = todo.filter((id) => hasOwnBranch(id, base.branches));
  const final = todo.length === 0;
  const inUse = [
    ...new Set(
      base.tasks
        .map((task) => task.status)
        .filter((status) => !LIFECYCLE_STATUSES.includes(status)),
    ),
  ];
  // An unreadable list is journaled anyway: applying it names the reason in a notice.
  if (!base.statuses.ok || targetStatuses(base.statuses.list, { final, inUse }) !== null) {
    targets.push({ step: "statuses", final, inUse });
    if (base.statuses.ok) previous["statuses"] = [...base.statuses.list];
  }
  const defaultStatus = base.settings["defaultStatus"] ?? "";
  if (defaultStatus !== DEFAULT_STATUS) {
    targets.push({ step: "defaultStatus" });
    previous["defaultStatus"] = settingValue(defaultStatus);
  }
  const differing = OFFICE_SETTINGS.filter(({ key, value }) => base.settings[key] !== value);
  if (differing.length > 0) {
    targets.push({ step: "settings" });
    for (const { key } of differing) previous[key] = settingValue(base.settings[key] ?? "");
  }
  if (todo.length > leftAlone.length) targets.push({ step: "migrate", leave: leftAlone });
  if (!base.gitignore) targets.push({ step: "gitignore" });
  return { targets, previous, leftAlone };
}

/** Local and remote-tracking branch names, without their `refs/...` prefix. */
async function branchNames(git: GitSession, remote: string): Promise<string[]> {
  const out = await git.ok(git.repository, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads/",
    `refs/remotes/${remote}/`,
  ]);
  const names: string[] = [];
  for (const ref of out.split("\n")) {
    for (const prefix of ["refs/heads/", `refs/remotes/${remote}/`]) {
      if (ref.startsWith(prefix) && ref.length > prefix.length)
        names.push(ref.slice(prefix.length));
    }
  }
  return names.filter((name) => name !== "HEAD");
}

/** Reads the base in the backlog worktree, checked out there by `OfficeLane.atBase`. */
async function readBase(
  ctx: { readonly git: GitSession; readonly cwd: string },
  cli: BacklogCli,
  remote: string,
): Promise<BaseState> {
  const file = join(ctx.cwd, CONFIG_FILE);
  const read = existsSync(file)
    ? readStatuses(readFileSync(file, "utf8"))
    : { ok: false as const, reason: `${CONFIG_FILE} does not exist` };
  const settings: Record<string, string> = {};
  for (const key of ["defaultStatus", ...OFFICE_SETTINGS.map((setting) => setting.key)]) {
    settings[key] = await configGet(cli, ctx.cwd, key);
  }
  const tasks = (await listAll(cli, ctx.cwd, "task")).entries.map((entry) => ({
    id: entry.id,
    status: entry.group,
  }));
  return {
    statuses: read.ok ? { ok: true, list: read.statuses } : { ok: false, reason: read.reason },
    settings,
    tasks,
    branches: await branchNames(ctx.git, remote),
    gitignore: existsSync(join(ctx.cwd, DIPO_GITIGNORE)),
  };
}

export interface InitResult {
  readonly office: OfficeId;
  readonly pr?: { readonly number: number; readonly url: string };
  readonly branch?: string;
  readonly waiting?: string;
  readonly leftAlone?: string[];
}

export interface OfficeInitDeps {
  readonly offices: OfficeDirectory;
  /** The office's planning lane, once the office loaded (DIPO-34). */
  readonly lane: (office: OfficeId) => OfficeLane | undefined;
  /** The office's git, once the office loaded (DIPO-31). */
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  readonly cli: BacklogCli;
  readonly clock: Clock;
  /** Why the backlog PR of a branch is not open (DIPO-35 `BacklogPrs.waiting`). */
  readonly prWaiting?: (office: OfficeId) => { readonly detail: string } | null;
  readonly onChanged?: (office: OfficeId) => void;
}

/** True when two targets are the same JSON value. */
function sameTarget(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class OfficeInit {
  readonly #deps: OfficeInitDeps;
  readonly #busy = new Map<OfficeId, Promise<unknown>>();

  constructor(deps: OfficeInitDeps) {
    this.#deps = deps;
  }

  /** `office.init { office }`: one run per office at a time. */
  init(office: OfficeId): Promise<CommandOutcome<InitResult>> {
    const before = this.#busy.get(office) ?? Promise.resolve();
    const run = before.then(
      () => this.#init(office),
      () => this.#init(office),
    );
    this.#busy.set(
      office,
      run.catch(() => undefined),
    );
    return run;
  }

  async #init(officeId: OfficeId): Promise<CommandOutcome<InitResult>> {
    const access = await this.#deps.offices.load(officeId);
    if (!access.ok) {
      throw new CommandError(access.error.code, access.error.message, access.error.details);
    }
    const office = access.office;
    const lane = this.#deps.lane(officeId);
    if (lane === undefined) throw new Error(`office ${officeId} has no planning lane`);

    let base: BaseState;
    try {
      base = await lane.atBase((ctx) => readBase(ctx, this.#deps.cli, lane.git.settings.remote));
    } catch (error) {
      if (
        error instanceof BacklogCommandError ||
        error instanceof BacklogRefusedError ||
        error instanceof BacklogParseError
      ) {
        throw new CommandError(
          "backlog.unreadable",
          `Office init could not read the backlog on the office's base branch: ${error.message}`,
          { office: officeId },
        );
      }
      throw error;
    }
    const plan = planInit(base);

    // Record the settings before any step can change them, then journal the steps that are not
    // open with the same target already.
    const open = allEntries(office).filter(
      (entry) => entry.kind === INIT_KIND && OPEN_STATES.includes(entry.state),
    );
    const fresh = plan.targets.filter(
      (target) => !open.some((entry) => sameTarget(entry.target, target)),
    );
    const now = this.#deps.clock.now();
    office.immediate(() => recordPrevious(office, plan.previous, now));
    if (plan.leftAlone.length > 0) {
      this.#notice(office, officeId, {
        level: "info",
        code: INIT_NOTICES.leftAlone,
        text: `Office init left ${plan.leftAlone.join(", ")} at ${LEGACY_STATUS}: each has its own <ID>/... branch, so it counts as in progress there and its story PR carries its status. If such a branch is left over, delete it and run dipo office init again.`,
      });
    }
    const journaled: JournalEntry[] = [];
    for (const target of fresh) {
      journaled.push(
        await lane.journal({ kind: INIT_KIND, subject: STEP_SUBJECTS[target.step], target }),
      );
    }

    let report: FlushReport | null = null;
    let failure: string | null = null;
    if (journaled.length > 0) {
      try {
        report = await lane.flush();
      } catch (error) {
        // The lane put the failure on the office as a notice; the steps stay journaled and are
        // applied at the next backlog change.
        if (!(error instanceof LaneFlushError)) throw error;
        failure = error.message;
      }
    }
    const ours = new Set(journaled.map((entry) => entry.opId));
    const changed =
      report === null
        ? failure !== null
        : report.held === true || report.committed.some((opId) => ours.has(opId));
    return { result: this.#result(officeId, office, lane, report, failure, plan), changed };
  }

  #result(
    officeId: OfficeId,
    office: OfficeHandle,
    lane: OfficeLane,
    report: FlushReport | null,
    failure: string | null,
    plan: InitPlan,
  ): InitResult {
    const leftAlone = plan.leftAlone.length > 0 ? { leftAlone: [...plan.leftAlone] } : {};
    const openInit = allEntries(office).filter(
      (entry) => entry.kind === INIT_KIND && OPEN_STATES.includes(entry.state),
    );
    const branch =
      report?.branch ?? openInit.findLast((entry) => entry.branch !== null)?.branch ?? null;
    if (failure !== null) return { office: officeId, waiting: failure, ...leftAlone };
    if (report?.held === true && branch !== null) {
      return {
        office: officeId,
        branch,
        waiting: `the backlog branch ${branch} has auto-merge on; the init steps stay journaled and go to the next backlog PR`,
        ...leftAlone,
      };
    }
    if (branch === null) {
      // Nothing waits: every step is on the base, or held without a branch.
      return { office: officeId, ...leftAlone };
    }
    const pr = openPrs(office).find((record) => record.branch === branch);
    if (pr !== undefined) {
      return { office: officeId, pr: { number: pr.number, url: pr.url }, branch, ...leftAlone };
    }
    const waiting = this.#deps.prWaiting?.(officeId)?.detail ?? lane.waiting()?.detail;
    return {
      office: officeId,
      branch,
      ...(waiting === undefined ? {} : { waiting }),
      ...leftAlone,
    };
  }

  /**
   * A refusal naming `dipo office init` while the base's `backlog/config.yml` lacks `In Review` or
   * `Parked`, or names why the statuses could not be read; null when runs may start. `work.run`
   * (DIPO-48) refuses with it.
   */
  officeStatusesReady(office: OfficeId): Promise<string | null> {
    const git = this.#deps.git(office);
    if (git === undefined) {
      return Promise.resolve(`Office ${office} has not loaded, so its statuses are unknown.`);
    }
    return officeStatusesReady(git);
  }

  #notice(
    office: OfficeHandle,
    officeId: OfficeId,
    delta: { level: "info" | "warn" | "error"; code: string; text: string },
  ): void {
    const entries: NewEntry[] = [{ type: "engine.notice", delta }];
    office.immediate(() => appendEntries(office, entries, { at: this.#deps.clock.now() }));
    this.#deps.onChanged?.(officeId);
  }

  /** The software command `office.init` and the load step that raises the statuses notice. */
  get feature(): FeatureModule {
    return {
      name: "office/init",
      register: (registry) => {
        registry.addSoftwareCommand({
          definition: officeInit,
          handle: (_ctx, args) => this.init(args.office),
        });
        registry.registerLoadStep(STATUSES_STEP, async (ctx) => {
          // A base that cannot be read yet (no remote, no `base`) raises nothing here: the lane
          // and `officeStatusesReady` name that when they are used.
          const git = this.#deps.git(ctx.officeId);
          if (git === undefined) return { ok: true };
          const read = await git.run((session) => readBaseConfig(session, git));
          if (!read.ok) return { ok: true };
          const statuses = readStatuses(read.text);
          const refusal = statuses.ok ? statusesRefusal(statuses.statuses) : null;
          if (refusal !== null) {
            this.#notice(ctx.office, ctx.officeId, {
              level: "warn",
              code: INIT_NOTICES.statusesMissing,
              text: refusal,
            });
          }
          return { ok: true };
        });
      },
    };
  }
}

/**
 * The refusal of a run while the base of the office (`git`) lacks `In Review` or `Parked`, naming
 * `dipo office init`, or why its statuses could not be read; null when runs may start. One item of
 * the office git queue.
 */
export async function officeStatusesReady(git: OfficeGit): Promise<string | null> {
  const read = await git.run((session) => readBaseConfig(session, git));
  if (!read.ok) {
    return `dipo could not read the statuses on the office's base branch (${read.reason}), so it runs no story yet; run \`dipo office init\` once the base can be read.`;
  }
  const statuses = readStatuses(read.text);
  if (!statuses.ok) {
    return `dipo could not read the statuses on the office's base branch (${statuses.reason}), so it runs no story yet; run \`dipo office init\`.`;
  }
  return statusesRefusal(statuses.statuses);
}

/**
 * `backlog/config.yml` on the base: `<remote>/<base>` with a remote, the local `<base>` without
 * one, as the lane applies to (0010 section 7).
 */
async function readBaseConfig(
  git: GitSession,
  office: OfficeGit,
): Promise<
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string }
> {
  const { remote } = office.settings;
  const url = await git.step(git.repository, ["config", "--get", `remote.${remote}.url`]);
  const hasRemote = url.code === 0 && url.stdout.trim() !== "";
  let name: string;
  try {
    name = await office.resolveBaseIn(git);
  } catch (error) {
    if (!(error instanceof GitError && error.code === "git.baseUnknown")) throw error;
    return { ok: false, reason: "the office has no base branch: set `base` in .dipo/office.yaml" };
  }
  const ref = hasRemote ? `refs/remotes/${remote}/${name}` : `refs/heads/${name}`;
  const blob = await git.step(git.repository, ["cat-file", "blob", `${ref}:${CONFIG_FILE}`]);
  if (blob.code !== 0) {
    return { ok: false, reason: `${ref} has no readable ${CONFIG_FILE}` };
  }
  return { ok: true, text: blob.stdout };
}
