// Worker output that is stored but not yet sent as `work.output` (0005 section 6). Ingestion sends
// an agent's pending output after its debounce; a phase marker (DIPO-83) sends it first, in its own
// transaction, so the marker's byte range follows every range already sent and each byte of the
// run's worker output goes out exactly once, in order.

import type { WorkRef } from "@dipsaus-orchestrator/contract";

import type { NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";

/** The `ingest_cursors.source_kind` of a worker host's event file. */
export const HOST_EVENTS_SOURCE = "host-events";

/**
 * `work.output` for the output of `agent` not yet sent, and advances its emitted mark. Runs inside
 * the caller's transaction. A run with no story (`work` undefined) advances the mark and sends
 * nothing.
 */
export function pendingWorkerOutput(
  office: OfficeHandle,
  run: string,
  agent: string,
  work: WorkRef | undefined,
): NewEntry[] {
  const from =
    office.get<{ output_emitted_to: number }>(
      `select output_emitted_to from ingest_cursors
       where office_id = $office_id and run_id = $run and agent_id = $agent
         and source_kind = $kind`,
      { run, agent, kind: HOST_EVENTS_SOURCE },
    )?.output_emitted_to ?? 0;
  const chunks = office.all<{ from_offset: number; to_offset: number; text: string }>(
    `select from_offset, to_offset, text from output_chunks
     where office_id = $office_id and run_id = $run and source = 'worker'
       and agent_id = $agent and from_offset >= $from
     order by from_offset`,
    { run, agent, from },
  );
  const first = chunks[0];
  const last = chunks[chunks.length - 1];
  if (first === undefined || last === undefined) return [];
  office.run(
    `update ingest_cursors set output_emitted_to = $to
     where office_id = $office_id and run_id = $run and agent_id = $agent
       and source_kind = $kind`,
    { to: last.to_offset, run, agent, kind: HOST_EVENTS_SOURCE },
  );
  if (work === undefined) return [];
  return [
    {
      type: "work.output",
      key: work.key,
      run: work.run,
      delta: {
        work,
        source: "worker",
        from: first.from_offset,
        to: last.to_offset,
        text: chunks.map((chunk) => chunk.text).join(""),
      },
    },
  ];
}
