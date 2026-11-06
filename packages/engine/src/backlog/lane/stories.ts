// The lane-b kinds `file` and `revise` (DIPO-450; 0010, 0022): what a planning session's
// confirmed proposals change in the backlog. Both are target states, applied through the Backlog CLI
// in the `_backlog` worktree and read back.
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
//
// Labels are set only at `task create`; a revision never changes them (0010).

import { join } from "node:path";
import { mkdirSync } from "node:fs";

import { recordStoryEntry } from "../../records/planning-record";
import { BLOCK_OPEN, FieldBlockError, locateBlock } from "../../story-store/fields/block";
import {
  FILE_KIND,
  FileTarget,
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

export { FILE_KIND, REVISE_KIND };

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
