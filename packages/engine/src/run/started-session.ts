// A re-attached session's initial state (DIPO-207): built with the model and effort its run started
// with, not the office tier in force.

import type { OfficeHandle } from "../db/office";
import type { WorkerPort } from "../workers/port";
import type { ParseState } from "../workers/types";
import { runWorkerSpec, type TierCaps } from "./launch";
import type { StoredRun } from "./records";
import { startTierOf } from "./resume";

/**
 * A re-attached session's initial state, built with the model and effort its run started with, not
 * the office tier in force (DIPO-207).
 */
export interface StartedSession {
  readonly handle: OfficeHandle;
  readonly run: StoredRun;
  readonly agent: string;
  /** The office's tier caps in force now. */
  readonly inForce: TierCaps;
  readonly paths: Parameters<typeof runWorkerSpec>[2];
  readonly resume: boolean;
  readonly previous?: ParseState;
}

export function startedSessionState(
  worker: Pick<WorkerPort, "reportSchema" | "initialState">,
  session: StartedSession,
): ParseState {
  const { handle, run, agent, inForce, paths, resume, previous } = session;
  const tier = startTierOf(handle, run, inForce);
  const spec = runWorkerSpec(worker, { runId: run.runId, agent, caps: tier }, paths, "", {
    id: "",
    resume,
  });
  return worker.initialState(spec, previous);
}
