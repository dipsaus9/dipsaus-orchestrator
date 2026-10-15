// One compaction reported through both `compact_boundary` and the `PostCompact` hook (DIPO-100):
// replayed through the fake process and the real adapter, both orders give one `compacted` with
// the real `pre_tokens`. A hook whose boundary does not come by the turn end is reported there with
// `preTokens` 0, and a boundary after that does not count the compaction again.

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
const notHook = (events: readonly WorkerEvent[]) => events.filter((event) => event.t !== "hook");

describe("a compaction seen as compact_boundary and PostCompact, replayed (DIPO-100)", () => {
  it("gives the same count and preTokens in both orders", async () => {
    const boundaryFirst = await replay(withCompaction((t) => [boundary(t), postCompact(t)]));
    const hookFirst = await replay(withCompaction((t) => [postCompact(t), boundary(t)]));
    const expected = [{ t: "compacted" as const, preTokens: PRE_TOKENS }];
    expect(compacted(boundaryFirst.events)).toEqual(expected);
    expect(compacted(hookFirst.events)).toEqual(expected);
    // Apart from where the neutral hook event sits, the run is unchanged by the order.
    expect(notHook(hookFirst.events)).toEqual(notHook(boundaryFirst.events));
    expect(hookFirst.result).toEqual(boundaryFirst.result);
  });

  it("reports a hook-only compaction by the turn end, and a later boundary does not count it again", async () => {
    const hookOnly = await replay(withCompaction((t) => [postCompact(t)]));
    expect(compacted(hookOnly.events)).toEqual([{ t: "compacted", preTokens: 0 }]);
    // Before the turn event, so a consumer of the turn already has the compaction.
    const at = hookOnly.events.findIndex((event) => event.t === "compacted");
    const turn = hookOnly.events.findIndex((event) => event.t === "turn");
    expect(at).toBeLessThan(turn);

    const late = await replay(
      withCompaction(
        (t) => [postCompact(t)],
        (t) => [boundary(t)],
      ),
    );
    expect(compacted(late.events)).toEqual([{ t: "compacted", preTokens: 0 }]);
  });
});
