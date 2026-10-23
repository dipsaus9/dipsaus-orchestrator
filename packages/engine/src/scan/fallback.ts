// The scan fallback (0013 section 6 and its amendment of 2026-10-22, 0019 and 0021 amendments of
// the same day, DIPO-310): one model session that proposes a command for each capability code left
// unresolved or in conflict. Code drives it:
//
// - It starts only on the maintainer's `office.infer` (`dipo office infer`), never after a scan,
//   and never for a capability code resolved or the maintainer confirmed (`requestItems`).
// - One session run per office at a time, outside the worker and reviewer places: a second infer
//   waits for the running one and then builds its own request (0019 amendment of 2026-10-22).
// - A plan-limit hold on the session's model makes it wait, never park: before the session starts,
//   and again when the session itself meets the limit (0008 section 7).
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
/** How often a session held by a plan limit looks again, when no reset time is known. */
export const SCAN_PLAN_LIMIT_POLL_MS = 60_000;
/** A session that met a plan limit with a reset time starts this long after it (0008 section 7). */
export const SCAN_RESUME_AFTER_MS = 2 * 60_000;

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
  /** The session met a plan limit: the fallback waits and starts a new one (never parks). */
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
}

export interface ScanFallbackDeps {
  /** The session runner; without one, infer reports that no session can run. */
  readonly runner?: () => ScanSessionRunner | undefined;
  /** The office's `scan` settings in force. */
  readonly settings: (office: OfficeId) => Omit<ScanSessionSettings, "maxTurns">;
  /** Why new sessions of `model` are held by a plan limit now; null when they are not. */
  readonly planLimitHeld?: (office: OfficeId, model: string) => string | null;
  /** dipo| null;
  /** dipo's base copy of the office: its files and evidence texts, read in one git queue item. */
  readonly readBase: (office: OfficeId) => Promise<BaseEvidence>;
  /** Change-log entries were appended outside a command; subscribers catch up. */
  readonly onOfficeChanged?: (office: OfficeId) => void;
  readonly logger?: Logger;
  /** How long a held session waits before it looks again; `SCAN_PLAN_LIMIT_POLL_MS` by default. */
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

  /** Stops waiting: held sessions start no more. */
  close(): void {
    this.#closed = true;
    for (const pending of this.#timers) {
      pending.clock.clearTimeout(pending.timer);
      pending.resolve();
    }
    this.#timers.clear();
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

  /** Waits while a plan limit holds sessions of `model`; one notice when the wait begins. */
  async #waitForPlan(office: OfficeId, state: Tracked, model: string): Promise<void> {
    let told = false;
    for (;;) {
      if (this.#closed) return;
      const held = this.#deps.planLimitHeld?.(office, model) ?? null;
      if (held === null) return;
      if (!told) {
        this.#append(office, state, [
          notice(
            "info",
            SCAN_NOTICES.waiting,
            `The scan fallback waits for a plan limit before its session starts: ${held}`,
          ),
        ]);
        told = true;
      }
      await this.#sleep(state.clock, this.#deps.pollMs ?? SCAN_PLAN_LIMIT_POLL_MS);
    }
  }

  async #session(office: OfficeId): Promise<void> {
    const state = this.#offices.get(office);
    if (state === undefined) return;
    for (;;) {
      if (this.#closed) return;
      const settings = this.#settings(office);
      await this.#waitForPlan(office, state, settings.model);
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
        // Plan limits are not the office's fault: wait for the reset, then a new session.
        const now = state.clock.now();
        const wait =
          result.resetsAt === undefined
            ? (this.#deps.pollMs ?? SCAN_PLAN_LIMIT_POLL_MS)
            : Math.max(0, result.resetsAt - now) + SCAN_RESUME_AFTER_MS;
        this.#append(office, state, [
          notice(
            "info",
            SCAN_NOTICES.waiting,
            "The scan fallback's session met a plan limit; it waits for the reset and starts again.",
          ),
        ]);
        await this.#sleep(state.clock, wait);
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
