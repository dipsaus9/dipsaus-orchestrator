// No write to a story branch while its PR has auto-merge on (0002). GitHub checks
// `--match-head-commit` only when auto-merge goes on, so a head pushed afterwards would merge with
// no merge gate. Every park and every lift of the branch (a fix round's In Progress commit, a
// resume) first turns auto-merge off (`AutoMerge.autoMergeOff`); when that fails the write throws
// and nothing reaches the branch. The auto-merge poll also turns it off each round for any PR whose
// run no longer waits for its merge.

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import type { ParkWriter, UnparkWriter } from "../run/park";

/** Turns auto-merge off for the open story PR of `branch`; throws when it cannot. */
export type AutoMergeOff = (office: OfficeId, branch: string) => Promise<void>;

/** `writer`, with auto-merge turned off for the branch's PR before each park is written. */
export function guardedParkWriter(writer: ParkWriter, off: AutoMergeOff): ParkWriter {
  return {
    async write(office, request) {
      await off(office, request.branch);
      return writer.write(office, request);
    },
  };
}

/** `writer`, with auto-merge turned off for the branch's PR before each lift is written. */
export function guardedUnparkWriter(writer: UnparkWriter, off: AutoMergeOff): UnparkWriter {
  return {
    async lift(office, request) {
      await off(office, request.branch);
      return writer.lift(office, request);
    },
  };
}
