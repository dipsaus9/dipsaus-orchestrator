// The story content hash a gate decision applies to (0007 section 4, 0010 structural check):
// sha256 over the canonical JSON of the story fields the Ready gate reads. Free context in the
// description is left out: of the description only the `Outcome:` lines and the parsed field
// block count, so editing the context around them keeps the hash.
//
// The status is left out too. The ready-mode decision is taken while the story is Refined and the
// backlog PR then sets it to Ready; the structural check must find the decision under the same
// hash. A field block that does not parse counts as its raw description, since its fields are
// unknown (R02).

import { createHash } from "node:crypto";

import { canonicalJson } from "../../config/merge";
import { FieldBlockError, parseFieldBlock } from "../../story-store/fields/block";
import { outcomeLines } from "../rules";
import type { GateStory } from "../types";

function fieldBlockOf(description: string): unknown {
  try {
    return { fields: parseFieldBlock(description).fields };
  } catch (error) {
    if (!(error instanceof FieldBlockError)) throw error;
    return { invalid: description };
  }
}

/** The story fields the gate reads, without status and without free description context. */
export function gateContent(story: GateStory): Record<string, unknown> {
  return {
    id: story.id,
    title: story.title,
    type: story.type,
    milestone: story.milestone,
    labels: [...story.labels].toSorted(),
    outcome: outcomeLines(story.description),
    fieldBlock: fieldBlockOf(story.description),
    acceptanceCriteria: story.acceptanceCriteria.map((criterion) => ({
      index: criterion.index,
      checked: criterion.checked,
      text: criterion.text,
    })),
    references: story.references,
    documentation: story.documentation,
    dependencies: story.dependencies,
    subtasks: story.subtasks,
    implementationPlan: story.implementationPlan,
  };
}

/** sha256, hex, over the canonical JSON of `gateContent(story)`. */
export function gateContentHash(story: GateStory): string {
  return createHash("sha256")
    .update(canonicalJson(gateContent(story)))
    .digest("hex");
}
