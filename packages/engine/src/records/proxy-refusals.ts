// The model proxy's refusals (0008, DIPO-484): the proxy writes one row for each 429 it sends when
// a run's token cap is reached, against the run its peer address names, and a run's ending reads
// the rows. A 429 the worker meets while a refusal is recorded for its run is that cap, not the
// plan's limit; the worker's stream never decides it. Writers run inside the caller's
// `office.immediate`.

import type { RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";

/** Records one refusal of `run` with its reason. */
export function recordProxyRefusal(
  office: OfficeHandle,
  run: RunId,
  reason: string,
  at: number,
): void {
  const next = office.get<{ next: number }>(
    `select coalesce(max(refusal), 0) + 1 as next from proxy_refusals
      where office_id = $office_id and run_id = $run`,
    { run },
  );
  office.run(
    `insert into proxy_refusals (office_id, run_id, refusal, reason, at)
     values ($office_id, $run, $refusal, $reason, $at)`,
    { run, refusal: next?.next ?? 1, reason, at },
  );
}

/**
 * The reason of the newest refusal of `run` recorded at or after `since` (the session's start) and
 * not after `now`; null when there is none. A refusal recorded for another run, in an earlier
 * session or after the ending was decided is never one this returns.
 */
export function readProxyRefusal(
  office: OfficeHandle,
  run: RunId,
  since: number,
  now: number,
): string | null {
  const row = office.get<{ reason: string }>(
    `select reason from proxy_refusals
      where office_id = $office_id and run_id = $run and at >= $since and at <= $now
      order by refusal desc limit 1`,
    { run, since, now },
  );
  return row?.reason ?? null;
}

/**
 * The reason the model proxy's refusal gives a 429 that `agent`'s session of `run` met, or null
 * when the proxy recorded none in the session: that 429 is then the plan's limit (DIPO-484).
 */
export function proxyRefusalOf(
  office: OfficeHandle,
  run: RunId,
  agent: string,
  now: number,
): string | null {
  const started = office.get<{ started_at: number }>(
    "select started_at from agents where office_id = $office_id and agent_id = $agent and run_id = $run",
    { agent, run },
  );
  return started === null ? null : readProxyRefusal(office, run, started.started_at, now);
}
