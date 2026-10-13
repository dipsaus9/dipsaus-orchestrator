// Lane-b operation kinds (0010 section 2). An operation is a target state: applying it twice, or
// again on a newer base, leaves the story the same. A kind applies its target through the Backlog
// CLI in the `_backlog` worktree and answers whether it still applies; the lane commits whatever
// changed. The lane calls `apply` only inside its office's git queue item, so every CLI write,
// `writeFields` and `editLabels` included, runs in the serial queue (DIPO-31).
//
// The built-in kind `edit` sets a story's status, field-block keys and labels. Later stories add
// their own kinds with `editKind(name)` (for example `hold` or `ready`) or a kind of their own.

import { z } from "zod";

import { FieldBlockError } from "../fields/block";
import { editLabels, FieldWriteError, viewStory, writeFields } from "../fields/write";
import type { PlainTask } from "../plain";
import { BacklogCommandError, runBacklog, type BacklogCli } from "../runner";

import type { JournalEntry } from "./journal";

export interface ApplyContext {
  readonly cli: BacklogCli;
  /** The `_backlog` worktree. */
  readonly cwd: string;
  /** The story's current id (from its key when the engine knows it), else the op's subject. */
  readonly story: string;
  readonly entry: JournalEntry;
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

/** The target state of an `edit`. */
export const EditTarget = z
  .object({
    /** `task` (default) or `draft`. */
    kind: z.enum(["task", "draft"]).optional(),
    /** Applies only while the story's status is one of these; otherwise it is dropped. */
    from: z.array(z.string().min(1)).min(1).optional(),
    status: z.string().min(1).optional(),
    /** Field-block keys to set (0010 section 3). */
    fields: z.record(z.string(), z.unknown()).optional(),
    /** Field-block keys to remove. */
    unset: z.array(z.string()).optional(),
    labels: z
      .object({
        add: z.array(z.string()).optional(),
        remove: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .strict();
export type EditTarget = z.infer<typeof EditTarget>;

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
        throw error;
      }
      return { applies: true };
    },
  };
}

/** The built-in `edit` kind. */
export const EDIT_KIND = "edit";
