// The Ready gate against an office (DIPO-71, 0012 section 3). It reads the story, the active tasks
// and the milestones through the Backlog CLI on the office's `_base` worktree, as one item in the
// office git queue so no fetch moves `_base` meanwhile, and evaluates them with `evaluateGate`.
//
// - `recordGateDecision(office, key, mode)` stores every evaluation it makes, in one transaction;
//   the pickup re-check inside `work.run` (DIPO-48) calls it in `pickup` mode.
// - The read `story.gate` evaluates in `ready` mode and stores nothing (M0 breakdown decision D3).
// - `checkGate` evaluates in any mode and stores nothing; `work.preview` (DIPO-74) uses it.
//
// The daemon registers the read after `EngineGit.feature`; the read needs the office's git.

import {
  type Clock,
  type IdSource,
  type OfficeId,
  type StoryId,
  type StoryKey,
  storyGate,
} from "@dipsaus-orchestrator/contract";

import { BacklogParseError } from "../../backlog/plain";
import { type BacklogCli, BacklogCommandError, BacklogRefusedError } from "../../backlog/runner";
import { CommandError } from "../../commands/errors";
import type { FeatureModule } from "../../commands/registry";
import type { OfficeConfig } from "../../config";
import type { OfficeHandle } from "../../db/office";
import type { GitSession, OfficeGit } from "../../git/office";
import type { IndexResult } from "../../stories/index-stories";
import { findStoryByKey } from "../../stories/keys";
import { evaluateGate } from "../evaluate";
import type { GateConfig, GateMode, GateResult, GateTask } from "../types";

import { baseSha, cachedGateTasks } from "./cache";
import { type GateDecisionRecord, storeGateDecision } from "./decisions";
import { gateContentHash } from "./hash";
import { readGateInput, StoryNotFoundError } from "./read";
import { BaseTreeCache, listTreeFiles } from "./tree";

export interface GateStoreDeps {
  /** The office's git once the git load step attached it. */
  readonly git: { forOffice(office: OfficeId): OfficeGit | undefined };
  readonly cli: BacklogCli;
  /** The loaded offices: their handles and the configuration in force. */
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  readonly clock: Clock;
  readonly ids: IdSource;
  /** The stories index; the pass that brings a stale mirror up to date goes through it (DIPO-201). */
  readonly index: {
    indexInSession(office: OfficeId, session: GitSession, basePath: string): Promise<IndexResult>;
  };
}

/** The `_base` checkout a gate reads: its path and the base branch it is at. */
export interface BaseCheckout {
  readonly path: string;
  readonly base: string;
}

/** One evaluation of a story's gate on `_base`, with the content hash it applies to. */
export interface GateEvaluation {
  readonly story: StoryId;
  readonly result: GateResult;
  readonly contentHash: string;
}

/** The first line of a CLI error, without the command line the runner prefixes. */
function reasonOf(error: Error): string {
  const line = error.message.split("\n")[0] ?? "";
  return line.replace(/^`[^`]*` /, "");
}

/** A contract error for a failed read of the gate's inputs; other throws pass through. */
function gateReadError(office: OfficeId, story: StoryId, base: string, error: unknown): unknown {
  if (error instanceof StoryNotFoundError) {
    return new CommandError(
      "story.unknown",
      `${story} is not on the office's base branch ${base}; the Ready gate reads the story as it is there, so push or merge it first.`,
      { story },
    );
  }
  if (
    error instanceof BacklogCommandError ||
    error instanceof BacklogRefusedError ||
    error instanceof BacklogParseError
  ) {
    return new CommandError(
      "backlog.unreadable",
      `The Ready gate cannot run: the Backlog CLI could not read ${story} on the office's base branch ${base} (${reasonOf(error)}).`,
      { office, story },
    );
  }
  return error;
}

/** The office configuration keys the gate reads. */
export function gateConfigOf(config: OfficeConfig): GateConfig {
  return { story: config.story, prompt: { contractMax: config.prompt.contractMax } };
}

export class GateStore {
  readonly #deps: GateStoreDeps;
  /** The base tree's file paths per office, for the base commit last listed (R29, DIPO-251). */
  readonly #trees = new BaseTreeCache();

  constructor(deps: GateStoreDeps) {
    this.#deps = deps;
  }

  /**
   * Evaluates the gate of `story` (a Backlog.md id) on the office's `_base` in `ready` mode,
   * without storing it. A pickup-mode evaluation only happens through `recordGateDecision`.
   */
  checkReady(office: OfficeId, story: StoryId): Promise<GateEvaluation> {
    return this.#evaluate(office, story, "ready");
  }

  /**
   * Evaluates the gate of `story` on `_base` in `mode` without storing it: `work.preview`
   * (DIPO-74) asks the pickup gate this way, so the dry run stores no decision.
   */
  async checkGate(office: OfficeId, story: StoryId, mode: GateMode): Promise<GateResult> {
    return (await this.#evaluate(office, story, mode)).result;
  }

  /**
   * Throws `story.unknown` when the story is not on `_base`; `office.refused` with `details.step`
   * `git.version` (the load step that attaches it) when the office's git is not attached;
   * `config.invalid` when the office has no valid configuration; and `backlog.unreadable` when the
   * Backlog CLI cannot read the story or the backlog.
   */
  async #evaluate(
    office: OfficeId,
    story: StoryId,
    mode: GateMode,
    at?: BaseCheckout,
    held?: GitSession,
  ): Promise<GateEvaluation> {
    const git = this.#deps.git.forOffice(office);
    if (git === undefined) {
      throw new CommandError(
        "office.refused",
        `The Ready gate cannot run: office ${office} has no git attached yet, so its base branch cannot be read. Run \`dipo office open\` in the repository again.`,
        { office, step: "git.version" },
      );
    }
    const config = this.#deps.offices.config(office);
    if (config === undefined) {
      throw new CommandError(
        "config.invalid",
        `The Ready gate cannot run: office ${office} has no valid configuration yet. Fix .dipo/office.yaml and run \`dipo office reload-config\`.`,
        { office },
      );
    }
    const base = at ?? (await git.ensureBaseWorktree());
    const read = async (session: GitSession | undefined = held) => {
      const others = await this.#otherTasks(office, git, base.path, session);
      const files = await this.#baseFiles(office, git, base.path, session);
      return readGateInput(this.#deps.cli, base.path, story, gateConfigOf(config), others, files);
    };
    let input;
    try {
      // Inside the caller's queue item the `_base` worktree is already where the item put it.
      input = at === undefined ? await git.run(read) : await read();
    } catch (error) {
      throw gateReadError(office, story, base.base, error);
    }
    return {
      story,
      result: evaluateGate(input, mode),
      contentHash: gateContentHash(input.story),
    };
  }

  /**
   * The active tasks as the mirror holds them for the commit `_base` is at (DIPO-180), or
   * undefined when the caller must read them through the CLI. When the mirror was read at another
   * commit, the index pass runs first (the caller's `session`, inside its queue item) so a decision
   * never uses task data older than its base. Without a session no pass can run, and a stale
   * mirror is not used.
   */
  async #otherTasks(
    office: OfficeId,
    git: OfficeGit,
    basePath: string,
    session: GitSession | undefined,
  ): Promise<GateTask[] | undefined> {
    const handle = this.#deps.offices.get(office);
    const sha = baseSha(git, basePath);
    if (handle === undefined || sha === null) return undefined;
    const fresh = cachedGateTasks(handle, sha);
    if (fresh !== null || session === undefined) return fresh ?? undefined;
    const pass = await this.#deps.index.indexInSession(office, session, basePath);
    return pass.sha === sha ? (cachedGateTasks(handle, sha) ?? undefined) : undefined;
  }

  /**
   * The file paths of the tree at the commit `_base` is at (R29, DIPO-251), listed from git's
   * objects once per base commit (`BaseTreeCache`). Undefined when that commit cannot be told, or
   * when no session is held and the commit was not listed before; R29 then knows no base file.
   */
  async #baseFiles(
    office: OfficeId,
    git: OfficeGit,
    basePath: string,
    session: GitSession | undefined,
  ): Promise<readonly string[] | undefined> {
    const sha = baseSha(git, basePath);
    if (sha === null) return undefined;
    return this.#trees.filesAt(
      office,
      sha,
      session === undefined ? undefined : (commit) => listTreeFiles(session, commit),
    );
  }

  /**
   * Evaluates the gate of the story `key` in `mode` and stores the decision with every rule
   * result and the content hash, in one transaction. Every evaluation is stored, pass or fail.
   *
   * With `checkout`, the caller runs inside the office's git queue item (the pickup re-check inside the
   * claim, DIPO-48) and names the `_base` checkout to read; no queue item of its own is started.
   * `session` is that item's git session, so a stale mirror is brought up to date in one pass.
   */
  async recordGateDecision(
    office: OfficeId,
    key: StoryKey,
    mode: GateMode,
    checkout?: BaseCheckout,
    session?: GitSession,
  ): Promise<GateDecisionRecord & { readonly story: StoryId; readonly result: GateResult }> {
    const handle = this.#handle(office);
    const identity = findStoryByKey(handle, key);
    if (identity === null) {
      throw new CommandError("story.unknown", `No story has the key ${key}.`, { story: key });
    }
    const evaluation = await this.#evaluate(office, identity.story, mode, checkout, session);
    const at = this.#deps.clock.now();
    const stored = handle.immediate(() =>
      storeGateDecision(handle, this.#deps.ids, {
        key,
        result: evaluation.result,
        contentHash: evaluation.contentHash,
        at,
      }),
    );
    return { ...stored, story: evaluation.story, result: evaluation.result };
  }

  /** The feature module that adds the read `story.gate`. */
  get feature(): FeatureModule {
    return {
      name: "gate/store",
      register: (registry) => {
        registry.addAsyncRead({
          definition: storyGate,
          handle: async (ctx, args) => {
            const identity = ctx.stories.get(args.story);
            if (ctx.office === undefined || identity === undefined) {
              throw new Error("story.gate runs with its office and its story resolved");
            }
            const { result } = await this.checkReady(ctx.office.officeId, identity.story);
            return {
              story: identity.story,
              key: identity.key,
              passed: result.passed,
              failures: result.failures.map(({ rule, message }) => ({ rule, message })),
              ...(result.waitingOn === undefined ? {} : { waitingOn: [...result.waitingOn] }),
            };
          },
        });
      },
    };
  }

  #handle(office: OfficeId): OfficeHandle {
    const handle = this.#deps.offices.get(office);
    if (handle === undefined) throw new Error(`Office ${office} has not loaded.`);
    return handle;
  }
}
