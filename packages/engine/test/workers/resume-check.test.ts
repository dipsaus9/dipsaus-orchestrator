// `canResume` of the Claude CLI adapter (DIPO-51; 0008 section 8, 0014 section 6 and its
// amendment): the threshold cases, with a temp home holding a fixture transcript.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CACHE_WARM_MS,
  checkResume,
  findTranscript,
  type ResumeCheckContext,
} from "../../src/workers/claude-cli/resume-check";
import type { SessionRef } from "../../src/workers/types";

let home: string;
const SESSION = "0e6f3f4c-5b8d-4c1e-9a2b-3c4d5e6f7a8b";
const NOW = 10 * CACHE_WARM_MS;

beforeAll(() => {
  home = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "resume-check-"));
  const project = join(home, ".claude", "projects", "-work-tree");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${SESSION}.jsonl`), "{}\n");
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const ref = (extra: Partial<SessionRef> = {}): SessionRef => ({
  id: SESSION,
  transcriptPath: null,
  version: "2.1.296",
  systemHash: "hash-1",
  contextTokens: 10_000,
  contextWindow: 200_000,
  lastRequestAt: NOW - 60_000,
  ...extra,
});

const ctx = (extra: Partial<ResumeCheckContext> = {}): ResumeCheckContext => ({
  home,
  now: NOW,
  version: "2.1.296",
  systemHash: "hash-1",
  handoffTokens: 2_000,
  maxContextShare: 0.6,
  rereadFactor: 3,
  ...extra,
});

describe("checkResume", () => {
  it("finds the transcript under <home>/.claude/projects", () => {
    expect(findTranscript(home, SESSION)).toBe(
      join(home, ".claude", "projects", "-work-tree", `${SESSION}.jsonl`),
    );
    expect(findTranscript(home, "missing")).toBeNull();
    expect(checkResume(ref(), ctx())).toEqual({ ok: true });
  });

  it("refuses a missing transcript", () => {
    const check = checkResume(ref({ id: "11111111-2222-4333-8444-555555555555" }), ctx());
    expect(check).toEqual({
      ok: false,
      reason: "session 11111111-2222-4333-8444-555555555555 has no transcript to resume",
    });
    expect(checkResume(ref({ transcriptPath: join(home, "gone.jsonl") }), ctx()).ok).toBe(false);
  });

  it("refuses another Claude Code version, or an unknown one", () => {
    expect(checkResume(ref(), ctx({ version: "2.1.297" }))).toEqual({
      ok: false,
      reason: `session ${SESSION} ran on Claude Code 2.1.296, now 2.1.297`,
    });
    expect(checkResume(ref({ version: null }), ctx()).ok).toBe(false);
    expect(checkResume(ref(), ctx({ version: null })).ok).toBe(false);
  });

  it("refuses a changed L1+L2 hash, or none recorded", () => {
    expect(checkResume(ref(), ctx({ systemHash: "hash-2" }))).toEqual({
      ok: false,
      reason: `the system prompt changed since session ${SESSION} started`,
    });
    expect(checkResume(ref({ systemHash: null }), ctx()).ok).toBe(false);
  });

  it("resumes under 60% of the context window, not at it", () => {
    const share = (tokens: number) =>
      checkResume(
        ref({ contextTokens: tokens, contextWindow: 100_000 }),
        ctx({ handoffTokens: 1_000_000 }),
      );
    expect(share(59_000)).toEqual({ ok: true });
    expect(share(60_000)).toEqual({
      ok: false,
      reason: `session ${SESSION} used 60% of its context, not under 60%`,
    });
    // Unknown numbers pass the share check.
    expect(checkResume(ref({ contextWindow: null }), ctx()).ok).toBe(true);
    expect(checkResume(ref({ contextTokens: null }), ctx()).ok).toBe(true);
  });

  it("compares the re-read cost with three handoffs: 3.0 passes, 3.01 does not", () => {
    // Warm cache: tokens x 0.1 against 3 x 1,000 x 2 = 6,000.
    expect(reread(60_000, NOW - 60_000)).toEqual({ ok: true });
    expect(reread(60_100, NOW - 60_000).ok).toBe(false);
  });

  it("prices a cold cache as a one-hour write", () => {
    // Warm: 1,000 <= 6,000. Cold: 20,000 > 6,000.
    expect(reread(10_000, NOW - CACHE_WARM_MS + 1)).toEqual({ ok: true });
    const cold = reread(10_000, NOW - CACHE_WARM_MS);
    expect(cold.ok).toBe(false);
    if (!cold.ok) expect(cold.reason).toContain("costs 20000 token equivalents");
    expect(reread(10_000, null).ok).toBe(false);
  });
});

/** The re-read check alone: a 1,000-token handoff and a window too large to matter. */
function reread(tokens: number, lastRequestAt: number | null) {
  return checkResume(
    ref({ contextTokens: tokens, contextWindow: 1_000_000_000, lastRequestAt }),
    ctx({ handoffTokens: 1_000 }),
  );
}
