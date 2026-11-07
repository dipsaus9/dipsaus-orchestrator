// The lane-b kinds `file`, `revise` and `refine` (DIPO-450, DIPO-454; 0010, 0022): what a planning
// session's confirmed proposals change in the backlog. Each is a target state, applied through the
// Backlog CLI in the `_backlog` worktree and read back.
//
// - `file` creates a story Refined to the story standard (0012): `task create` with its title,
//   description (the Story line and its context), type, milestone, tier label, criteria,
//   references and dependencies, then the field block with the branch `<ID>/<slug>`, an empty
//   unknowns list and the test plan through the single write path (`writeFields`). The target state
//   is "a task with the target's title whose description starts with its Story line exists": applied
//   again (a replay, or a rebuild on a newer base) it finds that task and creates none, and only
//   fills in what is missing. The id it found or made goes into the session's record; a rebuild
//   that gives the story another id replaces it there.
// - `revise` changes an existing task while its status is one of the target's: its title
//   (`--title`), its Story line and the context below it (the description, with the field block
//   kept byte for byte), its criteria (`--clear-ac`, then `--ac` for each, since 1.53 takes neither
//   with the other) and its references (`--ref` for each, which 1.53 reads as the whole list), each
//   only when it differs. A story that is gone, or in another status, no longer applies. The story
//   goes into the session's record once the revision applied.
// - `refine` turns a draft a triage session refined into a story Refined to the standard: Backlog's
//   `draft promote`, then what `file` writes, with a branch named for its new id (`refineKind`).
//
<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
// Labels are set only at `task create`, and a refined draft gets its tier label added; a revision
// never changes them (0010).
=======
// - `refine` (DIPO-454) turns a draft a triage session confirmed into a story: `draft promote`, which
//   gives it a new task id, then `task edit` with the filing's title, description, Refined status,
//   type, milestone, tier label, criteria, the draft's references with the refinement's added,
//   dependencies, and the field block with
//   the branch `<new ID>/<slug>`. The draft's own labels (`tech-debt`) stay. The target state is
//   a filing's: applied again it finds the task by its title and Story line and only fills in what
//   is missing. The new id goes into the session's record and on the draft's story key as
//   `promoted_to`, so the index renumbers the story to it (`story.renumbered`) once the backlog PR
//   merged, and the story keeps its key.
//
// Labels are set only at `task create` or a refinement; a revision never changes them (0010).
>>>>>>> de146a854c2be9713e40505688960f87444be951

import { join } from "node:path";
import { mkdirSync } from "node:fs";

import { StoryId } from "@dipsaus-orchestrator/contract";

import { recordStoryEntry } from "../../records/planning-record";
import { isProvisionalId, recordPromotion } from "../../records/story-keys";
import { BLOCK_OPEN, FieldBlockError, locateBlock } from "../../story-store/fields/block";
import {
  FILE_KIND,
  FileTarget,
  REFINE_KIND,
  RefineTarget,
  REVISE_KIND,
  ReviseTarget,
  storyDescription,
} from "../../story-store/planning";
import type { PlainTask } from "../../story-store/story";
import { FieldWriteError, viewStory, writeFields } from "../fields/write";
import { listAll } from "../list";
import { BacklogCommandError, type BacklogCli, runBacklog } from "../runner";
import { slug } from "../slug";

import type { ApplyContext, LaneOpKind } from "./ops";

export { FILE_KIND, REFINE_KIND, REVISE_KIND };

export { storyDescription };

/** The prefix of the Story line (0012 F3). */
const STORY_PREFIX = "Story: ";

/** The text above the field block, and the block from its opening line on ("" without one). */
function splitBlock(description: string): { readonly head: string; readonly block: string } {
  const location = locateBlock(description);
  if (location === undefined) return { head: description, block: "" };
  const open = description.lastIndexOf(BLOCK_OPEN, location.contentStart);
  return { head: description.slice(0, open), block: description.slice(open) };
}

/**
 * Pure: `current` with its Story line, its context or both replaced, the field block kept as it
 * is. A new context replaces every line above the block but the Story line, which goes first; a
 * new Story line replaces the first `Story:` line, or goes first when there is none. Throws
 * `FieldBlockError` when the block does not parse.
 */
export function revisedDescription(
  current: string,
  change: { readonly storyLine?: string | undefined; readonly context?: string | undefined },
): string {
  const { head, block } = splitBlock(current.replace(/\r\n/g, "\n"));
  const lines = head.split("\n");
  const at = lines.findIndex((line) => line.startsWith(STORY_PREFIX.trimEnd()));
  const oldLine = at < 0 ? null : (lines[at] ?? null);
  const storyLine =
    change.storyLine === undefined ? oldLine : `${STORY_PREFIX}${change.storyLine.trim()}`;
  let text: string;
  if (change.context !== undefined) {
    text = [storyLine, change.context.trim()].filter((part) => part !== null).join("\n\n");
  } else if (at >= 0) {
    text = lines.map((line, index) => (index === at ? (storyLine ?? line) : line)).join("\n");
  } else {
    text = [storyLine, head.trim()].filter((part) => part !== null && part !== "").join("\n\n");
  }
  text = text.trim();
  return block === "" ? text : `${text}\n\n${block.trimEnd()}`;
}

/** The CLI stores the description trimmed and with LF line endings; comparing also NFC-normalises. */
function comparable(text: string): string {
  return text.replace(/\r\n/g, "\n").normalize("NFC").trim();
}

/** True when the CLI failed because the story does not exist (0010). */
function isNotFound(error: unknown): boolean {
  return (
    error instanceof BacklogCommandError &&
    /\bnot found\b/i.test(`${error.stdout}\n${error.stderr}\n${error.message}`)
  );
}

/**
 * The id of the task filed for `target`: an active task with its title whose description's first
 * line is its Story line; null when there is none.
 */
export async function filedStory(
  ctx: { readonly cli: BacklogCli; readonly cwd: string },
  target: Pick<FileTarget, "title" | "description">,
): Promise<string | null> {
  const title = target.title.normalize("NFC").trim();
  const firstLine = comparable(target.description).split("\n")[0] ?? "";
  const list = await listAll(ctx.cli, ctx.cwd, "task");
  for (const entry of list.entries) {
    if (entry.title.trim() !== title) continue;
    const view = await viewStory({ cli: ctx.cli, cwd: ctx.cwd, id: entry.id });
    if ((comparable(view.description).split("\n")[0] ?? "") === firstLine) return entry.id;
  }
  return null;
}

/** The criteria texts of a view, in order. */
const criteriaOf = (view: PlainTask): string[] =>
  view.acceptanceCriteria.map((item) => item.text.trim());

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index]);

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item) => b.includes(item));

/** The field block a filed story holds: its branch, no unknowns and the test plan. */
async function fillFields(ctx: ApplyContext, id: string, target: FileTarget): Promise<void> {
  const story = { cli: ctx.cli, cwd: ctx.cwd, id };
  await writeFields(story, (fields) => ({
    ...fields,
    // The branch is frozen once the story has it (0012 F15).
    branch: fields.branch ?? `${id}/${slug(target.title)}`,
    unknowns: fields.unknowns ?? [],
    ...(target.testPlan === undefined ? {} : { test_plan: fields.test_plan ?? target.testPlan }),
  }));
}

/** Throws when the filed story `id` does not read back as `target` asks. */
async function checkFiled(ctx: ApplyContext, id: string, target: FileTarget): Promise<void> {
  const view = await viewStory({ cli: ctx.cli, cwd: ctx.cwd, id });
  const problems: string[] = [];
  if (view.status !== "Refined") problems.push(`its status is ${view.status}, not Refined`);
  if (!view.labels.includes(`tier:${target.tier}`)) problems.push(`it lacks tier:${target.tier}`);
  if (
    !sameList(
      criteriaOf(view),
      target.criteria.map((text) => text.trim()),
    )
  ) {
    problems.push("its criteria differ");
  }
  const missing = target.references.filter((path) => !view.references.includes(path));
  if (missing.length > 0) problems.push(`its references lack ${missing.join(", ")}`);
  if (problems.length > 0) {
    throw new FieldWriteError(id, `the filed story reads back wrong: ${problems.join("; ")}`);
  }
}

export const fileKind: LaneOpKind = {
  kind: FILE_KIND,
  async apply(ctx, raw) {
    const parsed = FileTarget.safeParse(raw);
    if (!parsed.success) {
      return {
        applies: false,
        reason: `the target is not a valid story to file: ${parsed.error.message}`,
      };
    }
    const target = parsed.data;
    let id = await filedStory(ctx, target);
    if (id === null) {
      // Backlog.md keeps tasks in `backlog/tasks`, which git does not keep while it is empty.
      mkdirSync(join(ctx.cwd, "backlog", "tasks"), { recursive: true });
      await runBacklog(ctx.cli, ctx.cwd, [
        "task",
        "create",
        target.title,
        "--description",
        target.description,
        "--status",
        "Refined",
        "--type",
        target.type,
        "--milestone",
        target.milestone,
        "--labels",
        `tier:${target.tier}`,
        "--no-dod-defaults",
        ...target.criteria.flatMap((text) => ["--ac", text]),
        ...target.references.flatMap((path) => ["--ref", path]),
        ...target.dependencies.flatMap((dep) => ["--dep", dep]),
      ]);
      id = await filedStory(ctx, target);
      if (id === null) {
        throw new FieldWriteError(
          ctx.story,
          "no task with the story's title and Story line is there after `task create`",
        );
      }
    }
    await fillFields(ctx, id, target);
    await checkFiled(ctx, id, target);
    const office = ctx.office;
    if (office !== undefined) {
      const story = id;
      office.immediate(() =>
        recordStoryEntry(office, target.run, {
          proposal: target.proposal,
          kind: "filed",
          story,
          at: ctx.entry.updatedAt,
        }),
      );
    }
    return { applies: true };
  },
};

/** What a revision asks a story to read: each field it changes. */
interface Revised {
  readonly title?: string;
  readonly description?: string;
  readonly criteria?: readonly string[];
  readonly references?: readonly string[];
}

/** The fields `target` asks of the story `view`; throws `FieldBlockError` (R02). */
function revisedOf(view: PlainTask, target: ReviseTarget): Revised {
  const describes = target.storyLine !== undefined || target.context !== undefined;
  return {
    ...(target.title === undefined ? {} : { title: target.title.trim() }),
    ...(describes ? { description: revisedDescription(view.description, target) } : {}),
    ...(target.criteria === undefined
      ? {}
      : { criteria: target.criteria.map((text) => text.trim()) }),
    ...(target.references === undefined ? {} : { references: target.references }),
  };
}

/** The fields of `view` that differ from `revised`, by name. */
function differences(view: PlainTask, revised: Revised): string[] {
  const differ: string[] = [];
  if (revised.title !== undefined && view.title.trim() !== revised.title) differ.push("title");
  if (
    revised.description !== undefined &&
    comparable(view.description) !== comparable(revised.description)
  ) {
    differ.push("description");
  }
  if (revised.criteria !== undefined && !sameList(criteriaOf(view), revised.criteria)) {
    differ.push("criteria");
  }
  if (revised.references !== undefined && !sameSet(view.references, revised.references)) {
    differ.push("references");
  }
  return differ;
}

/** The `task edit` calls that write the fields of `revised` that differ, in order. */
function revisionCalls(view: PlainTask, revised: Revised): string[][] {
  const calls: string[][] = [];
  for (const field of differences(view, revised)) {
    if (field === "title") calls.push(["--title", revised.title ?? ""]);
    if (field === "description") calls.push(["--description", revised.description ?? ""]);
    if (field === "criteria") {
      // 1.53 takes `--clear-ac` only on its own.
      if (view.acceptanceCriteria.length > 0) calls.push(["--clear-ac"]);
      calls.push((revised.criteria ?? []).flatMap((text) => ["--ac", text]));
    }
    if (field === "references") {
      calls.push((revised.references ?? []).flatMap((path) => ["--ref", path]));
    }
  }
  return calls;
}

export const reviseKind: LaneOpKind = {
  kind: REVISE_KIND,
  async apply(ctx, raw) {
    const parsed = ReviseTarget.safeParse(raw);
    if (!parsed.success) {
      return {
        applies: false,
        reason: `the target is not a valid revision: ${parsed.error.message}`,
      };
    }
    const target = parsed.data;
    const story = { cli: ctx.cli, cwd: ctx.cwd, id: ctx.story };
    let view: PlainTask;
    try {
      view = await viewStory(story, false);
    } catch (error) {
      if (isNotFound(error)) return { applies: false, reason: `${ctx.story} no longer exists` };
      throw error;
    }
    if (!target.from.includes(view.status)) {
      return {
        applies: false,
        reason: `${ctx.story} is ${view.status} now, not ${target.from.join(" or ")}`,
      };
    }
    let revised: Revised;
    try {
      revised = revisedOf(view, target);
    } catch (error) {
      // The story's block no longer parses (R02): the change cannot be applied as asked.
      if (error instanceof FieldBlockError) {
        return { applies: false, reason: `${ctx.story}: ${error.message}` };
      }
      throw error;
    }
    for (const args of revisionCalls(view, revised)) {
      await runBacklog(ctx.cli, ctx.cwd, ["task", "edit", ctx.story, ...args]);
    }
    const left = differences(await viewStory(story, false), revised);
    if (left.length > 0) {
      throw new FieldWriteError(ctx.story, `the revision reads back wrong: its ${left.join(", ")}`);
    }
    const office = ctx.office;
    if (office !== undefined) {
      office.immediate(() =>
        recordStoryEntry(office, target.run, {
          proposal: target.proposal,
          kind: "edited",
          story: ctx.story,
          at: ctx.entry.updatedAt,
        }),
      );
    }
    return { applies: true };
  },
};

<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
/**
 * The `task edit` calls that make the promoted task `view` read as `target` asks of a filing:
 * Refined, its type, milestone and tier label, its criteria, references and dependencies, each only
 * when it differs. The description was written on the draft before its promote.
 */
function refinementCalls(view: PlainTask, target: RefineTarget): string[][] {
  const calls: string[][] = [];
  const fields: string[] = [];
  if (view.status !== "Refined") fields.push("--status", "Refined");
  if (view.type !== target.type) fields.push("--type", target.type);
  if (view.milestone !== target.milestone) fields.push("--milestone", target.milestone);
  const tier = `tier:${target.tier}`;
  if (!view.labels.includes(tier)) fields.push("--add-label", tier);
  if (fields.length > 0) calls.push(fields);
  const criteria = target.criteria.map((text) => text.trim());
  if (!sameList(criteriaOf(view), criteria)) {
    // 1.53 takes `--clear-ac` only on its own.
    if (view.acceptanceCriteria.length > 0) calls.push(["--clear-ac"]);
    calls.push(criteria.flatMap((text) => ["--ac", text]));
  }
  if (!sameSet(view.references, target.references)) {
    calls.push(target.references.flatMap((path) => ["--ref", path]));
  }
  const deps = view.dependencies.map((dep) => dep.id.toUpperCase());
  if (!sameSet(deps, target.dependencies)) {
    calls.push(
      target.dependencies.length === 0
        ? ["--clear-deps"]
        : target.dependencies.flatMap((dep) => ["--dep", dep]),
    );
=======
/** The ids of the active tasks under `cwd`. */
async function taskIds(ctx: { readonly cli: BacklogCli; readonly cwd: string }): Promise<string[]> {
  return (await listAll(ctx.cli, ctx.cwd, "task")).entries.map((entry) => entry.id);
}

/**
 * Promotes the draft `ctx.story` to a task and returns the task's new id, the one task id the
 * promote added; null when the draft is gone or holds another title (it no longer applies).
 */
async function promoteDraft(ctx: ApplyContext, draftTitle: string): Promise<string | null> {
  let draft: PlainTask;
  try {
    draft = await viewStory({ cli: ctx.cli, cwd: ctx.cwd, id: ctx.story, kind: "draft" });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  // Backlog.md reuses draft ids: another draft under the same id is not the one confirmed.
  if (draft.title.normalize("NFC").trim() !== draftTitle.normalize("NFC").trim()) return null;
  const before = new Set(await taskIds(ctx));
  mkdirSync(join(ctx.cwd, "backlog", "tasks"), { recursive: true });
  await runBacklog(ctx.cli, ctx.cwd, ["draft", "promote", ctx.story]);
  const added = (await taskIds(ctx)).filter((id) => !before.has(id));
  if (added.length !== 1 || added[0] === undefined) {
    throw new FieldWriteError(
      ctx.story,
      `\`draft promote\` added ${added.length} tasks, not one: ${added.join(", ") || "none"}`,
    );
  }
  return added[0];
}

/** The `task edit` calls that make the promoted task `id` read as `target` asks. */
function refineCalls(view: PlainTask, target: RefineTarget): string[][] {
  const calls: string[][] = [
    [
      "--title",
      target.title,
      "--description",
      target.description,
      "--status",
      "Refined",
      "--type",
      target.type,
      "--milestone",
      target.milestone,
      "--add-label",
      `tier:${target.tier}`,
    ],
  ];
  if (!sameList(criteriaOf(view), target.criteria)) {
    // 1.53 takes `--clear-ac` only on its own.
    if (view.acceptanceCriteria.length > 0) calls.push(["--clear-ac"]);
    calls.push(target.criteria.flatMap((text) => ["--ac", text]));
  }
  // `--ref` replaces the whole list: the draft's own references stay, the refinement's join them.
  const references = [...new Set([...view.references, ...target.references])];
  if (!sameSet(view.references, references)) {
    calls.push(references.flatMap((path) => ["--ref", path]));
  }
  if (target.dependencies.length > 0) {
    calls.push(target.dependencies.flatMap((dep) => ["--dep", dep]));
>>>>>>> de146a854c2be9713e40505688960f87444be951
  }
  return calls;
}

<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
/**
 * The `refine` kind (DIPO-454): a draft a triage session refined becomes a story Refined to the
 * story standard. Its title and description (the Story line and context) are written on the draft,
 * Backlog's `draft promote` makes it a task with a new id, and the task then gets what a filing
 * gets: status Refined, type, milestone, tier label, criteria, references, dependencies, and the
 * field block with a branch named for its new id. The target state is "a task with the target's
 * title whose description starts with its Story line exists": applied again it finds that task and
 * only fills in what is missing. A draft that is gone, or whose title is not the one the
 * maintainer confirmed (a reused draft id), no longer applies. The promotion is recorded so the
 * story index renumbers the story (`story.renumbered`), and the new id goes into the session's
 * record.
 */
=======
/** Records the refined story: its id in the session's record and as the draft key's new id. */
function recordRefined(ctx: ApplyContext, target: RefineTarget, id: string): void {
  const office = ctx.office;
  if (office === undefined) return;
  office.immediate(() => {
    recordStoryEntry(office, target.run, {
      proposal: target.proposal,
      kind: "filed",
      story: id,
      at: ctx.entry.updatedAt,
    });
    if (ctx.entry.key !== null) {
      office.run(
        `update stories set promoted_to = $id
          where office_id = $office_id and key = $key and promoted_to is not $id`,
        { key: ctx.entry.key, id },
      );
    }
  });
}

>>>>>>> de146a854c2be9713e40505688960f87444be951
export const refineKind: LaneOpKind = {
  kind: REFINE_KIND,
  async apply(ctx, raw) {
    const parsed = RefineTarget.safeParse(raw);
    if (!parsed.success) {
      return {
        applies: false,
<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
        reason: `the target is not a valid draft to refine: ${parsed.error.message}`,
=======
        reason: `the target is not a valid refinement: ${parsed.error.message}`,
>>>>>>> de146a854c2be9713e40505688960f87444be951
      };
    }
    const target = parsed.data;
    let id = await filedStory(ctx, target);
    if (id === null) {
<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
      const draft = { cli: ctx.cli, cwd: ctx.cwd, id: ctx.story, kind: "draft" as const };
      let view: PlainTask;
      try {
        view = await viewStory(draft, false);
      } catch (error) {
        if (isNotFound(error)) return { applies: false, reason: `${ctx.story} is no draft now` };
        throw error;
      }
      if (view.title.normalize("NFC").trim() !== target.draftTitle.normalize("NFC").trim()) {
        return {
          applies: false,
          reason: `${ctx.story} is titled "${view.title}" now, not "${target.draftTitle}"`,
        };
      }
      // Title and description first, so the task the promote makes is found by them.
      await runBacklog(ctx.cli, ctx.cwd, [
        "draft",
        "edit",
        ctx.story,
        "--title",
        target.title,
        "--description",
        target.description,
      ]);
      mkdirSync(join(ctx.cwd, "backlog", "tasks"), { recursive: true });
      await runBacklog(ctx.cli, ctx.cwd, ["draft", "promote", ctx.story]);
      id = await filedStory(ctx, target);
      if (id === null) {
        throw new FieldWriteError(
          ctx.story,
          "no task with the story's title and Story line is there after `draft promote`",
        );
      }
    }
    const task = { cli: ctx.cli, cwd: ctx.cwd, id };
    for (const args of refinementCalls(await viewStory(task, false), target)) {
      await runBacklog(ctx.cli, ctx.cwd, ["task", "edit", id, ...args]);
    }
    await fillFields(ctx, id, target);
    await checkFiled(ctx, id, target);
    const office = ctx.office;
    const key = ctx.entry.key;
    if (office !== undefined) {
      const story = id;
      office.immediate(() => {
        if (key !== null && isProvisionalId(ctx.entry.subject)) {
          recordPromotion(
            office,
            { key, draft: StoryId.parse(ctx.entry.subject), story: StoryId.parse(story) },
            ctx.entry.updatedAt,
          );
        }
        recordStoryEntry(office, target.run, {
          proposal: target.proposal,
          story,
          kind: "refined",
          at: ctx.entry.updatedAt,
        });
      });
    }
=======
      id = await promoteDraft(ctx, target.draftTitle);
      if (id === null) {
        return {
          applies: false,
          reason: `${ctx.story} is no longer the draft "${target.draftTitle}"`,
        };
      }
      const view = await viewStory({ cli: ctx.cli, cwd: ctx.cwd, id }, false);
      for (const args of refineCalls(view, target)) {
        await runBacklog(ctx.cli, ctx.cwd, ["task", "edit", id, ...args]);
      }
    }
    await fillFields(ctx, id, target);
    await checkFiled(ctx, id, target);
    recordRefined(ctx, target, id);
>>>>>>> de146a854c2be9713e40505688960f87444be951
    return { applies: true };
  },
};
