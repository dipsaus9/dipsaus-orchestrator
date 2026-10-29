// What a running worker is doing now, in words (0009 sections 4 and 6, DIPO-81): the line the live
// agent detail shows under its header, and the `now:` line under each running row of the overview.
// Both take the newest stored worker line as stored, and its age from the engine's `lastOutputAt`.
// Nothing here parses adapter output.

import type { QuestionView, StoryView, WorkView } from "@dipsaus-orchestrator/contract";

import { healthLabel } from "./views";

/** An age as `12s`, `4m` or `2h`. */
export function shortAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

/** `12s ago` from the engine's `lastOutputAt`, or null before any output. */
export function outputAge(view: WorkView, now: number): string | null {
  if (view.lastOutputAt === undefined) return null;
  return `${shortAge(now - Date.parse(view.lastOutputAt))} ago`;
}

/** Phase words of the overview's `now:` line; an unknown phase shows as its own word. */
const PHASE_WORDS: Readonly<Record<string, string>> = {
  setup: "setting up",
  build: "building",
  review: "reviewing",
  test: "testing",
  merge: "merging",
};

export function phaseWord(phase: string): string {
  return PHASE_WORDS[phase] ?? phase;
}

/** The `now` line of a run that ended: where its story went; null when it left the office. */
export function endedLine(ended: StoryView | null, dot: string): string {
  if (ended === null) return `run ended ${dot} the story is no longer in this office`;
  const parked = ended.parked === undefined ? "" : ` (${ended.parked.reason})`;
  return `run ended ${dot} ${ended.story} is ${ended.lifecycle}${parked}`;
}

/**
 * What the worker is doing right now: health, phase, the newest output line and its age. `ended`
 * set means the run ended (null: the story left the office).
 */
export function nowLine(options: {
  view: WorkView;
  ended: StoryView | null | undefined;
  worker: string | null;
  now: number;
  dot: string;
}): string {
  const { view, ended, worker, now, dot } = options;
  if (ended !== undefined) return endedLine(ended, dot);
  const parts = [`now  ${healthLabel(view.health)}`, view.phase, worker ?? "no output yet"];
  const age = outputAge(view, now);
  if (age !== null) parts.push(age);
  return parts.join(` ${dot} `);
}

/**
 * The overview's `now:` text of a running row: `building · [tool] Edit src/app.ts · 12s ago`. A
 * run with an open question says `asking you` with the question.
 */
export function boardNow(options: {
  view: WorkView;
  worker: string | null;
  question: QuestionView | undefined;
  now: number;
  dot: string;
}): string {
  const { view, worker, question, now, dot } = options;
  const age = outputAge(view, now);
  if (question !== undefined) {
    const text = question.kind === "permission" ? `permission: ${question.text}` : question.text;
    return ["asking you", text].join(` ${dot} `);
  }
  const parts = [phaseWord(view.phase), worker ?? "no output yet"];
  if (age !== null) parts.push(age);
  return parts.join(` ${dot} `);
}
