// One compaction as the stream reports it (DIPO-100): replayed through the fake process and the
// real adapter, a `compact_boundary` gives one `compacted` with the real `pre_tokens`. No session
// has hooks any more (0008, DIPO-347): a `PostCompact` hook line an earlier binary left in an event
// file changes nothing.

import { describe, expect, it } from "bun:test";

import type { RecordedLine, Recording } from "@dipsaus-orchestrator/testkit";

import type { WorkerEvent } from "../../src/workers/types";
import { loadRecording, replay } from "./replay";

const PRE_TOKENS = 150_000;

const boundary = (t: number): RecordedLine => ({
  t,
  ch: "stdout",
  data: {
    type: "system",
    subtype: "compact_boundary",
    session_id: "session-1",
    uuid: "uuid-compact",
    compact_metadata: { trigger: "auto", pre_tokens: PRE_TOKENS },
  },
});

const postCompact = (t: number): RecordedLine => ({
  t,
  ch: "hook",
  data: {
    session_id: "session-1",
    transcript_path: "${TRANSCRIPT}",
    cwd: "${WORKDIR}",
    permission_mode: "default",
    hook_event_name: "PostCompact",
    trigger: "auto",
  },
});

const isResult = (line: RecordedLine) =>
  line.ch === "stdout" && (line.data as { type?: string }).type === "result";

/** `success-single` with lines put before its result line (or after it, with `afterResult`). */
function withCompaction(
  before: (t: number) => RecordedLine[],
  afterResult: (t: number) => RecordedLine[] = () => [],
): Recording {
  const recording = loadRecording("success-single");
  const index = recording.lines.findIndex(isResult);
  const result = recording.lines[index];
  if (result === undefined) throw new Error("success-single has no result line");
  const lines = [
    ...recording.lines.slice(0, index),
    ...before(result.t),
    result,
    ...afterResult(result.t),
    ...recording.lines.slice(index + 1),
  ];
  return { ...recording, name: `${recording.name}-compaction`, lines };
}

const compacted = (events: readonly WorkerEvent[]) =>
  events.filter((event) => event.t === "compacted");

describe("a compaction seen as compact_boundary, replayed (DIPO-100)", () => {
  it("gives one compacted with the boundary's preTokens", async () => {
    const replayed = await replay(withCompaction((t) => [boundary(t)]));
    expect(compacted(replayed.events)).toEqual([{ t: "compacted", preTokens: PRE_TOKENS }]);
  });

  it("ignores a PostCompact hook line of an earlier binary, before or after the boundary", async () => {
    const plain = await replay(withCompaction((t) => [boundary(t)]));
    const hookFirst = await replay(withCompaction((t) => [postCompact(t), boundary(t)]));
    const hookOnly = await replay(withCompaction((t) => [postCompact(t)]));
    expect(hookFirst.events).toEqual(plain.events);
    expect(hookFirst.result).toEqual(plain.result);
    expect(compacted(hookOnly.events)).toEqual([]);
  });
});
