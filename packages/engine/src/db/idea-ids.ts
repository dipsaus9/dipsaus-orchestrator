// The identity of a held idea (0022, DIPO-452), shared by the idea store and the migration that held
// the open worker proposals as ideas, so a proposal held by either gets the same id.

import { createHash } from "node:crypto";

/**
 * The id of an idea: its origin, its source (the run it came from, or the story key, or nothing),
 * its title and its text. The same idea from the same source holds once; the same idea from
 * another source is held again, and code rejects it as a duplicate.
 */
export function ideaIdOf(origin: string, source: string, title: string, text: string): string {
  return createHash("sha256")
    .update(JSON.stringify([origin, source, title.trim(), text.trim()]))
    .digest("hex");
}

/** The text of an idea held from a worker's proposal: its Story line, why and paths. */
export function proposalIdeaText(storyLine: string, why: string, paths: readonly string[]): string {
  const lines = [`Story: ${storyLine.trim()}`, `Why: ${why.trim()}`];
  if (paths.length > 0) lines.push(`Paths: ${paths.join(", ")}`);
  return lines.join("\n");
}
