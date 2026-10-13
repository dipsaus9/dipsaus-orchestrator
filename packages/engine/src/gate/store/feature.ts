// The Ready gate against an office (DIPO-71, 0012 section 3). It reads the story, the active tasks
// and the milestones through the Backlog CLI on the office's `_base` worktree, as one item in the
// office git queue so no fetch moves `_base` meanwhile, and evaluates them with `evaluateGate`.
//
// - `recordGateDecision(office, key, mode)` stores every evaluation it makes, in one transaction;
//   the pickup re-check inside `work.run` (DIPO-48) calls it in `pickup` mode.
// - The read `story.gate` evaluates in `ready` mode and stores nothing (M0 breakdown decision D3).
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

import type { BacklogCli } from "../../backlog/runner";
import { CommandError } from "../../commands/errors";
import type { FeatureModule } from "../../commands/registry";
import type { OfficeConfig } from "../../config";
import type { OfficeHandle } from "../../db/office";
import type { OfficeGit } from "../../git/office";
import { findStoryByKey } from "../../stories/keys";
import { evaluateGate } from "../evaluate";
import type { GateConfig, GateMode, GateResult } from "../types";

import { type GateDecisionRecord, storeGateDecision } from "./decisions";
import { gateContentHash } from "./hash";
import { readGateInput } from "./read";

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
}

/** One evaluation of a story's gate on `_base`, with the content hash it applies to. */
export interface GateEvaluation {
  readonly story: StoryId;
  readonly result: GateResult;
  readonly contentHash: string;
}

/** The office configuration keys the gate reads. */
export function gateConfigOf(config: OfficeConfig): GateConfig {
  return { story: config.story, prompt: { contractMax: config.prompt.contractMax } };
}

export class GateStore {
  readonly #deps: GateStoreDeps;

  constructor(deps: GateStoreDeps) {
    this.#deps = deps;
  }

  /**
   * Evaluates the gate of `story` (a Backlog.md id) on the office's `_base`, without storing it.
   * Throws when the office has not loaded, has no base, or the Backlog CLI fails.
   */
  async evaluate(office: OfficeId, story: StoryId, mode: GateMode): Promise<GateEvaluation> {
    const git = this.#deps.git.forOffice(office);
    if (git === undefined) {
      throw new Error(`Office ${office} has not loaded; its git is not attached.`);
    }
    const config = this.#deps.offices.config(office);
    if (config === undefined) {
      throw new CommandError(
        "config.invalid",
        `Office ${office} has no valid configuration; fix .dipo/office.yaml and run \`dipo office reload-config\`.`,
      );
    }
    const base = await git.ensureBaseWorktree();
    const input = await git.run(() =>
      readGateInput(this.#deps.cli, base.path, story, gateConfigOf(config)),
    );
    return {
      story,
      result: evaluateGate(input, mode),
      contentHash: gateContentHash(input.story),
    };
  }

  /**
   * Evaluates the gate of the story `key` in `mode` and stores the decision with every rule
   * result and the content hash, in one transaction. Every evaluation is stored, pass or fail.
   */
  async recordGateDecision(
    office: OfficeId,
    key: StoryKey,
    mode: GateMode,
  ): Promise<GateDecisionRecord & { readonly story: StoryId; readonly result: GateResult }> {
    const handle = this.#handle(office);
    const identity = findStoryByKey(handle, key);
    if (identity === null) {
      throw new CommandError("story.unknown", `No story has the key ${key}.`, { story: key });
    }
    const evaluation = await this.evaluate(office, identity.story, mode);
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
            const { result } = await this.evaluate(ctx.office.officeId, identity.story, "ready");
            return {
              story: identity.story,
              key: identity.key,
              passed: result.passed,
              failures: result.failures.map(({ rule, message }) => ({ rule, message })),
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
