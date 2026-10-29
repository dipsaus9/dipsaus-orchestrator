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

/** A claim of `run`; live while `releasedAt` is null. */
export function insertClaim(office: OfficeHandle, run: string, releasedAt: number | null): void {
  office.immediate(() =>
    office.run(
      `insert into claims (office_id, run_id, key, story_id, branch, base, base_sha, start_sha,
         reused, claimed_at, released_at)
       values ($office_id, $run, $key, 'DIPO-1', $branch, 'main', 'a', 'a', 0, 0, $released)`,
      { run, key: `sto-${run}`, branch: `DIPO-1/${run}`, released: releasedAt },
    ),
  );
}

export function insertScan(office: OfficeHandle, scan: number, finishedAt: number): void {
  office.immediate(() =>
    office.run(
      `insert into scans (office_id, scan_id, trigger, started_at, finished_at, result)
       values ($office_id, $scan, 'start', $at, $at, 'failed')`,
      { scan, at: finishedAt },
    ),
  );
}

export function insertPromptPart(
  office: OfficeHandle,
  run: string,
  agent: string,
  at: number,
): void {
  office.immediate(() =>
    office.run(
      `insert into prompt_parts (office_id, run_id, agent_id, part, sha256, bytes, est_tokens,
         recorded_at)
       values ($office_id, $run, $agent, 'system', 'h', 10, 3, $at)`,
      { run, agent, at },
    ),
  );
}

export function insertReleasedBranch(
  office: OfficeHandle,
  branch: string,
  reclaimedAt: number | null,
): void {
  office.immediate(() =>
    office.run(
      `insert into released_branches (office_id, branch, released_at, key, reason, reclaimed_at)
       values ($office_id, $branch, 0, 'sto-1', 'parked', $reclaimed)`,
      { branch, reclaimed: reclaimedAt },
    ),
  );
}

/** A story PR of `run`: open while `closedAt` is null, otherwise `closedState` at that time. */
export function insertStoryPr(
  office: OfficeHandle,
  run: string,
  closedAt: number | null,
  closedState: "merged" | "closed" = "merged",
): void {
  office.immediate(() =>
    office.run(
      `insert into story_prs (office_id, run_id, key, pr_number, url, branch, base, head_sha, state,
         title, body_hash, opened_at, closed_at)
       values ($office_id, $run, $key, 1, 'https://example.test/pr/1', $branch, 'main', 'h',
         $state, 't', 'b', 0, $closed)`,
      {
        run,
        key: `sto-${run}`,
        branch: `DIPO-1/${run}`,
        state: closedAt === null ? "open" : closedState,
        closed: closedAt,
      },
    ),
  );
}

export function insertPricingCheck(office: OfficeHandle, run: string, raisedAt: number): void {
  office.immediate(() =>
    office.run(
      `insert into pricing_checks (office_id, run_id, est_cost_micros, cli_cost_micros, raised_at)
       values ($office_id, $run, 1, 2, $at)`,
      { run, at: raisedAt },
    ),
  );
}

/** A run profile with one row in each of its child tables. */
export function insertProfile(
  office: OfficeHandle,
  id: number,
  previous: number | null,
  current: boolean,
): void {
  office.immediate(() => {
    office.run(
      `insert into run_profiles (office_id, profile_id, scanned_at, commit_sha, fingerprint,
         toolchain, conformance, deviations, previous_profile_id, current)
       values ($office_id, $id, 0, 'a', 'f', '{}', 'conforming', '[]', $previous, $current)`,
      { id, previous, current: current ? 1 : 0 },
    );
    office.run(
      `insert into run_capabilities (office_id, profile_id, capability, status)
       values ($office_id, $id, 'verify', 'resolved')`,
      { id },
    );
    office.run(
      `insert into run_env_files (office_id, profile_id, path, present, ignored)
       values ($office_id, $id, '.env', 1, 1)`,
      { id },
    );

    office.run(
      `insert into run_extra_scripts (office_id, profile_id, name, command)
       values ($office_id, $id, 'lint', 'bun lint')`,
      { id },
    );
  });
}
