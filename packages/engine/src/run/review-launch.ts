// Starting a reviewer session of a story run (0019 sections 4 and 13, DIPO-219), and the git reads
// a review needs. The reviewer is a new agent of the run with role `reviewer`, always a fresh
// session (0008 section 8): the `review` system file (L1+L2; `review-box` for a box run, whose
// verify is CI, DIPO-299) in its own file of the run directory, the review task message as its
// first message, the reviewer's tools, model, effort and its own
// turn and minute caps (`runWorkerSpec` with the review settings), and what remains of the story's
// budget. The launch checks run first (`WorkerPort.prepare`); a refused check is `startFailed`
// with the adapter hold set. The backstop snapshot is taken before the session starts, so a
// worktree the review changed parks `scope-violation` with cause `backstop` (0008 backstop).
// Ingestion starts after what earlier hosts wrote to the run's event file, and run control tracks
// the session with the reviewer's caps.
//
// The reviewer has no box and reads a read-only copy of the pushed commit (0021 sections 10 and
// 14, DIPO-276). For each session dipo makes a folder of its own in its temp root,
// `dipo-review-<run>-<agent>`, private to the daemon's user, outside every worktree:
//
// - `session/`, empty: the reviewer's working directory. Claude Code reads project settings, hooks
//   and CLAUDE.md from its working directory and that folder's parents, so the copy is neither.
// - The copy: exactly the head the review round read (`ReviewSessionRequest.head`), refused when
//   the story branch has moved since, from git's objects alone (`stageBoxCode`: `git archive` on
//   the repository without a work tree, the hardened config with every filter driver off, no
//   `.gitattributes` of the archived tree or the index applied, so `export-ignore` and
//   `export-subst` hide or rewrite nothing, and the system `tar`). It has no `.git`, its symbolic
//   links are left out, and every file and folder is made read-only. It is then compared with
//   `git ls-tree` of the commit: a file of the commit that is missing, or a file the commit does
//   not hold, refuses it.
//   The run settings add it as a directory the read tools may read and exclude its CLAUDE.md files
//   by path; `--disable-slash-commands`, `enabledPlugins` false for every installed plugin and the
//   `system/init` plugin refusal keep the skills and plugin keys it may hold inert (`plan`).
// - `commit`: the head the copy holds, read back for the verdict (`reviewedCommit`).
//
// The folder goes when the session's start fails, when its exit or lost host is decided
// (`finish`), and at daemon start for every folder whose reviewer host no longer runs
// (`sweepReviewFolders`).
//
// The reviewer fetches from the Mac, so each session gets a web proxy listener of its own
// (DIPO-292, `startReviewWebProxy`): the box web proxy's address rule, on the loopback interface
// only, on a port the system picks, refusing the box network by the host address the web guard
// reads (`boxHostAddress`). The session's HTTPS_PROXY and HTTP_PROXY name it and its
// NO_PROXY names only the model API (`plan`), so every web fetch, and each redirect it follows,
// is checked at connect time on the address actually used. The web guard's check of the URL before
// the fetch stays as the first layer. The listener starts before the launch checks and stops with
// the folder: when the start fails and when the session's exit or lost host is decided (a crash
// or a stop included). A listener that cannot start fails the review start: no reviewer runs
// without it. It lives in the daemon, so a daemon that stops takes it along; a reviewer host that
// outlives the daemon then reaches no web at all.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, realpath, rm, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  AgentId,
  type Clock,
  type IdSource,
  type OfficeId,
  RoleId,
  StoryId,
  StoryKey,
  RunId,
  type WorkRef,
} from "@dipsaus-orchestrator/contract";

import { type BoxCodeDeps, stageBoxCode } from "../box/code";
import { startReviewWebProxy } from "../box/web-proxy";
import { BOX_RUN_FILE } from "../box/workers";
import { appendEntries } from "../changelog/log";
import type { OfficeConfig } from "../config";
import { sizeClassOfWorkspace } from "../context/size";
import type { SizeClass } from "../context/types";
import { gitWorkspace } from "../context/workspace";
import type { OfficeHandle } from "../db/office";
import type { GitLocation } from "../git/hardened";
import type { OfficeGit } from "../git/office";
import { type FetchAddressDeps, SYSTEM_FETCH_ADDRESSES } from "../hooks/web-guard";
import { EVENTS_FILE } from "../host/protocol";
import type { IngestAdapter } from "../ingest/ingestor";
import { ensurePrivateDir } from "../platform/paths";
import { systemSpawn } from "../platform/process";
import { promptParts, recordPromptParts, recordPromptTexts } from "../prompts/parts";
import { type ReviewChangedPath, withReviewCommit } from "../prompts/review";
import { renderSystemFile } from "../prompts/system";
import { withWorkViews } from "../views/work";
import type { AdapterHold } from "../workers/hold";
import type { WorkerPort } from "../workers/port";
import { PlanError, type Caps } from "../workers/types";

import type { BackstopSnapshot } from "./backstop";
import { REVIEWER_ROLE, runCaps, runTotals } from "./caps";
import { runConfigOf } from "./config-snapshot";
import type { TrackedRun } from "./control-types";
import {
  type HostStarter,
  type ReviewerSettings,
  type RunIngest,
  runLaunchPaths,
  runWorkerSpec,
  systemHashOf,
  type TierCaps,
} from "./launch";
import { sessionUuid } from "./prompts";
import { findRun, type StoredRun } from "./records";
import { codeTreeKeyOf } from "./story-git";
import { prepareRunTempDirs } from "./temp-dirs";

/** The git reads of a review, in the story worktree. */
export interface ReviewGit {
  /** The commit the worktree's HEAD names. */
  head(office: OfficeId, worktree: string): Promise<string>;
  /**
   * sha256 of `git ls-tree -r <commit>` without the story's own task file (0010 section 7);
   * `commit` is the worktree's HEAD unless given.
   */
  codeTreeKey(
    office: OfficeId,
    worktree: string,
    taskFile: string,
    commit?: string,
  ): Promise<string>;
  /** `git diff <base>...<commit>` (HEAD unless given), unified, and its changed paths with counts. */
  diff(
    office: OfficeId,
    worktree: string,
    base: string,
    commit?: string,
  ): Promise<{ readonly diff: string; readonly changes: readonly ReviewChangedPath[] }>;
  /** The project's size class at the worktree, for the diff budget (0014 section 4). */
  sizeClass(office: OfficeId, worktree: string): Promise<SizeClass>;
}

/** Pure: `git diff --numstat -z --no-renames` output as changed paths; `-` counts are binary. */
export function parseNumstat(output: string): ReviewChangedPath[] {
  return output.split("\0").flatMap((record): ReviewChangedPath[] => {
    const match = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(record.replace(/^\n+/, ""));
    if (match === null) return [];
    const [, added, removed, path] = match;
    return [
      {
        path: path ?? "",
        added: added === "-" ? null : Number(added),
        removed: removed === "-" ? null : Number(removed),
      },
    ];
  });
}

/** A commit id, or HEAD by default; anything else is refused before it reaches git. */
function revision(commit: string | undefined): string {
  if (commit === undefined) return "HEAD";
  if (!COMMIT_ID.test(commit)) throw new Error(`${JSON.stringify(commit)} is not a commit id`);
  return commit;
}

function worktreeAt(git: OfficeGit, worktree: string): Extract<GitLocation, { kind: "worktree" }> {
  return git.worktreeLocation(worktree) as Extract<GitLocation, { kind: "worktree" }>;
}

/**
 * The `git diff` arguments of the story diff the reviewer gets. The prefixes are fixed, so a user's
 * or a repository's diff.noprefix, diff.srcPrefix or diff.dstPrefix cannot change the `+++ b/<path>`
 * lines parseStoryDiff reads (DIPO-146 review).
 */
export function storyDiffArgs(range: string): string[] {
  return [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    range,
  ];
}

/** The real `ReviewGit`: office git queue items through the hardened runner. */
export function gitReviewOps(gitOf: (office: OfficeId) => OfficeGit | undefined): ReviewGit {
  const attached = (office: OfficeId): OfficeGit => {
    const git = gitOf(office);
    if (git === undefined) throw new Error(`Office ${office} has no git attached.`);
    return git;
  };
  return {
    head: (office, worktree) => {
      const git = attached(office);
      return git.run(async (session) =>
        (await session.ok(worktreeAt(git, worktree), ["rev-parse", "--verify", "HEAD"])).trim(),
      );
    },
    codeTreeKey: (office, worktree, taskFile, commit) => {
      const git = attached(office);
      const rev = revision(commit);
      return git.run(async (session) =>
        codeTreeKeyOf(
          await session.ok(worktreeAt(git, worktree), ["ls-tree", "-r", "-z", rev]),
          taskFile,
        ),
      );
    },
    diff: (office, worktree, base, commit) => {
      const git = attached(office);
      const rev = revision(commit);
      return git.run(async (session) => {
        const location = worktreeAt(git, worktree);
        const range = `${base}...${rev}`;
        const diff = await session.ok(location, storyDiffArgs(range));
        const numstat = await session.ok(location, [
          "diff",
          "--numstat",
          "-z",
          "--no-renames",
          range,
        ]);
        return { diff, changes: parseNumstat(numstat) };
      });
    },
    sizeClass: (office, worktree) => {
      const git = attached(office);
      return sizeClassOfWorkspace(gitWorkspace({ git, location: worktreeAt(git, worktree) }));
    },
  };
}

/** The name prefix of a reviewer session's folder in dipo's temp root (DIPO-276). */
export const REVIEW_FOLDER_PREFIX = "dipo-review-";
/** The reviewer's working directory in its folder: empty, made by dipo. */
export const REVIEW_SESSION_DIR = "session";
/** The file in a reviewer's folder that names the commit its copy holds. */
export const REVIEW_COMMIT_FILE = "commit";

const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** Git's modes of a regular file; links (120000) and submodules (160000) have no file in the copy. */
const FILE_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);

const REVIEW_FOLDER = /^dipo-review-(run_[0-9A-Za-z]+)-(agt_[0-9A-Za-z]+)$/;

/** The folder of one reviewer session: its empty working directory and the copy. */
export function reviewFolder(tmpRoot: string, runId: string, agent: string): string {
  return join(tmpRoot, `${REVIEW_FOLDER_PREFIX}${runId}-${agent}`);
}

/** A reviewer session's read-only copy of the pushed commit and its empty working directory. */
export interface ReviewCopy {
  /** The session's folder in dipo's temp root; removing it removes everything below. */
  readonly root: string;
  /** The reviewer's working directory: empty, outside the copy. */
  readonly session: string;
  /** The read-only copy of `commit`. */
  readonly copy: string;
  readonly commit: string;
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "error";
}

/**
 * Makes everything below `dir` read-only: files 0444 (0555 when executable), folders 0555. A
 * symbolic link is removed: the read tools would follow it out of the copy; the diff shows it. So
 * is anything that is neither a file nor a folder.
 */
async function lockReadOnly(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const stat = await lstat(path);
    if (stat.isDirectory()) {
      await lockReadOnly(path);
    } else if (stat.isFile()) {
      await chmod(path, (stat.mode & 0o111) === 0 ? 0o444 : 0o555);
    } else {
      await unlink(path);
    }
  }
  await chmod(dir, 0o555);
}

/** The paths of every regular file below `dir`, relative to it. */
async function filesBelow(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await filesBelow(join(dir, entry.name), rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Compares the copy with the commit's own file list (`git ls-tree -r -z`, links and submodules
 * left out): throws when a file of the commit is missing from it or it holds a file the commit
 * does not, for example one an `export-ignore` attribute left out.
 */
export async function checkCopyComplete(
  git: OfficeGit,
  commit: string,
  dir: string,
): Promise<void> {
  const listed = await git.run((session) =>
    session.ok(session.repository, ["ls-tree", "-r", "-z", "--full-tree", commit]),
  );
  const expected = new Set(
    listed.split("\0").flatMap((record) => {
      const tab = record.indexOf("\t");
      if (tab === -1) return [];
      const mode = record.slice(0, record.indexOf(" "));
      return FILE_MODES.has(mode) ? [record.slice(tab + 1)] : [];
    }),
  );
  const present = new Set(await filesBelow(dir));
  const missing = [...expected].filter((path) => !present.has(path));
  const extra = [...present].filter((path) => !expected.has(path));
  if (missing.length > 0 || extra.length > 0) {
    throw new ReviewCopyMismatchError(
      `the copy of ${commit} does not match the commit: ${missing.length} of its files missing, ${extra.length} files it does not hold`,
    );
  }
}

/** The copy does not hold exactly the commit's files: the review of that head cannot start. */
export class ReviewCopyMismatchError extends Error {}

/** Gives every folder below `dir` its owner's write bit back, so the tree can be removed. */
async function unlock(dir: string): Promise<void> {
  await chmod(dir, 0o700);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) await unlock(join(dir, entry.name));
  }
}

/** Removes a reviewer session's folder, read-only copy included; nothing when it is not there. */
export async function removeReviewFolder(root: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(root);
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return;
    throw error;
  }
  // Never through a link: only the folder dipo made.
  if (stat.isDirectory()) await unlock(root);
  await rm(root, { recursive: true, force: true });
}

/**
 * Makes the folder of one reviewer session: its empty working directory and a read-only copy of
 * `commit` from git's objects (`stageBoxCode` with the tree's attributes off, no file of any
 * worktree read), checked against the commit's file list. A failure leaves no folder behind.
 */
export async function makeReviewCopy(
  deps: BoxCodeDeps,
  request: {
    readonly git: OfficeGit;
    readonly commit: string;
    readonly tmpRoot: string;
    readonly runId: string;
    readonly agent: string;
  },
): Promise<ReviewCopy> {
  if (!COMMIT_ID.test(request.commit)) {
    throw new Error(`${JSON.stringify(request.commit)} is not a commit id`);
  }
  const root = reviewFolder(await realpath(request.tmpRoot), request.runId, request.agent);
  await removeReviewFolder(root);
  await mkdir(root, { mode: 0o700 });
  try {
    const session = join(root, REVIEW_SESSION_DIR);
    await mkdir(session, { mode: 0o700 });
    const staged = await stageBoxCode(deps, {
      git: request.git,
      commit: request.commit,
      files: [],
      source: root,
      tmpRoot: root,
      ignoreTreeAttributes: true,
    });
    await lockReadOnly(staged.dir);
    await checkCopyComplete(request.git, request.commit, staged.dir);
    writeFileSync(join(root, REVIEW_COMMIT_FILE), `${request.commit}\n`, { mode: 0o400 });
    return { root, session, copy: staged.dir, commit: request.commit };
  } catch (error) {
    await removeReviewFolder(root).catch(() => undefined);
    throw error;
  }
}

/**
 * Removes every reviewer session folder in `tmpRoot` whose session `live` does not name (a
 * crash, a daemon stopped mid-review), at daemon start. Only real folders of this user with a
 * reviewer folder's name are touched; nothing through a symlink. Never rejects; resolves to the
 * names removed.
 */
export async function sweepReviewFolders(
  tmpRoot: string,
  live: (runId: string, agent: string) => boolean,
  uid: number | undefined = process.getuid?.(),
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(tmpRoot);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of entries.toSorted()) {
    const match = REVIEW_FOLDER.exec(name);
    if (match === null) continue;
    const path = join(tmpRoot, name);
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) continue;
      if (live(match[1] ?? "", match[2] ?? "")) continue;
      await removeReviewFolder(path);
      removed.push(name);
    } catch {
      // Left for the next sweep.
    }
  }
  return removed;
}

/** What one reviewer session starts with. */
export interface ReviewSessionRequest {
  readonly office: OfficeId;
  readonly run: StoredRun;
  /**
   * The review task message (L4), the session's first message; the launcher adds its `commit`
   * section, which names the read-only copy (DIPO-276).
   */
  readonly taskMessage: string;
  /**
   * The story branch's head the round read once at its start (DIPO-276): the copy holds exactly
   * this commit, and the session is refused when the branch has moved since.
   */
  readonly head: string;
}

export type ReviewSessionOutcome =
  | { readonly kind: "started"; readonly agent: AgentId }
  /** A launch check refused the session; the adapter hold is set. */
  | { readonly kind: "startFailed"; readonly hold: AdapterHold }
  | {
      readonly kind: "failed";
      readonly reason: string;
      /**
       * The copy of the head does not match its tree (`ReviewCopyMismatchError`): no session of
       * this head can start, so the maintainer is told (DIPO-276).
       */
      readonly copyMismatch?: true;
      /**
       * The launch plan refused the session (`PlanError`), for example a path with a character that
       * has a meaning in Claude Code permission rules: the maintainer is told (DIPO-247).
       */
      readonly planRefused?: PlanError;
    };

/** Starts a reviewer session (the real one is `ReviewLauncher`). */
export interface ReviewSessions {
  start(request: ReviewSessionRequest): Promise<ReviewSessionOutcome>;
  /**
   * Removes what the session of `agent` read and stops its web proxy (DIPO-292), once its exit or
   * lost host is decided.
   */
  finish?(office: OfficeId, runId: string, agent: string): Promise<void>;
  /** The head the session of `agent` was given and reviews, while its copy exists; else null. */
  reviewedCommit?(office: OfficeId, runId: string, agent: string): Promise<string | null>;
}

export interface ReviewLauncherDeps {
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  readonly worker: WorkerPort;
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  readonly runtimeDir: string;
  /** dipo's temp root: the run temp directories and each reviewer session's folder. */
  readonly tmpRoot: string;
  readonly tempOwner?: () => string | undefined;
  /** Runs the system `tar` that unpacks the copy; the system spawn by default. */
  readonly code?: Pick<BoxCodeDeps, "spawn" | "tar">;
  readonly hosts: HostStarter;
  readonly ingest: RunIngest;
  /** Run control: the session is tracked before its ingestion starts. */
  readonly control: { track(office: OfficeId, run: TrackedRun): void };
  /**
   * Starts the web proxy listener of one reviewer session (DIPO-292); `startReviewWebProxy` on the
   * loopback interface by default. The launcher stops it when the session ends.
   */
  readonly webProxy?: () => Promise<ReviewWebProxy>;
  /**
   * The box network's host address for the default listener's address rule, when a box network
   * exists: the source the web guard reads (`FetchAddressDeps.boxHostAddress`), its system one by
   * default.
   */
  readonly boxHostAddress?: FetchAddressDeps["boxHostAddress"];
  /** The backstop snapshot of the worktree before the review; without it no backstop runs. */
  readonly snapshot?: (office: OfficeId, worktree: string) => Promise<BackstopSnapshot>;
  readonly onChanged?: (office: OfficeId) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Inside the caller's transaction: the run's snapshot of the reviewer's turn and minute caps, from
 * the office's `review` block in force, for a run that has none (one started before they were
 * kept). A cap the snapshot holds is never changed, so a later config change reaches new runs only
 * (0020 section 5, DIPO-247).
 */
export function snapshotReviewCaps(
  office: OfficeHandle,
  runId: RunId | string,
  config: Pick<OfficeConfig, "review">,
): void {
  office.run(
    `update runs set review_max_turns = coalesce(review_max_turns, $turns),
       review_max_minutes = coalesce(review_max_minutes, $minutes)
      where office_id = $office_id and run_id = $run`,
    { run: runId, turns: config.review.maxTurns, minutes: config.review.maxMinutes },
  );
}

/**
 * The reviewer's settings for the run (0019 sections 4 and 16): model and effort from the office's
 * `review` block, its turn and minute caps only from the run's start snapshot with their grants. A
 * run whose snapshot has none gets the office's current caps written into it first
 * (`snapshotReviewCaps`), and keeps them.
 */
export function reviewerSettings(
  office: OfficeHandle,
  run: StoredRun,
  config: OfficeConfig,
): ReviewerSettings {
  let current = run;
  if (run.reviewMaxTurns == null || run.reviewMaxMinutes == null) {
    office.immediate(() => snapshotReviewCaps(office, run.runId, config));
    current = findRun(office, run.runId) ?? run;
  }
  const caps = runCaps(office, current);
  // Model and effort as the run started with them (its configuration snapshot, DIPO-303 review).
  const started = runConfigOf(office, current, config);
  return {
    model: started.review.model,
    effort: started.review.effort,
    // Null only for a run with no row: the snapshot was written above.
    maxTurns: caps.reviewMaxTurns ?? config.review.maxTurns,
    maxMinutes: caps.reviewMaxMinutes ?? config.review.maxMinutes,
  };
}

/** A reviewer session's web proxy listener (DIPO-292): its URL, and how to stop it. */
export interface ReviewWebProxy {
  readonly url: string;
  stop(): Promise<void>;
}

/** The real `ReviewSessions`. */
export class ReviewLauncher implements ReviewSessions {
  readonly #deps: ReviewLauncherDeps;
  /** The web proxy of each session that started and has not finished, by run and agent. */
  readonly #proxies = new Map<string, ReviewWebProxy>();

  constructor(deps: ReviewLauncherDeps) {
    this.#deps = deps;
  }

  /** Stops the web proxy of the session of `agent`; nothing when it has none. Never rejects. */
  async #stopProxy(runId: string, agent: string): Promise<void> {
    const key = `${runId}/${agent}`;
    const proxy = this.#proxies.get(key);
    if (proxy === undefined) return;
    this.#proxies.delete(key);
    await proxy.stop().catch((error: unknown) => {
      this.#deps.warn?.("a reviewer's web proxy could not be stopped", {
        run: runId,
        agent,
        reason: messageOf(error),
      });
    });
  }

  async start(request: ReviewSessionRequest): Promise<ReviewSessionOutcome> {
    const deps = this.#deps;
    const { run } = request;
    const git = deps.git(request.office);
    if (git === undefined) {
      return { kind: "failed", reason: `office ${request.office} is not loaded` };
    }
    if (run.branch === null) {
      return { kind: "failed", reason: `${run.runId} is not a story run with a branch` };
    }
    const branch = run.branch;
    const agent = AgentId.parse(deps.ids.next("agt"));
    // A fresh read-only copy of exactly the round's head for this session (DIPO-276).
    let copy: ReviewCopy;
    try {
      const tip = (
        await git.run((session) =>
          session.ok(session.repository, [
            "rev-parse",
            "--verify",
            "--end-of-options",
            `refs/heads/${branch}^{commit}`,
          ]),
        )
      ).trim();
      if (tip !== request.head) {
        return {
          kind: "failed",
          reason: `the story branch moved from ${request.head} to ${tip} since the review round read it`,
        };
      }
      const commit = request.head;
      copy = await makeReviewCopy(
        {
          spawn: deps.code?.spawn ?? systemSpawn,
          clock: deps.clock,
          ...(deps.code?.tar === undefined ? {} : { tar: deps.code.tar }),
        },
        { git, commit, tmpRoot: deps.tmpRoot, runId: run.runId, agent },
      );
    } catch (error) {
      return {
        kind: "failed",
        reason: `the read-only copy of the pushed commit could not be made: ${messageOf(error)}`,
        ...(error instanceof ReviewCopyMismatchError ? { copyMismatch: true as const } : {}),
      };
    }
    // The session's own web proxy (DIPO-292): no reviewer runs without it.
    let proxy: ReviewWebProxy;
    try {
      const boxHostAddress = deps.boxHostAddress ?? SYSTEM_FETCH_ADDRESSES.boxHostAddress;
      proxy = await (
        deps.webProxy ?? (() => startReviewWebProxy({ clock: deps.clock }, { boxHostAddress }))
      )();
    } catch (error) {
      await removeReviewFolder(copy.root).catch(() => undefined);
      return {
        kind: "failed",
        reason: `the reviewer's web proxy did not start, and a reviewer never fetches without it: ${messageOf(error)}`,
      };
    }
    this.#proxies.set(`${run.runId}/${agent}`, proxy);
    let outcome: ReviewSessionOutcome;
    try {
      outcome = await this.#launch(request, agent, copy, proxy.url);
    } catch (error) {
      await this.#stopProxy(run.runId, agent);
      await removeReviewFolder(copy.root).catch(() => undefined);
      throw error;
    }
    if (outcome.kind !== "started") {
      await this.#stopProxy(run.runId, agent);
      await removeReviewFolder(copy.root).catch(() => undefined);
    }
    return outcome;
  }

  /**
   * Stops the web proxy of the session of `agent` and removes its folder: its copy and its working
   * directory.
   */
  async finish(_office: OfficeId, runId: string, agent: string): Promise<void> {
    await this.#stopProxy(runId, agent);
    await removeReviewFolder(reviewFolder(await realpath(this.#deps.tmpRoot), runId, agent));
  }

  /** The commit the copy of the session of `agent` holds, from its folder; null without one. */
  async reviewedCommit(_office: OfficeId, runId: string, agent: string): Promise<string | null> {
    const root = reviewFolder(await realpath(this.#deps.tmpRoot), runId, agent);
    try {
      const commit = readFileSync(join(root, REVIEW_COMMIT_FILE), "utf8").trim();
      return COMMIT_ID.test(commit) ? commit : null;
    } catch {
      return null;
    }
  }

  async #launch(
    request: ReviewSessionRequest,
    agent: AgentId,
    copy: ReviewCopy,
    webProxy: string,
  ): Promise<ReviewSessionOutcome> {
    const deps = this.#deps;
    const { run } = request;
    const office = deps.offices.get(request.office);
    const inForce = deps.offices.config(request.office);
    const git = deps.git(request.office);
    if (office === undefined || inForce === undefined || git === undefined) {
      return { kind: "failed", reason: `office ${request.office} is not loaded` };
    }
    // The configuration the run started with (its snapshot, DIPO-150): a base change that
    // reloaded the configuration in force never reaches a running run's reviewer, its launch plan
    // or its ingest adapter.
    const config = runConfigOf(office, run, inForce);
    if (run.worktree === null || run.key === null || run.story === null) {
      return { kind: "failed", reason: `${run.runId} is not a story run with a worktree` };
    }
    const tier =
      (config.tiers as Readonly<Record<string, TierCaps>>)[run.tier ?? ""] ?? config.tiers.M;
    const settings = reviewerSettings(office, run, config);
    // The reviewer's working directory is the empty folder, never the worktree or the copy.
    const paths = runLaunchPaths(git, deps, copy.session, run.runId);
    // The reviewer of a box run reads that dipo ran no verify of its own: CI is its verify
    // (DIPO-299). The run directory says the run is a box worker's, as for its developer.
    const box = existsSync(join(paths.runDir, BOX_RUN_FILE));
    const systemFile = renderSystemFile(box ? "review-box" : "review", "reviewer");
    const taskMessage = withReviewCommit(request.taskMessage, {
      commit: copy.commit,
      dir: copy.copy,
    });
    // The CLI's own budget is what remains of the story's; the reviewer's turns and minutes are
    // its own caps (0019 section 13).
    const now = deps.clock.now();
    const budget =
      runCaps(office, run).budgetTokens - runTotals(office, run.runId, now, now).budgetTokens;
    const caps: Caps = {
      budgetTokens: Math.max(1, budget),
      maxTurns: settings.maxTurns,
      maxMinutes: settings.maxMinutes,
    };
    const spec = {
      ...runWorkerSpec(
        deps.worker,
        { runId: run.runId, agent, caps: tier, reviewer: settings },
        paths,
        taskMessage,
        { id: sessionUuid(agent), resume: false },
        caps,
      ),
      readOnlyDir: copy.copy,
      webProxy,
    };
    try {
      ensurePrivateDir(paths.runDir);
      prepareRunTempDirs(paths, run.runId, deps.tempOwner?.());
      writeFileSync(spec.systemFile, systemFile, { mode: 0o600 });
    } catch (error) {
      return {
        kind: "failed",
        reason: `the run directory could not be prepared: ${messageOf(error)}`,
      };
    }
    // The launch checks run before every launch (0008 section 2).
    let prepared;
    try {
      prepared = await deps.worker.prepare(
        spec,
        paths,
        config,
        sessionUuid(`${agent}:launch-check`),
      );
    } catch (error) {
      if (!(error instanceof PlanError)) return { kind: "failed", reason: messageOf(error) };
      // A path the plan refuses is the maintainer's to fix, as for the worker's launch: the review
      // rounds raise its notice (DIPO-247).
      return {
        kind: "failed",
        reason: `the launch plan refused it: ${error.message}`,
        planRefused: error,
      };
    }
    if (!prepared.ok) return { kind: "startFailed", hold: prepared.hold };

    let snapshot: BackstopSnapshot | null = null;
    if (deps.snapshot !== undefined) {
      try {
        snapshot = await deps.snapshot(request.office, run.worktree);
      } catch (error) {
        deps.warn?.("the backstop snapshot before a review could not be taken; no backstop runs", {
          run: run.runId,
          reason: messageOf(error),
        });
      }
    }
    // The new host appends to the run's event file: its ingestion starts after what is there.
    let offset = 0;
    try {
      offset = statSync(join(paths.runDir, EVENTS_FILE)).size;
    } catch {
      offset = 0;
    }
    const work: WorkRef = {
      story: StoryId.parse(run.story),
      key: StoryKey.parse(run.key),
      run: RunId.parse(run.runId),
      agent,
      role: RoleId.parse(REVIEWER_ROLE),
      tier: run.tier ?? "",
      model: settings.model,
    };
    const recordAgent = (): void => {
      const at = deps.clock.now();
      office.run(
        `insert or ignore into agents (office_id, agent_id, run_id, role, model, effort,
           session_id, system_hash, started_at)
         values ($office_id, $agent, $run, $role, $model, $effort, $session, $hash, $at)`,
        {
          agent,
          run: run.runId,
          role: REVIEWER_ROLE,
          model: settings.model,
          effort: settings.effort,
          session: spec.session.id,
          hash: systemHashOf(systemFile),
          at,
        },
      );
      recordPromptParts(
        office,
        run.runId,
        agent,
        promptParts(systemFile, taskMessage, []),
        deps.clock,
      );
      recordPromptTexts(
        office,
        run.runId,
        agent,
        [
          { part: "system", text: systemFile },
          { part: "message", text: taskMessage },
        ],
        config,
        deps.clock,
      );
    };
    let recorded = false;
    let host;
    try {
      host = await deps.hosts.start(office, {
        runId: run.runId,
        agentId: agent,
        officeDir: paths.officeDir,
        plan: prepared.plan,
        processedOffset: offset,
        record: () => {
          recordAgent();
          recorded = true;
        },
      });
    } catch (error) {
      return { kind: "failed", reason: `the reviewer host did not start: ${messageOf(error)}` };
    }
    if (!recorded) {
      // A host starter that does not take the extras: the same writes, after the start.
      office.immediate(() => {
        office.run(
          `update worker_hosts set processed_offset = $offset
            where office_id = $office_id and run_id = $run and agent_id = $agent`,
          { offset, run: run.runId, agent },
        );
        recordAgent();
      });
    }
    deps.control.track(request.office, {
      runId: run.runId,
      work,
      caps,
      startedAt: deps.clock.now(),
      snapshot,
    });
    deps.ingest.start(office, host, {
      run: run.runId,
      agent,
      role: REVIEWER_ROLE,
      tier: run.tier ?? "",
      budgetLimit: runCaps(office, run).budgetTokens,
      model: settings.model,
      work,
      adapter: deps.worker.adapter(paths, config) as IngestAdapter,
      initialState: deps.worker.initialState(spec),
    });
    const at = deps.clock.now();
    const appended = office.immediate(() => {
      const entries = withWorkViews(office, [
        { type: "work.assigned", key: work.key, run: run.runId, delta: { work } },
      ]);
      appendEntries(office, entries, { at });
      return entries.length;
    });
    if (appended > 0) deps.onChanged?.(request.office);
    return { kind: "started", agent };
  }
}
