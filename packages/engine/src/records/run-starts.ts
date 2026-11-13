// The starts `work.run` decided whose run row is not in yet (DIPO-456, migration 5). Every function
// runs inside the caller's transaction.

import type { OfficeHandle } from "../db/office";

/** A decided start: who will work on it, from the decision until its run row. */
export interface RunStart {
  readonly runId: string;
  readonly key: string;
  readonly story: string;
  readonly agent: string;
  readonly tier: string;
  /** The role it runs as, from the story's role label (DIPO-477, migration 14). */
  readonly role: string;
  readonly model: string;
  readonly loopCap: number;
  readonly startedAt: number;
}

interface RunStartRow {
  run_id: string;
  key: string;
  story_id: string;
  agent_id: string;
  tier: string;
  role: string;
  model: string;
  loop_cap: number;
  started_at: number;
}

const SELECT = `select run_id, key, story_id, agent_id, tier, role, model, loop_cap, started_at
  from run_starts where office_id = $office_id`;

function startOf(row: RunStartRow): RunStart {
  return {
    runId: row.run_id,
    key: row.key,
    story: row.story_id,
    agent: row.agent_id,
    tier: row.tier,
    role: row.role,
    model: row.model,
    loopCap: row.loop_cap,
    startedAt: row.started_at,
  };
}

export function insertRunStart(office: OfficeHandle, start: RunStart): void {
  office.run(
    `insert into run_starts (office_id, run_id, key, story_id, agent_id, tier, role, model,
       loop_cap, started_at)
     values ($office_id, $run, $key, $story, $agent, $tier, $role, $model, $loop_cap, $at)`,
    {
      run: start.runId,
      key: start.key,
      story: start.story,
      agent: start.agent,
      tier: start.tier,
      role: start.role,
      model: start.model,
      loop_cap: start.loopCap,
      at: start.startedAt,
    },
  );
}

/** Removes the start of `runId`; true when it was there. */
export function deleteRunStart(office: OfficeHandle, runId: string): boolean {
  return (
    office.run("delete from run_starts where office_id = $office_id and run_id = $run", {
      run: runId,
    }).changes > 0
  );
}

/** The office's decided starts, oldest first. */
export function runStarts(office: OfficeHandle): RunStart[] {
  return office.all<RunStartRow>(`${SELECT} order by started_at, run_id`).map(startOf);
}

/** The decided start of the story `key`, or null. */
export function runStartOf(office: OfficeHandle, key: string): RunStart | null {
  const row = office.get<RunStartRow>(`${SELECT} and key = $key`, { key });
  return row === null ? null : startOf(row);
}

/** The decided start of the run `runId`, or null. */
export function runStartOfRun(office: OfficeHandle, runId: string): RunStart | null {
  const row = office.get<RunStartRow>(`${SELECT} and run_id = $run`, { run: runId });
  return row === null ? null : startOf(row);
}

/** Removes every start of the office: none survives a daemon restart. Returns how many went. */
export function clearRunStarts(office: OfficeHandle): number {
  return office.run("delete from run_starts where office_id = $office_id").changes;
}
