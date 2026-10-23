// The lane-b kind `propose` (DIPO-166; 0020 section 11c): an accepted worker proposal becomes a
// Backlog draft (`backlog draft create`, then `draft edit --ref` for its paths), committed as
// `backlog: propose <source story>`. The target state is "a draft or task whose description holds
// the proposal's marker line exists": applied again (a replay, a rebuild on a newer base) it finds
// the draft it made and creates none. Backlog.md 1.53's `draft create` takes no references, so
// they follow in a `draft edit`, and both are read back.
//
// The draft's text is built by `run/proposals.ts` from the worker's words, cleaned and capped; this
// kind only checks the target's shape and writes it. The draft id the CLI gave is recorded on the
// proposal's row; Backlog.md reuses draft ids, so the marker, not the id, finds the draft again.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import type { OfficeHandle } from "../../db/office";
import { FieldWriteError, viewStory } from "../fields/write";
import { runBacklog } from "../runner";

import type { LaneOpKind } from "./ops";

/** The kind of `proposal.accept`; the commit's verb. */
export const PROPOSE_KIND = "propose";

/** The line a filed draft's description carries, followed by the proposal id. */
export const PROPOSAL_MARKER = "dipo proposal: ";

/** The target state of a `propose`: the draft's title, description and references. */
export const ProposeTarget = z
  .object({
    proposal: z.string().regex(/^[0-9a-f]{64}$/),
    title: z.string().min(1),
    description: z.string().min(1),
    references: z.array(z.string().min(1)),
  })
  .strict();
export type ProposeTarget = z.infer<typeof ProposeTarget>;

/** Where Backlog.md keeps a draft, and a task once a draft is promoted. */
const FOLDERS = ["backlog/drafts", "backlog/tasks"] as const;

/**
 * The id of the draft (or the task it was promoted to) under `cwd` whose description holds the
 * marker line of `proposal`, or null. Reads the files, since the CLI has no search by text.
 */
export function markedStory(cwd: string, proposal: string): string | null {
  const line = new RegExp(`^${PROPOSAL_MARKER}${proposal}\\s*$`, "m");
  for (const folder of FOLDERS) {
    let names: string[];
    try {
      names = readdirSync(join(cwd, folder)).filter((name) => name.endsWith(".md"));
    } catch {
      continue;
    }
    for (const name of names.toSorted()) {
      const text = readFileSync(join(cwd, folder, name), "utf8");
      if (!line.test(text)) continue;
      const id = /^id:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text)?.[1];
      if (id !== undefined) return id;
    }
  }
  return null;
}

/** Records the draft id the lane created for an accepted proposal (migration 48). */
export function recordDraftId(office: OfficeHandle, proposal: string, draft: string): void {
  office.immediate(() =>
    office.run(
      `update proposals set draft_id = $draft
        where office_id = $office_id and hash = $hash and draft_id is not $draft`,
      { hash: proposal, draft },
    ),
  );
}

export const proposeKind: LaneOpKind = {
  kind: PROPOSE_KIND,
  async apply(ctx, raw) {
    const parsed = ProposeTarget.safeParse(raw);
    if (!parsed.success) {
      return {
        applies: false,
        reason: `the target is not a valid proposal draft: ${parsed.error.message}`,
      };
    }
    const target = parsed.data;
    const found = markedStory(ctx.cwd, target.proposal);
    if (found !== null) {
      // Filed already, here or on the base: the target state holds.
      if (ctx.office !== undefined) recordDraftId(ctx.office, target.proposal, found);
      return { applies: true };
    }
    await runBacklog(ctx.cli, ctx.cwd, [
      "draft",
      "create",
      target.title,
      "--description",
      target.description,
    ]);
    const draft = markedStory(ctx.cwd, target.proposal);
    if (draft === null) {
      throw new FieldWriteError(
        ctx.story,
        `no draft holds the proposal's marker after \`draft create\``,
      );
    }
    if (target.references.length > 0) {
      await runBacklog(ctx.cli, ctx.cwd, [
        "draft",
        "edit",
        draft,
        ...target.references.flatMap((path) => ["--ref", path]),
      ]);
    }
    const view = await viewStory({ cli: ctx.cli, cwd: ctx.cwd, id: draft, kind: "draft" });
    const missing = target.references.filter((path) => !view.references.includes(path));
    if (missing.length > 0) {
      throw new FieldWriteError(
        draft,
        `the references read back lack ${missing.join(", ")} after \`draft edit --ref\``,
      );
    }
    if (ctx.office !== undefined) recordDraftId(ctx.office, target.proposal, draft);
    return { applies: true };
  },
};
