// Test helpers (DIPO-373): a run at In Review stays open, in phase review while it waits for its
// review and in phase merge (or build after a blocked verdict) once its head's verdict is in.

import type { RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../../src/db/office";
import { enterPhase, stopAtInReview } from "../../src/run-state/rounds";

/** The run's developer period ends at In Review at `at`: it waits for its review. */
export function atInReview(office: OfficeHandle, runId: string, at: number): void {
  office.immediate(() => {
    stopAtInReview(office, runId as RunId, at);
  });
}

/** The run stands open at In Review at `at` with its head's verdict in, in `phase`. */
export function reviewedAt(
  office: OfficeHandle,
  runId: string,
  at: number,
  phase: "merge" | "build" | "test" = "merge",
): void {
  office.immediate(() => {
    stopAtInReview(office, runId as RunId, at);
    enterPhase(office, runId as RunId, phase, at);
  });
}
