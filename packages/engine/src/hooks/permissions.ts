// The permission wait (0008 section 5, open question 2: hybrid, decided by code; DIPO-59). A
// worker's `PermissionRequest` hook arrives as a neutral `permissionRequest` hook event with the id
// its worker host holds the call under. The engine decides at once:
//
// - With `permissions.ask: when-present`, a connected client and a client command or read within
//   `permissions.presentMinutes` (stream heartbeats do not count), the maintainer is present: the
//   engine stores a permission question, emits `question.asked` (kind permission, the tool and a
//   one-line input summary) and `work.observed input-wait`, and waits up to
//   `timeouts.permissionWaitSeconds` for `work.answer`. An answer allows or denies the call; no
//   answer in time denies it.
// - Otherwise (not present, `never`, a run being ended, no story work), the hook gets no decision at
//   once, so the call is denied. With the daemon down nobody answers and the worker host itself
//   returns no decision.
//
// The reply goes to the worker host as the adapter encodes the neutral `HookReply`; this module
// never names a CLI field. A worker's exit closes its open questions (`ended`), and an office load
// closes the ones a previous daemon left (`expired`): their hook calls were already answered by the
// host with no decision.
//
// The timeout's own writes run in a timer, outside any command: a database error there is logged
// once with its error code and the deny is still sent; a question that could not be closed stays
// open until the next office load expires it (DIPO-119).

import {
  type Clock,
  type IdSource,
  type OfficeId,
  type RunId,
  workAnswer,
} from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type { AsyncCommandContext, CommandOutcome, FeatureModule } from "../commands/registry";
import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import { background, failureFields } from "../platform/background";
import type { RunSteering } from "../run/control";
import { activeSignals, clearSignals, raiseSignal } from "../run/signals";
import { withWorkViews, workRefOf } from "../views/work";
import type { HostOp, SteerOp, WorkerEvent } from "../workers/types";

import {
  answerParkQuestion,
  type ParkAnswerResult,
  parkedElsewhere,
  type ParkResumer,
  staleParkQuestions,
} from "./park-answers";
import {
  closeQuestion,
  findQuestion,
  insertPermissionQuestion,
  openQuestions,
  type QuestionClose,
  questionViewOf,
  type StoredQuestion,
  takeAllowOnce,
} from "./questions";
import type { HookEvent, HookReply, PermissionDecision } from "./types";

/** The error of `work.answer` for a question that is not waiting (0005 section 4). */
export const QUESTION_CLOSED = "question.closed";

/** The host's error for a hook call it no longer holds. */
const HOOK_GONE = "hook.unknown";

/** `engine.notice` code when a decision could not reach the worker host. */
export const REPLY_NOT_SENT = "run.hookReplyNotSent";

/** Whether the maintainer is at a client (0008 section 5). */
export interface Presence {
  /** True while at least one client is connected to the daemon (0006). */
  connected(): boolean;
  /** When a client's last command or read arrived, on the engine clock; null before any. */
  lastRequestAt(): number | null;
}

/** No client, ever: every request is denied at once. */
export const ABSENT: Presence = { connected: () => false, lastRequestAt: () => null };

export interface PermissionAsksDeps {
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  /** Sends host ops to a run's worker host. */
  readonly steering: RunSteering;
  /** The worker adapter's pure `encode`, which turns the neutral reply into host ops. */
  readonly encode: (op: SteerOp) => HostOp[];
  readonly presence: Presence;
  /** True while a decision on the run (a cap, a park, a stop) is being carried out. */
  readonly ending?: (run: string) => boolean;
  /** Resumes the run of a `needs-permission` park its question's answer lifts (DIPO-75). */
  readonly parks?: ParkResumer;
  /** False while the daemon schedules no work (`safe`, `draining`); true by default. */
  readonly scheduling?: () => boolean;
  /** Called after change-log entries were appended outside a command. */
  readonly onChanged?: (office: OfficeId) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

type PermissionRequest = Extract<HookEvent, { kind: "permissionRequest" }>;

/** True when the maintainer counts as present for `config` at `now` (0008 section 5). */
export function maintainerPresent(
  config: OfficeConfig | undefined,
  presence: Presence,
  now: number,
): boolean {
  if (config === undefined || config.permissions.ask !== "when-present") return false;
  if (!presence.connected()) return false;
  const last = presence.lastRequestAt();
  return last !== null && now - last <= config.permissions.presentMinutes * 60_000;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PermissionAsks {
  readonly #deps: PermissionAsksDeps;
  /** Open permission questions this engine waits on, with their timeout. */
  readonly #timers = new Map<string, ReturnType<Clock["setTimeout"]>>();
  readonly #inflight = new Set<Promise<unknown>>();

  constructor(deps: PermissionAsksDeps) {
    this.#deps = deps;
  }

  /** The events of one committed ingestion pass of `office`'s run `run` (`OfficeIngest`). */
  onWorkerEvents(
    office: OfficeHandle,
    run: string,
    agent: string,
    events: readonly WorkerEvent[],
  ): void {
    for (const event of events) {
      if (event.t === "hook" && event.hook.kind === "permissionRequest") {
        this.request(office, run as RunId, agent, event.hook);
      }
    }
  }

  /** The worker of `run` exited: its open questions stop waiting. */
  onEnded(office: OfficeHandle, run: string): void {
    // A park's question (DIPO-75) waits for the maintainer after its worker exited.
    const open = openQuestions(office, run).filter((question) => question.parkId === null);
    if (open.length === 0) return;
    this.#close(office, open, "ended");
  }

  /** Resolves once every reply this module started has been sent. */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled(this.#inflight);
  }

  /** Stops every timeout; open questions are closed as `expired` at the next office load. */
  close(): void {
    for (const timer of this.#timers.values()) this.#deps.clock.clearTimeout(timer);
    this.#timers.clear();
  }

  /** Asks the maintainer, or denies at once (see the file comment). */
  request(office: OfficeHandle, run: RunId, agent: string, hook: PermissionRequest): void {
    if (hook.id === null) return;
    const officeId = office.officeId;
    const config = this.#deps.offices.config(officeId);
    const now = this.#deps.clock.now();
    const work = workRefOf(office, run);
    if (work !== null && this.#deps.ending?.(run) !== true && this.#allowOnce(office, run, hook)) {
      return;
    }
    if (
      work === null ||
      this.#deps.ending?.(run) === true ||
      !maintainerPresent(config, this.#deps.presence, now)
    ) {
      this.#reply(office, run, { hook: hook.id, decision: null });
      return;
    }
    const questionId = this.#deps.ids.next("qst");
    const hookId = hook.id;
    const appended = office.immediate(() => {
      const question = insertPermissionQuestion(office, {
        questionId,
        runId: run,
        agentId: agent,
        tool: hook.tool,
        input: hook.input,
        hook: hookId,
        at: now,
      });
      const view = questionViewOf(office, question);
      const entries: NewEntry[] = [];
      if (view !== null) entries.push({ type: "question.asked", key: work.key, run, delta: view });
      const raised = raiseSignal(office, run, "input-wait", now);
      if (raised !== null) {
        entries.push({
          type: "work.observed",
          key: work.key,
          run,
          delta: { work, signal: "input-wait", since: new Date(now).toISOString() },
        });
      }
      const ready = withWorkViews(office, entries);
      appendEntries(office, ready, { at: now });
      return ready.length;
    });
    if (appended > 0) this.#deps.onChanged?.(officeId);
    const seconds = config?.timeouts.permissionWaitSeconds ?? 300;
    const timer = this.#deps.clock.setTimeout(() => {
      this.#timers.delete(questionId);
      this.#timeout(officeId, questionId, seconds);
    }, seconds * 1000);
    this.#timers.set(questionId, timer);
  }

  /** `work.answer { question, text, decision? }` on a permission question (0008 section 5). */
  async answer(
    ctx: AsyncCommandContext,
    args: {
      readonly question: string;
      readonly text: string;
      readonly decision?: "allow" | "deny" | undefined;
    },
  ): Promise<CommandOutcome<ParkAnswerResult>> {
    const office = ctx.office;
    const question = findQuestion(office, args.question);
    if (question === null || question.closedAt !== null) {
      throw new CommandError(QUESTION_CLOSED, `${args.question} is not waiting for an answer.`, {
        question: args.question,
      });
    }
    if (question.kind === "permission" && question.parkId !== null) {
      // The question of a `needs-permission` park (DIPO-75): the answer resumes the run.
      if (args.decision === undefined) throw decisionMissing();
      return answerParkQuestion(
        {
          now: () => this.#deps.clock.now(),
          ...(this.#deps.parks === undefined ? {} : { resumer: this.#deps.parks }),
          ...(this.#deps.scheduling === undefined ? {} : { scheduling: this.#deps.scheduling }),
          closing: (handle, closed, at, answer) => this.#closingEntries(handle, closed, at, answer),
        },
        ctx,
        question,
        { text: args.text, decision: args.decision },
      );
    }
    if (question.kind !== "permission" || question.hook === null) {
      // Worker questions (`kind: question`) are asked by later stories; none is stored yet.
      throw new CommandError(
        QUESTION_CLOSED,
        `${args.question} is not a permission question this engine can answer.`,
        { question: args.question },
      );
    }
    const decision = args.decision;
    if (decision === undefined) throw decisionMissing();
    // A story parked meanwhile resumes only through its park's question (DIPO-75, AC #4).
    const parked = parkedElsewhere(office, question);
    if (parked !== null) throw parked;
    let closed = false;
    const now = this.#deps.clock.now();
    ctx.commit(() => {
      closed = closeQuestion(office, question.questionId, "answered", now, {
        text: args.text,
        decision,
        delivered: "now",
      });
      return closed
        ? this.#closingEntries(office, question, now, answerOf(decision, args.text))
        : [];
    });
    if (!closed) {
      throw new CommandError(QUESTION_CLOSED, `${args.question} is not waiting for an answer.`, {
        question: args.question,
      });
    }
    this.#clearTimer(question.questionId);
    const reason = args.text.trim();
    await this.#send(office, question.runId as RunId, {
      hook: question.hook,
      decision,
      ...(decision === "deny" && reason !== "" ? { reason } : {}),
    });
    return { result: { question: question.questionId, delivered: "now" } };
  }

  /** The command `work.answer`. */
  get feature(): FeatureModule {
    return {
      name: "permission-asks",
      register: (registry) => {
        registry.addAsyncOfficeCommand({
          definition: workAnswer,
          handle: (ctx, args) => this.answer(ctx, args),
        });
        // Questions a previous daemon left open: their hook calls were answered by the host.
        registry.registerLoadStep("expire open permission questions", (ctx) => {
          const stale = openQuestions(ctx.office).filter(
            (question) =>
              question.kind === "permission" &&
              question.parkId === null &&
              !this.#timers.has(question.questionId),
          );
          // A park's question whose park ended while no engine listened (DIPO-75).
          stale.push(...staleParkQuestions(ctx.office));
          if (stale.length > 0) this.#close(ctx.office, stale, "expired");
        });
      },
    };
  }

  /**
   * Allow once (DIPO-75, 0008 section 5): a request whose tool and exact command or path equal
   * those of an answered `allow` of the run's park question, not used yet, is allowed at once and
   * the allow is spent. True when it was.
   */
  #allowOnce(office: OfficeHandle, run: RunId, hook: PermissionRequest): boolean {
    if (hook.id === null || hook.exact === undefined) return false;
    const exact = hook.exact;
    const now = this.#deps.clock.now();
    const taken = office.immediate(() => takeAllowOnce(office, run, hook.tool, exact, now));
    if (taken === null) return false;
    this.#reply(office, run, { hook: hook.id, decision: "allow" });
    return true;
  }

  #timeout(officeId: OfficeId, questionId: string, seconds: number): void {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) return;
    let question: StoredQuestion | null;
    try {
      question = findQuestion(office, questionId);
    } catch (error) {
      // Without the question its hook is unknown; the host gives no decision when its wait ends.
      this.#deps.warn?.("reading a timed-out permission question failed", {
        question: questionId,
        ...failureFields(error),
      });
      return;
    }
    if (question === null || question.closedAt !== null || question.hook === null) return;
    try {
      this.#close(office, [question], "timeout");
    } catch (error) {
      this.#deps.warn?.("closing a timed-out permission question failed", {
        question: questionId,
        run: question.runId,
        ...failureFields(error),
      });
    }
    this.#reply(
      office,
      question.runId as RunId,
      {
        hook: question.hook,
        decision: "deny",
        reason: `The maintainer did not answer within ${seconds} s.`,
      },
      true,
    );
  }

  /** Closes `questions` as `how` in one transaction, with their entries. */
  #close(office: OfficeHandle, questions: readonly StoredQuestion[], how: QuestionClose): void {
    const now = this.#deps.clock.now();
    const appended = office.immediate(() => {
      const entries: NewEntry[] = [];
      for (const question of questions) {
        this.#clearTimer(question.questionId);
        if (!closeQuestion(office, question.questionId, how, now)) continue;
        entries.push(...this.#closingEntries(office, question, now));
      }
      const ready = withWorkViews(office, entries);
      appendEntries(office, ready, { at: now });
      return ready.length;
    });
    if (appended > 0) this.#deps.onChanged?.(office.officeId);
  }

  /**
   * `question.closed`, and `work.observed input-wait` cleared once no permission question of the
   * run waits any more. Runs inside the caller's transaction, after the question was closed.
   */
  #closingEntries(
    office: OfficeHandle,
    question: StoredQuestion,
    at: number,
    answer?: string,
  ): NewEntry[] {
    const run = question.runId as RunId;
    const work = workRefOf(office, run);
    const entries: NewEntry[] = [
      {
        type: "question.closed",
        ...(work === null ? {} : { key: work.key }),
        run,
        delta: { question: question.questionId, ...(answer === undefined ? {} : { answer }) },
      },
    ];
    const waiting = openQuestions(office, run).some(
      (open) => open.kind === "permission" && open.hook !== null,
    );
    if (waiting || !activeSignals(office, run).some((s) => s.signal === "input-wait")) {
      return entries;
    }
    for (const cleared of clearSignals(office, run, ["input-wait"], at)) {
      if (work === null) continue;
      entries.push({
        type: "work.observed",
        key: work.key,
        run,
        delta: {
          work,
          signal: cleared.signal,
          since: new Date(cleared.since).toISOString(),
          clearedAt: new Date(at).toISOString(),
        },
      });
    }
    return entries;
  }

  #clearTimer(questionId: string): void {
    const timer = this.#timers.get(questionId);
    if (timer === undefined) return;
    this.#deps.clock.clearTimeout(timer);
    this.#timers.delete(questionId);
  }

  /**
   * Sends a reply without waiting for it. The notice of a reply that did not arrive is written in
   * the job too; a failure there is logged, never an unhandled rejection (DIPO-110).
   */
  #reply(office: OfficeHandle, run: RunId, reply: HookReply, timedOut = false): void {
    background(() => this.#send(office, run, reply, timedOut), {
      failed: "sending a permission decision failed",
      fields: { run, hook: reply.hook },
      log: this.#deps.warn,
      inflight: this.#inflight,
    });
  }

  /** Sends a reply to the run's worker host; a failure puts a notice on the office. */
  async #send(office: OfficeHandle, run: RunId, reply: HookReply, timedOut = false): Promise<void> {
    let error: string | null = null;
    let code: string | undefined;
    try {
      const sent = await this.#deps.steering.send(
        office,
        run,
        this.#deps.encode({ kind: "hookReply", reply }),
      );
      if (!sent.ok) {
        error = sent.reason;
        code = sent.code;
      }
    } catch (thrown) {
      error = messageOf(thrown);
    }
    if (error === null) return;
    // A timeout reply the host no longer holds a call for: the call was answered already (the
    // worker exited, or the host gave up), so there is nothing to report.
    if (timedOut && code === HOOK_GONE) return;
    this.#deps.warn?.("a permission decision did not reach the worker host", {
      run,
      hook: reply.hook,
      reason: error,
    });
    // No decision is the default the host gives anyway; only a maintainer's answer is worth a
    // notice.
    if (reply.decision === null) return;
    const at = this.#deps.clock.now();
    const work = workRefOf(office, run);
    office.immediate(() =>
      appendEntries(
        office,
        [
          {
            type: "engine.notice",
            ...(work === null ? {} : { key: work.key }),
            run,
            delta: {
              level: "warn",
              code: REPLY_NOT_SENT,
              text: `${work?.story ?? run}: dipo could not send the ${decisionWord(reply.decision)} to its worker (${error}); the worker's call was denied.`,
            },
          },
        ],
        { at },
      ),
    );
    this.#deps.onChanged?.(office.officeId);
  }
}

/** `args.invalid` for a permission answer without `decision` (DIPO-59, and DIPO-75 AC #7). */
function decisionMissing(): CommandError {
  return new CommandError("args.invalid", "A permission question needs decision allow or deny.", {
    field: "decision",
  });
}

function decisionWord(decision: PermissionDecision): string {
  return decision === "allow" ? "allow" : "deny";
}

/** The answer `question.closed` carries: the decision, and the maintainer's text after it. */
export function answerOf(decision: "allow" | "deny", text: string): string {
  const reason = text.trim();
  return reason === "" ? decision : `${decision}: ${reason}`;
}
