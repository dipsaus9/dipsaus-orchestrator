// Shared setup for the ingestion tests: a migrated database on the manual clock, one office, a
// recorded worker host whose event file the test writes line by line, and readers for the facts
// and change-log entries ingestion stores.

import { appendFileSync } from "node:fs";
import { join } from "node:path";

import {
  AgentId,
  RunId,
  StoryKey,
  type WorkRef,
  type OfficeId,
} from "@dipsaus-orchestrator/contract";
import { type Recording, stdoutText } from "@dipsaus-orchestrator/testkit";

import { Renderer } from "../../src/changelog/render";
import type { StoredEntry } from "../../src/changelog/log";
import type { OfficeHandle } from "../../src/db/office";
import { recordWorkerHost } from "../../src/runs/worker-hosts";
import type { HostLine, ParseState } from "../../src/workers/types";
import type { IngestAdapter, IngestTarget } from "../../src/ingest/ingestor";
import { addOffice, openTestState, type TestState } from "../commands/helpers";

export interface IngestFixture {
  readonly t: TestState;
  readonly office: OfficeHandle;
  readonly eventFile: string;
  readonly run: RunId;
  readonly agent: AgentId;
  readonly work: WorkRef;
}

export async function ingestFixture(dir: string): Promise<IngestFixture> {
  const t = await openTestState(dir);
  const office = addOffice(t);
  const run = RunId.parse(t.ids.next("run"));
  const agent = AgentId.parse(t.ids.next("agt"));
  const key = StoryKey.parse(t.ids.next("sto"));
  const eventFile = join(dir, "events.ndjson");
  recordWorkerHost(
    office,
    {
      pid: 4242,
      startTimeMs: 0,
      runId: run,
      agentId: agent,
      socketPath: join(dir, "host.sock"),
      protocolVersion: 1,
      runDir: dir,
      eventFile,
    },
    t.clock,
  );
  const work = {
    story: "DIPO-1",
    key,
    run,
    agent,
    role: "developer",
    tier: "M",
    model: "haiku",
  } as WorkRef;
  return { t, office, eventFile, run, agent, work };
}

export function target(
  f: IngestFixture,
  adapter: IngestAdapter,
  initialState: ParseState,
  options: { readonly work?: boolean; readonly budgetLimit?: number } = {},
): IngestTarget {
  return {
    run: f.run,
    agent: f.agent,
    role: "developer",
    tier: "M",
    model: "haiku",
    budgetLimit: options.budgetLimit ?? 400_000,
    ...(options.work === false ? {} : { work: f.work }),
    adapter,
    initialState,
  };
}

/** Appends host lines as the worker host writes them. */
export function appendLines(path: string, lines: readonly HostLine[]): void {
  if (lines.length === 0) return;
  appendFileSync(
    path,
    lines
      .map((line) => `${JSON.stringify({ t: line.t, ch: line.ch, data: line.data })}\n`)
      .join(""),
    { mode: 0o600 },
  );
}

/** A recording's lines as the worker host would have written them to `events.ndjson`. */
export function hostLines(recording: Recording): HostLine[] {
  return recording.lines.map((line) => ({
    t: line.t,
    ch: line.ch,
    data: line.ch === "stdout" ? stdoutText(line.data) : JSON.stringify(line.data),
  }));
}

/** The whole event file text of a recording. */
export function eventFileText(recording: Recording): string {
  return hostLines(recording)
    .map((line) => `${JSON.stringify(line)}\n`)
    .join("");
}

/** Stored change-log entries, rendered through the contract so every shape is checked. */
export function loggedEvents(office: OfficeHandle): { type: string; data: unknown }[] {
  const rows = office.all<{
    seq: number;
    at: number;
    type: string;
    delta: string;
    view: string | null;
  }>("select seq, at, type, delta, view from change_log where office_id = $office_id order by seq");
  const renderer = new Renderer();
  return rows.map((row) => {
    const entry: StoredEntry = {
      seq: row.seq,
      at: row.at,
      type: row.type,
      delta: JSON.parse(row.delta) as unknown,
      ...(row.view === null ? {} : { view: JSON.parse(row.view) as unknown }),
    };
    const event = renderer.render(office.officeId as OfficeId, entry);
    return { type: event.type, data: event.data };
  });
}

export function typesOf(office: OfficeHandle): string[] {
  return loggedEvents(office).map((event) => event.type);
}

export interface TotalsRow {
  model: string;
  input: number;
  output: number;
  cache_create: number;
  cache_read: number;
  turns: number;
  budget_used: number;
  final: number;
}

export function totalsOf(office: OfficeHandle, run: string): TotalsRow[] {
  return office.all<TotalsRow>(
    `select model, input, output, cache_create, cache_read, turns, budget_used, final
     from usage_totals where office_id = $office_id and run_id = $run order by model`,
    { run },
  );
}

export function storedOutput(office: OfficeHandle, run: string): string {
  return office
    .all<{ text: string }>(
      `select text from output_chunks where office_id = $office_id and run_id = $run
       order by from_offset`,
      { run },
    )
    .map((row) => row.text)
    .join("");
}
