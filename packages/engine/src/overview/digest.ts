// "Since you left" (0009): `office.digest` counts what happened in an office after `since`, from
// the stored change log, and gives one code-built line per fact in log order. The client keeps
// `since` itself, so the engine does not depend on which clients connect (0001). Nothing here asks
// a model; worker text (a proposal title) is cleaned as the desk cleans it, because a terminal
// shows the line.

import { officeDigest } from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import type { FeatureRegistry, ReadContext } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import { deskLine } from "./desk";

/** The counts `office.digest` returns, in this order, each present even when zero. */
export const DIGEST_COUNTS = [
  "done",
  "parked",
  "parkedByYou",
  "questions",
  "merges",
  "proposals",
] as const;
export type DigestCount = (typeof DIGEST_COUNTS)[number];

/** The most lines one digest returns; the counts cover the rest. */
export const DIGEST_LINES_MAX = 20;

/** The change-log types a digest reads. */
const DIGEST_TYPES = [
  "story.state",
  "story.parked",
  "question.asked",
  "gate.reached",
  "proposal.filed",
] as const;

type Delta = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The story id a work event's `work` names. */
function workStory(delta: Delta): string | null {
  const work = delta["work"];
  return typeof work === "object" && work !== null ? text((work as Delta)["story"]) : null;
}

/** What one change-log entry adds to the digest: a count and its line, or nothing. */
function factOf(type: string, delta: Delta): { count: DigestCount; line: string } | null {
  switch (type) {
    case "story.state": {
      const story = text(delta["story"]);
      return delta["to"] === "Done" && story !== null
        ? { count: "done", line: `${story} done` }
        : null;
    }
    case "story.parked": {
      const story = text(delta["story"]);
      const reason = text(delta["reason"]);
      if (story === null || reason === null) return null;
      return reason === "by-maintainer"
        ? { count: "parkedByYou", line: `${story} parked by you` }
        : { count: "parked", line: `${story} parked: ${reason}` };
    }
    case "question.asked": {
      const story = workStory(delta);
      return story === null ? null : { count: "questions", line: `${story} asked a question` };
    }
    case "gate.reached": {
      const story = workStory(delta);
      if (story === null || delta["kind"] !== "merge" || delta["waitingOn"] !== "maintainer") {
        return null;
      }
      return { count: "merges", line: `${story} waits for your merge` };
    }
    case "proposal.filed": {
      const who = text(delta["story"]) ?? "a story";
      const kind = text(delta["kind"]) ?? "proposal";
      const title = deskLine(text(delta["title"]) ?? "");
      return { count: "proposals", line: `${who} proposed a ${kind}: ${JSON.stringify(title)}` };
    }
    default:
      return null;
  }
}

/** What happened in `office` after `since` (ms), as `office.digest` returns it. */
export function digest(office: OfficeHandle, since: number): z.input<typeof officeDigest.result> {
  const rows = office.all<{ type: string; delta: string }>(
    `select type, delta from change_log
      where office_id = $office_id and at > $since
        and type in (${DIGEST_TYPES.map((type) => `'${type}'`).join(", ")})
      order by seq`,
    { since },
  );
  const counts: Record<DigestCount, number> = {
    done: 0,
    parked: 0,
    parkedByYou: 0,
    questions: 0,
    merges: 0,
    proposals: 0,
  };
  const lines: string[] = [];
  for (const row of rows) {
    let delta: unknown;
    try {
      delta = JSON.parse(row.delta);
    } catch {
      continue;
    }
    if (typeof delta !== "object" || delta === null) continue;
    const fact = factOf(row.type, delta as Delta);
    if (fact === null) continue;
    counts[fact.count] += 1;
    if (lines.length < DIGEST_LINES_MAX) lines.push(fact.line);
  }
  return { since: new Date(since).toISOString(), counts, lines };
}

/** Registers `office.digest`; `overview/feature.ts` calls it. */
export function registerDigest(registry: FeatureRegistry): void {
  registry.addRead({
    definition: officeDigest,
    handle: (ctx: ReadContext, args) => {
      if (ctx.office === undefined) throw new Error("office.digest runs with its office");
      return digest(ctx.office, Date.parse(args.since));
    },
  });
}
