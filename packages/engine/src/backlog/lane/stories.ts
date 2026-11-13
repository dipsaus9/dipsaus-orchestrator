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
// The maintainer's confirm is the Ready choice (DIPO-495, 0012, 0022): once a filed or refined
// story reads back as asked, the same operation runs the Ready gate (`ready` mode) on it as the
// `_backlog` worktree holds it (`ApplyContext.gate`, the evaluation and store `readyStories` uses)
// and stores the decision for its content hash, under no key, since the base does not hold the
// story yet. When the gate passes, the story is set Ready and read back; when it fails, or its
// content then reads other than the content the decision was for, it stays Refined. A revision of
// a Ready story is gated again the same way, under its key: it stays Ready when the gate passes the
// revised content and goes back to Refined when it fails. A revision of a Refined or Parked story
// keeps its status. What the gate decided is the operation's notice, which the planning view shows.
// Without a gate nothing is set Ready.
//
// Labels are set only at `task create` or a refinement; a revision never changes them (0010).

import { join } from "node:path";
import { mkdirSync } from "node:fs";

import type { StoryKey } from "@dipsaus-orchestrator/contract";

import { CommandError } from "../../commands/errors";
import { gateContentHash } from "../../gate/hash";
import { gateStoryFromView } from "../../gate/input";
import { recordStoryEntry } from "../../records/planning-record";
import { BLOCK_OPEN, FieldBlockError, locateBlock } from "../../story-store/fields/block";
import { readLabels } from "../../story-store/fields/labels";
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
  // Ready when an earlier apply of this target already passed the gate (DIPO-495).
  if (view.status !== REFINED && view.status !== READY) {
    problems.push(`its status is ${view.status}, not Refined`);
  }
  if (!view.labels.includes(`tier:${target.tier}`)) problems.push(`it lacks tier:${target.tier}`);
  if (!view.labels.includes(`role:${target.role}`)) problems.push(`it lacks role:${target.role}`);
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

/** The status a story is filed at, and the one the gate's pass sets (0012). */
const REFINED = "Refined";
const READY = "Ready";

/** The gate content hash of a view, as the gate and the structural check compute it. */
const contentHashOf = (view: PlainTask): string =>
  gateContentHash(
    gateStoryFromView(
      view,
      view.subtasks.map((task) => task.id),
    ),
  );

/** Sets the status of `id` and reads it back; throws `FieldWriteError` when it does not hold. */
async function setStatus(ctx: ApplyContext, id: string, status: string): Promise<PlainTask> {
  await runBacklog(ctx.cli, ctx.cwd, ["task", "edit", id, "--status", status]);
  const view = await viewStory({ cli: ctx.cli, cwd: ctx.cwd, id });
  if (view.status !== status) {
    throw new FieldWriteError(id, `status read back is ${view.status}, not ${status}`);
  }
  return view;
}

/**
 * Runs the Ready gate on the story `id` as the `_backlog` worktree holds it and leaves it Ready
 * when the gate passes, Refined otherwise (DIPO-495); returns what it decided, for the
 * operation's notice. The gate runs in `ready` mode, which wants the story Refined (R01a), so a
 * Ready story is set Refined first. Only a pass sets Ready, and only while the story then reads
 * back with the content the passing decision was for.
 */
async function gateToReady(ctx: ApplyContext, id: string, key: StoryKey | null): Promise<string> {
  if ((await viewStory({ cli: ctx.cli, cwd: ctx.cwd, id })).status !== REFINED) {
    await setStatus(ctx, id, REFINED);
  }
  const later = "set it Ready from the Queue once it is on the base";
  if (ctx.gate === undefined) return `${id} is Refined: no Ready gate runs here; ${later}`;
  let decision;
  try {
    decision = await ctx.gate(id, key);
  } catch (error) {
    // The gate could not read its inputs: the story stays Refined rather than blocking the lane.
    if (!(error instanceof CommandError)) throw error;
    return `${id} is Refined: the Ready gate could not run (${error.message}); ${later}`;
  }
  if (!decision.result.passed) {
    // Each message names the story, the rule and why (`ready <ID> failed <rule>: ...`).
    const failures = decision.result.failures.map((failure) => failure.message);
    return `${id} is Refined: ${failures.join("; ")}`;
  }
  const ready = await setStatus(ctx, id, READY);
  if (contentHashOf(ready) !== decision.contentHash) {
    await setStatus(ctx, id, REFINED);
    return `${id} is Refined: it read back with other content than the Ready gate passed; ${later}`;
  }
  return `${id} is Ready: the Ready gate passed it`;
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
        `tier:${target.tier},role:${target.role}`,
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
    const notice = await gateToReady(ctx, id, null);
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
    return { applies: true, notice };
  },
};

/** What a revision asks a story to read: each field it changes. */
interface Revised {
  readonly title?: string;
  readonly description?: string;
  readonly criteria?: readonly string[];
  readonly references?: readonly string[];
  readonly dependencies?: readonly string[];
  readonly role?: string;
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
    ...(target.dependencies === undefined ? {} : { dependencies: target.dependencies }),
    ...(target.role === undefined ? {} : { role: target.role }),
  };
}

/** The `role:` labels of a view. */
const roleLabels = (view: PlainTask): string[] =>
  readLabels(view.labels).roles.map((name) => `role:${name}`);

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
  if (
    revised.dependencies !== undefined &&
    !sameSet(
      view.dependencies.map((dependency) => dependency.id.toUpperCase()),
      revised.dependencies,
    )
  ) {
    differ.push("dependencies");
  }
  if (revised.role !== undefined && !sameSet(roleLabels(view), [`role:${revised.role}`])) {
    differ.push("role");
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
    if (field === "role") {
      const labels = roleLabels(view).filter((label) => label !== `role:${revised.role}`);
      calls.push([
        ...labels.flatMap((label) => ["--remove-label", label]),
        "--add-label",
        `role:${revised.role}`,
      ]);
    }
    if (field === "dependencies") {
      // 1.53 replaces the whole list; `--dep ""` clears it.
      const deps = revised.dependencies ?? [];
      calls.push(deps.length === 0 ? ["--dep", ""] : deps.flatMap((dep) => ["--dep", dep]));
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
    const roleChanged = differences(view, revised).includes("role");
    const calls = revisionCalls(view, revised);
    for (const args of calls) {
      await runBacklog(ctx.cli, ctx.cwd, ["task", "edit", ctx.story, ...args]);
    }
    const left = differences(await viewStory(story, false), revised);
    if (left.length > 0) {
      throw new FieldWriteError(ctx.story, `the revision reads back wrong: its ${left.join(", ")}`);
    }
    // A Ready story is gated again on its revised content (DIPO-495); any other keeps its status.
    // A new role sends it back to Refined for the daemon's Ready gate to decide under that role.
    let notice: string | undefined;
    // A revision that changes nothing moves nothing.
    if (view.status === READY && (roleChanged || calls.length > 0)) {
      if (roleChanged) {
        await setStatus(ctx, ctx.story, REFINED);
        notice = `${ctx.story} is Refined: its role changed to ${target.role}; the Ready gate decides it again`;
      } else {
        notice = await gateToReady(ctx, ctx.story, ctx.entry.key);
      }
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
    return notice === undefined ? { applies: true } : { applies: true, notice };
  },
};

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
      "--add-label",
      `role:${target.role}`,
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
  }
  return calls;
}

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

export const refineKind: LaneOpKind = {
  kind: REFINE_KIND,
  async apply(ctx, raw) {
    const parsed = RefineTarget.safeParse(raw);
    if (!parsed.success) {
      return {
        applies: false,
        reason: `the target is not a valid refinement: ${parsed.error.message}`,
      };
    }
    const target = parsed.data;
    let id = await filedStory(ctx, target);
    if (id === null) {
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
    const notice = await gateToReady(ctx, id, null);
    recordRefined(ctx, target, id);
    return { applies: true, notice };
  },
};
