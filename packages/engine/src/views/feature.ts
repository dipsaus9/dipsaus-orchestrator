// The view reads (0005 sections 7 and 8, 0009 sections 2 and 4): `office.snapshot` and its alias
// `office.switch`, `story.detail` and `work.outputRange`. Each runs in one deferred read
// transaction (`reads/execute.ts`), so a snapshot's views and its cursor match: a client that
// subscribes after the cursor gets every later event once (0005 section 8).

import {
  AgentId,
  GateId,
  type OfficeSnapshot,
  officeSnapshot,
  officeSwitch,
  type OutputSource,
  RoleId,
  RunId,
  type RunRecord,
  type StoryKey,
  storyDetail,
  type Verdict,
  workOutputRange,
  workPrompt,
} from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import { headCursor } from "../changelog/log";
import type { FeatureModule, ReadContext } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import { openQuestionViews, storyQuestionViews } from "../questions/questions";
import { readUsage } from "../records/usage";
import { promptTextsOf } from "../prompts/parts";
import { reviewVerdictOfGate, reviewVerdictView } from "../review/store";
import { runCaps } from "../records/caps";
import { baseConflictOf } from "../run/conflicts";
import { storedDoneReport } from "../run/done-report";
import { storedMarker } from "../run/markers";
import { findRun } from "../records/run-records";
import { openTestViews } from "../run/test-records";

import { DESK_SOURCES, type DeskSources, registerDesk } from "./desk";
import { registerDigest } from "./digest";
import { activeStoryViews, storyView } from "./story";
import { openGateViews } from "./summary";
import { activeWorkViews, workView } from "./work";

/** `work.outputRange` returns at most this many bytes; the client asks again from `to`. */
export const OUTPUT_RANGE_MAX_BYTES = 1024 * 1024;

function officeOf(ctx: ReadContext): OfficeHandle {
  if (ctx.office === undefined) throw new Error("a view read runs with its office");
  return ctx.office;
}

/** The office's derived state and the cursor it matches, read in the caller's transaction. */
export function snapshot(office: OfficeHandle): OfficeSnapshot {
  return {
    cursor: headCursor(office),
    stories: activeStoryViews(office),
    work: activeWorkViews(office),
    gates: openGateViews(office),
    questions: openQuestionViews(office),
    // The open tests whose product runs (DIPO-309).
    tests: openTestViews(office),
  };
}

interface RunRow {
  run_id: string;
  role: string;
  tier: string | null;
  model: string;
  budget_limit: number;
  started_at: number;
  ended_at: number | null;
  end_kind: string | null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Every run of the story `key`, oldest first, with its agents and run usage. */
export function storyRuns(office: OfficeHandle, key: StoryKey): RunRecord[] {
  const rows = office.all<RunRow>(
    `select run_id, role, tier, model, budget_limit, started_at, ended_at, end_kind from runs
      where office_id = $office_id and key = $key order by started_at, run_id`,
    { key },
  );
  return rows.map((row) => {
    const agents = office.all<{ agent_id: string; model: string }>(
      `select agent_id, model from agents where office_id = $office_id and run_id = $run
        order by started_at, rowid`,
      { run: row.run_id },
    );
    const last = agents.at(-1);
    const stored = findRun(office, RunId.parse(row.run_id));
    if (stored === null) throw new Error(`run ${row.run_id} vanished inside its read`);
    const usage = readUsage(office, {
      run: row.run_id,
      agent: last?.agent_id ?? "",
      role: row.role,
      tier: row.tier ?? "",
      // Only usage.run reaches the RunRecord; the feature view's budget limit comes from workView.
      budgetLimit: runCaps(office, stored).budgetTokens,
    });
    return {
      run: RunId.parse(row.run_id),
      agents: agents.map((agent) => AgentId.parse(agent.agent_id)),
      role: RoleId.parse(row.role),
      tier: row.tier ?? "",
      model: last?.model ?? row.model,
      startedAt: iso(row.started_at),
      // A run ended done, parked or dropped (0020); one open at In Review has not ended, and says
      // since when it stands there.
      ...(row.ended_at === null
        ? {}
        : row.end_kind === null
          ? { inReviewSince: iso(row.ended_at) }
          : { endedAt: iso(row.ended_at), outcome: row.end_kind }),
      usage: usage.run,
      ...(row.ended_at === null ? {} : doneReportField(office, row.run_id)),
    };
  });
}

interface VerdictRow {
  gate_id: string;
  kind: string;
  run_id: string | null;
  decision: "approved" | "rejected";
  decided_by: "maintainer" | "rule";
  note: string | null;
  rule_results: string;
  decided_at: number;
}

function failuresOf(json: string): string[] {
  const value = JSON.parse(json) as unknown;
  if (!Array.isArray(value)) return [];
  return value.flatMap((result: { passed?: unknown; messages?: unknown }) =>
    result.passed === false && Array.isArray(result.messages)
      ? result.messages.filter((message): message is string => typeof message === "string")
      : [],
  );
}

/** Every decided gate of the story `key`, oldest first. */
export function storyVerdicts(office: OfficeHandle, key: StoryKey): Verdict[] {
  const rows = office.all<VerdictRow>(
    `select g.gate_id, g.kind, g.run_id, d.decision, d.decided_by, d.note, d.rule_results,
            d.decided_at
       from gate_decisions d
       join gates g on g.office_id = d.office_id and g.gate_id = d.gate_id
      where d.office_id = $office_id and g.key = $key
      order by d.decided_at, d.rowid`,
    { key },
  );
  return rows.map((row) => {
    const failures = failuresOf(row.rule_results);
    const gate = GateId.parse(row.gate_id);
    // A review gate carries its round's verdict (0019 section 14, DIPO-146).
    const review = row.kind === "review" ? reviewVerdictOfGate(office, gate) : null;
    return {
      gate,
      ...(row.run_id === null ? {} : { run: RunId.parse(row.run_id) }),
      kind: row.kind,
      decision: row.decision,
      by: row.decided_by,
      ...(row.note === null ? {} : { note: row.note }),
      ...(failures.length === 0 ? {} : { failures }),
      at: iso(row.decided_at),
      ...(review === null ? {} : { review: reviewVerdictView(office, review) }),
    };
  });
}

type DetailResult = z.input<typeof storyDetail.result>;

/** The story's view, its active run's view, its runs, its verdicts and its open questions. */
export function detail(office: OfficeHandle, key: StoryKey): DetailResult {
  const view = storyView(office, key);
  if (view === null) throw new Error(`story ${key} resolved but has no row`);
  const runs = storyRuns(office, key);
  const active = view.work === undefined ? null : workView(office, view.work.run);
  // A conflict with the base found while the story is In Review (DIPO-149).
  const conflict = baseConflictOf(office, key);
  // The story's open gates that wait for the maintainer (DIPO-150): `dipo approve` sends one.
  const gates = openGateViews(office).filter(
    (gate) => gate.work.key === key && gate.waitingOn === "maintainer",
  );
  return {
    view,
    ...(active === null ? {} : { work: active }),
    runs,
    verdicts: storyVerdicts(office, key),
    questions: storyQuestionViews(office, key),
    ...(gates.length === 0 ? {} : { gates }),
    ...(conflict === null
      ? {}
      : {
          baseConflict: {
            base: conflict.base,
            onto: conflict.onto,
            paths: conflict.paths,
            at: iso(conflict.at),
          },
        }),
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** True for a UTF-8 continuation byte, which never starts a character. */
function continuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

type RangeResult = z.input<typeof workOutputRange.result>;

/**
 * Stored output of `run` from `source` in the byte range [from, to), at most
 * `OUTPUT_RANGE_MAX_BYTES`. Output removed by retention or not yet written is left out, so the
 * result's `from` and `to` say what it holds; both fall on character boundaries. An empty range
 * has `from` equal to `to`.
 * Engine markers in the worker output that overlap the result are flagged in `markers` (DIPO-95):
 * a marker is a worker chunk with no agent, which only the engine writes.
 */
export function outputRange(
  office: OfficeHandle,
  run: RunId,
  source: OutputSource,
  from: number,
  to?: number,
): RangeResult {
  const chunks = office.all<{
    from_offset: number;
    to_offset: number;
    text: string;
    agent_id: string | null;
  }>(
    `select from_offset, to_offset, text, agent_id from output_chunks
      where office_id = $office_id and run_id = $run and source = $source
        and to_offset > $from and ($to is null or from_offset < $to)
      order by from_offset`,
    { run, source, from, to: to ?? null },
  );
  const first = chunks[0];
  if (first === undefined) return { run, source, from, to: from, text: "" };
  const bytes = new Uint8Array(chunks.reduce((sum, c) => sum + (c.to_offset - c.from_offset), 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(encoder.encode(chunk.text), at);
    at += chunk.to_offset - chunk.from_offset;
  }
  const base = first.from_offset;
  let start = Math.max(from, base) - base;
  let end = Math.min((to ?? Number.POSITIVE_INFINITY) - base, bytes.length);
  end = Math.min(end, start + OUTPUT_RANGE_MAX_BYTES);
  while (start < end && continuation(bytes[start])) start += 1;
  while (end > start && end < bytes.length && continuation(bytes[end])) end -= 1;
  const markers =
    source === "worker"
      ? chunks.flatMap((chunk) =>
          chunk.agent_id === null &&
          chunk.from_offset < base + end &&
          chunk.to_offset > base + start
            ? (storedMarker(chunk.text, chunk.from_offset, chunk.to_offset) ?? [])
            : [],
        )
      : [];
  return {
    run,
    source,
    from: base + start,
    to: base + end,
    text: decoder.decode(bytes.subarray(start, end)),
    ...(markers.length === 0 ? {} : { markers }),
  };
}

/**
 * The prompt text stored for `run` and `agent` (DIPO-137): the system file and the first message,
 * or an empty list when none is stored.
 */
export function storedPrompt(
  office: OfficeHandle,
  run: RunId,
  agent: AgentId,
): z.input<typeof workPrompt.result> {
  return { run, agent, texts: promptTextsOf(office, run, agent) };
}

/**
 * The view reads, listed in `features.ts`, with the desk's sources beyond this engine's own (the
 * daemon's office starts paused, 0020).
 */
export function viewsFeatureWith(
  desk: Partial<DeskSources> & Pick<DeskSources, "stories">,
): FeatureModule {
  const sources: DeskSources = { ...DESK_SOURCES, ...desk };
  return {
    name: "views",
    register(registry) {
      registry.addRead({
        definition: officeSnapshot,
        handle: (ctx) => snapshot(officeOf(ctx)),
      });
      // `office.switch` changes no fact: the same snapshot (0005 section 7, 0009 section 4).
      registry.addRead({
        definition: officeSwitch,
        handle: (ctx) => snapshot(officeOf(ctx)),
      });
      registry.addRead({
        definition: storyDetail,
        handle: (ctx, args) => detail(officeOf(ctx), args.story as StoryKey),
      });
      registry.addRead({
        definition: workOutputRange,
        handle: (ctx, args) =>
          outputRange(officeOf(ctx), args.run, args.source, args.from, args.to),
      });
      registry.addRead({
        definition: workPrompt,
        handle: (ctx, args) => storedPrompt(officeOf(ctx), args.run, args.agent),
      });
      // `office.desk` (DIPO-158): what waits on the maintainer.
      registerDesk(registry, sources);
      // `office.digest` (DIPO-308): what happened since the maintainer last left the office.
      registerDigest(registry);
    },
  };
}

/** The `doneReport` of a run record when the run stored notes or proposals (DIPO-152). */
function doneReportField(
  office: OfficeHandle,
  run: string,
): { doneReport: NonNullable<ReturnType<typeof storedDoneReport>> } | Record<string, never> {
  const doneReport = storedDoneReport(office, RunId.parse(run));
  return doneReport === null ? {} : { doneReport };
}
