// The budget nudge through a reviewer's hooks (0014 section 8, DIPO-60). A reviewer's tool use and
// session start arrive as neutral `toolUsed` and `sessionStarted` hook events with the id the worker
// host holds the call under (the hook waits for it, within 2 s). Code checks one fact and answers
// each call: once the run's budget tokens passed 80% of its budget limit, a tool use gets the
// `budget` nudge, at most once per session (the agents of a run that share a session id). Every
// other call, a session start included, is released at once with an empty reply, so the hook
// prints nothing. The text comes from `prompts/feedback/nudge-budget.md`, at most 300 characters.
// Each nudge sent is a row of `prompt_parts` (`nudge.budget`, its text measured, `nudges` counting
// the sends), so nudges are counted per run like any other prompt part.
//
// The developer's nudges (an out-of-scope write, a stale context pack, an input changed on the base)
// and their `nudge_sources` are gone (DIPO-342): a developer runs in its box with no hooks, and a
// reviewer writes no file and never resumes. What stays answers the reviewer's waiting hook calls
// until its hooks go (DIPO-347).
//
// This module emits only the neutral `nudge` op; the adapter's `encode` decides what its CLI
// prints (0008 amendment of 2026-10-12). Every failure is silent: the hook then prints nothing.

import type { Clock, RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import { background } from "../platform/background";
import budgetTemplate from "../prompts/feedback/nudge-budget.md" with { type: "text" };
import { measurePart } from "../prompts/parts";
import { renderTemplate } from "../prompts/templates";
import type { RunSteering } from "../run/control";
import { runCaps, runTotals } from "../run/caps";
import { findRun } from "../run/records";
import type { HostOp, NudgeOp, SteerOp, WorkerEvent } from "../workers/types";

import type { HookEvent } from "./types";

/** The 0014 section 8 nudge templates, one per trigger. */
export const NUDGE_TEMPLATES = {
  budget: budgetTemplate,
} as const;

export type NudgeTrigger = keyof typeof NUDGE_TEMPLATES;

/** One fact that makes a nudge relevant. */
export type NudgeFact = { readonly trigger: "budget" };

/** The longest nudge, in characters (0014 section 4). */
export const NUDGE_MAX_CHARS = 300;
/** The share of the run's budget tokens past which the budget nudge fires (0014 section 8). */
export const BUDGET_NUDGE_SHARE = 0.8;

/** `prompt_parts` name prefix of a nudge row. */
export const NUDGE_PART = "nudge.";

// ---- pure rules ----------------------------------------------------------------------------------

/** The fact's signature, also its `prompt_parts` name: the same fact is nudged once per session. */
export function nudgeSignature(fact: NudgeFact): string {
  return `${NUDGE_PART}${fact.trigger}`;
}

/** Cuts `text` to `max` characters, ending in an ellipsis when it was cut. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The nudge text of one fact, at most `NUDGE_MAX_CHARS` characters. */
export function nudgeText(fact: NudgeFact): string {
  return clip(renderTemplate(NUDGE_TEMPLATES[fact.trigger], {}), NUDGE_MAX_CHARS);
}

export interface ComposedNudge {
  /** The reply's text, at most `NUDGE_MAX_CHARS` characters; empty when no fact is given. */
  readonly text: string;
  /** The facts the text holds, in order; the others wait for a later call. */
  readonly facts: readonly NudgeFact[];
}

/** Pure: the texts of `facts`, in order, as many as fit in `NUDGE_MAX_CHARS`, one space apart. */
export function composeNudge(facts: readonly NudgeFact[]): ComposedNudge {
  const kept: NudgeFact[] = [];
  let text = "";
  for (const fact of facts) {
    const next = nudgeText(fact);
    const joined = text === "" ? next : `${text} ${next}`;
    if (joined.length > NUDGE_MAX_CHARS) continue;
    text = joined;
    kept.push(fact);
  }
  return { text, facts: kept };
}

/** Pure: the budget fact when `used` budget tokens passed 80% of `limit`; null otherwise. */
export function budgetFact(used: number, limit: number): NudgeFact | null {
  return limit > 0 && used >= limit * BUDGET_NUDGE_SHARE ? { trigger: "budget" } : null;
}

// ---- stored facts --------------------------------------------------------------------------------

function insertPart(
  office: OfficeHandle,
  run: string,
  agent: string,
  part: ReturnType<typeof measurePart>,
  nudges: number,
  at: number,
): void {
  office.run(
    `insert into prompt_parts (office_id, run_id, agent_id, part, sha256, bytes, est_tokens,
       nudges, recorded_at)
     values ($office_id, $run, $agent, $part, $sha, $bytes, $tokens, $nudges, $at)
     on conflict (office_id, run_id, agent_id, part) do update set
       nudges = prompt_parts.nudges + excluded.nudges, recorded_at = excluded.recorded_at`,
    {
      run,
      agent,
      part: part.name,
      sha: part.sha256,
      bytes: part.bytes,
      tokens: part.estTokens,
      nudges,
      at,
    },
  );
}

/** True when `signature` was nudged in `agent`'s session: by it or an agent with its session id. */
export function nudgedInSession(
  office: OfficeHandle,
  run: string,
  agent: string,
  signature: string,
): boolean {
  return (
    office.get<{ found: number }>(
      `select 1 as found from prompt_parts p
       where p.office_id = $office_id and p.run_id = $run and p.part = $part and p.nudges > 0
         and (p.agent_id = $agent or p.agent_id in (
           select a.agent_id from agents a join agents me
             on me.office_id = a.office_id and me.agent_id = $agent
           where a.office_id = $office_id and a.run_id = $run and a.session_id = me.session_id))
       limit 1`,
      { run, agent, part: signature },
    ) !== null
  );
}

/** The nudges sent in `run`, over all its agents (0014 section 8: counted per run). */
export function nudgeCount(office: OfficeHandle, run: string): number {
  return (
    office.get<{ count: number }>(
      `select coalesce(sum(nudges), 0) as count from prompt_parts
       where office_id = $office_id and run_id = $run
         and substr(part, 1, length($prefix)) = $prefix`,
      { run, prefix: NUDGE_PART },
    )?.count ?? 0
  );
}

// ---- the listener --------------------------------------------------------------------------------

export interface NudgesDeps {
  readonly clock: Clock;
  /** Sends host ops to a run's worker host. */
  readonly steering: RunSteering;
  /** The worker adapter's pure `encode`, which turns the neutral op into host ops. */
  readonly encode: (op: SteerOp) => HostOp[];
  /** True while a decision on the run (a cap, a park, a stop) is being carried out. */
  readonly ending?: (run: string) => boolean;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

type ToolUsed = Extract<HookEvent, { kind: "toolUsed" }>;
type SessionStarted = Extract<HookEvent, { kind: "sessionStarted" }>;

/** Answers tool-use and session-start hook calls with a nudge or an empty reply (file comment). */
export class Nudges {
  readonly #deps: NudgesDeps;
  /** Signatures being sent, per run, so one pass never sends the same fact twice. */
  readonly #pending = new Map<string, Set<string>>();
  readonly #inflight = new Set<Promise<unknown>>();

  constructor(deps: NudgesDeps) {
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
      if (event.t !== "hook" || !("id" in event.hook) || event.hook.id === null) continue;
      if (event.hook.kind === "toolUsed") this.#toolUsed(office, run, agent, event.hook);
      else if (event.hook.kind === "sessionStarted")
        this.#sessionStarted(office, run, agent, event.hook);
    }
  }

  /** The worker of `run` exited: nothing more is sent to it. */
  onEnded(_office: OfficeHandle, run: string): void {
    this.#pending.delete(run);
  }

  /** Resolves once every reply this module started has been sent. */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled(this.#inflight);
  }

  #toolUsed(office: OfficeHandle, run: string, agent: string, hook: ToolUsed): void {
    const call = hook.id ?? 0;
    const facts: NudgeFact[] = [];
    try {
      const stored = findRun(office, run as RunId);
      if (stored !== null && this.#deps.ending?.(run) !== true) {
        const now = this.#deps.clock.now();
        const budget = budgetFact(
          runTotals(office, stored.runId, stored.startedAt, now).budgetTokens,
          runCaps(office, stored).budgetTokens,
        );
        if (budget !== null) facts.push(budget);
      }
    } catch (error) {
      this.#warn("the nudge facts could not be read", run, error);
      facts.length = 0;
    }
    this.#track(run, () => this.#reply(office, run, agent, call, "toolUsed", facts));
  }

  /** A session start gets no nudge: its call is released at once. */
  #sessionStarted(office: OfficeHandle, run: string, agent: string, hook: SessionStarted): void {
    const call = hook.id ?? 0;
    this.#track(run, () => this.#reply(office, run, agent, call, "sessionStarted", []));
  }

  /** Sends the nudge of the facts not yet nudged in the session, or an empty reply. */
  async #reply(
    office: OfficeHandle,
    run: string,
    agent: string,
    call: number,
    on: NudgeOp["on"],
    facts: readonly NudgeFact[],
  ): Promise<void> {
    const pending = this.#pending.get(run) ?? new Set<string>();
    this.#pending.set(run, pending);
    let fresh: NudgeFact[] = [];
    try {
      fresh = facts.filter((fact) => {
        const signature = nudgeSignature(fact);
        return !pending.has(signature) && !nudgedInSession(office, run, agent, signature);
      });
    } catch (error) {
      this.#warn("the sent nudges could not be read", run, error);
    }
    const nudge = composeNudge(fresh);
    const signatures = nudge.facts.map(nudgeSignature);
    for (const signature of signatures) pending.add(signature);
    try {
      const op: SteerOp =
        nudge.text === ""
          ? { kind: "hookReply", reply: { hook: call, decision: null } }
          : { kind: "nudge", text: nudge.text, hook: call, on };
      const sent = await this.#deps.steering.send(office, run as RunId, this.#deps.encode(op));
      if (sent.ok && nudge.facts.length > 0) this.#record(office, run, agent, nudge.facts);
    } catch (error) {
      this.#warn("a nudge did not reach the worker host", run, error);
    } finally {
      for (const signature of signatures) pending.delete(signature);
    }
  }

  /** Stores one sent nudge per fact (`prompt_parts`, `nudges` counting the sends). */
  #record(office: OfficeHandle, run: string, agent: string, facts: readonly NudgeFact[]): void {
    const at = this.#deps.clock.now();
    office.immediate(() => {
      for (const fact of facts) {
        insertPart(office, run, agent, measurePart(nudgeSignature(fact), nudgeText(fact)), 1, at);
      }
    });
  }

  /** Runs a reply without waiting for it; a failure is logged (DIPO-110). */
  #track(run: string, job: () => Promise<void>): void {
    background(job, {
      failed: "a nudge reply failed",
      fields: { run },
      log: this.#deps.warn,
      inflight: this.#inflight,
    });
  }

  #warn(message: string, run: string, error: unknown): void {
    this.#deps.warn?.(message, {
      run,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
