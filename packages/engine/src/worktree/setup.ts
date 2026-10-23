// Setting up a claimed worktree (0010 sections 8 and 9, its 0008 amendment). `claimStory` (DIPO-38)
// calls it through `ClaimRequest.setup` after the worktree, its lock and the live claim record,
// and before the claim commit and the push (0010 section 7). In order:
//
// 1. takes the lowest free machine-wide port slot (`slots.ts`) and builds the run environment
//    (`run-env.ts`);
// 2. places the configured gitignored files and the filtered `.claude/settings.local.json`
//    (`files.ts`), and the first time an office gets env files, shows the development-secrets
//    notice once with the list of files.
//
// The worktree is dipo's own copy of the story branch: no worker reads or writes it, since every
// developer works in its story's box (DIPO-240, 0021). So setup runs no install, no `setup` script,
// no `worktree.post_create` and no base verify on the Mac any more: the office's packages are
// installed in the box (`box/lifetime.ts`, DIPO-294), and CI is the verify (0021 amendment of
// 2026-10-22). The run environment and the slot go to the box's install.
//
// A failure frees the slot and returns `{ ok: false, reason, log }`; `claimStory` then rolls the
// claim back (worktree removed, a new branch deleted only while it still points at its start,
// nothing committed or pushed, the story still Ready) and returns a `pickupCheckFailed` skip with
// the log. A success returns the slot and the run environment with `release`, which frees the
// slot when the claim fails after setup. The log names paths, never file contents.
//
// Each git step setup needs (`check-ignore`) is a queue item of its own.

import type { OfficeConfig } from "../config";
import type { GitLocation } from "../git/hardened";
import type { GitSession } from "../git/office";
import type { RunProfile } from "../scan/detect";
import type { LocalSettingsCopy } from "../workers/port";

import type { BaseVerifyFacts } from "../prompts/base-verify";
import {
  CLAIM_NOTICES,
  type ClaimDeps,
  type ClaimSetupDone,
  type ClaimSetupFailed,
  notice,
  writeWith,
} from "./claim";
import { type FileStepResult, placeFiles } from "./files";
import type { ClaimRecord } from "./records";
import { buildRunEnv } from "./run-env";
import { slotsTakenMessage, type SlotTable } from "./slots";

/** `engine.notice` codes of setup. */
export const SETUP_NOTICES = {
  failed: CLAIM_NOTICES.setupFailed,
  envFiles: "setup.envFiles",
  fileSkipped: "setup.fileSkipped",
  settingsNotCopied: "setup.settingsNotCopied",
} as const;

/** The development-secrets rule (0008 section 2, "Env files"; open question 8). */
export const ENV_FILES_RULE = "worktree env files hold development secrets only";

/** Paths per `git check-ignore` call. */
const CHECK_IGNORE_BATCH = 200;

export interface SetupDeps extends Pick<
  ClaimDeps,
  "officeId" | "office" | "git" | "clock" | "onChanged"
> {
  /** The machine-wide slot table in `<state>`. */
  readonly slots: SlotTable;
  /** The worker port's local settings copy for step 2 (DIPO-113). */
  readonly localSettings: LocalSettingsCopy;
}

export interface SetupRequest {
  /** The live claim `claimStory` passes to its `setup`. */
  readonly claim: ClaimRecord;
  readonly config: Pick<OfficeConfig, "worktree">;
  /** The office's stored run profile (DIPO-72): its env files and dev port; null before a scan. */
  readonly profile: RunProfile | null;
}

export interface SetupDone extends ClaimSetupDone {
  readonly ok: true;
  readonly slot: number;
  /** The run environment for every later process of the run. */
  readonly env: Readonly<Record<string, string>>;
  readonly files: FileStepResult;
  readonly log: readonly string[];
  /**
   * What the office's verify said about the base commit (DIPO-183). Setup no longer runs it on the
   * Mac (DIPO-240), so it is always absent now: not known.
   */
  readonly baseVerify?: BaseVerifyFacts;
}

export type SetupOutcome = SetupDone | ClaimSetupFailed;

/** A setup failure with its reason for the notice. */
class SetupFailure extends Error {}

/** Sets up the claimed worktree; see the file comment. Never throws for a setup failure. */
export async function setupWorktree(deps: SetupDeps, request: SetupRequest): Promise<SetupOutcome> {
  const { claim, config, profile } = request;
  const log: string[] = [];
  try {
    const slot = deps.slots.take(
      {
        office: deps.officeId,
        story: claim.story,
        worktree: claim.worktree,
        takenAt: deps.clock.now(),
      },
      config.worktree.maxSlots,
    );
    if (slot === null) {
      throw new SetupFailure(slotsTakenMessage(deps.slots.live(), config.worktree.maxSlots));
    }
    log.push(`slot: ${slot} (port offset ${slot * config.worktree.ports.stride})`);
    const env = buildRunEnv({
      slot,
      stride: config.worktree.ports.stride,
      story: claim.story,
      worktree: claim.worktree,
      named: config.worktree.ports.named,
      devPort: devPortOf(profile),
      env: config.worktree.env,
    });

    const files = await placeFiles({
      main: deps.git.mainWorktree,
      worktree: claim.worktree,
      files: config.worktree.files,
      ignored: (paths) => ignoredIn(deps, claim.worktree, paths),
      envFiles: new Set(profile?.envFiles.map((file) => file.path) ?? []),
      localSettings: deps.localSettings,
    });
    log.push(...files.log);
    fileNotices(deps, claim, files);
    log.push("setup: done");
    const release = (): void => {
      deps.slots.free(claim.worktree);
    };
    return { ok: true, slot, env, files, log, release };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (!(error instanceof SetupFailure)) log.push(`setup: ${why}`);
    try {
      deps.slots.free(claim.worktree);
    } catch (freeError) {
      log.push(`setup: the slot could not be freed: ${String(freeError)}`);
    }
    log.push(`setup: failed: ${why}`);
    return { ok: false, reason: why, log: log.join("\n") };
  }
}

/** The dev port of the root package, else the first the scan found; null when none. */
function devPortOf(profile: RunProfile | null): number | null {
  const ports = profile?.devPorts ?? [];
  return (ports.find((port) => port.dir === ".") ?? ports[0])?.port ?? null;
}

/** The paths among `paths` that git ignores in the worktree, through the office's git queue. */
async function ignoredIn(
  deps: SetupDeps,
  worktree: string,
  paths: readonly string[],
): Promise<ReadonlySet<string>> {
  return deps.git.run(async (git) => {
    const location = deps.git.worktreeLocation(worktree);
    const ignored = new Set<string>();
    for (let start = 0; start < paths.length; start += CHECK_IGNORE_BATCH) {
      const batch = paths.slice(start, start + CHECK_IGNORE_BATCH);
      for (const path of await checkIgnore(git, location, batch)) ignored.add(path);
    }
    return ignored;
  });
}

/**
 * `git check-ignore -- <paths>`: the same rule as `check-ignore -q` per path, batched. Exit 0
 * prints the ignored paths one per line, exit 1 means none is ignored; tracked paths are never
 * printed. `files.ts` refuses names git would quote, so each line is a path as given.
 */
async function checkIgnore(
  git: GitSession,
  location: GitLocation,
  paths: readonly string[],
): Promise<string[]> {
  const result = await git.step(location, ["check-ignore", "--", ...paths]);
  if (result.code === 1) return [];
  if (result.code !== 0) {
    throw new SetupFailure(
      `git check-ignore failed: ${result.stderr.trim() || `exit ${result.code}`}`,
    );
  }
  return result.stdout.split("\n").filter((path) => path !== "");
}

/** The notices of step 1: env files once per office, skipped optional files, settings left out. */
function fileNotices(deps: SetupDeps, claim: ClaimRecord, files: FileStepResult): void {
  writeWith(deps, () => {
    const entries = [];
    for (const path of files.skipped) {
      entries.push(
        notice(
          "info",
          SETUP_NOTICES.fileSkipped,
          `${claim.story}: ${path} from worktree.files is not in the main checkout and is optional, so setup skipped it.`,
          claim.key,
        ),
      );
    }
    if (files.settings !== null && !files.settings.copied) {
      entries.push(
        notice(
          "warn",
          SETUP_NOTICES.settingsNotCopied,
          `${claim.story}: .claude/settings.local.json was not copied into the worktree: ${files.settings.why}.`,
          claim.key,
        ),
      );
    }
    if (files.envFiles.length > 0) {
      const first = deps.office.run(
        `insert into once_notices (office_id, code, shown_at)
         values ($office_id, $code, $at) on conflict do nothing`,
        { code: SETUP_NOTICES.envFiles, at: deps.clock.now() },
      );
      if (first.changes > 0) {
        entries.push(
          notice(
            "warn",
            SETUP_NOTICES.envFiles,
            `Setup copied env files into the worktree of ${claim.story}: ${files.envFiles.join(", ")}. Rule: ${ENV_FILES_RULE}. A worker's scripts can read them, so keep production secrets out of them. dipo shows this once per office.`,
            claim.key,
          ),
        );
      }
    }
    return entries;
  });
}
