// The single write path for a story's fields (0010 section 3), the same in both lanes: view, parse,
// change the typed value, emit canonically, splice so every byte outside the block is unchanged,
// write with `task edit --description` (or `draft edit`), read back and compare. Just before writing
// the description is read again; if it changed since the first read, it is parsed again and the
// target-state change reapplied. Labels change only with `--add-label` and `--remove-label`.
//
// Two values are the same when their canonical emits are the same, so an absent key and a key set
// to `undefined` compare equal.
//
// Callers serialise writes per worktree (one write queue per worktree); this module does not queue.

import { FieldBlock } from "@dipsaus-orchestrator/contract";

import { parseView, type PlainTask } from "../plain";
import { runBacklog, type BacklogCli } from "../runner";
import { emitFieldBlock, parseFieldBlock, spliceFieldBlock } from "./block";
import { labelEditArgs, readLabels, type LabelChange, type StoryLabels } from "./labels";

/** A story the engine writes: a task or a draft, by id, in the worktree `cwd`. */
export interface StoryTarget {
  readonly cli: BacklogCli;
  readonly cwd: string;
  readonly id: string;
  /** `task` by default. */
  readonly kind?: "task" | "draft";
}

/** How many times a write re-reads a description that changed under it before giving up. */
export const MAX_WRITE_ATTEMPTS = 3;

/** A write the CLI did not apply as asked, or that kept racing another writer. */
export class FieldWriteError extends Error {
  constructor(
    readonly id: string,
    reason: string,
  ) {
    super(`writing the fields of ${id} failed: ${reason}`);
    this.name = "FieldWriteError";
  }
}

/** `<kind> view <id> --plain`, parsed. */
export async function viewStory(target: StoryTarget): Promise<PlainTask> {
  const { stdout } = await runBacklog(target.cli, target.cwd, [
    target.kind ?? "task",
    "view",
    target.id,
    "--plain",
  ]);
  return parseView(stdout);
}

/** The CLI stores the description trimmed; the parser NFC-normalises it. */
function comparable(description: string): string {
  return description.normalize("NFC").trim();
}

/**
 * Applies the target-state `change` to the story's field block and writes it through the single
 * write path. Returns the value now stored. Throws `FieldBlockError` (R02) when the description's
 * block does not parse, and `FieldWriteError` when the read back differs or the description kept
 * changing between reads.
 */
export async function writeFields(
  target: StoryTarget,
  change: (fields: FieldBlock) => FieldBlock,
): Promise<FieldBlock> {
  let read = (await viewStory(target)).description;
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const { fields } = parseFieldBlock(read);
    const next = FieldBlock.parse(change(fields));
    if (emitFieldBlock(next) === emitFieldBlock(fields)) return fields;
    const description = spliceFieldBlock(read, next);

    const latest = (await viewStory(target)).description;
    if (latest !== read) {
      read = latest;
      continue;
    }

    await runBacklog(target.cli, target.cwd, [
      target.kind ?? "task",
      "edit",
      target.id,
      "--description",
      description,
    ]);

    const back = (await viewStory(target)).description;
    if (comparable(back) !== comparable(description)) {
      throw new FieldWriteError(
        target.id,
        "the description read back differs from the one written",
      );
    }
    const stored = parseFieldBlock(back).fields;
    if (emitFieldBlock(stored) !== emitFieldBlock(next)) {
      throw new FieldWriteError(
        target.id,
        "the field block read back differs from the one written",
      );
    }
    return stored;
  }
  throw new FieldWriteError(
    target.id,
    `the description changed between reads ${MAX_WRITE_ATTEMPTS} times`,
  );
}

/**
 * Adds and removes labels with `--add-label` and `--remove-label` only, reads back and checks that
 * every added label is present and every removed one gone. Returns the labels now stored.
 */
export async function editLabels(target: StoryTarget, change: LabelChange): Promise<StoryLabels> {
  const args = labelEditArgs(change);
  if (args.length > 0) {
    await runBacklog(target.cli, target.cwd, [target.kind ?? "task", "edit", target.id, ...args]);
  }
  const labels = (await viewStory(target)).labels;
  const missing = (change.add ?? []).filter((label) => !labels.includes(label));
  const left = (change.remove ?? []).filter((label) => labels.includes(label));
  if (missing.length > 0 || left.length > 0) {
    throw new FieldWriteError(
      target.id,
      `labels read back differ: missing ${JSON.stringify(missing)}, still present ${JSON.stringify(left)}`,
    );
  }
  return readLabels(labels);
}
