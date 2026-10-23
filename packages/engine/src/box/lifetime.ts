// The life of a story's box from claim to merge (DIPO-278; 0021 section 6 and decision 15). Every
// developer session of a story runs in the story's one box; nothing of a worker runs on the Mac.
//
// - Made at the claim (`BoxLifetime.make`, from the launch's setup): the box at the claim's start
//   commit (`BoxWorkers.create`), then the office's packages installed in it at the start commit
//   with the office's install command, within the office's install deadline (DIPO-294, 0021
//   amendment of 2026-10-22), then `/work` compared with the start commit on dipo's own copy
//   (`BoxWorkers.changedSinceStart`), never by running git on the box's files (0021 section 14).
//   A failed step deletes the box again and says why; the launch rolls the claim back.
// - Running while the worker works, stopped while the story waits (`boxRunState`, read by the
//   daemon's passes over the boxes, `BoxWorkers.finishEnded`): a run that ended (at In Review, a
//   park, a review period's end) with its claim live and its worker hosts exited waits, for a
//   review, an answer, a resume, CI or the maintainer, so its box is checked for the token and
//   stopped with its files (`BoxWorkers.rest`). The next session starts it again
//   (`BoxWorkers.session`).
// - Rebuilt when lost (`BoxLifetime.ensure`, before every later developer session): a run whose box
//   the backend no longer has, whose box was deleted, or that never had one (a run from before
//   every run was a box run) gets a new box made from the start commit plus the delivered parts:
//   the story branch's tip with `backlog/` as the start commit holds it, which is the tree the next
//   part is compared with (`box/parts.ts`). The packages are installed again and `/work` is checked
//   against that tree. Only work the worker had not delivered as a part is lost, and the caller
//   tells the maintainer (`boxRebuiltText`).
// - Deleted when the claim ends (`boxRunState` `released`): merge (Done), drop and discard all
//   release the claim, and the next pass deletes the box (`BoxWorkers.finish`). A launch that
//   fails deletes the box it made at once.

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import type { OfficeConfig } from "../config";
import { BASE_CHECKOUT_ENV } from "../git/hardened";
import type { OfficeGit } from "../git/office";
import type { RunProfile } from "../scan/detect";
import { buildRunEnv } from "../worktree/run-env";
import { BOX_WORKDIR } from "./code";
import { cleanDoorText } from "./door";
import { partNumber } from "./parts";
import { BoxError } from "./port";
import { BOX_WAITING, type BoxEnded, type BoxMade, type BoxWorkers } from "./workers";

/** `engine.notice` codes of a box's life. */
export const BOX_LIFETIME_NOTICES = {
  rebuilt: "run.boxRebuilt",
} as const;

/** The install deadline in a box when the office's `timeouts.scriptMinutes` names none. */
export const BOX_INSTALL_MINUTES_DEFAULT = 15;

/** How many paths the reason of a box with files git does not ignore names; the rest are counted. */
const TREE_PATHS_SHOWN = 5;

/** The prefix of the folder the temporary index of a rebuild's tree lives in. */
export const DELIVERED_INDEX_PREFIX = "dipo-box-delivered-";

/**
 * Why a launch fails when the install left files git does not ignore in the box's `/work`. The
 * paths are names from the box, cleaned.
 */
export function boxTreeChangedText(paths: readonly string[]): string {
  const shown = paths.slice(0, TREE_PATHS_SHOWN).map((path) => cleanDoorText(path).slice(0, 200));
  const more = paths.length > shown.length ? `, and ${paths.length - shown.length} more` : "";
  return `the install left files git does not ignore in the box's /work (${shown.join(", ")}${more}); setup steps may change only ignored files. If install rewrote a lockfile, use a frozen install (for example \`bun install --frozen-lockfile\`); write generated files to ignored paths`;
}

/** The most characters of an unexpected error's message a box preparation's reason carries. */
const PREPARE_MESSAGE_MAX = 300;

/** The fixed reasons of the box errors preparing a box can throw, by code. */
const PREPARE_REASONS: Readonly<Record<string, string>> = {
  "box.routeFailed": "dipo's web route for the box did not start",
  "box.gone": "the box was gone",
  "box.failed": "a call to the box failed",
};

/**
 * Why preparing a box failed, for the maintainer's notice (DIPO-294): a fixed text for a box
 * error, by its code, since its message may quote the box or a proxy; any other error's message
 * cleaned of control characters and cut.
 */
export function boxPrepareFailedText(error: unknown): string {
  if (error instanceof BoxError) {
    const fixed = PREPARE_REASONS[error.code] ?? "a box step failed";
    return `the box could not be prepared: ${fixed} (${cleanDoorText(error.code).slice(0, 60)})`;
  }
  const message = cleanDoorText(messageOf(error)).replaceAll(/\s+/g, " ").trim();
  const cut =
    message.length > PREPARE_MESSAGE_MAX ? `${message.slice(0, PREPARE_MESSAGE_MAX)}…` : message;
  return `the box could not be prepared: ${cut}`;
}

/** The notice of a rebuilt box: what it was made from and what was lost. */
export function boxRebuiltText(
  story: string,
  rebuilt: { had: "gone" | "none"; parts: number },
): string {
  const why =
    rebuilt.had === "none"
      ? `${story}'s run had no box (it started before every run ran in a box)`
      : `${story}'s box was gone`;
  const parts = rebuilt.parts === 1 ? "1 delivered part" : `${rebuilt.parts} delivered parts`;
  return `${why}, so dipo made it again from the start commit and the ${parts} on the story branch. Work the worker had not delivered as a part is lost.`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the daemon's passes do with a run's box (DIPO-278). */
export type BoxRunState =
  /** The claim ended (merge, drop, discard) and no worker host runs: delete the box. */
  | "released"
  /** The run ended with its claim live and no worker host runs: the story waits, stop the box. */
  | "waiting"
  /** A session runs or may start: leave the box alone. */
  | "working";

/** The facts `boxRunState` decides from. */
export interface BoxRunFacts {
  /** When the run's active period ended; null while it is open. */
  readonly endedAt: number | null;
  /** Whether the run's claim is live; null when the run has no claim row. */
  readonly claimLive: boolean | null;
  /** Whether every worker host of the run has exited. */
  readonly hostsExited: boolean;
}

/** Pure: what happens to a run's box now. */
export function boxRunState(facts: BoxRunFacts): BoxRunState {
  if (!facts.hostsExited) return "working";
  if (facts.claimLive === false) return "released";
  if (facts.endedAt === null) return "working";
  // A run without a claim row keeps the old rule: its box ends with the run.
  return facts.claimLive === null ? "released" : "waiting";
}

/** `boxRunState` as `BoxWorkers.finishEnded` asks it; null for a run no office knows. */
export function boxEndedOf(state: BoxRunState | null): BoxEnded {
  if (state === null) return null;
  if (state === "released") return true;
  return state === "waiting" ? BOX_WAITING : false;
}

/** The code of a rebuilt box: the delivered tree and what it was made from. */
export interface DeliveredCode {
  /** The story branch's tip the tree was read from. */
  readonly tip: string;
  /** The branch tip's tree with `backlog/` as the start commit holds it. */
  readonly tree: string;
  /** The parts delivered on the branch since the start commit. */
  readonly parts: number;
}

/**
 * The delivered code of a story (DIPO-278): the tree the box's `/work` held after its last part,
 * built in a temporary index of dipo's own on the repository without a work tree: the branch tip
 * read, `backlog/` replaced by the start commit's (dipo's own task-file commits never reach a box),
 * written as a tree. No checkout of the branch is read or written.
 */
export async function deliveredCode(
  git: OfficeGit,
  input: { readonly branch: string; readonly startSha: string; readonly tmpRoot: string },
): Promise<DeliveredCode> {
  const stage = await mkdtemp(join(input.tmpRoot, DELIVERED_INDEX_PREFIX));
  try {
    return await git.run(async (session) => {
      const repo = session.repository;
      const index = { env: { ...BASE_CHECKOUT_ENV, GIT_INDEX_FILE: join(stage, "index") } };
      const tip = (
        await session.ok(repo, ["rev-parse", "--verify", `refs/heads/${input.branch}^{commit}`])
      ).trim();
      await session.ok(repo, ["read-tree", tip], index);
      await session.ok(
        repo,
        ["rm", "-r", "--cached", "--force", "--quiet", "--ignore-unmatch", "--", "backlog"],
        index,
      );
      const atStart = await session.ok(repo, [
        "ls-tree",
        "-r",
        "-z",
        input.startSha,
        "--",
        "backlog",
      ]);
      const entries = atStart
        .split("\0")
        .filter((line) => line !== "")
        .map((line) => {
          const tab = line.indexOf("\t");
          const [mode = "", , id = ""] = line.slice(0, tab).split(" ");
          return `${mode},${id},${line.slice(tab + 1)}`;
        });
      for (let at = 0; at < entries.length; at += 200) {
        const group = entries.slice(at, at + 200).flatMap((entry) => ["--cacheinfo", entry]);
        await session.ok(repo, ["update-index", "--add", "--replace", ...group], index);
      }
      const tree = (await session.ok(repo, ["write-tree"], index)).trim();
      const parts = (await partNumber(session, input.startSha, tip)) - 1;
      return { tip, tree, parts };
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** What the life of a box needs of the box workers. */
export type RunBoxes = Pick<
  BoxWorkers,
  "create" | "discard" | "install" | "changedSinceStart" | "has"
>;

/** One run's box, as `make` and `ensure` get it. */
export interface RunBoxRequest {
  readonly office: OfficeId;
  readonly runId: string;
  readonly runDir: string;
  readonly story: string;
  readonly branch: string;
  readonly startSha: string;
  /** The run's port slot, for the run environment of the install; 0 when it has none. */
  readonly slot: number | null;
  readonly git: OfficeGit;
  readonly config: OfficeConfig;
}

export interface BoxLifetimeDeps {
  readonly boxes: RunBoxes;
  /**
   * The office's current run profile (DIPO-72), whose install a box gets (DIPO-294); without it
   * no box is made.
   */
  readonly profile?: (office: OfficeId) => RunProfile | null;
  /** dipo's temp root: the temporary index of a rebuild's tree. */
  readonly tmpRoot: string;
}

/** Called with why a box got no package cache, and whether an install fell back without it. */
export type CacheSkipped = (reason: string, fallback: boolean) => void;

export type BoxMadeOutcome =
  | { readonly ok: true; readonly made: BoxMade }
  | { readonly ok: false; readonly reason: string };

export type BoxEnsured =
  | { readonly kind: "ready" }
  | { readonly kind: "rebuilt"; readonly had: "gone" | "none"; readonly parts: number }
  | { readonly kind: "failed"; readonly reason: string };

/** The dev port of the root package, else the first the scan found; null when none. */
function devPortOf(profile: RunProfile | null): number | null {
  const ports = profile?.devPorts ?? [];
  return (ports.find((port) => port.dir === ".") ?? ports[0])?.port ?? null;
}

export class BoxLifetime {
  readonly #deps: BoxLifetimeDeps;

  constructor(deps: BoxLifetimeDeps) {
    this.#deps = deps;
  }

  /**
   * Makes the run's box at the claim's start commit and prepares it (see the file comment). A
   * failure deletes the box it made and returns the reason.
   */
  make(request: RunBoxRequest, cacheSkipped: CacheSkipped): Promise<BoxMadeOutcome> {
    return this.#make(request, null, cacheSkipped);
  }

  /**
   * Before a later developer session: `ready` when the run's box is there (stopped or running),
   * else the box rebuilt from the start commit and the delivered parts, or why it could not be.
   */
  async ensure(request: RunBoxRequest, cacheSkipped: CacheSkipped): Promise<BoxEnsured> {
    const { boxes } = this.#deps;
    let had;
    try {
      had = await boxes.has(request.runId, request.runDir);
    } catch (error) {
      return { kind: "failed", reason: `dipo could not see the run's box: ${messageOf(error)}` };
    }
    if (had === "ready") return { kind: "ready" };
    let code: DeliveredCode;
    try {
      code = await deliveredCode(request.git, {
        branch: request.branch,
        startSha: request.startSha,
        tmpRoot: this.#deps.tmpRoot,
      });
    } catch (error) {
      return {
        kind: "failed",
        reason: `the delivered parts of ${request.story} could not be read: ${messageOf(error)}`,
      };
    }
    // A box the record still names may linger in the backend half made: it goes first.
    if (had === "gone") await boxes.discard(request.runId);
    const made = await this.#make(request, code, cacheSkipped);
    return made.ok
      ? { kind: "rebuilt", had, parts: code.parts }
      : { kind: "failed", reason: made.reason };
  }

  async #make(
    request: RunBoxRequest,
    code: DeliveredCode | null,
    cacheSkipped: CacheSkipped,
  ): Promise<BoxMadeOutcome> {
    const { boxes } = this.#deps;
    let made: BoxMade;
    try {
      made = await boxes.create({
        office: request.office,
        runId: request.runId,
        runDir: request.runDir,
        git: request.git,
        startCommit: request.startSha,
        ...(code === null ? {} : { code: code.tree }),
      });
    } catch (error) {
      return { ok: false, reason: `the box could not be made: ${messageOf(error)}` };
    }
    if (made.cache.kind === "skipped") cacheSkipped(made.cache.reason, false);
    let ready: string | null;
    try {
      ready = await this.#ready(request, code, cacheSkipped);
    } catch (error) {
      ready = boxPrepareFailedText(error);
    }
    if (ready === null) return { ok: true, made };
    await boxes.discard(request.runId);
    return { ok: false, reason: ready };
  }

  /**
   * Prepares a box before its worker (DIPO-294): the run profile's install in the box, then the
   * check of `/work` against the code it was made from. Returns why the launch must stop, or null
   * when the box is ready. A profile with no install runs none.
   */
  async #ready(
    request: RunBoxRequest,
    code: DeliveredCode | null,
    cacheSkipped: CacheSkipped,
  ): Promise<string | null> {
    const { boxes } = this.#deps;
    if (this.#deps.profile === undefined) {
      return "this daemon cannot read the run profile, so the box gets no install";
    }
    const profile = this.#deps.profile(request.office);
    if (profile === null) return "the office has no run profile yet; rescan the office";
    const install = profile.capabilities.install;
    if (install.status === "conflict") {
      return "the run profile's install is in conflict; confirm one in the office";
    }
    if (install.status === "resolved") {
      if (install.value.cwd !== ".") {
        return `install runs in ${install.value.cwd}, but the box runs it only at the root of /work`;
      }
      const { config } = request;
      const env = buildRunEnv({
        slot: request.slot ?? 0,
        stride: config.worktree.ports.stride,
        story: request.story,
        worktree: BOX_WORKDIR,
        named: config.worktree.ports.named,
        devPort: devPortOf(profile),
        env: config.worktree.env,
      });
      const minutes = config.timeouts.scriptMinutes["install"] ?? BOX_INSTALL_MINUTES_DEFAULT;
      const installed = await boxes.install({
        runId: request.runId,
        commands: install.value.commands,
        env,
        timeoutMs: minutes * 60_000,
      });
      if (installed.cacheFallback !== undefined) cacheSkipped(installed.cacheFallback, true);
      if (!installed.ok) return installed.reason;
    }
    const tree = await boxes.changedSinceStart({
      runId: request.runId,
      office: request.office,
      story: request.story,
      branch: request.branch,
      startSha: request.startSha,
      ...(code === null ? {} : { codeTip: code.tip }),
    });
    if (tree.kind === "changed") return boxTreeChangedText(tree.paths);
    if (tree.kind === "unknown") {
      return `dipo could not check the box's /work against the start commit after the install (${tree.reason})`;
    }
    return null;
  }
}
