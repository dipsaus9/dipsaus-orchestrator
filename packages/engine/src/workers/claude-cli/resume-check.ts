// `canResume` of the Claude CLI adapter (0008 section 8, 0014 section 6 and its DIPO-51
// amendment). A crashed or reassigned session is resumed with `--resume` only when all of these
// hold, else the engine starts a new session with a handoff:
//
// - the transcript exists at `<home>/.claude/projects/<project>/<session>.jsonl` (Claude Code
//   keeps it 30 days);
// - the Claude Code version and the L1+L2 hash are the ones the session ran with;
// - the last request used under the context share (60% in M0) of the model's context window;
//   when either number is unknown this check passes;
// - re-reading the context costs at most the re-read factor (three in M0) times a handoff: the
//   last request's context tokens times 0.1 (a cache read, last request under one hour ago) or
//   times 2 (a one-hour cache write, otherwise) against the handoff task message's estimated
//   tokens times 2 (it is written to the cache once).
//
// The share and the factor are engine constants passed in `ResumeFacts`; the cache rates are the
// Claude ones and stay here.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { ResumeCheck, ResumeFacts, SessionRef } from "../types";

/** A cache read costs this share of a fresh input token. */
export const CACHE_READ_RATE = 0.1;
/** A one-hour cache write costs this many fresh input tokens. */
export const CACHE_WRITE_1H_RATE = 2;
/** The cache stays warm for this long after the last request (the one-hour cache). */
export const CACHE_WARM_MS = 60 * 60 * 1000;

/** Finds a session's transcript under `<home>/.claude/projects`; null when there is none. */
export function findTranscript(home: string, sessionId: string): string | null {
  const projects = join(home, ".claude", "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs.toSorted()) {
    const path = join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}

export interface ResumeCheckContext extends ResumeFacts {
  /** The home directory the worker runs with. */
  readonly home: string;
  /** Finds the transcript; `findTranscript` by default. */
  readonly transcript?: (home: string, sessionId: string) => string | null;
}

function percent(share: number): string {
  return `${Math.round(share * 1000) / 10}%`;
}

/** Whether the session `ref` can be resumed now; see the file comment. */
export function checkResume(ref: SessionRef, ctx: ResumeCheckContext): ResumeCheck {
  const transcript = ref.transcriptPath ?? (ctx.transcript ?? findTranscript)(ctx.home, ref.id);
  if (transcript === null || (ref.transcriptPath !== null && !existsSync(ref.transcriptPath))) {
    return { ok: false, reason: `session ${ref.id} has no transcript to resume` };
  }
  if (ref.version === null || ctx.version === null || ref.version !== ctx.version) {
    return {
      ok: false,
      reason: `session ${ref.id} ran on Claude Code ${ref.version ?? "unknown"}, now ${ctx.version ?? "unknown"}`,
    };
  }
  if (ref.systemHash === null || ref.systemHash !== ctx.systemHash) {
    return { ok: false, reason: `the system prompt changed since session ${ref.id} started` };
  }
  const tokens = ref.contextTokens ?? null;
  const window = ref.contextWindow ?? null;
  if (tokens !== null && window !== null && window > 0 && tokens / window >= ctx.maxContextShare) {
    return {
      ok: false,
      reason: `session ${ref.id} used ${percent(tokens / window)} of its context, not under ${percent(ctx.maxContextShare)}`,
    };
  }
  if (tokens !== null) {
    const last = ref.lastRequestAt ?? null;
    const warm = last !== null && ctx.now - last < CACHE_WARM_MS;
    const reread = tokens * (warm ? CACHE_READ_RATE : CACHE_WRITE_1H_RATE);
    const handoff = ctx.rereadFactor * ctx.handoffTokens * CACHE_WRITE_1H_RATE;
    if (reread > handoff) {
      return {
        ok: false,
        reason: `re-reading session ${ref.id} costs ${Math.round(reread)} token equivalents, more than ${ctx.rereadFactor} handoffs (${Math.round(handoff)})`,
      };
    }
  }
  return { ok: true };
}
