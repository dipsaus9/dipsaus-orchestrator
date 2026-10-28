// Worker transcripts as the second usage source (0008 section 4, DIPO-134). The hook relay of an
// earlier binary named a session's transcript and each subagent's; no session has hooks now (0008,
// DIPO-347), so no new path is named and usage comes from the host's events only. A cursor an
// earlier binary stored is still read: its path and the byte offset read so far are kept in an
// `ingest_cursors` row of source kind `transcript`, with the per-subagent detail in its
// `parse_state`. The adapter's pure parser (`readTranscript`) keeps only
// message id, model and usage; this file stores what it returns.
//
// The tailer runs only when it is needed: a worker host died without `exit.json` (`mode: "lost"`:
// the session's and the subagents' usage the stream lacked is counted, once per message id across
// the run's agents, so a resumed session that names its earlier session's file counts that
// session's messages no second time), or at a healthy end for the per-subagent detail the stream
// lacked (`mode: "detail"`: subagent usage is stored as detail only, the totals already hold it).
// Both are idempotent: a second pass reads from the stored offset and counts nothing twice.

import type { OfficeHandle } from "../db/office";
import { priceAgentUsage } from "../pricing/usage";
import type { PriceBook } from "../pricing/estimate";
import type { TranscriptMessage, TranscriptRead } from "../workers/types";
import { readCompleteLines, statEventFile } from "./event-file";
import { feedFinalChanges, finalRows, recordTranscriptUsage, type UsageScope } from "./usage";

/** The `ingest_cursors.source_kind` of a worker transcript. */
export const TRANSCRIPT_SOURCE = "transcript";

/** The adapter's pure transcript parser; absent for an adapter without a transcript. */
export type TranscriptReader = (lines: readonly string[], version: string | null) => TranscriptRead;

/** One subagent message as kept for its detail. */
interface StoredMessage {
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cacheCreate5m: number;
  readonly cacheCreate1h: number;
  readonly cacheRead: number;
}

interface SubagentState {
  path: string;
  offset: number;
  messages: Record<string, StoredMessage>;
}

interface TranscriptState {
  subagents: Record<string, SubagentState>;
}

interface CursorRow {
  path: string;
  read_offset: number;
  parse_state: string;
}

const WHERE = `office_id = $office_id and run_id = $run and agent_id = $agent
  and source_kind = '${TRANSCRIPT_SOURCE}'`;

function readCursor(office: OfficeHandle, run: string, agent: string): CursorRow | null {
  return office.get<CursorRow>(
    `select path, read_offset, parse_state from ingest_cursors where ${WHERE}`,
    { run, agent },
  );
}

function stateOf(row: CursorRow | null): TranscriptState {
  if (row === null) return { subagents: {} };
  try {
    const value = JSON.parse(row.parse_state) as Partial<TranscriptState>;
    return { subagents: value.subagents ?? {} };
  } catch {
    return { subagents: {} };
  }
}

function writeCursor(
  office: OfficeHandle,
  scope: { readonly run: string; readonly agent: string },
  cursor: { readonly path: string; readonly offset: number; readonly state: TranscriptState },
  at: number,
): void {
  office.run(
    `insert into ingest_cursors (office_id, run_id, agent_id, source_kind, path, read_offset,
       parse_state, updated_at)
     values ($office_id, $run, $agent, '${TRANSCRIPT_SOURCE}', $path, $offset, $state, $at)
     on conflict (office_id, run_id, agent_id, source_kind) do update set
       path = excluded.path, read_offset = excluded.read_offset,
       parse_state = excluded.parse_state, updated_at = excluded.updated_at`,
    {
      run: scope.run,
      agent: scope.agent,
      path: cursor.path,
      offset: cursor.offset,
      state: JSON.stringify(cursor.state),
      at,
    },
  );
}

/** What one transcript pass did. */
export interface TranscriptPass {
  /** Messages whose usage was added to the totals. */
  readonly counted: number;
  /** Subagent messages stored as detail (new ones only). */
  readonly detailed: number;
  /** Why the parser refused a transcript (unsupported version); null when none was refused. */
  readonly refused: string | null;
}

const NOTHING: TranscriptPass = { counted: 0, detailed: 0, refused: null };

/** The lines of `path` past `from`, to the end of the last complete line; null if unreadable. */
function newLines(
  path: string,
  from: number,
): { readonly lines: string[]; readonly end: number } | null {
  if (path === "") return null;
  let identity;
  try {
    identity = statEventFile(path);
  } catch {
    return null;
  }
  if (identity === null) return null;
  // A file shorter than the offset was replaced: read it whole; message ids dedupe.
  const start = identity.size < from ? 0 : from;
  const lines: string[] = [];
  let end = start;
  for (;;) {
    let chunk;
    try {
      chunk = readCompleteLines(path, end, identity.size);
    } catch {
      return null;
    }
    if (chunk.length === 0) break;
    for (const line of chunk) lines.push(line.text);
    end = chunk[chunk.length - 1]?.end ?? end;
  }
  return { lines, end };
}

export interface RecoverTranscriptOptions {
  readonly office: OfficeHandle;
  readonly scope: UsageScope;
  readonly read: TranscriptReader;
  readonly pricing: PriceBook | null;
  readonly mode: "lost" | "detail";
  readonly at: number;
}

/**
 * Reads the agent's transcripts from their stored offsets and stores what they hold that the
 * stream lacked (see the file comment). One transaction; nothing is stored for a transcript the
 * parser refuses or that cannot be read. Feeds `usage_daily` the change in rows that were already
 * final, as ingestion does.
 */
export function recoverTranscriptUsage(options: RecoverTranscriptOptions): TranscriptPass {
  const { office, scope, read, mode, at } = options;
  return office.immediate(() => {
    const row = readCursor(office, scope.run, scope.agent);
    if (row === null) return NOTHING;
    const version =
      office.get<{ adapter_version: string | null }>(
        "select adapter_version from agents where office_id = $office_id and agent_id = $agent",
        { agent: scope.agent },
      )?.adapter_version ?? null;
    const finalBefore = finalRows(office, scope.run, scope.agent);
    const state = stateOf(row);
    let counted = 0;
    let detailed = 0;
    let refused: string | null = null;
    let offset = row.read_offset;

    if (mode === "lost") {
      const fresh = newLines(row.path, row.read_offset);
      if (fresh !== null) {
        const parsed = read(fresh.lines, version);
        if (parsed.ok) {
          for (const message of parsed.messages) {
            if (recordTranscriptUsage(office, scope, message, at)) counted++;
          }
          offset = fresh.end;
        } else {
          refused = parsed.reason;
        }
      }
    }

    for (const sub of Object.values(state.subagents)) {
      const fresh = newLines(sub.path, sub.offset);
      if (fresh === null) continue;
      const parsed = read(fresh.lines, version);
      if (!parsed.ok) {
        refused ??= parsed.reason;
        continue;
      }
      for (const message of parsed.messages) {
        if (sub.messages[message.messageId] === undefined) detailed++;
        sub.messages[message.messageId] = storedOf(message);
        // The stream carries a subagent's usage in the totals; only a lost host lacks it.
        if (mode === "lost" && recordTranscriptUsage(office, scope, message, at)) {
          counted++;
        }
      }
      sub.offset = fresh.end;
    }

    if (counted > 0) priceAgentUsage(office, options.pricing, scope.run, scope.agent);
    writeCursor(office, scope, { path: row.path, offset, state }, at);
    if (counted > 0) feedFinalChanges(office, scope.run, scope.agent, finalBefore, at);
    return { counted, detailed, refused };
  });
}

export interface LostUsageOptions extends Omit<RecoverTranscriptOptions, "read" | "mode"> {
  /** The adapter's transcript parser; nothing is read without one. */
  readonly read: TranscriptReader | undefined;
  readonly warn?:
    | ((message: string, fields: Readonly<Record<string, unknown>>) => void)
    | undefined;
}

/**
 * The usage a dead host never wrote to `exit.json`, read from the worker's transcripts in `lost`
 * mode (0008 section 4, DIPO-134), once per message id, in its own transaction. A transcript that
 * cannot be read costs the usage, never the caller's decision: a refusal or a failure is warned,
 * never thrown.
 */
export function recoverLostUsage(options: LostUsageOptions): void {
  const { read, warn, ...rest } = options;
  if (read === undefined) return;
  const fields = { run: rest.scope.run, agent: rest.scope.agent };
  try {
    const pass = recoverTranscriptUsage({ ...rest, read, mode: "lost" });
    if (pass.refused !== null) {
      warn?.("the worker transcript was not read", { ...fields, reason: pass.refused });
    }
  } catch (error) {
    warn?.("reading the worker transcript failed", {
      ...fields,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function storedOf(message: TranscriptMessage): StoredMessage {
  return {
    model: message.model,
    input: message.input,
    output: message.output,
    cacheCreate5m: message.cacheCreate5m,
    cacheCreate1h: message.cacheCreate1h,
    cacheRead: message.cacheRead,
  };
}

/** One subagent's usage as its transcript gave it (DIPO-134). */
export interface SubagentUsage {
  readonly subagent: string;
  readonly messages: number;
  readonly input: number;
  readonly output: number;
  readonly cacheCreate: number;
  readonly cacheRead: number;
}

/** The per-subagent usage stored for the agent, by subagent id. */
export function readSubagentUsage(
  office: OfficeHandle,
  run: string,
  agent: string,
): SubagentUsage[] {
  const state = stateOf(readCursor(office, run, agent));
  return Object.entries(state.subagents)
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([subagent, sub]) => {
      const messages = Object.values(sub.messages);
      const sum = (pick: (message: StoredMessage) => number): number =>
        messages.reduce((total, message) => total + pick(message), 0);
      return {
        subagent,
        messages: messages.length,
        input: sum((m) => m.input),
        output: sum((m) => m.output),
        cacheCreate: sum((m) => m.cacheCreate5m + m.cacheCreate1h),
        cacheRead: sum((m) => m.cacheRead),
      };
    });
}
