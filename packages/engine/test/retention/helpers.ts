// Rows for the retention tests: agents with usage, worker hosts with run directories, journal
// entries and requests, each at a chosen time.

import { OfficeHandle } from "../../src/db/office";
import type { RunResult, SqlParams } from "../../src/platform/sqlite";

/** An office handle that records the rows each delete statement removed. */
export class DeleteRecorder extends OfficeHandle {
  readonly batches: number[] = [];

  override run(sql: string, params?: SqlParams): RunResult {
    const result = super.run(sql, params);
    if (/^\s*delete\b/i.test(sql)) this.batches.push(result.changes);
    return result;
  }
}

export function insertRequest(office: OfficeHandle, id: string, at: number): void {
  office.immediate(() =>
    office.run(
      `insert into requests (office_id, request_id, command, args_hash, reply, at)
       values ($office_id, $id, 'work.run', 'hash', '{}', $at)`,
      { id, at },
    ),
  );
}

export function insertRequests(office: OfficeHandle, count: number, at: number): void {
  office.immediate(() => {
    for (let i = 0; i < count; i++) {
      office.run(
        `insert into requests (office_id, request_id, command, args_hash, reply, at)
         values ($office_id, $id, 'work.run', 'hash', '{}', $at)`,
        { id: `req-${at}-${i}`, at },
      );
    }
  });
}

export interface AgentRows {
  readonly run: string;
  readonly agent: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

/** An agent with one usage message, its totals, an ingest cursor and stored output. */
export function insertAgent(office: OfficeHandle, rows: AgentRows): void {
  const { run, agent, startedAt, endedAt } = rows;
  office.immediate(() => {
    office.run(
      `insert into agents (office_id, agent_id, run_id, role, model, started_at, ended_at)
       values ($office_id, $agent, $run, 'developer', 'sonnet', $started, $ended)`,
      { agent, run, started: startedAt, ended: endedAt },
    );
    office.run(
      `insert into usage_messages (office_id, agent_id, message_id, run_id, model, input, output,
         cache_create, cache_create_5m, cache_create_1h, cache_read, at)
       values ($office_id, $agent, $message, $run, 'sonnet', 10, 20, 0, 0, 0, 0, $at)`,
      { agent, message: `msg-${agent}`, run, at: startedAt },
    );
    office.run(
      `insert into usage_totals (office_id, run_id, agent_id, model, role, tier, final, updated_at)
       values ($office_id, $run, $agent, 'sonnet', 'developer', 'M', 1, $at)`,
      { agent, run, at: endedAt ?? startedAt },
    );
    office.run(
      `insert into ingest_cursors (office_id, run_id, agent_id, source_kind, path, parse_state,
         ended_at, updated_at)
       values ($office_id, $run, $agent, 'host-events', '/x/events.ndjson', '{}', $ended, $at)`,
      { agent, run, ended: endedAt, at: startedAt },
    );
    office.run(
      `insert into output_chunks (office_id, run_id, source, from_offset, to_offset, agent_id, text, at)
       values ($office_id, $run, 'worker', 0, 5, $agent, 'hello', $at)`,
      { agent, run, at: startedAt },
    );
  });
}

export interface HostRows {
  readonly run: string;
  readonly agent: string;
  readonly runDir: string;
  readonly processed: number;
  readonly final: number | null;
  readonly endedAt: number | null;
}

export function insertHost(office: OfficeHandle, rows: HostRows): void {
  office.immediate(() =>
    office.run(
      `insert into worker_hosts (office_id, run_id, agent_id, pid, start_time_ms, socket_path,
         protocol_version, run_dir, event_file, processed_offset, final_offset, ended_at, started_at)
       values ($office_id, $run, $agent, 4242, 1, '/run/host.sock', 1, $dir, $events,
         $processed, $final, $ended, 1)`,
      {
        run: rows.run,
        agent: rows.agent,
        dir: rows.runDir,
        events: `${rows.runDir}/events.ndjson`,
        processed: rows.processed,
        final: rows.final,
        ended: rows.endedAt,
      },
    ),
  );
}

export function insertJournal(
  office: OfficeHandle,
  op: number,
  state: string,
  closedAt: number | null,
): void {
  office.immediate(() =>
    office.run(
      `insert into backlog_journal (office_id, op_id, subject, op_kind, target, state, created_at,
         updated_at, closed_at)
       values ($office_id, $op, 'DIPO-1', 'edit', '{}', $state, 0, 0, $closed)`,
      { op, state, closed: closedAt },
    ),
  );
}
