// Lane-b operation kinds (0010 section 2). An operation is a target state: applying it twice, or
// again on a newer base, leaves the story the same. A kind applies its target through the Backlog
// CLI in the `_backlog` worktree and answers whether it still applies; the lane commits whatever
// changed. The lane calls `apply` only inside its office's git queue item, so every CLI write,
// `writeFields` and `editLabels` included, runs in the serial queue (DIPO-31).
//
// The built-in kind `edit` sets a story's status, field-block keys and labels. Later stories add
// their own kinds with `editKind(name)` (for example `hold` or `ready`) or a kind of their own.
// A status change the runner refuses because a Backlog file of the `_backlog` worktree defines a
// command for the CLI to run on it (`BacklogStatusCommandError`, DIPO-312; the runner raised the
// `engine.notice`) no longer applies: the operation is dropped with that reason, not retried.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { OfficeHandle } from "../../db/office";
import { editLabels, FieldWriteError, viewStory, writeFields } from "../fields/write";
import { FieldBlockError } from "../../story-store/fields/block";
import {
  DISCARD_KIND,
  DROP_KIND,
  DropTarget,
  EDIT_KIND,
  EditTarget,
  HOLD_KIND,
  RESUME_KIND,
} from "../../story-store/planning";
import type { PlainTask } from "../../story-store/story";
import {
  BacklogCommandError,
  BacklogStatusCommandError,
  runBacklog,
  type BacklogCli,
} from "../runner";

import type { JournalEntry } from "./journal";

export interface ApplyContext {
  readonly cli: BacklogCli;
  /** The `_backlog` worktree. */
  readonly cwd: string;
  /** The story's current id (from its key when the engine knows it), else the op's subject. */
  readonly story: string;
  readonly entry: JournalEntry;
  /**
   * The office's state database, for a kind that records what it created (the draft id of an
   * accepted proposal, DIPO-166). Absent where a test applies a kind by hand.
   */
  readonly office?: OfficeHandle;
}

export type ApplyOutcome =
  | { readonly applies: true }
  /** The operation no longer applies (the story changed or vanished); it is dropped. */
  | { readonly applies: false; readonly reason: string };

export interface LaneOpKind {
  readonly kind: string;
  /** Paths outside `backlog/` the kind may change, relative to the repository root. */
  readonly paths?: readonly string[];
  apply(ctx: ApplyContext, target: unknown): Promise<ApplyOutcome>;
}

// The target-state model is the seam's (`story-store/planning.ts`); the kinds apply it here.
export { DISCARD_KIND, DROP_KIND, DropTarget, EDIT_KIND, EditTarget, HOLD_KIND, RESUME_KIND };

/** True when the CLI failed because the story does not exist (0010 fact 3). */
function isNotFound(error: unknown): boolean {
  return (
    error instanceof BacklogCommandError &&
    /\bnot found\b/i.test(`${error.stdout}\n${error.stderr}\n${error.message}`)
  );
}

/** An `edit` kind under `name`: status, field-block keys and labels, each only when it differs. */
export function editKind(name: string): LaneOpKind {
  return {
    kind: name,
    async apply(ctx, raw) {
      const parsed = EditTarget.safeParse(raw);
      if (!parsed.success) {
        return {
          applies: false,
          reason: `the target is not a valid edit: ${parsed.error.message}`,
        };
      }
      const target = parsed.data;
      const story = { cli: ctx.cli, cwd: ctx.cwd, id: ctx.story, kind: target.kind ?? "task" };
      let view: PlainTask;
      try {
        view = await viewStory(story);
      } catch (error) {
        if (isNotFound(error)) return { applies: false, reason: `${ctx.story} no longer exists` };
        throw error;
      }
      if (target.from !== undefined && !target.from.includes(view.status)) {
        return {
          applies: false,
          reason: `${ctx.story} is ${view.status} now, not ${target.from.join(" or ")}`,
        };
      }
      try {
        if (target.status !== undefined && target.status !== view.status) {
          await runBacklog(ctx.cli, ctx.cwd, [
            story.kind,
            "edit",
            ctx.story,
            "--status",
            target.status,
          ]);
          const back = (await viewStory(story)).status;
          if (back !== target.status) {
            throw new FieldWriteError(
              ctx.story,
              `status read back is ${back}, not ${target.status}`,
            );
          }
        }
        const sets = target.fields ?? {};
        const unset = target.unset ?? [];
        if (Object.keys(sets).length > 0 || unset.length > 0) {
          await writeFields(story, (fields) => {
            const next: Record<string, unknown> = { ...fields, ...sets };
            for (const key of unset) delete next[key];
            return next as typeof fields;
          });
        }
        if (target.labels !== undefined) {
          const add = (target.labels.add ?? []).filter((label) => !view.labels.includes(label));
          const remove = (target.labels.remove ?? []).filter((label) =>
            view.labels.includes(label),
          );
          if (add.length > 0 || remove.length > 0) await editLabels(story, { add, remove });
        }
      } catch (error) {
        // The story's block no longer parses (R02): the change cannot be applied as asked.
        if (error instanceof FieldBlockError) {
          return { applies: false, reason: `${ctx.story}: ${error.message}` };
        }
        if (error instanceof BacklogStatusCommandError) {
          return { applies: false, reason: error.reason };
        }
        throw error;
      }
      return { applies: true };
    },
  };
}

/**
 * The `drop` kind: archives the story (`task archive` or `draft archive`). The CLI fails without
 * its archive folder (DIPO-32), so the folder is created first. A story that is gone already is
 * the target state, so the operation is dropped with its reason rather than failing.
 */
export const dropKind: LaneOpKind = {
  kind: DROP_KIND,
  async apply(ctx, raw) {
    const parsed = DropTarget.safeParse(raw);
    if (!parsed.success) {
      return { applies: false, reason: `the target is not a valid drop: ${parsed.error.message}` };
    }
    const kind = parsed.data.kind ?? "task";
    const story = { cli: ctx.cli, cwd: ctx.cwd, id: ctx.story, kind };
    try {
      await viewStory(story);
    } catch (error) {
      if (isNotFound(error)) return { applies: false, reason: `${ctx.story} no longer exists` };
      throw error;
    }
    mkdirSync(join(ctx.cwd, "backlog", "archive", kind === "task" ? "tasks" : "drafts"), {
      recursive: true,
    });
    await runBacklog(ctx.cli, ctx.cwd, [kind, "archive", ctx.story]);
    try {
      await viewStory(story);
    } catch (error) {
      if (isNotFound(error)) return { applies: true };
      throw error;
    }
    throw new FieldWriteError(ctx.story, "the story is still there after it was archived");
  },
};
