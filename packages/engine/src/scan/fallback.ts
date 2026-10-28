// The scan fallback (0013 section 6 and its amendment of 2026-10-22, 0019 and 0021 amendments of
// the same day, DIPO-310): one model session that proposes a command for each capability code left
// unresolved or in conflict. Code drives it:
//
// - It starts only on the maintainer's `office.infer` (`dipo office infer`), never after a scan,
//   and never for a capability code resolved or the maintainer confirmed (`requestItems`).
// - One session run per office at a time, outside the worker and reviewer places: a second infer
//   waits for the running one and then builds its own request (0019 amendment of 2026-10-22).
// - The office's starts paused (0020) makes it wait, never park: the session starts once the pause
//   lifted. A session that meets the plan limit itself pauses the office's starts with the limit's
//   reset time, then waits for the lift the same way and starts a new session.
// - The evidence is built by code from dipo's base copy (`readBase`, `buildEvidence`); the session
//   runs on the Mac with no box and every tool off, through the worker adapter only (the
//   `ScanSessionRunner` port; the Claude one is `run/session-run.ts`).
// - The answer is checked against the schema and the base copy (`checkAnswer`); each proposal
//   that passes is stored pending, confidence `low`, with its evidence. Nothing runs a pending
//   command: it is not part of the effective profile until the maintainer confirms it.

import type { Clock, OfficeId, RunId, TimerHandle } from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type { OfficeHandle } from "../db/office";
import type { Logger } from "../log/logger";
import { background } from "../platform/background";
import { endRun } from "../run/records";
import type { JsonSchema } from "../workers/types";

import { checkAnswer, SCAN_ANSWER_JSON_SCHEMA } from "./answer";
import { profileScripts, shownSpec } from "./diff";
import type { BaseEvidence } from "./evidence-read";
import { buildEvidence, requestItems, type RequestItem } from "./evidence";
import { writeProposal } from "./marks";
import { scanSystemFile, scanTaskMessage } from "./request";
import { currentProfile, type StoredProfile } from "./store";

/** The session's role in `runs` and `agents`. */
export const SCAN_ROLE = "scanner";
/** One turn plus one schema retry (0013 amendment of 2026-10-22). */
export const SCAN_MAX_TURNS = 2;
/** How often a session waiting for the office's starts paused to lift looks again. */
export const SCAN_STARTS_PAUSED_POLL_MS = 60_000;

/** The end kind of a session run no daemon follows any more (a restart during the session). */
export const SCAN_SESSION_LOST = "lost";

/**
 * Ends every scan session run of the office that has not ended, inside its own transaction: at
 * office load no fallback session runs yet, so such a run was left by a daemon that stopped during
 * it, and would keep the office busy. Its usage stays counted. Returns the runs it ended.
 */
export function endLostScanSessions(office: OfficeHandle, at: number): string[] {
  return office.immediate(() => {
    const open = office.all<{ run_id: string }>(
      `select run_id from runs where office_id = $office_id and kind = 'session' and role = $role
         and ended_at is null order by started_at`,
      { role: SCAN_ROLE },
    );
    for (const row of open) endRun(office, row.run_id as RunId, at, SCAN_SESSION_LOST);
    return open.map((row) => row.run_id);
  });
}

/** `engine.notice` codes of the fallback. */
export const SCAN_NOTICES = {
  waiting: "scan.inferWaiting",
  answerDropped: "scan.answerDropped",
  proposalDropped: "scan.proposalDropped",
  failed: "scan.inferFailed",
} as const;

/** The office's `scan` block, plus the fixed turn cap. */
export interface ScanSessionSettings {
  readonly model: string;
  readonly effort: string;
  readonly budgetTokens: number;
  readonly maxMinutes: number;
  readonly maxTurns: number;
}

/** What one fallback session is started with. */
export interface ScanSessionRequest {
  readonly office: OfficeId;
  readonly handle: OfficeHandle;
  readonly settings: ScanSessionSettings;
  /** The L1+L2 system file text. */
  readonly systemFile: string;
  /** The task message: the request and the evidence. */
  readonly taskMessage: string;
  /** The structured output the session's answer must follow. */
  readonly schema: JsonSchema;
}

/** How one fallback session ended. */
export type ScanSessionResult =
  | { readonly kind: "answered"; readonly runId: string; readonly answer: unknown }
  /** The session met a plan limit: the office's starts pause, then a new session (never parks). */
  | {
      readonly kind: "plan-limit";
      readonly runId: string | null;
      /** When the limit resets (engine clock, ms), when the session said. */
      readonly resetsAt?: number;
    }
  | { readonly kind: "failed"; readonly runId: string | null; readonly reason: string };

/** Starts and follows one fallback session to its end (the worker adapter behind it). */
export interface ScanSessionRunner {
  run(request: ScanSessionRequest): Promise<ScanSessionResult>;
  /** Stops every session still running, at daemon stop; it never rejects. */
  stopAll?(): Promise<void>;
}

export interface ScanFallbackDeps {
  /** The session runner; without one, infer reports that no session can run. */
  readonly runner?: () => ScanSessionRunner | undefined;
  /** The office's `scan` settings in force. */
  readonly settings: (office: OfficeId) => Omit<ScanSessionSettings, "maxTurns">;
  /** Why no new session starts in the office now (its starts paused, 0020); null when it may. */
  readonly startsPaused?: (office: OfficeId) => string | null;
  /** A session met the plan limit: the office's starts pause until `resetsAt` (ms) or a lift. */
  readonly pausePlanLimit?: (office: OfficeId, resetsAt: number | undefined) => void;
  /** dipo's base copy of the office: its files and evidence texts, read in one git queue item. */
  readonly readBase: (office: OfficeId) => Promise<BaseEvidence>;
  /** Change-log entries were appended outside a command; subscribers catch up. */
  readonly onOfficeChanged?: (office: OfficeId) => void;
  readonly logger?: Logger;
  /** How long a waiting session waits before it looks again; `SCAN_STARTS_PAUSED_POLL_MS` by default. */
  readonly pollMs?: number;
}

interface Tracked {
  readonly handle: OfficeHandle;
  readonly clock: Clock;
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class ScanFallback {
  readonly #deps: ScanFallbackDeps;
  /** The office's running or queued sessions, as one chain each. */
  readonly #chains = new Map<OfficeId, Promise<void>>();
  readonly #offices = new Map<OfficeId, Tracked>();
  readonly #timers = new Set<{ timer: TimerHandle; clock: Clock; resolve: () => void }>();
  #closed = false;

  constructor(deps: ScanFallbackDeps) {
    this.#deps = deps;
  }

  /** True while a session of the office runs or waits to run. */
  inferring(office: OfficeId): boolean {
    return this.#chains.has(office);
  }

  /** Resolves once the office's sessions, running and queued, have ended. */
  async whenIdle(office: OfficeId): Promise<void> {
    for (;;) {
      const chain = this.#chains.get(office);
      if (chain === undefined) return;
      await chain;
    }
  }

  /**
   * At daemon stop: held sessions start no more, and every session still running gets the stop,
   * so its caps hold after the daemon is gone (DIPO-310). Never rejects.
   */
  async close(): Promise<void> {
    this.#closed = true;
    for (const pending of this.#timers) {
      pending.clock.clearTimeout(pending.timer);
      pending.resolve();
    }
    this.#timers.clear();
    try {
      await this.#deps.runner?.()?.stopAll?.();
    } catch (error) {
      this.#deps.logger?.warn("stopping the scan sessions failed", { reason: reasonOf(error) });
    }
  }

  /**
   * `office.infer`, inside the command's transaction: what the request would ask for now, and
   * whether a session starts now, waits for the office's running one, or is not needed. The
   * session itself starts after the command replied.
   */
  infer(
    office: OfficeId,
    handle: OfficeHandle,
    clock: Clock,
  ): { infer: "started" | "queued" | "nothing"; capabilities: RequestItem["capability"][] } {
    const current = currentProfile(handle);
    if (current === null) {
      throw new CommandError(
        "scan.noProfile",
        "The office has no run profile yet. Run `dipo office rescan` first.",
      );
    }
    const items = requestItems(current.profile.capabilities, current.nothingToStart);
    if (items.length === 0) return { infer: "nothing", capabilities: [] };
    this.#offices.set(office, { handle, clock });
    const queued = this.#chains.has(office);
    const previous = this.#chains.get(office) ?? Promise.resolve();
    const chain: Promise<void> = previous
      .then(() =>
        background(() => this.#session(office), {
          failed: "the scan fallback failed",
          fields: { office },
          log: (message, fields) => this.#deps.logger?.warn(message, fields),
        }),
      )
      .then(() => {
        // The newest chain of the office waits for every earlier one, so it alone clears it.
        if (this.#chains.get(office) === chain) this.#chains.delete(office);
      });
    this.#chains.set(office, chain);
    return { infer: queued ? "queued" : "started", capabilities: items.map((i) => i.capability) };
  }

  #sleep(clock: Clock, ms: number): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const entry = {
        clock,
        resolve,
        timer: clock.setTimeout(() => {
          this.#timers.delete(entry);
          resolve();
        }, ms),
      };
      this.#timers.add(entry);
    });
  }

  #settings(office: OfficeId): ScanSessionSettings {
    return { ...this.#deps.settings(office), maxTurns: SCAN_MAX_TURNS };
  }

  /** Waits while the office's starts are paused; one notice when the wait begins. */
  async #waitForStarts(office: OfficeId, state: Tracked): Promise<void> {
    let told = false;
    for (;;) {
      if (this.#closed) return;
      const paused = this.#deps.startsPaused?.(office) ?? null;
      if (paused === null) return;
      if (!told) {
        this.#append(office, state, [
          notice(
            "info",
            SCAN_NOTICES.waiting,
            `The scan fallback waits before its session starts: ${paused}`,
          ),
        ]);
        told = true;
      }
      await this.#sleep(state.clock, this.#deps.pollMs ?? SCAN_STARTS_PAUSED_POLL_MS);
    }
  }

  async #session(office: OfficeId): Promise<void> {
    const state = this.#offices.get(office);
    if (state === undefined) return;
    for (;;) {
      if (this.#closed) return;
      const settings = this.#settings(office);
      await this.#waitForStarts(office, state);
      if (this.#closed) return;
      const runner = this.#deps.runner?.();
      if (runner === undefined) {
        this.#failed(office, state, null, "this daemon has no worker adapter for the session");
        return;
      }
      let base: BaseEvidence;
      try {
        base = await this.#deps.readBase(office);
      } catch (error) {
        this.#failed(office, state, null, `dipo's base copy could not be read: ${reasonOf(error)}`);
        return;
      }
      const current = currentProfile(state.handle);
      if (current === null) {
        this.#failed(office, state, null, "the office has no run profile");
        return;
      }
      const items = requestItems(current.profile.capabilities, current.nothingToStart);
      if (items.length === 0) {
        this.#finished(office, state, current, [], ["Nothing is left to infer."]);
        return;
      }
      const bundle = buildEvidence(
        { files: base.files, texts: base.texts, envFiles: current.profile.envFiles },
        items,
      );
      let result: ScanSessionResult;
      try {
        result = await runner.run({
          office,
          handle: state.handle,
          settings,
          systemFile: scanSystemFile(),
          taskMessage: scanTaskMessage(bundle),
          schema: SCAN_ANSWER_JSON_SCHEMA,
        });
      } catch (error) {
        this.#failed(office, state, null, reasonOf(error));
        return;
      }
      if (result.kind === "plan-limit") {
        // A plan limit is not the office's fault: the office's starts pause, and a new session
        // starts once the pause lifted (`#waitForStarts`).
        this.#deps.pausePlanLimit?.(office, result.resetsAt);
        this.#append(office, state, [
          notice(
            "info",
            SCAN_NOTICES.waiting,
            "The scan fallback's session met a plan limit; it starts again once the office's starts paused lifts.",
          ),
        ]);
        // Without a pause to wait on, the next session waits one poll.
        if (this.#deps.startsPaused?.(office) == null) {
          await this.#sleep(state.clock, this.#deps.pollMs ?? SCAN_STARTS_PAUSED_POLL_MS);
        }
        continue;
      }
      if (result.kind === "failed") {
        this.#failed(office, state, result.runId, result.reason);
        return;
      }
      this.#store(office, state, items, base, result.runId, result.answer);
      return;
    }
  }

  /** Checks the answer and stores what passes, in one transaction with its entries. */
  #store(
    office: OfficeId,
    state: Tracked,
    items: readonly RequestItem[],
    base: BaseEvidence,
    runId: string,
    answer: unknown,
  ): void {
    const checked = checkAnswer(answer, items, base);
    const at = state.clock.now();
    state.handle.immediate(() => {
      const current = currentProfile(state.handle);
      if (current === null) return;
      const entries: NewEntry[] = [];
      const diff: string[] = [];
      if (!checked.ok) {
        entries.push(
          notice(
            "warn",
            SCAN_NOTICES.answerDropped,
            `dipo dropped the scan fallback's answer (check: ${checked.check}): ${checked.detail}`,
          ),
        );
      } else {
        for (const dropped of checked.dropped) {
          entries.push(
            notice(
              "warn",
              SCAN_NOTICES.proposalDropped,
              `dipo dropped the proposed ${dropped.capability} (check: ${dropped.check}): ${dropped.detail}`,
            ),
          );
        }
        for (const proposal of checked.accepted) {
          writeProposal(state.handle, {
            capability: proposal.capability,
            spec: proposal.spec,
            modelConfidence: proposal.modelConfidence,
            evidence: proposal.evidence,
            fingerprint: current.code.fingerprint,
            runId,
            proposedAt: at,
          });
          diff.push(
            `+ ${proposal.capability} proposal: ${shownSpec(proposal.spec)} [inferred, low; ${proposal.evidence.join("; ")}]`,
          );
        }
      }
      const warnings =
        checked.ok && checked.accepted.length === 0 ? ["The fallback proposed nothing."] : [];
      entries.push(finishedEntry(current, diff, warnings));
      appendEntries(state.handle, entries, { at });
    });
    this.#deps.onOfficeChanged?.(office);
  }

  #finished(
    office: OfficeId,
    state: Tracked,
    current: StoredProfile,
    diff: readonly string[],
    warnings: readonly string[],
  ): void {
    const at = state.clock.now();
    state.handle.immediate(() =>
      appendEntries(state.handle, [finishedEntry(current, diff, warnings)], { at }),
    );
    this.#deps.onOfficeChanged?.(office);
  }

  #failed(office: OfficeId, state: Tracked, runId: string | null, reason: string): void {
    const text = `The scan fallback's session failed${runId === null ? "" : ` (${runId})`}: ${reason}`;
    this.#deps.logger?.warn("scan fallback failed", { office, reason });
    const at = state.clock.now();
    state.handle.immediate(() =>
      appendEntries(
        state.handle,
        [
          notice("warn", SCAN_NOTICES.failed, text),
          {
            type: "scan.finished",
            delta: { scripts: {}, warnings: [], trigger: "infer", error: text },
          },
        ],
        { at },
      ),
    );
    this.#deps.onOfficeChanged?.(office);
  }

  #append(office: OfficeId, state: Tracked, entries: readonly NewEntry[]): void {
    const at = state.clock.now();
    state.handle.immediate(() => appendEntries(state.handle, entries, { at }));
    this.#deps.onOfficeChanged?.(office);
  }
}

function notice(level: "info" | "warn", code: string, text: string): NewEntry {
  return { type: "engine.notice", delta: { level, code, text } };
}

/** The `scan.finished` of an infer: the profile as it stands, with the proposals as its diff. */
function finishedEntry(
  current: StoredProfile,
  diff: readonly string[],
  warnings: readonly string[],
): NewEntry {
  const { profile } = current;
  return {
    type: "scan.finished",
    delta: {
      scripts: profileScripts(profile),
      warnings: [...warnings],
      trigger: "infer",
      level: profile.conformance.level,
      deviations: profile.conformance.deviations.map((d) => d.message),
      diff: [...diff],
    },
  };
}
