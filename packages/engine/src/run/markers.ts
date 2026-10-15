// Phase markers in the worker output (DIPO-83). Every phase a run enters (setup, build, verify,
// build again after a failed verify) and the run's end are stored as one engine-written line in
// the run's worker output, so a reader of the output, live or later, sees where each phase began:
//
//   [dipo] 2026-10-15T12:04:31.000Z phase verify
//   [dipo] 2026-10-15T12:09:02.000Z ended in-review
//
// The line is code-made from facts the engine already keeps (`run_steps`, `runs.end_kind`), so it
// holds nothing private. Clients render it (the TUI as `── 12:04:31 phase: verify ──`).
//
// Offsets stay exactly-once: in one transaction the marker first sends every agent's pending
// worker output, then stores itself after the run's last stored byte (with no agent), sends its own
// `work.output`, and moves every agent's emitted mark past itself. Ingestion only ever sends an
// agent's own chunks from that mark, so no byte is sent twice and none is skipped.

import { AgentId, type RunId } from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { byteLength } from "../ingest/output";
import { HOST_EVENTS_SOURCE, pendingWorkerOutput } from "../ingest/pending";
import { withWorkViews, workRefOf } from "../views/work";

import { appendRunStep, endRun } from "./records";

/** The prefix of an engine-written marker line in the worker output. */
export const MARKER_PREFIX = "[dipo]";

/** The marker line: `[dipo] <ISO time> phase verify` or `[dipo] <ISO time> ended in-review`. */
export function markerLine(kind: "phase" | "ended", value: string, at: number): string {
  return `${MARKER_PREFIX} ${new Date(at).toISOString()} ${kind} ${value}\n`;
}

/**
 * Records that the run entered `phase` (`run_steps`) and stores its marker. Inside a transaction.
 * Returns the `work.output` entries (pending output, then the marker) for the caller to append
 * right before its `work.phase`.
 */
export function markPhase(
  office: OfficeHandle,
  runId: RunId,
  phase: string,
  at: number,
): NewEntry[] {
  appendRunStep(office, runId, "phase", phase, at);
  return writeMarker(office, runId, markerLine("phase", phase, at), at);
}

/**
 * Ends the run (`endRun`) and, when this call ended it, writes the `ended <kind>` marker. Inside a
 * transaction; its `work.output` entries are appended at once. Returns what `endRun` returns.
 */
export function endRunMarked(
  office: OfficeHandle,
  runId: RunId,
  at: number,
  kind: string,
): boolean {
  const ended = endRun(office, runId, at, kind);
  if (ended) {
    const entries = writeMarker(office, runId, markerLine("ended", kind, at), at);
    appendEntries(office, withWorkViews(office, entries), { at });
  }
  return ended;
}

/** Stores the marker line; returns the pending output and the marker as `work.output` entries. */
function writeMarker(office: OfficeHandle, runId: RunId, text: string, at: number): NewEntry[] {
  const work = workRefOf(office, runId) ?? undefined;
  const agents = office.all<{ agent_id: string }>(
    `select agent_id from ingest_cursors
     where office_id = $office_id and run_id = $run and source_kind = $kind
     order by rowid`,
    { run: runId, kind: HOST_EVENTS_SOURCE },
  );
  // Output stored before the marker goes out first, so the ranges sent stay in order.
  const entries: NewEntry[] = agents.flatMap(({ agent_id }) =>
    pendingWorkerOutput(
      office,
      runId,
      agent_id,
      work === undefined ? undefined : { ...work, agent: AgentId.parse(agent_id) },
    ),
  );
  const from =
    office.get<{ end: number | null }>(
      `select max(to_offset) as end from output_chunks
       where office_id = $office_id and run_id = $run and source = 'worker'`,
      { run: runId },
    )?.end ?? 0;
  const to = from + byteLength(text);
  office.run(
    `insert into output_chunks (office_id, run_id, source, from_offset, to_offset, agent_id, text,
       at)
     values ($office_id, $run, 'worker', $from, $to, null, $text, $at)`,
    { run: runId, from, to, text, at },
  );
  office.run(
    `update ingest_cursors set output_emitted_to = $to
     where office_id = $office_id and run_id = $run and source_kind = $kind`,
    { to, run: runId, kind: HOST_EVENTS_SOURCE },
  );
  if (work !== undefined) {
    entries.push({
      type: "work.output",
      key: work.key,
      run: work.run,
      delta: { work, source: "worker", from, to, text },
    });
  }
  return entries;
}
