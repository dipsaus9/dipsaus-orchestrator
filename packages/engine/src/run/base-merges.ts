// The merge of a moved base into a story branch (0002, 0008, DIPO-464). A box has no route out,
// so its worker can never fetch or merge the base itself: only dipo can bring the base into a box.
// Both cases below are the box runs' one catch-up (`mergeOutsideBox`: a merge committed from git
// objects in dipo's own git, recorded as a merge the box still lacks, the branch moved, pushed
// without force), and the box gets it through the copy before the next developer session
// (`RunResumerDeps.boxSync`, `BoxCollisions.copyPending`), committed in the box's own git as a
// commit of its own (`commitInBoxRepository`).
//
// - Before a session (`beforeSession`). The resume of a park of any reason that starts a developer
//   session, and each fix round's session, ask for it (`NextSessionRequest.catchUp`). dipo fetches,
//   and when the base moved and the branch lacks base commits it first takes what the box holds
//   since its last part as a part (`takePart`, the box woken for it), since a story parked mid-work
//   takes no part and the copy of the merge would otherwise overwrite that work; a part that
//   cannot be taken, or that asks for a park, parks the story and merges nothing. Then it merges
//   the base, clean or conflicted, before the handoff reads the branch and before the worker's first turn. A parked
//   story's box is stopped, so it gets the merge at its resume. The worker's first message holds
//   what happened (`caughtUpText`): the base is already merged into its branch, the files the merge
//   changed, and that the box cannot fetch the base; a conflict adds the conflict item, which the
//   worker resolves as ordinary work, since no model outside the box resolves a conflict. A
//   conflict in a path the worker cannot write merges nothing and parks `conflict`, and so does a
//   push the remote rejects (its resume merges the remote branch, `ConflictResumes`).
// - A story In Review (`inReview`). When the collision poll finds a story In Review whose branch
//   conflicts with the base (`BoxCollisions` `found`), dipo merges the base at that poll and hands
//   the conflict to the worker as one fix round at once (`FixRounds.conflict`), as the auto-merge's
//   conflict hand-off does, instead of waiting for the story's next In Review. A base that merges
//   cleanly into a story In Review merges nothing there: its next session merges it.
//
// The claim of a reused branch still merges nothing (0010): the launch never asks for this. The
// merge commit changes neither the PR's diff against the base nor its squash merge, whose subject
// stays the PR title (0002, 0016).
//
// A box that still waits for an earlier merge dipo made outside it gives no part (DIPO-324: a part
// then would undo that merge), so it gets the new merge on top of the pending copy, as before.

import type { OfficeId, StoryKey } from "@dipsaus-orchestrator/contract";

import {
  baseRefOf,
  type ConflictFile,
  type ConflictItem,
  conflictFeedbackItem,
  shownPaths,
} from "../box/collisions";
import { appendEntries, type NewEntry } from "../changelog/log";
import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import type { OfficeGit } from "../git/office";
import type { StoredRun } from "../records/run-records";
import { withWorkViews } from "../views/work";

import { mergeOutsideBox, type OutsideMergeDeps } from "./conflicts";
import { sendFeedback } from "./feedback";
import { CATCH_UP_KEY } from "./fix-rounds";
import type { SessionCatchUp } from "./resume";

/** `engine.notice` codes of a merge of a moved base. */
export const BASE_MERGE_NOTICES = {
  /** The base merged into a story's branch before its session. */
  merged: "base.merged",
  /** The base merged with conflicts, handed to the worker. */
  conflict: "base.mergeConflict",
} as const;

export interface BaseCatchUpsDeps extends OutsideMergeDeps {
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  /**
   * Takes what the run's box holds since its last part as a part, the box woken for it, before a
   * merge is copied in (`BoxParts.deliverBeforeSession`): the copy would otherwise overwrite work
   * the worker never handed over. `park` when the part asks for one; throws when it cannot be
   * taken. Without it no part is taken.
   */
  readonly takePart?: (office: OfficeId, run: StoredRun) => Promise<BoxPartTaken>;
  /** The conflict item's character budget of the run (`prompt.budgets.feedbackItem`). */
  readonly itemMax?: (office: OfficeId, run: StoredRun) => number;
  readonly onChanged?: (office: OfficeId) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

/** What taking the box's work as a part before a merge did (`BaseCatchUpsDeps.takePart`). */
export type BoxPartTaken =
  | { readonly kind: "taken" }
  | {
      readonly kind: "park";
      readonly reason: "conflict" | "scope-violation";
      readonly detail: string;
    };

/** What the merge at a story In Review hands on (`BaseCatchUps.inReview`). */
export type InReviewMerge =
  | { readonly kind: "none" }
  /** The conflict for one fix round on the merge commit. */
  | { readonly kind: "handOff"; readonly head: string; readonly item: ConflictItem }
  | { readonly kind: "park"; readonly detail: string };

function files(n: number): string {
  return n === 1 ? "1 file" : `${n} files`;
}

/**
 * Pure: the worker's message after dipo merged the moved base into its branch before its session
 * (DIPO-464): the base is already merged, the files the merge changed, and the box cannot fetch the
 * base.
 */
export function caughtUpText(facts: {
  readonly base: string;
  readonly onto: string;
  readonly files: readonly string[];
  readonly conflicts: readonly ConflictFile[];
}): string {
  const { base } = facts;
  const merged = `dipo: ${base} moved, so before this session dipo merged ${base} at ${facts.onto.slice(0, 12)} into your branch. ${base} is already merged into your branch: the merge is committed and pushed on the story branch, copied into your box, and committed in your box's git as a commit of its own, so your git log shows ${base}'s changes and your git diff only your own work.`;
  const changed =
    facts.files.length === 0
      ? "The merge changed no file outside the story folders."
      : `The merge changed ${files(facts.files.length)}: ${shownPaths(facts.files)}. Read them again before you change them further.`;
  const conflicts =
    facts.conflicts.length === 0
      ? ""
      : ` ${files(facts.conflicts.length)} conflicted and ${facts.conflicts.length === 1 ? "stays" : "stay"} as git left ${facts.conflicts.length === 1 ? "it" : "them"}: resolve them as the next part of this message says.`;
  const fetch = `Your box cannot fetch ${base}: it has no route to the remote. Do not try to fetch, pull or merge ${base} yourself; dipo merges ${base} into your branch whenever it moves.`;
  return `${merged} ${changed}${conflicts} ${fetch}`;
}

/** The merges of a moved base into story branches (see the file comment). */
export class BaseCatchUps {
  readonly #deps: BaseCatchUpsDeps;

  constructor(deps: BaseCatchUpsDeps) {
    this.#deps = deps;
  }

  /**
   * Before a resumed or fix round session (see the file comment): the base fetched and merged when
   * the branch lacks base commits, the worker's message held on the one feedback path.
   */
  async beforeSession(officeId: OfficeId, run: StoredRun): Promise<SessionCatchUp> {
    const office = this.#deps.offices.get(officeId);
    const git = this.#deps.git(officeId);
    if (office === undefined || git === undefined) return { kind: "none" };
    const fetched = await git.fetch();
    if (!fetched.ok) {
      this.#deps.warn?.("the fetch before a session failed; dipo merges the base it has", {
        run: run.runId,
        reason: fetched.error.message,
      });
    }
    const ref = await git.run((session) => baseRefOf(git, session));
    if (ref === null || !(await this.#behind(git, run, ref.ref))) return { kind: "none" };
    // The box's work goes first, so the copy of the merge never overwrites what it holds.
    const taken = await this.#takePart(officeId, run, ref.base);
    if (taken.kind === "park") return taken;
    const merged = await mergeOutsideBox(this.#deps, office, git, run, {
      name: ref.base,
      ref: ref.ref,
      conflictsOnly: false,
    });
    if (merged.kind === "none") return { kind: "none" };
    if (merged.kind === "unwritable") {
      return {
        kind: "park",
        reason: "conflict",
        detail: `git cannot merge ${ref.base} at ${merged.onto.slice(0, 12)} cleanly in paths the worker cannot write: ${shownPaths(merged.paths)}`,
      };
    }
    if (merged.push.rejected) {
      return {
        kind: "park",
        reason: "conflict",
        detail: `${merged.push.error ?? "the push was rejected"} after dipo merged ${ref.base}; the remote branch has commits the story branch lacks`,
      };
    }
    this.#unpushed(run, merged.push.error);
    const text = [caughtUpText({ ...merged, base: ref.base })];
    if (merged.conflicts.length > 0) {
      text.push(this.#item(officeId, run, ref.base, merged).text);
    }
    const at = this.#deps.clock.now();
    sendFeedback(
      office,
      run.runId,
      { source: "conflict", key: `${CATCH_UP_KEY}${merged.commit}`, text: text.join("\n\n") },
      { at },
    );
    this.#notice(office, run, ref.base, merged);
    return { kind: "merged", commit: merged.commit };
  }

  /**
   * A story In Review whose branch conflicts with the base (see the file comment): the base merged
   * at once and the conflict for one fix round; a clean merge merges nothing here.
   */
  async inReview(officeId: OfficeId, run: StoredRun): Promise<InReviewMerge> {
    const office = this.#deps.offices.get(officeId);
    const git = this.#deps.git(officeId);
    if (office === undefined || git === undefined) return { kind: "none" };
    const ref = await git.run((session) => baseRefOf(git, session));
    if (ref === null) return { kind: "none" };
    const merged = await mergeOutsideBox(this.#deps, office, git, run, {
      name: ref.base,
      ref: ref.ref,
      conflictsOnly: true,
    });
    if (merged.kind === "none") return { kind: "none" };
    if (merged.kind === "unwritable") {
      return {
        kind: "park",
        detail: `git could not merge ${ref.base} at ${merged.onto.slice(0, 12)} cleanly in paths the worker cannot write: ${shownPaths(merged.paths)}`,
      };
    }
    if (merged.push.rejected) {
      return {
        kind: "park",
        detail: `${merged.push.error ?? "the push was rejected"} after dipo merged ${ref.base}; the remote branch has commits the story branch lacks`,
      };
    }
    this.#unpushed(run, merged.push.error);
    this.#notice(office, run, ref.base, merged);
    // Only the task file conflicted: dipo resolved it, and the next session gets the merge.
    if (merged.conflicts.length === 0) return { kind: "none" };
    return {
      kind: "handOff",
      head: merged.commit,
      item: this.#item(officeId, run, ref.base, merged),
    };
  }

  /** True when the base `ref` holds commits the run's branch lacks. */
  async #behind(git: OfficeGit, run: StoredRun, ref: string): Promise<boolean> {
    if (run.branch === null) return false;
    const branch = run.branch;
    return git.run(async (session) => {
      const read = async (rev: string) => {
        const found = await session.step(session.repository, [
          "rev-parse",
          "--verify",
          "--quiet",
          rev,
        ]);
        return found.code === 0 ? found.stdout.trim() : null;
      };
      const tip = await read(`refs/heads/${branch}^{commit}`);
      const onto = await read(`${ref}^{commit}`);
      if (tip === null || onto === null) return false;
      const held = await session.step(session.repository, [
        "merge-base",
        "--is-ancestor",
        onto,
        tip,
      ]);
      return held.code !== 0;
    });
  }

  /**
   * The box's work since its last part taken as a part before a merge (`takePart`): a park it asks
   * for, or a failure, parks the story with nothing merged and the box's files kept.
   */
  async #takePart(
    officeId: OfficeId,
    run: StoredRun,
    base: string,
  ): Promise<
    | BoxPartTaken
    | { readonly kind: "park"; readonly reason: "worker-failed"; readonly detail: string }
  > {
    const take = this.#deps.takePart;
    if (take === undefined) return { kind: "taken" };
    try {
      return await take(officeId, run);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return {
        kind: "park",
        reason: "worker-failed",
        detail: `dipo could not take the box's work as a part before merging ${base} into the story branch, so it merged nothing and the box keeps its files: ${why}`,
      };
    }
  }

  #item(
    officeId: OfficeId,
    run: StoredRun,
    base: string,
    merged: {
      readonly onto: string;
      readonly conflicts: readonly ConflictFile[];
      readonly hunks: readonly string[];
    },
  ): ConflictItem {
    const itemMax = this.#deps.itemMax?.(officeId, run);
    return conflictFeedbackItem({
      base,
      onto: merged.onto,
      conflicts: merged.conflicts,
      hunks: merged.hunks,
      ...(itemMax === undefined ? {} : { itemMax }),
    });
  }

  #unpushed(run: StoredRun, error: string | null): void {
    if (error === null) return;
    this.#deps.warn?.("a merge of the base was committed but not pushed", {
      run: run.runId,
      reason: error,
    });
  }

  /** The maintainer's notice of the merge, naming the files it changed. */
  #notice(
    office: OfficeHandle,
    run: StoredRun,
    base: string,
    merged: {
      readonly onto: string;
      readonly commit: string;
      readonly files: readonly string[];
      readonly conflicts: readonly ConflictFile[];
    },
  ): void {
    const story = run.story ?? run.runId;
    const changed =
      merged.files.length === 0
        ? "no file outside the story folders"
        : `${files(merged.files.length)}: ${shownPaths(merged.files)}`;
    const conflicted =
      merged.conflicts.length === 0
        ? ""
        : ` ${files(merged.conflicts.length)} conflicted (${shownPaths(merged.conflicts.map((file) => file.path))}) and go to the worker as git left them.`;
    const entry: NewEntry = {
      type: "engine.notice",
      ...(run.key === null ? {} : { key: run.key as StoryKey }),
      run: run.runId,
      delta: {
        level: merged.conflicts.length === 0 ? "info" : "warn",
        code:
          merged.conflicts.length === 0 ? BASE_MERGE_NOTICES.merged : BASE_MERGE_NOTICES.conflict,
        text: `${story}: ${base} moved, so dipo merged ${base} at ${merged.onto.slice(0, 12)} into its branch (${merged.commit.slice(0, 12)}), which changed ${changed}.${conflicted} The box gets the merge before the worker's next turn.`,
      },
    };
    const at = this.#deps.clock.now();
    office.immediate(() => appendEntries(office, withWorkViews(office, [entry]), { at }));
    this.#deps.onChanged?.(office.officeId as OfficeId);
  }
}
