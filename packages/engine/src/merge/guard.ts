// No write to a story branch while its PR has auto-merge on (0002). GitHub checks
// `--match-head-commit` only when auto-merge goes on, so a head pushed afterwards would merge with
// no merge gate. Every park and every lift of the branch (a fix round's In Progress commit, a
// resume) runs through `AutoMerge.guarded`: in the office's auto-merge queue, so no round can turn
// auto-merge on between the two, auto-merge goes off first and then the write runs; when it cannot
// go off the write throws and nothing reaches the branch. The auto-merge poll also turns it off
// each round for any PR whose run no longer waits for its merge.
//
// The auto-merge's own parks (a conflict in a path the worker cannot write, a PR closed on GitHub)
// run inside a round and use the unguarded writer: they come after auto-merge is off.

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import type { ParkWriter, UnparkWriter } from "../run/park";

/**
 * Runs `write` to the story branch `branch` with auto-merge off for its open PR, inside the
 * office's auto-merge queue; throws, writing nothing, when auto-merge cannot be turned off.
 */
export type AutoMergeGuard = <T>(
  office: OfficeId,
  branch: string,
  write: () => Promise<T>,
) => Promise<T>;

/** `writer`, each park written through `guard`. */
export function guardedParkWriter(writer: ParkWriter, guard: AutoMergeGuard): ParkWriter {
  return {
    write: (office, request) => guard(office, request.branch, () => writer.write(office, request)),
  };
}

/** `writer`, each lift written through `guard`. */
export function guardedUnparkWriter(writer: UnparkWriter, guard: AutoMergeGuard): UnparkWriter {
  return {
    lift: (office, request) => guard(office, request.branch, () => writer.lift(office, request)),
  };
}
