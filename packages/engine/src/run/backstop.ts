// The backstop after every worker turn (DIPO-49; 0008 section 2 "Backstop after every turn", 0014
// section 3 "Backstop in code"). At run start, before the worker host starts, the engine records
// the story worktree's HEAD, its checked-out branch, the repository's stash and
// `git status --porcelain -- backlog .dipo`. After every worker turn it reads them again; any
// difference parks the story `scope-violation` with the evidence, whatever the tool rules said.
//
// The engine's own ref updates are excluded: the engine writes nothing in a story worktree while
// its worker runs (no mid-implementation commits, 0014 section 3), and the commits it makes at
// the end of a run (In Review, park) end the run, so no later turn is compared with them. A caller
// that commits in the worktree and keeps the run going takes a new snapshot.
//
// Every read goes through the office git queue and the hardened runner, so a worktree whose git
// links changed is refused (`git.worktreeTampered`) and parks `scope-violation` the same way.

import type { GitLocation } from "../git/hardened";
import type { OfficeGit } from "../git/office";

/** What the backstop compares (all strings as git printed them). */
export interface BackstopSnapshot {
  /** `git rev-parse --verify HEAD`. */
  readonly head: string;
  /** `git symbolic-ref -q HEAD`; empty when HEAD is detached. */
  readonly branch: string;
  /** `git rev-parse -q --verify refs/stash`; empty when there is no stash. */
  readonly stash: string;
  /** `git status --porcelain=v1 -z --untracked-files=all -- backlog .dipo`. */
  readonly backlogStatus: string;
}

type WorktreeLocation = Extract<GitLocation, { kind: "worktree" }>;

/** Reads the snapshot of the story worktree at `worktree`, in one git queue item. */
export function readBackstop(git: OfficeGit, worktree: string): Promise<BackstopSnapshot> {
  return git.run(async (session) => {
    const location = git.worktreeLocation(worktree) as WorktreeLocation;
    const head = (await session.ok(location, ["rev-parse", "--verify", "HEAD"])).trim();
    const branch = await session.step(location, ["symbolic-ref", "-q", "HEAD"]);
    const stash = await session.step(location, ["rev-parse", "-q", "--verify", "refs/stash"]);
    const status = await session.ok(location, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      "backlog",
      ".dipo",
    ]);
    return {
      head,
      branch: branch.code === 0 ? branch.stdout.trim() : "",
      stash: stash.code === 0 ? stash.stdout.trim() : "",
      backlogStatus: status,
    };
  });
}

function shown(value: string, empty: string): string {
  return value === "" ? empty : value;
}

function statusLines(status: string): string {
  const records = status.split("\0").filter((record) => record !== "");
  return records.length === 0 ? "clean" : records.join(", ");
}

/**
 * Pure: the evidence of every change between the run-start snapshot and now, one line each, in a
 * fixed order; empty when nothing changed.
 */
export function backstopEvidence(start: BackstopSnapshot, now: BackstopSnapshot): string[] {
  const evidence: string[] = [];
  if (now.head !== start.head) {
    evidence.push(`HEAD moved from ${start.head} to ${now.head}`);
  }
  if (now.branch !== start.branch) {
    evidence.push(
      `the checked-out branch changed from ${shown(start.branch, "a detached HEAD")} to ${shown(now.branch, "a detached HEAD")}`,
    );
  }
  if (now.stash !== start.stash) {
    evidence.push(
      `the stash changed from ${shown(start.stash, "none")} to ${shown(now.stash, "none")}`,
    );
  }
  if (now.backlogStatus !== start.backlogStatus) {
    evidence.push(
      `git status of backlog and .dipo changed from ${statusLines(start.backlogStatus)} to ${statusLines(now.backlogStatus)}`,
    );
  }
  return evidence;
}

/** The park detail of a backstop hit. */
export function backstopDetail(evidence: readonly string[]): string {
  return `The worker changed git state the engine owns after a turn: ${evidence.join("; ")}.`;
}
