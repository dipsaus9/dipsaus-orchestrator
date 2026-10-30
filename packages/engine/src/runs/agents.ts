// The one writer of `agents` (0001, 0007): every insert and update of an agent row goes through
// this module, and `test/run/one-writer.test.ts` fails on one anywhere else. Each function runs
// inside the caller's transaction.
//
// `endAgent` is the one end of an agent: its usage made final, the agent row ended, its ingestion
// cursors ended and its worker host row ended, in that order, inside one transaction.

import type { OfficeHandle } from "../db/office";
import { finalizeAgentUsage } from "../ingest/usage";

import { ofNoOpenRun } from "../run/retired";

import { endHostRow } from "./worker-hosts";

/** An agent row as a session start records it. */
export interface NewAgent {
  readonly agentId: string;
  readonly runId: string;
  readonly role: string;
  readonly model: string;
  readonly startedAt: number;
  readonly effort?: string | null;
  readonly sessionId?: string | null;
  /** The L1+L2 hash a resume compares (DIPO-51). */
  readonly systemHash?: string | null;
}

/**
 * Records the agent of a session. `ifNew` keeps a row that is already there (a restart that
 * records the same agent again); without it, a second row for the agent throws.
 */
export function recordAgent(office: OfficeHandle, agent: NewAgent, ifNew = true): void {
  office.run(
    ifNew
      ? `insert or ignore into agents (office_id, agent_id, run_id, role, model, effort,
           session_id, system_hash, started_at)
         values ($office_id, $agent, $run, $role, $model, $effort, $session, $hash, $at)`
      : `insert into agents (office_id, agent_id, run_id, role, model, effort, session_id,
           system_hash, started_at)
         values ($office_id, $agent, $run, $role, $model, $effort, $session, $hash, $at)`,
    {
      agent: agent.agentId,
      run: agent.runId,
      role: agent.role,
      model: agent.model,
      effort: agent.effort ?? null,
      session: agent.sessionId ?? null,
      hash: agent.systemHash ?? null,
      at: agent.startedAt,
    },
  );
}

/** The session's own report of its start: the model, session id and adapter version. */
export function recordAgentStart(
  office: OfficeHandle,
  agentId: string,
  start: { readonly model: string; readonly sessionId: string; readonly version: string | null },
): void {
  office.run(
    `update agents set model = $model, session_id = $session, adapter_version = $version
     where office_id = $office_id and agent_id = $agent`,
    { model: start.model, session: start.sessionId, version: start.version, agent: agentId },
  );
}

/** The first reason the session's start was rejected, kept once. */
export function recordInitRejected(office: OfficeHandle, agentId: string, reason: string): void {
  office.run(
    `update agents set init_rejected = coalesce(init_rejected, $reason)
     where office_id = $office_id and agent_id = $agent`,
    { reason, agent: agentId },
  );
}

/** How an agent ends (`endAgent`). */
export interface AgentEnd {
  readonly runId: string;
  readonly agentId: string;
  readonly at: number;
  /** The end reason, unless the agent has one already. */
  readonly reason: string;
  /** Makes the agent's usage final first (`finalizeAgentUsage`). */
  readonly finalizeUsage: boolean;
  /** Ends the agent's worker host row too. */
  readonly endHost: boolean;
}

/**
 * The one end of an agent (DIPO-364): its usage final when `finalizeUsage`, the agent ended at
 * `at` with `reason` (an end time or reason it has stays), every ingestion cursor of the agent
 * ended (its `host-events` cursor, so retention ages it out), and its
 * worker host row ended when `endHost`. Inside the caller's transaction.
 */
export function endAgent(office: OfficeHandle, end: AgentEnd): void {
  const { runId, agentId, at } = end;
  if (end.finalizeUsage) finalizeAgentUsage(office, runId, agentId, at);
  office.run(
    `update agents set ended_at = coalesce(ended_at, $at),
       end_reason = coalesce(end_reason, $reason)
     where office_id = $office_id and agent_id = $agent`,
    { at, agent: agentId, reason: end.reason },
  );
  office.run(
    `update ingest_cursors set ended_at = coalesce(ended_at, $at)
      where office_id = $office_id and run_id = $run and agent_id = $agent`,
    { at, run: runId, agent: agentId },
  );
  if (end.endHost) endHostRow(office, runId, agentId, at);
}

/**
 * The reason an agent ended, as decided after its exit: it replaces the ingestor's `exited` or
 * none, never a reason decided before.
 */
export function decideEndReason(office: OfficeHandle, agentId: string, reason: string): void {
  office.run(
    `update agents set end_reason = $reason
      where office_id = $office_id and agent_id = $agent
        and (end_reason is null or end_reason = 'exited')`,
    { reason, agent: agentId },
  );
}

/**
 * The reason every agent of the run that has not ended yet will end for, known before its exit is
 * ingested (a park or a stop); a reason an agent has stays.
 */
export function presetEndReasons(office: OfficeHandle, runId: string, reason: string): void {
  office.run(
    `update agents set end_reason = coalesce(end_reason, $reason)
     where office_id = $office_id and run_id = $run and ended_at is null`,
    { reason, run: runId },
  );
}

/**
 * A reviewer session that crashed (0002): the agent ends at `at` unless it ended before, and its
 * end reason becomes `reason` whatever it was, so the crashes of a round are counted.
 */
export function recordCrashedEnd(
  office: OfficeHandle,
  agentId: string,
  at: number,
  reason: string,
): void {
  office.run(
    `update agents set ended_at = coalesce(ended_at, $at), end_reason = $reason
      where office_id = $office_id and agent_id = $agent`,
    { at, agent: agentId, reason },
  );
}

/**
 * Retention (0007): deletes at most `limit` agents that ended before `cutoff` and whose run may not
 * reopen (`ofNoOpenRun`), inside the caller's transaction; returns how many it deleted.
 */
export function deleteRetiredAgents(office: OfficeHandle, cutoff: number, limit: number): number {
  return office.run(
    `delete from agents where rowid in (select rowid from agents
       where office_id = $office_id and ended_at < $cutoff and ${ofNoOpenRun("agents")}
       limit $limit)`,
    { cutoff, limit },
  ).changes;
}
