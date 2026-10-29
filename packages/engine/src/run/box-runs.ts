// What the engine's box runs need besides the box workers (DIPO-271 to DIPO-324): Apple `container`
// on the PATH, whether a run's box is ended, the sweeps a stopped daemon's leftovers get at start,
// the package cache roots, the parts' `behind` check and the merge a resumed conflict park needs.

import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { OfficeId, RunId } from "@dipsaus-orchestrator/contract";

import { officePackageCacheRoot } from "../box/cache";
import type { BoxCollisions, SyncOutcome } from "../box/collisions";
import type { DoorPart } from "../box/door";
import { boxEndedOf, boxRunState } from "../box/lifetime";
import { sweepPartStages, type BoxParts, type PartRun } from "../box/parts";
import { sweepTokenCheckLeftovers } from "../box/token-check";
import type { BoxEnded, BoxPassOptions, BoxWorkers, BoxPackageCacheDeps } from "../box/workers";
import type { OfficeHandle } from "../db/office";
import type { Logger } from "../log/logger";
import type { OfficeManager } from "../office/manager";
import { systemIsExecutable } from "../platform/tools";
import { workerHostsOf } from "../runs/worker-hosts";
import { findClaim } from "../worktree/records";
import { pendingBoxCopy } from "./conflicts";
import { findRun } from "./records";

/** Apple `container` on `pathEnv`, by absolute path; undefined when it is not there. */
export function containerOnPath(
  pathEnv: string | undefined,
  isExecutable: (path: string) => boolean = systemIsExecutable,
): string | undefined {
  return (pathEnv ?? "")
    .split(":")
    .filter((dir) => dir !== "" && isAbsolute(dir))
    .map((dir) => join(dir, "container"))
    .find((path) => isExecutable(path));
}

/** True when `host` has exited, as its row records it. */
function hostExited(host: ReturnType<typeof workerHostsOf>[number]): boolean {
  return host.endedAt !== null || host.exitCode !== null || host.exitSignal !== null;
}

/**
 * What the daemon's pass does with run `runId`'s box (DIPO-278, `boxRunState`), as
 * `BoxWorkers.finishEnded` asks it: true when the run's claim ended (merge, drop, discard) and every
 * worker host exited (the box is deleted), `BOX_WAITING` when the run ended with its claim live and
 * its hosts exited (the story waits: the box stops, files kept), false while a session runs or may
 * start, null when no loaded office knows the run.
 */
export function boxRunEnded(
  offices: Pick<OfficeManager, "loadedOffices" | "get">,
  runId: string,
  read: {
    readonly run: (
      handle: OfficeHandle,
      runId: RunId,
    ) => { readonly endedAt: number | null } | null;
    readonly hosts: (handle: OfficeHandle, runId: string) => ReturnType<typeof workerHostsOf>;
    readonly claim: (
      handle: OfficeHandle,
      runId: RunId,
    ) => { readonly releasedAt: number | null } | null;
  } = { run: findRun, hosts: workerHostsOf, claim: findClaim },
): BoxEnded {
  for (const office of offices.loadedOffices()) {
    const handle = offices.get(office);
    if (handle === undefined) continue;
    const run = read.run(handle, runId as RunId);
    if (run === null) continue;
    const claim = read.claim(handle, runId as RunId);
    return boxEndedOf(
      boxRunState({
        endedAt: run.endedAt,
        claimLive: claim === null ? null : claim.releasedAt === null,
        hostsExited: read.hosts(handle, runId).every(hostExited),
      }),
    );
  }
  return null;
}

/**
 * Checks and deletes the boxes of the runs that ended (`BoxWorkers.finishEnded`) and logs the
 * runs a pass finished. Each exit decision and the end of its ingestion both call it; the passes
 * run one after another, so each deleted run is logged once (DIPO-307). Never rejects.
 */
export async function finishEndedBoxRuns(
  workers: Pick<BoxWorkers, "finishEnded">,
  ended: (runId: string) => BoxEnded,
  logger: Pick<Logger, "info">,
  options: BoxPassOptions = {},
): Promise<string[]> {
  const finished = await workers.finishEnded(ended, options);
  if (finished.length > 0) logger.info("ended box runs checked and deleted", { finished });
  return finished;
}

/**
 * Removes the export folders a post-run token check left in `tmpRoot` (a crash, a failed
 * removal): they may hold a leaked token (DIPO-269). Runs at daemon start; never rejects.
 */
export async function sweepBoxTokenChecks(
  tmpRoot: string,
  logger: Pick<Logger, "info">,
): Promise<number> {
  const removed = await sweepTokenCheckLeftovers(tmpRoot);
  if (removed > 0) logger.info("removed token check exports a stopped daemon left", { removed });
  return removed;
}

/**
 * Removes the part stage folders this daemon left in its own folder of stages `stageRoot`
 * (`partStageRoot`, DIPO-290) when it stopped: a crash during a part leaves the box's files there.
 * Runs at daemon start, leaving the stages `parts` uses; another daemon's folder is never touched.
 * Never rejects.
 */
export async function sweepBoxPartStages(
  stageRoot: string,
  parts: Pick<BoxParts, "sweepStages"> | null,
  logger: Pick<Logger, "info">,
): Promise<number> {
  const removed = await (parts === null ? sweepPartStages(stageRoot) : parts.sweepStages());
  if (removed > 0) logger.info("removed part stage folders a stopped daemon left", { removed });
  return removed;
}

/**
 * The door's `onPart` of the daemon's box workers: the part is delivered (DIPO-273), then a
 * collision check runs, since the part may change the files the story changes (DIPO-277). A part
 * that was not delivered rejects, stays queued in the box and starts no check.
 */
export function deliverThenCheck(
  deliver: (part: DoorPart) => Promise<void>,
  check: () => void,
): (part: DoorPart) => Promise<void> {
  return async (part) => {
    await deliver(part);
    check();
  };
}

/**
 * The package cache of the daemon's box runs (DIPO-295): each office's root in dipo's state
 * folder, `<state>/PACKAGE_CACHE_DIR/<office>`; the lockfile is read from the base branch.
 */
export function boxPackageCache(stateDir: string): BoxPackageCacheDeps {
  return { root: (office) => officePackageCacheRoot(stateDir, office) };
}

/**
 * The real path of `dir` (on macOS `/tmp` is a link to `/private/tmp`), so the sandbox paths of a
 * run name the directory itself; `dir` as given when it cannot be resolved.
 */
export function realDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** Why a part is refused while the box lacks a merge dipo made outside it (DIPO-324). */
export const BOX_BEHIND_TEXT =
  "dipo merged the base into the story branch outside the box, and the box has not received that merge, so a part now would undo it; resume the story to copy the merge into the box first";

/**
 * The parts' `behind` check (DIPO-324): why the run's box lacks a merge dipo committed on its
 * branch outside the box, or null when it holds them all. Fails closed: a run whose office is not
 * loaded here is behind, since dipo cannot tell.
 */
export function boxBehind(offices: {
  get(office: OfficeId): OfficeHandle | undefined;
}): (run: PartRun) => string | null {
  return (run) => {
    const handle = offices.get(run.office);
    if (handle === undefined) {
      return `dipo cannot read the office of ${run.story} here, so it cannot tell whether the box holds every merge dipo made on the branch; no part is taken until it can`;
    }
    return pendingBoxCopy(handle, run.runId) === null ? null : BOX_BEHIND_TEXT;
  };
}

/**
 * The merge a resumed conflict park needs in its live run's box (DIPO-324,
 * `BoxCollisions.mergeOnResume`). The worker was told dipo merges, so a merge dipo cannot make
 * here is never silent: it is a park of the live run with what went wrong, and a warning.
 */
export function conflictMergeOf(deps: {
  readonly run: (runId: string) => PartRun | null;
  readonly collisions: () => BoxCollisions | null;
  readonly warn: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}): (office: OfficeId, runId: RunId) => Promise<SyncOutcome> {
  return async (office, runId) => {
    const run = deps.run(runId);
    const collisions = deps.collisions();
    if (run !== null && collisions !== null && run.office === office) {
      return collisions.mergeOnResume(run);
    }
    const why =
      run === null || run.office !== office
        ? `dipo does not know the box of run ${runId} here`
        : "this daemon has no box collisions to merge with";
    deps.warn("the merge a conflict resume promised cannot run", { office, run: runId, why });
    return {
      kind: "park",
      park: {
        reason: "conflict",
        detail: `dipo resumed the story to merge the base into its branch and box once the session ran, but ${why}, so nothing was merged; resume it again`,
      },
    };
  };
}
