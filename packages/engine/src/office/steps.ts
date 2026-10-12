// The office load-step seam (M0 review, DIPO-15). Feature modules add load steps and active-work
// checks from their `register(registry)`: the Backlog CLI version check (DIPO-28), the story index
// (DIPO-32), the scan (DIPO-72) and journal replay (DIPO-34) run as load steps, and the run check
// (DIPO-48) as an active-work check, so none of them edits `office/`.

import type { Clock, IdSource, OfficeId } from "@dipsaus-orchestrator/contract";

import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";

/** What a load step gets while its office loads. */
export interface OfficeLoadContext {
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
  /** The main worktree, the office path (0007 section 2). */
  readonly path: string;
  /** `<git-common-dir>`, shared by every worktree of the repository. */
  readonly commonDir: string;
  /** The configuration in force; undefined while the office has no valid one (0017 section 5). */
  readonly config: OfficeConfig | undefined;
  readonly clock: Clock;
  readonly ids: IdSource;
}

/** A step that refuses the office returns `ok: false` with a reason, or throws. */
export type LoadStepResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type LoadStep = (
  ctx: OfficeLoadContext,
) => LoadStepResult | void | Promise<LoadStepResult | void>;

/**
 * Reports whether the office has active work, so `office.forget` refuses it with `office.busy`.
 * Synchronous: it reads the office's rows.
 */
export type ActiveWorkCheck = (office: OfficeHandle) => boolean;

export interface RegisteredLoadStep {
  readonly module: string;
  readonly name: string;
  readonly run: LoadStep;
}

export interface RegisteredActiveWorkCheck {
  readonly module: string;
  readonly name: string;
  readonly check: ActiveWorkCheck;
}
