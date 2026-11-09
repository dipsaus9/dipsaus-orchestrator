// The run stream as a table (DIPO-461): thinking folded over a fixture stream, tool rows with their
// full command, bright words and verdicts, the filters, and the `you` line of a steer with the
// delivery state its reply names.

import { describe, expect, it } from "bun:test";

import type { OutputMarker } from "@dipsaus-orchestrator/contract";

import { type OutputLine } from "./output";
import {
  filterEntries,
  nextFilter,
  steerState,
  streamEntries,
  streamRows,
  youRow,
  type StreamRow,
} from "./stream";

const options = { full: false, dot: "·", ellipsis: "…", rule: "─" };

function marker(value: string, at: string): OutputMarker {
  return { from: 0, to: 1, kind: "phase", value, at };
}

function text(row: StreamRow): string {
  return row.map((span) => span.text).join("");
}

/** A fixture stream: thinking blocks around tool calls, words, a review section and a verdict. */
const FIXTURE: OutputLine[] = [
  marker("build", "2026-10-14T10:39:00.000Z"),
  "[thinking] 0.4s ~300 tokens",
  "[thinking] 0.3s ~250 tokens",
  "[thinking] 0.3s ~450 tokens",
  "[thinking] 0.2s ~100 tokens",
  "[tool] Read engine/src/a.ts",
  "[thinking] 1.1s",
  "[tool] Bash bun test reattach.test.ts",
  "Fixing the reattach shard timeout next.",
  marker("review", "2026-10-14T10:40:00.000Z"),
  "[tool] Grep box/workers.ts planning",
  "verdict: approved · 10/10 criteria met",
];

describe("the stream entries", () => {
  it("folds consecutive thinking into one line with its count and tokens", () => {
    // A section rule fills the row; the test cares for its label, not its length.
    const rows = streamRows(streamEntries(FIXTURE), 112, options).map((row) =>
      text(row).replace(/ ─+$/, " ─"),
    );
    expect(rows).toEqual([
      "  ── build · 10:39 ─",
      "  10:39  ··     4 thoughts · 1.1k tokens",
      "  10:39  read   engine/src/a.ts",
      "  10:39  ··     thinking 1.1s",
      "  10:39  bash   bun test reattach.test.ts",
      "  10:39  says   Fixing the reattach shard timeout next.",
      "  ── review · reviewer · 10:40 ─",
      "  10:40  grep   box/workers.ts planning",
      "  10:40  verdict approved · 10/10 criteria met",
    ]);
  });

  it("does not fold thinking across a tool call or a section", () => {
    const entries = streamEntries([
      "[thinking] 0.4s ~300 tokens",
      "[tool] Read a",
      "[thinking] 0.4s ~300 tokens",
      marker("review", "2026-10-14T10:40:00.000Z"),
      "[thinking] 0.4s ~300 tokens",
    ]);
    expect(entries.filter((entry) => entry.kind === "thinking")).toHaveLength(3);
  });

  it("paints the agent's words and the verdict bright, the rest dim", () => {
    const rows = streamRows(streamEntries(FIXTURE), 112, options);
    const says = rows.find((row) => text(row).includes("says"))!;
    expect(says.at(-1)).toMatchObject({
      role: "hi",
      text: "Fixing the reattach shard timeout next.",
    });
    expect(says[1]).toMatchObject({ role: "acc" });
    const verdict = rows.find((row) => text(row).includes("verdict"))!;
    expect(verdict[1]).toMatchObject({ role: "ok" });
    expect(verdict.at(-1)).toMatchObject({ role: "hi" });
    const read = rows.find((row) => text(row).includes("read"))!;
    expect(read[0]).toMatchObject({ role: "dim" });
  });

  it("cuts a long command to one row with a hint, and shows it whole in full", () => {
    const command = `bun test ${"packages/tui/src/very-long-name.test.ts ".repeat(6)}`.trim();
    const entries = streamEntries([`[tool] Bash ${command}`]);
    const cut = streamRows(entries, 80, options);
    expect(cut).toHaveLength(1);
    expect(text(cut[0]!)).toEndWith("… ⏎ full");
    expect(text(cut[0]!).length).toBeLessThanOrEqual(80);
    const full = streamRows(entries, 80, { ...options, full: true });
    expect(full.length).toBeGreaterThan(1);
    expect(full.map((row) => text(row).slice(16)).join(" ")).toBe(command);
  });

  it("keeps verify's text as plain lines and filters by source and section", () => {
    const worker = streamEntries(FIXTURE);
    const verify = streamEntries(["$ bun run verify", "all green"], "·", "verify");
    expect(verify.map((entry) => entry.kind)).toEqual(["plain", "plain"]);
    const kinds = (filter: Parameters<typeof filterEntries>[0]) =>
      filterEntries(filter, worker, verify).map((entry) => entry.kind);
    expect(kinds("verify")).toEqual(["plain", "plain"]);
    expect(kinds("reviewer")).toEqual(["head", "tool", "verdict"]);
    expect(kinds("worker")).not.toContain("verdict");
    expect(kinds("all")).toHaveLength(worker.length + verify.length + 1);
  });

  it("steps through the filters in the order of the tabs", () => {
    let filter = nextFilter("all");
    const seen = [filter];
    for (let i = 0; i < 4; i++) seen.push((filter = nextFilter(filter)));
    expect(seen).toEqual(["worker", "reviewer", "verify", "prompt", "all"]);
  });
});

describe("the you line of a steer", () => {
  const at = Date.parse("2026-10-14T10:42:00.000Z");
  const base = {
    id: 1,
    at,
    text: "Don’t raise the timeout. The real host must\nbind within 4.5 s.",
  };
  const flat = { dot: "·", ellipsis: "…" };

  it("shows the delivery state from the reply", () => {
    const next = steerState({ ok: true, result: { run: "run_1", delivered: "next-turn" } });
    const resume = steerState({ ok: true, result: { run: "run_1", delivered: "on-resume" } });
    expect(next).toEqual({ kind: "delivered", when: "next-turn" });
    expect(resume).toEqual({ kind: "delivered", when: "on-resume" });
    expect(text(youRow({ ...base, state: next }, 112, flat))).toMatch(
      /^ {2}\d\d:\d\d {2}you {4}Don’t raise the timeout\. The real host must bind within 4\.5 s\. · delivered next turn$/,
    );
    expect(text(youRow({ ...base, state: resume }, 112, flat))).toEndWith("· delivered on resume");
  });

  it("cuts a long message and says a refusal or a pending send", () => {
    const refused = steerState({
      ok: false,
      error: { code: "story.notSteerable", message: "the reviewer is working" },
    });
    expect(refused).toEqual({
      kind: "failed",
      message: "story.notSteerable: the reviewer is working",
    });
    const row = youRow({ ...base, state: refused }, 90, flat);
    expect(text(row).length).toBeLessThanOrEqual(90);
    expect(text(row)).toContain("Don’t raise the t…");
    expect(row.at(-1)).toMatchObject({ role: "err" });
    expect(text(youRow({ ...base, state: { kind: "sending" } }, 112, flat))).toEndWith("· sending");
    expect(steerState({ ok: true, result: {} })).toMatchObject({ kind: "failed" });
  });
});
