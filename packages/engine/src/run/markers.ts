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
// Clients know a marker by its flag, never by its text (DIPO-95): the marker's own `work.output`
// carries `markers`, and `work.outputRange` flags each marker in the range. In the store a marker
// is the worker-output chunk with no agent: ingestion stores every worker byte under its agent, so
// only the engine writes an agent-less worker chunk, and a worker that prints the same line gets
// no flag.
//
// Offsets stay exactly-once: in one transaction the marker first sends every agent's pending
// worker output, then stores itself after the run's last stored byte (with no agent), sends its own
// `work.output`, and moves every agent's emitted mark past itself. Ingestion only ever sends an
// agent's own chunks from that mark, so no byte is sent twice and none is skipped.

import { AgentId, type OutputMarker, type RunId } from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { byteLength } from "../ingest/output";
import { HOST_EVENTS_SOURCE, pendingWorkerOutput } from "../ingest/pending";
import { withWorkViews, workRefOf } from "../views/work";

import { appendRunStep, endRun } from "./records";

/** The prefix of an engine-written marker line in the worker output. */
export const MARKER_PREFIX = "[dipo]";

/** The marker line: `[dipo] <ISO time> phase verify` or `[dipo] <ISO time> ended in-review`. */
export function markerLine(kind: MarkerKind, value: string, at: number): string {
  return `${MARKER_PREFIX} ${new Date(at).toISOString()} ${kind} ${value}\n`;
}

type MarkerKind = "phase" | "ended";

const STORED_MARKER = /^\[dipo\] (\S+) (phase|ended) (\S.*)\n?$/;

/**
 * The flag of a stored agent-less worker chunk, read back from the line `markerLine` wrote for it
 * at `[from, to)`; null for text that is not such a line. Only ever called on chunks the engine
 * wrote (no agent), never on worker text.
 */
export function storedMarker(text: string, from: number, to: number): OutputMarker | null {
  const match = STORED_MARKER.exec(text);
  if (match === null) return null;
  const [, iso, kind, value] = match;
  const at = Date.parse(iso ?? "");
  if (Number.isNaN(at) || kind === undefined || value === undefined) return null;
  return { from, to, kind, value, at: new Date(at).toISOString() };
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
  return writeMarker(office, runId, "phase", phase, at);
}

/**
 * Ends the run (`endRun`, with the start of the review period it ends when given) and, when this
 * call ended it, writes the `ended <kind>` marker. Inside a transaction; its `work.output` entries
 * are appended at once. Returns what `endRun` returns.
 */
export function endRunMarked(
  office: OfficeHandle,
  runId: RunId,
  at: number,
  kind: string,
  reviewSince?: number,
): boolean {
  const ended = endRun(office, runId, at, kind, reviewSince);
  if (ended) {
    const entries = writeMarker(office, runId, "ended", kind, at);
    appendEntries(office, withWorkViews(office, entries), { at });
  }
  return ended;
}

/**
 * Stores the marker line with no agent; returns the pending output and the marker as `work.output`
 * entries, the marker's flagged in `markers`.
 */
function writeMarker(
  office: OfficeHandle,
  runId: RunId,
  kind: MarkerKind,
  value: string,
  at: number,
): NewEntry[] {
  const text = markerLine(kind, value, at);
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
      delta: {
        work,
        source: "worker",
        from,
        to,
        text,
        markers: [{ from, to, kind, value, at: new Date(at).toISOString() }],
      },
    });
  }
  return entries;
}
