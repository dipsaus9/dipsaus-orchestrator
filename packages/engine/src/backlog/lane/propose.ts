// The lane-b kind `propose` (DIPO-166, DIPO-454; 0020): an idea the maintainer accepted from the
// desk becomes a Backlog draft (`backlog draft create` with its labels, then `draft edit` for its
// references and milestone), committed as `backlog: propose <source story>`. The target state is
// "a draft with the target's title whose description holds the idea's marker line exists": applied
// again (a replay, a rebuild on a newer base) it finds the draft it made and creates none. The
// marker alone never decides: a worker can compute an idea's id and write its marker line into a
// file its story changes, so only a draft (not a task) with the same title counts. Backlog.md
// 1.53's `draft create` takes no references or milestone, so they follow in a `draft edit`, and
// everything is read back. A tech-debt draft has no milestone and the label `tech-debt` (0022).
//
// The draft's text is built by `run/idea-answers.ts` from the audit's words, cleaned and capped;
// this kind only checks the target's shape and writes it. The draft id the CLI gave is recorded on
// the idea's row; Backlog.md reuses draft ids, so the marker and title, not the id, find the draft.

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import type { OfficeHandle } from "../../db/office";
import { PROPOSE_KIND, type ProposedDraft } from "../../story-store/planning";
import { FieldWriteError, viewStory } from "../fields/write";
import { type BacklogCli, runBacklog } from "../runner";

import type { LaneOpKind } from "./ops";

/** The kind of `idea.accept`; the commit's verb. */
export { PROPOSE_KIND };

/** The line a filed draft's description carries, followed by the idea id. */
export const IDEA_MARKER = "dipo idea: ";

/** The target state of a `propose`: the draft's title, description, references, milestone and labels. */
export const ProposeTarget = z
  .object({
    idea: z.string().regex(/^[0-9a-f]{64}$/),
    title: z.string().min(1),
    description: z.string().min(1),
    references: z.array(z.string().min(1)),
    milestone: z.string().min(1).optional(),
    labels: z.array(z.string().regex(/^[A-Za-z0-9:_.-]+$/)),
  })
  .strict();
export type ProposeTarget = z.infer<typeof ProposeTarget>;

/**
 * The target of the draft `draft` as the engine wrote it: its description ends in the idea's
 * marker line, by which a replay finds the draft again.
 */
export function proposeTarget(draft: ProposedDraft): ProposeTarget {
  return {
    idea: draft.idea,
    title: draft.title,
    description: `${draft.description}\n${IDEA_MARKER}${draft.idea}`,
    references: [...draft.references],
    ...(draft.milestone === undefined ? {} : { milestone: draft.milestone }),
    labels: [...draft.labels],
  };
}

/** Where Backlog.md keeps drafts. */
const DRAFTS = "backlog/drafts";

/**
 * The ids of the drafts under `cwd` whose description holds the marker line of `idea`, in file
 * order. Reads the files, since the CLI has no search by text.
 */
export function markedDrafts(cwd: string, idea: string): string[] {
  const line = new RegExp(`^${IDEA_MARKER}${idea}\\s*$`, "m");
  let names: string[];
  try {
    names = readdirSync(join(cwd, DRAFTS)).filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const name of names.toSorted()) {
    const text = readFileSync(join(cwd, DRAFTS, name), "utf8");
    if (!line.test(text)) continue;
    const id = /^id:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text)?.[1];
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/**
 * The id of the draft filed for `target`: a draft with its marker line whose title, as the CLI
 * reads it, is the target's title; null when there is none.
 */
export async function filedDraft(
  ctx: { readonly cli: BacklogCli; readonly cwd: string },
  target: Pick<ProposeTarget, "idea" | "title">,
): Promise<string | null> {
  const title = target.title.normalize("NFC").trim();
  for (const id of markedDrafts(ctx.cwd, target.idea)) {
    const view = await viewStory({ cli: ctx.cli, cwd: ctx.cwd, id, kind: "draft" });
    if (view.title.trim() === title) return id;
  }
  return null;
}

/** Records the draft id the lane created for an accepted idea. */
export function recordDraftId(office: OfficeHandle, idea: string, draft: string): void {
  office.immediate(() =>
    office.run(
      `update ideas set draft_id = $draft
        where office_id = $office_id and idea_id = $idea and draft_id is not $draft`,
      { idea, draft },
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
        reason: `the target is not a valid idea draft: ${parsed.error.message}`,
      };
    }
    const target = parsed.data;
    const found = await filedDraft(ctx, target);
    if (found !== null) {
      // Filed already, here or on the base: the target state holds.
      if (ctx.office !== undefined) recordDraftId(ctx.office, target.idea, found);
      return { applies: true };
    }
    // Backlog.md 1.53's `draft create` fails (ENOENT) without its drafts folder, which git does
    // not keep while it is empty, so a repository with no draft has none (DIPO-401).
    mkdirSync(join(ctx.cwd, DRAFTS), { recursive: true });
    await runBacklog(ctx.cli, ctx.cwd, [
      "draft",
      "create",
      target.title,
      "--description",
      target.description,
      ...(target.labels.length === 0 ? [] : ["--labels", target.labels.join(",")]),
    ]);
    const draft = await filedDraft(ctx, target);
    if (draft === null) {
      throw new FieldWriteError(
        ctx.story,
        `no draft with the idea's marker and title is there after \`draft create\``,
      );
    }
    const edit = [
      ...target.references.flatMap((path) => ["--ref", path]),
      ...(target.milestone === undefined ? [] : ["--milestone", target.milestone]),
    ];
    if (edit.length > 0) await runBacklog(ctx.cli, ctx.cwd, ["draft", "edit", draft, ...edit]);
    const view = await viewStory({ cli: ctx.cli, cwd: ctx.cwd, id: draft, kind: "draft" });
    const problems: string[] = [];
    const missing = target.references.filter((path) => !view.references.includes(path));
    if (missing.length > 0) problems.push(`the references lack ${missing.join(", ")}`);
    const labels = target.labels.filter((label) => !view.labels.includes(label));
    if (labels.length > 0) problems.push(`the labels lack ${labels.join(", ")}`);
    if ((view.milestone ?? undefined) !== target.milestone) {
      problems.push(
        `the milestone is ${view.milestone ?? "none"}, not ${target.milestone ?? "none"}`,
      );
    }
    if (problems.length > 0) {
      throw new FieldWriteError(draft, `the draft reads back wrong: ${problems.join("; ")}`);
    }
    if (ctx.office !== undefined) recordDraftId(ctx.office, target.idea, draft);
    return { applies: true };
  },
};
