// Changed files and collisions of box runs (0021 section 12 and maintainer decisions 1 and 20,
// DIPO-277). References are only the planner's forecast; what counts is what each story really
// changed, and two stories in progress that change the same files both continue.
//
// - Changed files. A story's changed files are the paths its delivered parts changed: the story
//   branch's tip against its start commit, read from git (`storyChangedFiles`), never from the
//   worker's own list. After a catch-up the branch holds the new base, so the start point is the
//   merge base of the tip and the base when the start commit lies below it. `backlog/` is left out:
//   only dipo writes it, never a part (`protectedKind`).
// - Overlaps. Every pass compares the changed files of the live box runs of each office with the
//   prefix rule (0012, 0010 section 10): two paths overlap when they are equal or one is a folder
//   above the other. A new overlap (another pair of stories, or more paths) is told to the maintainer
//   as an `engine.notice` (the TUI and `dipo watch` show it) and to both workers as a message. What
//   was told lives in memory only: after a daemon restart an overlap still in place is told once
//   more. That is accepted; it is a notice and a message, never a change.
// - Catching up. The second story catches up once the first has merged: when the base branch holds
//   changes, since the story's merge base, to files the story changed too. The check is git's own
//   merge (`git merge-tree --write-tree`, from git objects alone, no checkout, no model). First the
//   box's work is taken as a part, so the branch tip is the box's code. Then, in the run's turn of
//   `BoxParts` (no other part is taken in between):
//   1. dipo commits the merge from git objects (`commit-tree` with the tip and the base as parents);
//   2. it stages the paths the merge changed against the tip, outside `backlog/` (dipo's task-file
//      commits never reach the box, `readView`), from a `git archive` of the merge, and checks that
//      every staged path is there with the mode and blob of the merge: `export-ignore` or
//      `export-subst` attributes would otherwise drop or rewrite a file, which fails the catch-up;
//   3. it takes one more part from the box: a worker that changed files since the first part would
//      lose them under the copy. Then dipo plans again on the new tip, once; a worker that keeps
//      changing files parks the story;
//   4. it removes and writes those paths in the box; only then the branch moves to the merge
//      (`update-ref` from the tip read), and it is pushed without force;
//   5. the maintainer gets a notice and the worker a message naming the files.
//   The box is written before the branch moves: a box that kept the old files while the branch held
//   the new ones would hand them back as the worker's next part and undo the merge. A stage or box
//   copy that fails, or a branch that moved meanwhile, parks the story (`catch-up-failed`), since
//   box and branch may then differ; a rejected push parks it `push-rejected`. A few seconds stay
//   between the last part and the box write in which a worker's edit to a merged file is lost.
// - A conflict starts a fix round. When git cannot merge cleanly the merge is committed as git left
//   it, copied into the box the same way, and the worker is told which files conflicted and how
//   (content, modify/delete, binary, file vs folder, from git's own messages), and to resolve them
//   and hand a part. Only content conflicts carry git's markers. Committing what git left keeps the
//   box and the branch on the same tree, so the worker's resolution is an ordinary part (scanned
//   like any other); holding the base back as a second parent of the next part instead would make
//   the base's own changes look like the worker's, and a base change to a protected file
//   (`.github/`) would park the story. The message ends with the conflict hunks as git left them
//   (`conflictFeedbackItem`, within the item budget), and the merge is recorded (`recorded`), so
//   the check at done can refuse In Review while a marker line remains (DIPO-149).
// - Paths the worker cannot write (DIPO-149, 0019 section 10). A conflict in the story's own task
//   file is dipo's: the merge takes the base's version of it (a temporary index in dipo's stage
//   folder, from git objects), and once the branch moved the branch's status is written back
//   through the single field write path (`taskStatus`). A conflict in any other protected path
//   (`protectedKind`: the rest of `backlog/`, `.dipo/`, `.github/`, the Claude settings, git's
//   attribute files, and the configuration of the Backlog CLI, Bun and Claude Code's MCP servers),
//   or a task-file conflict other than in its content, merges nothing, into neither the branch nor
//   the box, and parks `conflict` with cause `unwritable-path`.
// - The sync before In Review (`syncInTurn`, DIPO-149): verify and commit runs the same catch-up
//   at done, in the run's held turn, for a riskier story whenever the base moved and for any other
//   on a conflict; the caller tells the worker. Both are planned on git's merge alone, never on the
//   overlap of changed files: a re-claimed branch's earlier work lies below its start commit. A
//   merge that changed a lockfile installs the office's packages in the box again (`reinstall`,
//   the launch's install). Accepted: a conflicted catch-up during a fix round pushes the merge, its
//   markers included, to the story branch and so to its open PR; the check at done keeps that head
//   from review until the worker resolved it.
// - Stories In Review (`inReview`, DIPO-149): each pass checks their tips against the base with the
//   same plan, once per tip and base commit (remembered in memory), and hands a conflict to
//   `found`, a clean merge to `cleared`; nothing is merged until their next sync.
//
// Every git call runs on the repository without a work tree through the office git queue, with the
// hardened config, hooks off and filters off (`filtersOffConfig`); none runs in a folder the worker
// writes. The merge and the archives also run with no attributes file, no in-tree attributes
// (`attr.tree` the empty tree) and every configured merge driver blanked (`mergeOffConfig`): no
// driver program runs, and a path the repository's own `info/attributes` hands to one comes out as a
// conflict. The box is reached only through the box interface: `exec` with argv (`rm`), never a
// shell line, and `copyIn` of a folder dipo made.

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readlink, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import type { OfficeId, TimerHandle } from "@dipsaus-orchestrator/contract";

import { isTaskFileOf, TASKS_DIR } from "../backlog/runner";
import { BASE_CHECKOUT_ENV } from "../git/hardened";
import type { GitSession, OfficeGit } from "../git/office";
import { EXTERNAL_STEP_TIMEOUT_MS, GitError } from "../git/runner";
import { type PushResult, pushBranch } from "../git/task-commit";
import conflictMarkersTemplate from "../prompts/feedback/conflict-markers.md" with { type: "text" };
import conflictTemplate from "../prompts/feedback/conflict.md" with { type: "text" };
import { neutraliseTags, renderTemplate } from "../prompts/templates";
import { BOX_WORKDIR, type BoxCodeDeps, filtersOffConfig, unpack } from "./code";
import { cleanDoorText } from "./door";
import {
  blobId,
  type BoxParts,
  type PartPark,
  partPark,
  type PartRun,
  partSubject,
  protectedKind,
  unsafePath,
} from "./parts";
import { BoxError, type BoxPort } from "./port";
import { copyInAsUser } from "./user";

/** How often the live box runs are compared and caught up. */
export const COLLISION_POLL_MS = 60_000;
/** The prefix of the stage folder of one catch-up in dipo's temp root. */
export const CATCH_UP_STAGE_PREFIX = "dipo-box-catch-up-";
/** How long one command in the box may take while the merge is copied in. */
export const CATCH_UP_EXEC_TIMEOUT_MS = 60_000;
/** The message of the parts dipo takes from the box before it merges. */
export const CATCH_UP_PART_MESSAGE = "Work in progress before dipo merges the new base";
/** How often a catch-up is planned when the worker changed files during it. */
export const CATCH_UP_ATTEMPTS = 2;
/** How many paths a notice or message names; the rest are counted. */
export const SHOWN_PATHS_MAX = 20;
/** How many paths one git or box call names. */
const PATHS_PER_CALL = 100;
/** How much of a staged file one hash read takes. */
const HASH_CHUNK = 1024 * 1024;
/** The empty tree, by object format: the in-tree attributes git reads for a catch-up. */
const EMPTY_TREE = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
} as const;

/** `engine.notice` codes of overlaps and catch-ups. */
export const COLLISION_NOTICES = {
  overlap: "box.storiesOverlap",
  caughtUp: "box.caughtUp",
  conflict: "box.catchUpConflict",
  /** A conflict in a path the worker cannot write: nothing merged, the story parks (DIPO-149). */
  unwritable: "box.catchUpUnwritable",
  failed: "box.catchUpFailed",
  /** The story's own task file conflicted and dipo could not write its status back (DIPO-149). */
  taskFile: "box.catchUpTaskFile",
} as const;

/** The park causes of a catch-up. */
export const CATCH_UP_CAUSES = {
  failed: "catch-up-failed",
  pushRejected: "push-rejected",
  /** 0019 section 10: a conflict in a path the worker cannot write (`PARK_CAUSES.unwritablePath`). */
  unwritablePath: "unwritable-path",
} as const;

/** The most bytes of one conflicted file read for its hunks; a larger file is named only. */
export const CONFLICT_FILE_READ_MAX = 1024 * 1024;
/** Lines of context shown around each conflict hunk. */
export const CONFLICT_CONTEXT_LINES = 2;
/** The most marker lines named per file when markers are left at done. */
export const MARKER_LINES_SHOWN = 5;

// ---- the prefix rule -----------------------------------------------------------------------------

/** True when `a` and `b` are the same path or one is a folder above the other. */
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** The folders above `path`: `a/b/c` gives `a` and `a/b`. */
function foldersAbove(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(1).map((_, at) => parts.slice(0, at + 1).join("/"));
}

/** Pure: the paths of `mine` that overlap a path of `theirs` by the prefix rule, sorted. */
export function overlappingPaths(mine: readonly string[], theirs: readonly string[]): string[] {
  const exact = new Set(theirs);
  const above = new Set(theirs.flatMap(foldersAbove));
  const found = new Set<string>();
  for (const path of mine) {
    if (exact.has(path) || above.has(path) || foldersAbove(path).some((dir) => exact.has(dir))) {
      found.add(path);
    }
  }
  return [...found].toSorted();
}

/** One story's changed files. */
export interface StoryChanges {
  readonly runId: string;
  readonly story: string;
  readonly files: readonly string[];
}

/** Two stories in progress that change overlapping files. */
export interface StoryOverlap {
  readonly a: { readonly runId: string; readonly story: string };
  readonly b: { readonly runId: string; readonly story: string };
  /** The overlapping paths of both, sorted. */
  readonly paths: readonly string[];
}

/** Pure: every pair of `stories` whose changed files overlap, in the order given. */
export function findOverlaps(stories: readonly StoryChanges[]): StoryOverlap[] {
  const overlaps: StoryOverlap[] = [];
  for (let i = 0; i < stories.length; i += 1) {
    for (let j = i + 1; j < stories.length; j += 1) {
      const a = stories[i]!;
      const b = stories[j]!;
      const paths = new Set([
        ...overlappingPaths(a.files, b.files),
        ...overlappingPaths(b.files, a.files),
      ]);
      if (paths.size === 0) continue;
      overlaps.push({
        a: { runId: a.runId, story: a.story },
        b: { runId: b.runId, story: b.story },
        paths: [...paths].toSorted(),
      });
    }
  }
  return overlaps;
}

/** Pure: what makes an overlap new: its two runs, in either order, and its paths. */
export function overlapSignature(overlap: StoryOverlap): string {
  const runs = [overlap.a.runId, overlap.b.runId].toSorted();
  return JSON.stringify([...runs, ...overlap.paths]);
}

// ---- conflicts -----------------------------------------------------------------------------------

/** How a file conflicted, from git's own message about it. */
export type ConflictKind = "content" | "deleted" | "binary" | "folder" | "other";

/** One file git could not merge cleanly. */
export interface ConflictFile {
  readonly path: string;
  readonly kind: ConflictKind;
}

/** A path named by several messages takes the first of these kinds. */
const KIND_ORDER: readonly ConflictKind[] = ["binary", "folder", "deleted", "content", "other"];

/** The name of each kind in a notice or message. */
export const CONFLICT_KIND_TEXT: Readonly<Record<ConflictKind, string>> = {
  content: "content",
  deleted: "modify/delete",
  binary: "binary",
  folder: "file vs folder",
  other: "other",
};

/** What the worker does about each kind. */
const CONFLICT_KIND_HELP: Readonly<Record<ConflictKind, string>> = {
  content:
    "In a content conflict both sides changed the same lines: git marked them with its conflict markers (<<<<<<<, =======, >>>>>>>) where it could place them; keep both changes where they belong and remove the markers.",
  deleted:
    "In a modify/delete conflict one side changed a file the other deleted: git kept the changed version; decide whether the file stays.",
  binary:
    "In a binary conflict git could not merge the file and kept your version: bring in the base's change by hand.",
  folder:
    "In a file vs folder conflict a file and a folder share one name: git moved one of them to a name ending in `~` and a branch name; put each where it belongs.",
  other: "In any other conflict check what git left in the file.",
};

/** The kind of a merge-tree message type, or null for one that names no conflict. */
function kindOfType(type: string): ConflictKind | null {
  if (!type.startsWith("CONFLICT")) return null;
  if (type.includes("binary")) return "binary";
  if (type.includes("file/directory") || type.includes("directory/file")) return "folder";
  if (type.includes("/delete") || type.includes("delete/")) return "deleted";
  if (type.includes("content")) return "content";
  return "other";
}

/**
 * Pure: the tree and the conflicted files of `git merge-tree --write-tree --name-only -z`: the
 * tree, the conflicted paths, an empty item, then each informational message as its count of
 * paths, the paths, its type and its text. A conflicted path no message names is `other`.
 */
export function parseMergeTree(output: string): {
  readonly tree: string;
  readonly conflicts: ConflictFile[];
} {
  const items = output.split("\0");
  const tree = items[0] ?? "";
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(tree)) {
    throw new GitError("git.failed", "git merge-tree printed no tree.");
  }
  let at = 1;
  const paths = new Set<string>();
  for (; at < items.length && items[at] !== ""; at += 1) paths.add(items[at]!);
  at += 1;
  const kinds = new Map<string, ConflictKind>();
  while (at < items.length) {
    const count = Number(items[at]);
    if (!Number.isInteger(count) || count < 1) break;
    const named = items.slice(at + 1, at + 1 + count);
    const kind = kindOfType(items[at + 1 + count] ?? "");
    at += count + 3;
    if (kind === null) continue;
    for (const path of named) {
      const was = kinds.get(path);
      if (was === undefined || KIND_ORDER.indexOf(kind) < KIND_ORDER.indexOf(was)) {
        kinds.set(path, kind);
      }
    }
  }
  return {
    tree,
    conflicts: [...paths].toSorted().map((path) => ({ path, kind: kinds.get(path) ?? "other" })),
  };
}

/** Pure: the kinds present in `conflicts`, in `KIND_ORDER`. */
function kindsOf(conflicts: readonly ConflictFile[]): ConflictKind[] {
  return KIND_ORDER.filter((kind) => conflicts.some((file) => file.kind === kind));
}

// ---- the texts -----------------------------------------------------------------------------------

/** Pure: `paths` cleaned for a notice or message, at most `SHOWN_PATHS_MAX`, the rest counted. */
export function shownPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, SHOWN_PATHS_MAX).map((path) => cleanDoorText(path).slice(0, 300));
  const rest = paths.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/** Pure: the conflicted files grouped by kind: `content: a.ts, b.ts; binary: logo.png`. */
export function conflictSummary(conflicts: readonly ConflictFile[]): string {
  return kindsOf(conflicts)
    .map(
      (kind) =>
        `${CONFLICT_KIND_TEXT[kind]}: ${shownPaths(conflicts.filter((f) => f.kind === kind).map((f) => f.path))}`,
    )
    .join("; ");
}

function files(n: number): string {
  return n === 1 ? "1 file" : `${n} files`;
}

/** Pure: the maintainer's notice of an overlap. */
export function overlapNotice(overlap: StoryOverlap): string {
  return `${overlap.a.story} and ${overlap.b.story} are both in progress and change the same ${files(overlap.paths.length)}: ${shownPaths(overlap.paths)}. Both continue; when one merges, dipo merges the new base into the other's branch and box.`;
}

/** Pure: the message to a worker whose story overlaps `other`'s. */
export function overlapMessage(other: string, paths: readonly string[]): string {
  return `dipo: another story in progress, ${other}, changes the same ${files(paths.length)} as you: ${shownPaths(paths)}. Both stories continue. Keep your changes to these files to what your story needs. When ${other} merges first, dipo merges the new base into your branch, copies the result into your box and tells you.`;
}

/** What a catch-up did, for its texts. */
export interface CatchUpFacts {
  readonly story: string;
  readonly base: string;
  /** The base commit merged in. */
  readonly onto: string;
  /** The paths of the story that the base changed too. */
  readonly overlap: readonly string[];
  /** The files git could not merge cleanly; empty for a clean merge. */
  readonly conflicts: readonly ConflictFile[];
  /** The paths written into the box and removed from it. */
  readonly written: number;
  readonly removed: number;
}

/** Pure: the maintainer's notice of a catch-up. */
export function catchUpNotice(facts: CatchUpFacts): string {
  const at = `${facts.base} at ${facts.onto.slice(0, 12)}`;
  if (facts.conflicts.length === 0 && facts.overlap.length === 0) {
    return `dipo merged ${at} into ${facts.story}'s branch and box before review: a story of tier L or flagged test-before-merge always syncs with its base.`;
  }
  return facts.conflicts.length === 0
    ? `dipo merged ${at} into ${facts.story}'s branch and box: the base changed ${files(facts.overlap.length)} the story changed too (${shownPaths(facts.overlap)}).`
    : `${files(facts.conflicts.length)} conflicted when git merged ${at} into ${facts.story}'s branch (${conflictSummary(facts.conflicts)}). dipo committed the merge as git left it, copied it into the box, and gave the worker a fix round.`;
}

/**
 * Pure: the message to the worker of a caught-up story. A conflict's message ends with its hunks
 * as git left them (`facts.hunks`, from `conflictHunks`), when there are any.
 */
export function catchUpMessage(facts: CatchUpFacts & { readonly hunks?: string }): string {
  const copied = `It copied the merge into your box: ${files(facts.written)} written, ${files(facts.removed)} removed.`;
  if (facts.conflicts.length === 0) {
    return `dipo: ${facts.base} changed files your story changes too (${shownPaths(facts.overlap)}), so dipo merged ${facts.base} into your branch. ${copied} Read those files again before you change them further, and keep going.`;
  }
  const help = kindsOf(facts.conflicts).map((kind) => CONFLICT_KIND_HELP[kind]);
  const text = `dipo: fix round. ${facts.base} changed files your story changes too, and ${files(facts.conflicts.length)} conflicted when git merged ${facts.base} into your branch: ${conflictSummary(facts.conflicts)}. dipo committed the merge as git left it. ${copied} ${help.join(" ")} Then run the tests and hand a part with dipo-part. dipo does not move the story to review while a conflict marker line remains in one of these files.`;
  return facts.hunks === undefined || facts.hunks === ""
    ? text
    : `${text}\n\nThe conflicts as git left them:\n<diff>\n${neutraliseTags(facts.hunks)}\n</diff>`;
}

/**
 * Pure: the maintainer's notice of a conflict in a path the worker cannot write (0019 section 10):
 * dipo merged nothing and parks the story.
 */
export function unwritableNotice(story: string, base: string, paths: readonly string[]): string {
  return `git could not merge ${base} into ${story}'s branch cleanly, and the conflict is in ${files(paths.length)} the worker cannot write (${shownPaths(paths)}). dipo merged nothing, into neither the branch nor the box, and parked ${story}: resolve the conflict on the base or the branch by hand, then resume the story.`;
}

// ---- the conflict item and its markers (0019 sections 8 and 10, DIPO-149) ------------------------

/**
 * A conflict marker line, as git writes them (marker size 7): `<<<<<<< ` and `>>>>>>> ` with the
 * side's name, and `=======` alone on its line. A line of eight `=` (a Markdown heading underline)
 * is no marker.
 */
export const CONFLICT_MARKER = /^(?:<{7} |>{7} |={7}(?:[ \r]|$))/;
/** The same rule for `git grep -E`. */
const CONFLICT_MARKER_GREP = "^(<{7} |>{7} |={7}([ \r]|$))";

/** True for a `<<<<<<< ` or `>>>>>>> ` line: a side marker, not the lone `=======`. */
function sideMarker(line: string): boolean {
  return line.startsWith("<<<<<<< ") || line.startsWith(">>>>>>> ");
}

/**
 * Pure: the marker lines of one file, `{ n, text }` each, as found. A lone `=======` counts only
 * while a `<<<<<<< ` or `>>>>>>> ` line remains in the same file, so a resolved file whose text
 * holds a seven-character heading underline is no conflict.
 */
export function countedMarkers(
  found: readonly { readonly n: number; readonly text: string }[],
): number[] {
  if (!found.some((line) => sideMarker(line.text))) return [];
  return found.map((line) => line.n);
}

/** Pure: the 1-based numbers of the conflict marker lines of `text` (`countedMarkers`). */
export function markerLines(text: string): number[] {
  return countedMarkers(
    text
      .split("\n")
      .flatMap((line, at) => (CONFLICT_MARKER.test(line) ? [{ n: at + 1, text: line }] : [])),
  );
}

/**
 * Pure: the conflict hunks of one file's text as git left them, each from its `<<<<<<<` line to
 * its `>>>>>>>` line with `CONFLICT_CONTEXT_LINES` around it, headed by the path and line range.
 */
export function fileHunks(path: string, text: string): string[] {
  const lines = text.split("\n");
  const hunks: string[] = [];
  for (let at = 0; at < lines.length; at += 1) {
    if (!lines[at]!.startsWith("<<<<<<< ")) continue;
    let end = at + 1;
    while (end < lines.length && !lines[end]!.startsWith(">>>>>>> ")) end += 1;
    const from = Math.max(0, at - CONFLICT_CONTEXT_LINES);
    const to = Math.min(lines.length - 1, end + CONFLICT_CONTEXT_LINES);
    hunks.push(
      `--- ${cleanDoorText(path).slice(0, 300)} (lines ${from + 1}-${to + 1})\n${lines.slice(from, to + 1).join("\n")}`,
    );
    at = end;
  }
  return hunks;
}

/** Pure: `hunks` joined within `max` characters; the ones left out are counted. */
export function hunksWithin(hunks: readonly string[], max: number): string {
  const shown: string[] = [];
  let used = 0;
  for (const hunk of hunks) {
    const room = max - used - (shown.length === 0 ? 0 : 2);
    if (hunk.length > room) break;
    shown.push(hunk);
    used += hunk.length + (shown.length === 1 ? 0 : 2);
  }
  const rest = hunks.length - shown.length;
  if (rest === 0) return shown.join("\n\n");
  const more = `[dipo: ${rest} more conflict hunk${rest === 1 ? "" : "s"} not shown; open the files in your box.]`;
  return [...shown, more].join("\n\n");
}

/** Pure: the signature of a conflict item (0019 section 8): the base commit and the sorted paths. */
export function conflictSignature(onto: string, paths: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(["conflict", onto, [...paths].toSorted()]))
    .digest("hex");
}

/** A conflict feedback item (0019 section 8), for the developer session. */
export interface ConflictItem {
  readonly source: "conflict";
  readonly signature: string;
  readonly text: string;
}

/**
 * Pure: the one conflict item of a merge (0019 sections 8 and 10): the conflicted paths by kind,
 * what to do about each kind, and the hunks within the item budget `itemMax`, signed over the base
 * commit and the sorted paths.
 */
export function conflictFeedbackItem(input: {
  readonly base: string;
  readonly onto: string;
  readonly conflicts: readonly ConflictFile[];
  /** The hunks of every content conflict, in path order (`fileHunks`). */
  readonly hunks: readonly string[];
  readonly itemMax?: number;
}): ConflictItem {
  const conflicts = [...input.conflicts].toSorted((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const values = (hunks: string) => ({
    base: input.base,
    onto: input.onto.slice(0, 12),
    files: conflictSummary(conflicts),
    help: kindsOf(conflicts)
      .map((kind) => CONFLICT_KIND_HELP[kind])
      .join(" "),
    hunks: hunks === "" ? "(no conflict hunks: see the kinds above)" : hunks,
  });
  const frame = renderTemplate(conflictTemplate, values("")).length;
  const room = Math.max(0, (input.itemMax ?? 3_000) - frame);
  return {
    source: "conflict",
    signature: conflictSignature(
      input.onto,
      input.conflicts.map((file) => file.path),
    ),
    text: renderTemplate(conflictTemplate, values(hunksWithin(input.hunks, room))),
  };
}

/**
 * Pure: the feedback turn naming what is left unresolved on the tip, per file: the conflict marker
 * lines, and each binary, modify/delete or file vs folder conflict still as git left it.
 */
export function markersLeftText(
  left: ReadonlyMap<string, readonly number[]>,
  unchanged: readonly ConflictFile[] = [],
): string {
  const entries: [string, string][] = [
    ...[...left.entries()].map(([path, lines]): [string, string] => {
      const named = lines.slice(0, MARKER_LINES_SHOWN).join(", ");
      const more =
        lines.length > MARKER_LINES_SHOWN ? ` and ${lines.length - MARKER_LINES_SHOWN} more` : "";
      return [path, `line${lines.length === 1 ? "" : "s"} ${named}${more}`];
    }),
    ...unchanged.map((file): [string, string] => [
      file.path,
      `the ${CONFLICT_KIND_TEXT[file.kind]} conflict is still as git left it in dipo's merge`,
    ]),
  ].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const shown = entries
    .slice(0, SHOWN_PATHS_MAX)
    .map(([path, what]) => `- ${cleanDoorText(path).slice(0, 300)}: ${what}`);
  const rest = entries.length - shown.length;
  if (rest > 0) shown.push(`- and ${rest} more files`);
  return renderTemplate(conflictMarkersTemplate, { lines: shown.join("\n") });
}

/** Pure: the commit message of a catch-up merge. */
export function catchUpCommitMessage(
  facts: Pick<CatchUpFacts, "story" | "base" | "onto" | "conflicts">,
  branch: string,
): { readonly subject: string; readonly body: string } {
  const body = [
    `Catch-up of ${facts.story} with ${facts.base} at ${facts.onto.slice(0, 12)}, merged by dipo.`,
  ];
  if (facts.conflicts.length > 0) {
    const kinds = kindsOf(facts.conflicts).map((kind) => CONFLICT_KIND_TEXT[kind]);
    body.push(
      `${files(facts.conflicts.length)} conflicted (${kinds.join(", ")}) and stay as git left them for the worker's fix round.`,
    );
  }
  return {
    subject: partSubject(`Merge ${facts.base} into ${branch}`, "Merge the base"),
    body: body.join("\n\n"),
  };
}

// ---- reading git ---------------------------------------------------------------------------------

function inBacklog(path: string): boolean {
  return path === "backlog" || path.startsWith("backlog/");
}

function nulList(output: string): string[] {
  return output.split("\0").filter((item) => item !== "");
}

/** What a merge changes in the box: the paths to write and to remove, outside `backlog/`. */
export interface BoxChanges {
  readonly written: readonly string[];
  readonly removed: readonly string[];
}

/**
 * Pure: the box changes of `git diff-tree -r -z --no-renames <tip> <merge>` output. A submodule is
 * never written; a path that became one is removed.
 */
export function parseBoxChanges(output: string): BoxChanges {
  const items = output.split("\0");
  const written: string[] = [];
  const removed: string[] = [];
  for (let at = 0; at + 1 < items.length; at += 2) {
    const head = items[at]!;
    const path = items[at + 1]!;
    if (!head.startsWith(":") || inBacklog(path)) continue;
    const [, newMode = ""] = head.slice(1).split(" ");
    const status = head.split(" ").at(-1) ?? "";
    if (status.startsWith("D") || newMode === "160000") removed.push(path);
    else written.push(path);
  }
  return { written: written.toSorted(), removed: removed.toSorted() };
}

/** True when `path` is a plain repo-relative path: no empty, `.` or `..` part, nothing hidden. */
function plainPath(path: string): boolean {
  return (
    !unsafePath(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

async function revParse(session: GitSession, rev: string): Promise<string | null> {
  const found = await session.step(session.repository, ["rev-parse", "--verify", "--quiet", rev]);
  return found.code === 0 ? found.stdout.trim() : null;
}

async function isAncestor(session: GitSession, older: string, newer: string): Promise<boolean> {
  const checked = await session.step(session.repository, [
    "merge-base",
    "--is-ancestor",
    older,
    newer,
  ]);
  return checked.code === 0;
}

async function namesBetween(session: GitSession, from: string, to: string): Promise<string[]> {
  return nulList(
    await session.ok(session.repository, [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      from,
      to,
      "--",
    ]),
  ).filter((path) => !inBacklog(path));
}

async function objectFormat(session: GitSession): Promise<"sha1" | "sha256"> {
  const shown = (
    await session.ok(session.repository, ["rev-parse", "--show-object-format"])
  ).trim();
  return shown === "sha256" ? "sha256" : "sha1";
}

/** A merge driver name a `-c merge.<name>.driver=` override can name. */
const DRIVER = /^[^=\n]+$/;

/**
 * The config of a catch-up's merge and archives: filters off (`filtersOffConfig`), no attributes
 * file, the empty tree as the in-tree attributes (`attr.tree`), and every merge driver git's
 * config defines blanked, so none runs. A driver name the override cannot carry refuses.
 */
export async function mergeOffConfig(session: GitSession): Promise<(readonly [string, string])[]> {
  const listed = await session.step(session.repository, [
    "config",
    "--name-only",
    "--get-regexp",
    "^merge\\..*\\.driver$",
  ]);
  // 0 lists the drivers and 1 means none; anything else refuses, since a driver it missed would run.
  if (listed.code !== 0 && listed.code !== 1) {
    throw new BoxError(
      "box.refused",
      `git could not list its merge drivers (exit ${listed.code}), so they cannot be switched off.`,
    );
  }
  const drivers = new Set<string>();
  for (const line of listed.stdout.split("\n")) {
    const found = /^merge\.(.+)\.driver$/.exec(line.trim());
    if (found === null) continue;
    const name = found[1] ?? "";
    if (!DRIVER.test(name)) {
      throw new BoxError("box.refused", "a git merge driver's name cannot be switched off.");
    }
    drivers.add(name);
  }
  return [
    ...(await filtersOffConfig(session)),
    ["core.attributesFile", "/dev/null"],
    ["attr.tree", EMPTY_TREE[await objectFormat(session)]],
    ...[...drivers].map((name): readonly [string, string] => [`merge.${name}.driver`, ""]),
  ];
}

/**
 * The base branch's ref for a catch-up: `refs/remotes/<remote>/<base>` when the office has a
 * remote, else `refs/heads/<base>`; null when the office has no base branch.
 */
export async function baseRefOf(
  git: OfficeGit,
  session: GitSession,
): Promise<{ readonly base: string; readonly ref: string } | null> {
  const base = await git.resolveBaseIn(session).catch(() => null);
  if (base === null) return null;
  const { remote } = git.settings;
  const url = await session.step(session.repository, ["config", "--get", `remote.${remote}.url`]);
  const remoteRef = `refs/remotes/${remote}/${base}`;
  return {
    base,
    ref: url.code === 0 && url.stdout.trim() !== "" ? remoteRef : `refs/heads/${base}`,
  };
}

/** Where a story's changes start: its start commit, or the merge base after a catch-up. */
async function startPoint(
  session: GitSession,
  tip: string,
  startSha: string,
  baseRef: string | null,
): Promise<{ readonly from: string; readonly mergeBase: string | null }> {
  if (baseRef === null || (await revParse(session, `${baseRef}^{commit}`)) === null) {
    return { from: startSha, mergeBase: null };
  }
  const found = await session.step(session.repository, ["merge-base", tip, baseRef]);
  const mergeBase = found.code === 0 ? found.stdout.trim() : null;
  if (mergeBase === null || mergeBase === startSha) return { from: startSha, mergeBase };
  return {
    from: (await isAncestor(session, startSha, mergeBase)) ? mergeBase : startSha,
    mergeBase,
  };
}

/**
 * A story's changed files (criterion 1): the paths the branch tip changed against the start
 * commit, or against the merge base with `baseRef` once a catch-up brought the base in, without
 * `backlog/`. Read from git, never from the worker. Null when the branch is gone.
 */
export async function storyChangedFiles(
  session: GitSession,
  input: { readonly branch: string; readonly startSha: string; readonly baseRef: string | null },
): Promise<{ readonly tip: string; readonly from: string; readonly files: string[] } | null> {
  const tip = await revParse(session, `refs/heads/${input.branch}^{commit}`);
  if (tip === null) return null;
  const { from } = await startPoint(session, tip, input.startSha, input.baseRef);
  return { tip, from, files: await namesBetween(session, from, tip) };
}

/** What a catch-up check found. */
export type CatchUpPlan =
  /** The branch holds the base already, or there is no base to merge. */
  | { readonly kind: "current" }
  /** The base changed nothing the story changed: no catch-up. */
  | { readonly kind: "apart"; readonly onto: string }
  /**
   * The merge conflicts in paths the worker cannot write (0019 section 10): any protected path
   * (`protectedKind`: `backlog/`, `.dipo/`, `.github/`, the Claude settings, git's attribute
   * files, and the configuration of the Backlog CLI, Bun and Claude Code's MCP servers) other than
   * the story's own task file, or that task file conflicting other than in its content. Nothing is
   * merged.
   */
  | {
      readonly kind: "unwritable";
      readonly tip: string;
      readonly onto: string;
      readonly paths: readonly string[];
    }
  | {
      readonly kind: "merge";
      readonly tip: string;
      readonly onto: string;
      readonly tree: string;
      /** The merge commit, made only when asked to write. */
      readonly commit: string | null;
      readonly overlap: readonly string[];
      /** The conflicts left for the worker; the story's own task file is never one. */
      readonly conflicts: readonly ConflictFile[];
      /**
       * The story's own task file when it conflicted: the merge holds the base's version of it,
       * and dipo writes the branch's status back through the single field write path after the
       * branch moved (0019 section 10). Null when it merged cleanly.
       */
      readonly taskFile: string | null;
    };

/** How a catch-up check merges: on an overlap (the poll), or whenever the base moved (DIPO-149). */
export type CatchUpMode = "overlap" | "always";

/** The story's task file at `commit`: the one file of `story` directly in `backlog/tasks`. */
async function taskFileAt(
  session: GitSession,
  commit: string,
  story: string,
): Promise<string | null> {
  const listed = nulList(
    await session.ok(session.repository, [
      "ls-tree",
      "-z",
      "--name-only",
      commit,
      "--",
      `${TASKS_DIR}/`,
    ]),
  ).filter((path) => isTaskFileOf(path.slice(path.lastIndexOf("/") + 1), story));
  return listed.length === 1 ? listed[0]! : null;
}

/**
 * The tree `tree` with the blob `id` (mode 100644) at `path`, written through a temporary index in
 * `scratch` (`read-tree`, `update-index --cacheinfo`, `write-tree`): from git objects alone.
 */
async function treeWith(
  session: GitSession,
  scratch: string,
  tree: string,
  path: string,
  id: string,
): Promise<string> {
  const index = { env: { ...BASE_CHECKOUT_ENV, GIT_INDEX_FILE: join(scratch, "catch-up-index") } };
  const repo = session.repository;
  try {
    await session.ok(repo, ["read-tree", tree], index);
    await session.ok(
      repo,
      ["--literal-pathspecs", "update-index", "--add", "--cacheinfo", `100644,${id},${path}`],
      index,
    );
    return (await session.ok(repo, ["write-tree"], index)).trim();
  } finally {
    await rm(join(scratch, "catch-up-index"), { force: true });
  }
}

/**
 * The catch-up check of one story (criterion 4): does the base hold changes, since the merge base,
 * to files the story changed (with mode `always`, any change since the merge base: the sync of a
 * riskier story before In Review, DIPO-149), and does git merge them cleanly
 * (`git merge-tree --write-tree` from objects alone, `mergeOffConfig`)? With `write` the merge
 * commit is made too (`commit-tree`, the tip and the base as parents), but no ref moves; a
 * conflict in the story's own task file is resolved to the base's version in it, through a
 * temporary index in `scratch`.
 */
export async function planCatchUp(
  session: GitSession,
  input: {
    readonly branch: string;
    readonly startSha: string;
    readonly story: string;
    readonly base: string;
    readonly baseRef: string;
    readonly write: boolean;
    readonly mode?: CatchUpMode;
    /** A folder of dipo's own for the temporary index; needed to write a task-file resolution. */
    readonly scratch?: string;
  },
): Promise<CatchUpPlan> {
  const repo = session.repository;
  const tip = await revParse(session, `refs/heads/${input.branch}^{commit}`);
  const onto = await revParse(session, `${input.baseRef}^{commit}`);
  if (tip === null || onto === null || (await isAncestor(session, onto, tip))) {
    return { kind: "current" };
  }
  const { from, mergeBase } = await startPoint(session, tip, input.startSha, input.baseRef);
  if (mergeBase === null) return { kind: "apart", onto };
  const overlap = overlappingPaths(
    await namesBetween(session, from, tip),
    await namesBetween(session, mergeBase, onto),
  );
  if (overlap.length === 0 && input.mode !== "always") return { kind: "apart", onto };
  const merged = await session.step(
    repo,
    ["merge-tree", "--write-tree", "--name-only", "-z", tip, onto],
    { config: await mergeOffConfig(session), env: BASE_CHECKOUT_ENV },
  );
  if (merged.code !== 0 && merged.code !== 1) {
    throw new GitError(
      "git.failed",
      `git merge-tree failed (${merged.stderr.trim() || `exit ${merged.code}`}).`,
    );
  }
  const parsed = parseMergeTree(merged.stdout);
  if (merged.code === 1 && parsed.conflicts.length === 0) {
    throw new GitError("git.failed", "git merge-tree reported a conflict but named no file.");
  }
  const own = parsed.conflicts.length === 0 ? null : await taskFileAt(session, tip, input.story);
  const ownConflict = parsed.conflicts.find((file) => file.path === own);
  const conflicts = parsed.conflicts.filter((file) => file.path !== own);
  const unwritable = conflicts
    .map((file) => file.path)
    .filter((path) => protectedKind(path) !== null);
  const baseTask =
    ownConflict === undefined || own === null ? null : await revParse(session, `${onto}:${own}`);
  if (ownConflict !== undefined && (ownConflict.kind !== "content" || baseTask === null)) {
    unwritable.push(ownConflict.path);
  }
  if (unwritable.length > 0) {
    return { kind: "unwritable", tip, onto, paths: [...new Set(unwritable)].toSorted() };
  }
  const taskFile = ownConflict === undefined ? null : own;
  let tree = parsed.tree;
  let commit: string | null = null;
  if (input.write) {
    if (taskFile !== null && baseTask !== null) {
      if (input.scratch === undefined) {
        throw new GitError("git.failed", "a task-file resolution needs dipo's scratch folder.");
      }
      tree = await treeWith(session, input.scratch, tree, taskFile, baseTask);
    }
    const message = catchUpCommitMessage({ ...input, onto, conflicts }, input.branch);
    commit = (
      await session.ok(
        repo,
        ["commit-tree", tree, "-p", tip, "-p", onto, "-m", message.subject, "-m", message.body],
        { timeoutMs: EXTERNAL_STEP_TIMEOUT_MS },
      )
    ).trim();
  }
  return { kind: "merge", tip, onto, tree, commit, overlap, conflicts, taskFile };
}

/** The box changes of the merge `commit` against the tip it was made on. */
export async function boxChangesOf(
  session: GitSession,
  tip: string,
  commit: string,
): Promise<BoxChanges> {
  const changes = parseBoxChanges(
    await session.ok(session.repository, ["diff-tree", "-r", "-z", "--no-renames", tip, commit]),
  );
  if (![...changes.written, ...changes.removed].every(plainPath)) {
    throw new GitError("git.failed", "the merge holds a path dipo does not copy into a box.");
  }
  return changes;
}

/** Moves `branch` from `tip` to `commit`; false when it moved meanwhile. */
export async function moveBranch(
  session: GitSession,
  branch: string,
  commit: string,
  tip: string,
  subject: string,
): Promise<boolean> {
  const moved = await session.step(session.repository, [
    "update-ref",
    "-m",
    subject,
    `refs/heads/${branch}`,
    commit,
    tip,
  ]);
  return moved.code === 0;
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += PATHS_PER_CALL) {
    out.push(items.slice(at, at + PATHS_PER_CALL));
  }
  return out;
}

/** The mode and blob of each of `paths` in `commit` (`ls-tree -r -z`). */
async function entriesAt(
  session: GitSession,
  commit: string,
  paths: readonly string[],
): Promise<Map<string, { readonly mode: string; readonly id: string }>> {
  const entries = new Map<string, { readonly mode: string; readonly id: string }>();
  for (const group of chunks(paths)) {
    const listed = await session.ok(session.repository, [
      "--literal-pathspecs",
      "ls-tree",
      "-r",
      "-z",
      commit,
      "--",
      ...group,
    ]);
    for (const line of nulList(listed)) {
      const tab = line.indexOf("\t");
      const [mode = "", , id = ""] = line.slice(0, tab).split(" ");
      entries.set(line.slice(tab + 1), { mode, id });
    }
  }
  return entries;
}

/** git's blob id of the file at `at` (`size` bytes), read in chunks (O_NOFOLLOW). */
async function fileBlob(format: "sha1" | "sha256", at: string, size: number): Promise<string> {
  const hash = createHash(format).update(`blob ${size}\0`);
  const file = await open(at, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = new Uint8Array(HASH_CHUNK);
    for (let done = 0; done < size;) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(HASH_CHUNK, size - done), done);
      if (bytesRead === 0) return "";
      hash.update(buffer.subarray(0, bytesRead));
      done += bytesRead;
    }
  } finally {
    await file.close();
  }
  return hash.digest("hex");
}

/** True when the staged `at` is the entry `want`: a symlink or a file of its mode and blob. */
async function stagedAs(
  format: "sha1" | "sha256",
  at: string,
  want: { readonly mode: string; readonly id: string } | undefined,
): Promise<boolean> {
  if (want === undefined) return false;
  const info = await lstat(at).catch(() => null);
  if (info === null) return false;
  if (want.mode === "120000") {
    return info.isSymbolicLink() && blobId(format, await readlink(at, "buffer")) === want.id;
  }
  if (!info.isFile()) return false;
  if (((info.mode & 0o111) !== 0) !== (want.mode === "100755")) return false;
  return (await fileBlob(format, at, info.size)) === want.id;
}

// ---- the service ---------------------------------------------------------------------------------

type Log = (message: string, fields: Readonly<Record<string, unknown>>) => void;

/** A notice for the maintainer. */
export interface CollisionNotice {
  readonly level: "info" | "warn";
  readonly code: string;
  readonly text: string;
}

/** A merge dipo made into a story branch, for its record (DIPO-149, `catch_ups`). */
export interface CatchUpMerged {
  readonly base: string;
  /** The base commit merged in. */
  readonly onto: string;
  /** The branch tip the merge was made on. */
  readonly tip: string;
  readonly commit: string;
  /** The conflicts left for the worker; empty for a clean merge. */
  readonly conflicts: readonly ConflictFile[];
  /** The story's own task file when dipo resolved a conflict in it, else null. */
  readonly taskFile: string | null;
  /**
   * True for a merge dipo committed on the branch outside the box (the merge slot's sync,
   * DIPO-324): the box gets it only before the run's next developer session (`copyPending`).
   */
  readonly outsideBox?: true;
}

/** A conflict the check of a story In Review found; nothing merged (0019 section 10). */
export interface CatchUpFound {
  readonly base: string;
  readonly onto: string;
  readonly tip: string;
  readonly conflicts: readonly ConflictFile[];
}

/** What a base sync in the run's held turn did (`BoxCollisions.syncInTurn`, DIPO-149). */
export type SyncOutcome =
  /** Nothing merged: the branch holds the base, or the mode leaves a clean merge for later. */
  | { readonly kind: "none" }
  | {
      readonly kind: "merged";
      readonly merged: CatchUpMerged;
      /** The branch tip after the merge, and after the task file's status commit when one ran. */
      readonly head: string;
      readonly facts: CatchUpFacts;
      /** The conflict item for the worker; null for a clean merge. */
      readonly item: ConflictItem | null;
    }
  /** The sync parks the story: a path the worker cannot write, a failed copy, a rejected push. */
  | { readonly kind: "park"; readonly park: PartPark }
  /** The run stopped going on meanwhile. */
  | { readonly kind: "stopped" };

/** How the sync before In Review merges (0019 section 10). */
export type SyncMode =
  /** A riskier story (tier L or flagged test-before-merge): whenever the base moved. */
  | "always"
  /** Any other story: only when git cannot merge cleanly. */
  | "onConflict";

export interface BoxCollisionsDeps {
  readonly boxes: Pick<BoxPort, "copyIn" | "exec">;
  /** The `tar` that unpacks a merge for the box, and the clock of the poll. */
  readonly code: BoxCodeDeps;
  /** dipo's temp root; each catch-up's stage folder is made in it. */
  readonly tmpRoot: string;
  /** The box runs in progress, every office. */
  readonly runs: () => readonly PartRun[];
  /**
   * The box runs whose story is In Review (DIPO-149): each pass checks their tip against the base
   * with `merge-tree`, and a conflict is found (`found`), never merged.
   */
  readonly inReview?: () => readonly PartRun[];
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  /** True while the run goes on: tracked and nothing decided for it yet. */
  readonly live: (runId: string) => boolean;
  /** The delivery of parts: the box's work goes first, and the catch-up takes the run's turn. */
  readonly parts: Pick<BoxParts, "deliverLast" | "deliverInTurn" | "inTurn">;
  /** Parks the run, stopping its worker; false when another decision came first. */
  readonly park: (runId: string, park: PartPark) => boolean;
  /** Sends `text` to the run's worker as its next message. */
  readonly tell: (runId: string, text: string) => Promise<unknown>;
  /** Tells the maintainer (an `engine.notice` of the run). */
  readonly notice: (office: OfficeId, runId: string, notice: CollisionNotice) => void;
  /**
   * Records a merge dipo made into the branch (DIPO-149): its conflicted paths, a conflict
   * hand-off, and an approval carried over a clean merge. Called once the branch moved.
   */
  readonly recorded?: (run: PartRun, merged: CatchUpMerged) => Promise<void>;
  /**
   * Records a catch-up's push of the run's branch on its claim (DIPO-315: every story-branch push
   * sets `claims.pushed_at` once it reaches the remote). A throw is logged; the catch-up stands.
   */
  readonly pushed?: (run: PartRun, push: PushResult) => void;
  /** A conflict found while the story is In Review (DIPO-149): recorded and told, never merged. */
  readonly found?: (run: PartRun, found: CatchUpFound) => void;
  /** A later check of a story In Review found no conflict: a conflict found earlier is cleared. */
  readonly cleared?: (run: PartRun) => void;
  /**
   * Writes `status` back into the story's task file on its branch through the single field write
   * path, after a merge that took the base's version of it (DIPO-149, 0019 section 10).
   */
  readonly taskStatus?: (run: PartRun, status: string) => Promise<void>;
  /**
   * Installs the office's packages in the box again after a merge that changed `lockfiles`
   * (0019 section 10's reinstall). Without it nothing is installed again by dipo: the worker
   * installs in its own box.
   */
  readonly reinstall?: (run: PartRun, lockfiles: readonly string[]) => Promise<void>;
  /** The conflict item's character budget for the run (`prompt.budgets.feedbackItem`). */
  readonly itemMax?: (run: PartRun) => number;
  readonly pollMs?: number;
  readonly warn?: Log;
  readonly info?: Log;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The merge staged on the Mac for one box. */
interface StagedMerge {
  readonly dir: string;
  remove(): Promise<void>;
}

/** Lockfile names whose change makes a box install again. */
const LOCKFILE_NAMES: readonly string[] = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "poetry.lock",
  "uv.lock",
];

/** Pure: the lockfiles among `paths`, sorted. */
export function changedLockfiles(paths: readonly string[]): string[] {
  return paths
    .filter((path) => LOCKFILE_NAMES.includes(path.slice(path.lastIndexOf("/") + 1)))
    .toSorted();
}

/** Pure: the `status:` of a task file's front matter, or null when it has none. */
export function taskFileStatus(text: string): string | null {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (front === null) return null;
  const line = /^status:[ \t]*(.+?)[ \t]*\r?$/m.exec(front[1] ?? "");
  const value = line?.[1]?.replace(/^(["'])(.*)\1$/, "$2").trim() ?? "";
  return value === "" ? null : value;
}

/**
 * The paths of `paths` that hold a conflict marker line at `commit`, with the line numbers, read
 * from git objects (`git grep` on the commit, no work tree). Every file is read as text (`-a`), so
 * one NUL byte cannot hide a marker; attributes and filters are off (`mergeOffConfig`,
 * `--no-textconv`), so no textconv or driver runs. A lone `=======` counts only beside a side
 * marker in the same file (`countedMarkers`).
 */
export async function markersAt(
  session: GitSession,
  commit: string,
  paths: readonly string[],
): Promise<Map<string, number[]>> {
  const lines = new Map<string, { n: number; text: string }[]>();
  const config = await mergeOffConfig(session);
  for (const group of chunks(paths)) {
    const grep = await session.step(
      session.repository,
      [
        "--literal-pathspecs",
        "grep",
        "-a",
        "-n",
        "-z",
        "--no-color",
        "--no-textconv",
        "-E",
        "-e",
        CONFLICT_MARKER_GREP,
        commit,
        "--",
        ...group,
      ],
      { config, env: BASE_CHECKOUT_ENV },
    );
    if (grep.code === 1) continue;
    if (grep.code !== 0) {
      throw new GitError(
        "git.failed",
        `git grep failed (${grep.stderr.trim() || `exit ${grep.code}`}).`,
      );
    }
    // `<commit>:<path>\0<line>\0<text>` per match.
    const items = grep.stdout.split("\n").filter((line) => line !== "");
    for (const item of items) {
      const [where = "", line = "", ...rest] = item.split("\0");
      const path = where.startsWith(`${commit}:`) ? where.slice(commit.length + 1) : where;
      const n = Number(line);
      if (!Number.isInteger(n) || n < 1) continue;
      lines.set(path, [...(lines.get(path) ?? []), { n, text: rest.join("\0") }]);
    }
  }
  const found = new Map<string, number[]>();
  for (const [path, matched] of lines) {
    const counted = countedMarkers(matched);
    if (counted.length > 0) found.set(path, counted);
  }
  return found;
}

/** Compares the changed files of the box runs in progress and lets the second catch up. */
export class BoxCollisions {
  readonly #deps: BoxCollisionsDeps;
  /** The overlaps told already, by `overlapSignature`; in memory only (see the file comment). */
  readonly #told = new Set<string>();
  /** The `<tip> <onto>` each story In Review was last checked at; in memory only. */
  readonly #reviewSeen = new Map<string, string>();
  #pass: Promise<void> | null = null;
  #again = false;
  #timer: TimerHandle | null = null;
  #stopped = false;

  constructor(deps: BoxCollisionsDeps) {
    this.#deps = deps;
  }

  /** Arms the poll: a pass every `COLLISION_POLL_MS`. */
  start(): void {
    this.#stopped = false;
    this.#arm();
  }

  /** Stops the poll; a pass in progress finishes. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) this.#deps.code.clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #arm(): void {
    if (this.#stopped) return;
    this.#timer = this.#deps.code.clock.setTimeout(() => {
      this.#timer = null;
      void this.check().finally(() => this.#arm());
    }, this.#deps.pollMs ?? COLLISION_POLL_MS);
  }

  /**
   * One pass over every office: overlaps told, then each story whose base changed its files caught
   * up, then each story In Review checked against its base. One pass at a time; a call during a
   * pass runs one more after it. Never rejects.
   */
  check(): Promise<void> {
    if (this.#pass !== null) {
      this.#again = true;
      return this.#pass;
    }
    const pass = (async () => {
      do {
        this.#again = false;
        await this.#once().catch((error: unknown) => {
          this.#deps.warn?.("comparing the box runs' changed files failed", {
            reason: messageOf(error),
          });
        });
      } while (this.#again && !this.#stopped);
    })();
    this.#pass = pass.finally(() => {
      this.#pass = null;
    });
    return this.#pass;
  }

  /**
   * The sync before In Review of a box run at done (DIPO-149, 0019 section 10), inside the run's
   * held turn of parts (`BoxParts.finishLast`), so no part or catch-up runs meanwhile: `always`
   * merges the base whenever it moved, `onConflict` only when git cannot merge it cleanly. The
   * merge is made as a catch-up is (committed from git objects, copied into the box, the branch
   * moved and pushed, recorded), but nothing is told to the worker: the caller decides the turn.
   */
  async syncInTurn(run: PartRun, mode: SyncMode): Promise<SyncOutcome> {
    const git = this.#deps.git(run.office);
    if (git === undefined) return { kind: "none" };
    // Planned on git's merge alone, never on the overlap of changed files: a re-claimed branch's
    // earlier work lies below its start commit, so the overlap would miss a conflict there.
    const planMode: CatchUpMode = "always";
    const plan = await this.#plan(git, run, false, planMode);
    if (plan === null || plan.kind === "current" || plan.kind === "apart") return { kind: "none" };
    if (plan.kind === "unwritable") return { kind: "park", park: this.#unwritable(run, plan) };
    if (mode === "onConflict" && plan.conflicts.length === 0 && plan.taskFile === null) {
      return { kind: "none" };
    }
    return this.#catchUp(git, run, planMode);
  }

  /**
   * The merge a maintainer resume of a `conflict` park asks for once its new session runs in the
   * box (DIPO-324, 0020 section 2): whatever the box holds goes first, then the base is merged into
   * the story branch and the box as a catch-up is, whenever it moved, never on the overlap of
   * changed files. Nothing is told to the worker and nothing parks here: the caller decides from
   * the outcome.
   */
  async mergeOnResume(run: PartRun): Promise<SyncOutcome> {
    const git = this.#deps.git(run.office);
    if (git === undefined) return { kind: "none" };
    const before = await this.#deps.parts.deliverLast(run.runId, CATCH_UP_PART_MESSAGE);
    const park = partPark(before);
    if (park !== null) return { kind: "park", park };
    if (before.kind === "stopped") return { kind: "stopped" };
    return this.#deps.parts.inTurn(run.runId, async (): Promise<SyncOutcome> => {
      const plan = await this.#plan(git, run, false, "always");
      if (plan === null || plan.kind === "current" || plan.kind === "apart") {
        return { kind: "none" };
      }
      if (plan.kind === "unwritable") return { kind: "park", park: this.#unwritable(run, plan) };
      return this.#catchUp(git, run, "always");
    });
  }

  /**
   * Copies into the run's box what the story branch's tip holds outside `backlog/` and the tip
   * `from` did not (DIPO-324): the merges dipo committed on the branch outside the box since
   * `from` (the merge slot's sync), staged and checked as a catch-up's are, then removed and
   * written in the box. The box must run, and no part is taken meanwhile: the run's session has
   * not started. Throws when a stage or the copy fails; the branch is never moved here.
   */
  async copyPending(run: PartRun, from: string): Promise<BoxChanges> {
    const git = this.#deps.git(run.office);
    if (git === undefined) throw new BoxError("box.failed", `office ${run.office} has no git.`);
    const tip = await git.run((session) => revParse(session, `refs/heads/${run.branch}^{commit}`));
    if (tip === null) throw new BoxError("box.failed", `the branch ${run.branch} is gone.`);
    const changes = await git.run((session) => boxChangesOf(session, from, tip));
    if (changes.written.length === 0 && changes.removed.length === 0) return changes;
    const staged = await this.#stage(git, tip, changes);
    try {
      await this.#write(run, staged.dir, changes);
    } finally {
      await staged.remove();
    }
    this.#deps.info?.("dipo's merges on a story branch were copied into its box", {
      run: run.runId,
      written: changes.written.length,
      removed: changes.removed.length,
    });
    return changes;
  }

  async #once(): Promise<void> {
    const runs = this.#deps.runs().filter((run) => this.#deps.live(run.runId));
    const byOffice = new Map<OfficeId, PartRun[]>();
    for (const run of runs) byOffice.set(run.office, [...(byOffice.get(run.office) ?? []), run]);
    const ids = new Set(runs.map((run) => run.runId));
    for (const signature of this.#told) {
      const [a, b] = JSON.parse(signature) as string[];
      if (!ids.has(a ?? "") || !ids.has(b ?? "")) this.#told.delete(signature);
    }
    for (const [office, inOffice] of byOffice) {
      const git = this.#deps.git(office);
      if (git === undefined) continue;
      await this.#overlaps(office, git, inOffice);
      for (const run of inOffice) {
        await this.#maybeCatchUp(git, run).catch((error: unknown) => {
          this.#deps.warn?.("a box run could not catch up with its base", {
            run: run.runId,
            reason: messageOf(error),
          });
        });
      }
    }
    const checked = new Set<string>();
    for (const run of this.#deps.inReview?.() ?? []) {
      if (ids.has(run.runId) || this.#deps.live(run.runId)) continue;
      checked.add(run.runId);
      const git = this.#deps.git(run.office);
      if (git === undefined) continue;
      await this.#checkInReview(git, run).catch((error: unknown) => {
        this.#deps.warn?.("a story In Review could not be checked against its base", {
          run: run.runId,
          reason: messageOf(error),
        });
      });
    }
    for (const runId of this.#reviewSeen.keys()) {
      if (!checked.has(runId)) this.#reviewSeen.delete(runId);
    }
  }

  async #overlaps(office: OfficeId, git: OfficeGit, runs: readonly PartRun[]): Promise<void> {
    if (runs.length < 2) return;
    const changes = await git.run(async (session) => {
      const base = await baseRefOf(git, session);
      const out: StoryChanges[] = [];
      for (const run of runs) {
        const changed = await storyChangedFiles(session, {
          branch: run.branch,
          startSha: run.startSha,
          baseRef: base?.ref ?? null,
        });
        if (changed !== null)
          out.push({ runId: run.runId, story: run.story, files: changed.files });
      }
      return out;
    });
    for (const overlap of findOverlaps(changes)) {
      const signature = overlapSignature(overlap);
      if (this.#told.has(signature)) continue;
      this.#told.add(signature);
      this.#deps.notice(office, overlap.a.runId, {
        level: "warn",
        code: COLLISION_NOTICES.overlap,
        text: overlapNotice(overlap),
      });
      for (const [me, other] of [
        [overlap.a, overlap.b],
        [overlap.b, overlap.a],
      ] as const) {
        await this.#tell(me.runId, overlapMessage(other.story, overlap.paths));
      }
    }
  }

  async #tell(runId: string, text: string): Promise<void> {
    await Promise.resolve(this.#deps.tell(runId, text)).catch((error: unknown) => {
      this.#deps.warn?.("a collision message did not reach the worker", {
        run: runId,
        reason: messageOf(error),
      });
    });
  }

  /** Plans without writing first, so a story whose base did not touch its files is left alone. */
  async #maybeCatchUp(git: OfficeGit, run: PartRun): Promise<void> {
    const plan = await this.#plan(git, run, false, "overlap");
    if (plan === null || plan.kind === "current" || plan.kind === "apart") return;
    if (plan.kind === "unwritable") {
      this.#deps.park(run.runId, this.#unwritable(run, plan));
      return;
    }
    // Whatever the box holds goes first, so the branch tip is the box's code when git merges.
    const before = await this.#deps.parts.deliverLast(run.runId, CATCH_UP_PART_MESSAGE);
    if (this.#parked(run, partPark(before)) || before.kind === "stopped") return;
    const outcome = await this.#deps.parts.inTurn(run.runId, () =>
      this.#catchUp(git, run, "overlap"),
    );
    if (outcome.kind === "park") {
      this.#deps.park(run.runId, outcome.park);
      return;
    }
    if (outcome.kind !== "merged") return;
    const hunks = outcome.item === null ? undefined : this.#hunksOf(outcome.item);
    await this.#tell(
      run.runId,
      catchUpMessage({ ...outcome.facts, ...(hunks === undefined ? {} : { hunks }) }),
    );
  }

  /** The hunk block of a conflict item's text, for the worker's catch-up message. */
  #hunksOf(item: ConflictItem): string {
    const from = item.text.indexOf("<diff>\n");
    const close = item.text.lastIndexOf("\n</diff>");
    return from < 0 || close < from ? "" : item.text.slice(from + "<diff>\n".length, close);
  }

  /** A story In Review: a conflict with the base is found and recorded, never merged. */
  async #checkInReview(git: OfficeGit, run: PartRun): Promise<void> {
    // Checked again only once the tip or the base moved.
    const heads = await git.run(async (session) => {
      const base = await baseRefOf(git, session);
      const tip = await revParse(session, `refs/heads/${run.branch}^{commit}`);
      const onto = base === null ? null : await revParse(session, `${base.ref}^{commit}`);
      return `${tip ?? ""} ${onto ?? ""}`;
    });
    if (this.#reviewSeen.get(run.runId) === heads) return;
    const plan = await this.#plan(git, run, false, "always");
    const conflicts: readonly ConflictFile[] =
      plan === null || plan.kind === "current" || plan.kind === "apart"
        ? []
        : plan.kind === "unwritable"
          ? plan.paths.map((path) => ({ path, kind: "other" as const }))
          : plan.conflicts;
    if (
      conflicts.length === 0 ||
      plan === null ||
      plan.kind === "current" ||
      plan.kind === "apart"
    ) {
      // No conflict (any more): a conflict found earlier is cleared.
      this.#deps.cleared?.(run);
    } else {
      this.#deps.found?.(run, { base: plan.base, onto: plan.onto, tip: plan.tip, conflicts });
    }
    this.#reviewSeen.set(run.runId, heads);
  }

  /** Parks the run when a part asks for it; true then. */
  #parked(run: PartRun, park: PartPark | null): boolean {
    if (park === null) return false;
    this.#deps.park(run.runId, park);
    return true;
  }

  /** Tells the maintainer that the merge conflicts where the worker cannot write; the park. */
  #unwritable(
    run: PartRun,
    plan: Extract<CatchUpPlan, { kind: "unwritable" }> & { readonly base: string },
  ): PartPark {
    this.#deps.notice(run.office, run.runId, {
      level: "warn",
      code: COLLISION_NOTICES.unwritable,
      text: unwritableNotice(run.story, plan.base, plan.paths),
    });
    return {
      reason: "conflict",
      cause: CATCH_UP_CAUSES.unwritablePath,
      detail: `git could not merge ${plan.base} at ${plan.onto.slice(0, 12)} cleanly in paths the worker cannot write: ${shownPaths(plan.paths)}`,
    };
  }

  async #plan(
    git: OfficeGit,
    run: PartRun,
    write: boolean,
    mode: CatchUpMode,
    scratch?: string,
  ): Promise<(CatchUpPlan & { readonly base: string }) | null> {
    return git.run(async (session) => {
      const base = await baseRefOf(git, session);
      if (base === null) return null;
      const plan = await planCatchUp(session, {
        branch: run.branch,
        startSha: run.startSha,
        story: run.story,
        base: base.base,
        baseRef: base.ref,
        write,
        mode,
        ...(scratch === undefined ? {} : { scratch }),
      });
      return { ...plan, base: base.base };
    });
  }

  /** Tells the maintainer why the catch-up failed; the park it asks for. */
  #fail(run: PartRun, detail: string): SyncOutcome {
    this.#deps.notice(run.office, run.runId, {
      level: "warn",
      code: COLLISION_NOTICES.failed,
      text: `${run.story}: ${detail}`,
    });
    return { kind: "park", park: { reason: "conflict", cause: CATCH_UP_CAUSES.failed, detail } };
  }

  /** The catch-up itself, in the run's turn (see the file comment). */
  async #catchUp(git: OfficeGit, run: PartRun, mode: CatchUpMode): Promise<SyncOutcome> {
    const scratch = await realpath(await mkdtemp(join(this.#deps.tmpRoot, CATCH_UP_STAGE_PREFIX)));
    try {
      return await this.#catchUpWith(git, run, mode, scratch);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async #catchUpWith(
    git: OfficeGit,
    run: PartRun,
    mode: CatchUpMode,
    scratch: string,
  ): Promise<SyncOutcome> {
    for (let attempt = 1; attempt <= CATCH_UP_ATTEMPTS; attempt += 1) {
      if (!this.#deps.live(run.runId)) return { kind: "stopped" };
      const plan = await this.#plan(git, run, true, mode, scratch);
      if (plan === null || plan.kind === "current" || plan.kind === "apart")
        return { kind: "none" };
      if (plan.kind === "unwritable") return { kind: "park", park: this.#unwritable(run, plan) };
      const commit = plan.commit;
      if (commit === null) return { kind: "none" };
      const changes = await git.run((session) => boxChangesOf(session, plan.tip, commit));
      const copyFailed = (error: unknown): SyncOutcome => {
        this.#deps.warn?.("a catch-up could not be copied into the box", {
          run: run.runId,
          reason: messageOf(error),
        });
        return this.#fail(
          run,
          `dipo could not copy the merge of ${plan.base} into the box, so the box may hold part of it; the branch was not moved. Resume the story to try again.`,
        );
      };
      let staged: StagedMerge;
      try {
        staged = await this.#stage(git, commit, changes);
      } catch (error) {
        return copyFailed(error);
      }
      try {
        // The worker may have changed files since the part before the turn: one more part, now.
        const late = await this.#deps.parts.deliverInTurn(run.runId, CATCH_UP_PART_MESSAGE);
        const latePark = partPark(late);
        if (latePark !== null) return { kind: "park", park: latePark };
        if (late.kind === "stopped") return { kind: "stopped" };
        if (late.kind === "committed") {
          if (attempt < CATCH_UP_ATTEMPTS) continue;
          return this.#fail(
            run,
            `the worker kept changing files while dipo merged ${plan.base} into the story, so dipo merged nothing and left the branch and the box as they are. Resume the story to try again.`,
          );
        }
        try {
          await this.#write(run, staged.dir, changes);
        } catch (error) {
          return copyFailed(error);
        }
      } finally {
        await staged.remove();
      }
      return this.#finish(git, run, { ...plan, commit }, changes);
    }
    return { kind: "none" };
  }

  /**
   * After the box holds the merge: the branch moved, the task file's status written back when the
   * merge took the base's version of it, the merge recorded, the branch pushed and the maintainer
   * told. The worker is told by the caller.
   */
  async #finish(
    git: OfficeGit,
    run: PartRun,
    plan: Extract<CatchUpPlan, { kind: "merge" }> & {
      readonly base: string;
      readonly commit: string;
    },
    changes: BoxChanges,
  ): Promise<SyncOutcome> {
    const subject = `Merge ${plan.base} into ${run.branch}`;
    const moved = await git.run((session) =>
      moveBranch(session, run.branch, plan.commit, plan.tip, subject),
    );
    if (!moved) {
      return this.#fail(
        run,
        `the branch ${run.branch} moved while dipo merged ${plan.base} into it, after the merge was copied into the box. Check the branch and the box, then resume the story.`,
      );
    }
    if (plan.taskFile !== null) await this.#writeTaskStatus(git, run, plan);
    const merged: CatchUpMerged = {
      base: plan.base,
      onto: plan.onto,
      tip: plan.tip,
      commit: plan.commit,
      conflicts: plan.conflicts,
      taskFile: plan.taskFile,
    };
    await this.#deps.recorded?.(run, merged).catch((error: unknown) => {
      this.#deps.warn?.("a catch-up could not be recorded", {
        run: run.runId,
        reason: messageOf(error),
      });
    });
    const push: PushResult = await git
      .run((session) => pushBranch(session, git.settings.remote, run.branch))
      .catch((error: unknown) => ({ pushed: false, rejected: false, error: messageOf(error) }));
    try {
      this.#deps.pushed?.(run, push);
    } catch (error) {
      this.#deps.warn?.("a catch-up's push could not be recorded", {
        run: run.runId,
        reason: messageOf(error),
      });
    }
    const facts: CatchUpFacts = {
      story: run.story,
      base: plan.base,
      onto: plan.onto,
      overlap: plan.overlap,
      conflicts: plan.conflicts,
      written: changes.written.length,
      removed: changes.removed.length,
    };
    this.#deps.info?.("a box run caught up with its base", {
      run: run.runId,
      commit: plan.commit,
      conflicts: plan.conflicts.length,
    });
    this.#deps.notice(run.office, run.runId, {
      level: plan.conflicts.length === 0 ? "info" : "warn",
      code: plan.conflicts.length === 0 ? COLLISION_NOTICES.caughtUp : COLLISION_NOTICES.conflict,
      text: catchUpNotice(facts),
    });
    if (push.rejected) {
      return {
        kind: "park",
        park: {
          reason: "conflict",
          cause: CATCH_UP_CAUSES.pushRejected,
          detail: `${push.error ?? "the push was rejected"}; the remote branch has commits the story branch lacks`,
        },
      };
    }
    if (push.error !== null) {
      this.#deps.warn?.("a catch-up was committed but not pushed", {
        run: run.runId,
        reason: push.error,
      });
    }
    const lockfiles = changedLockfiles(changes.written);
    if (lockfiles.length > 0) {
      await this.#deps.reinstall?.(run, lockfiles).catch((error: unknown) => {
        this.#deps.warn?.("the install after a catch-up failed", {
          run: run.runId,
          reason: messageOf(error),
        });
      });
    }
    const head = await git
      .run((session) => revParse(session, `refs/heads/${run.branch}^{commit}`))
      .then((found) => found ?? plan.commit);
    const item = plan.conflicts.length === 0 ? null : await this.#item(git, run, plan);
    return { kind: "merged", merged, head, facts, item };
  }

  /**
   * The branch's status written back into the story's task file, which the merge took from the base
   * (0019 section 10): through `taskStatus`, the single field write path. A failure is a notice.
   */
  async #writeTaskStatus(
    git: OfficeGit,
    run: PartRun,
    plan: Extract<CatchUpPlan, { kind: "merge" }>,
  ): Promise<void> {
    const taskFile = plan.taskFile as string;
    const status = await git
      .run(async (session) => {
        const shown = await session.step(session.repository, ["show", `${plan.tip}:${taskFile}`]);
        return shown.code === 0 ? taskFileStatus(shown.stdout) : null;
      })
      .catch(() => null);
    const failed = (why: string): void => {
      this.#deps.notice(run.office, run.runId, {
        level: "warn",
        code: COLLISION_NOTICES.taskFile,
        text: `${run.story}'s task file ${shownPaths([taskFile])} conflicted when dipo merged the base; dipo took the base's version, but ${why}. Check its status on the branch.`,
      });
    };
    if (status === null) {
      failed("the branch's version holds no status to write back");
      return;
    }
    if (this.#deps.taskStatus === undefined) {
      failed("this daemon cannot write the status back");
      return;
    }
    await this.#deps.taskStatus(run, status).catch((error: unknown) => {
      this.#deps.warn?.("writing the task file's status back after a catch-up failed", {
        run: run.runId,
        reason: messageOf(error),
      });
      failed(`writing its status ${status} back failed`);
    });
  }

  /** The conflict item of a merge: its content conflicts' hunks read from the merge commit. */
  async #item(
    git: OfficeGit,
    run: PartRun,
    plan: Extract<CatchUpPlan, { kind: "merge" }> & {
      readonly base: string;
      readonly commit: string;
    },
  ): Promise<ConflictItem> {
    const hunks = await git
      .run(async (session) => {
        const out: string[] = [];
        for (const file of plan.conflicts) {
          if (file.kind !== "content") continue;
          const spec = `${plan.commit}:${file.path}`;
          const size = await session.step(session.repository, ["cat-file", "-s", spec]);
          if (size.code !== 0 || Number(size.stdout.trim()) > CONFLICT_FILE_READ_MAX) continue;
          const text = await session.step(session.repository, ["cat-file", "blob", spec]);
          if (text.code === 0) out.push(...fileHunks(file.path, text.stdout));
        }
        return out;
      })
      .catch(() => []);
    return conflictFeedbackItem({
      base: plan.base,
      onto: plan.onto,
      conflicts: plan.conflicts,
      hunks,
      ...(this.#deps.itemMax === undefined ? {} : { itemMax: this.#deps.itemMax(run) }),
    });
  }

  /**
   * Stages the merge's written paths on the Mac (`git archive`, `mergeOffConfig`, then `tar`) and
   * checks each against the merge's mode and blob; a path missing or different throws. The box is
   * not touched.
   */
  async #stage(git: OfficeGit, commit: string, changes: BoxChanges): Promise<StagedMerge> {
    const stage = await realpath(await mkdtemp(join(this.#deps.tmpRoot, CATCH_UP_STAGE_PREFIX)));
    const remove = () => rm(stage, { recursive: true, force: true });
    try {
      const dir = join(stage, "files");
      await mkdir(dir, { mode: 0o755 });
      let n = 0;
      for (const group of chunks(changes.written)) {
        n += 1;
        const archive = join(stage, `merge-${n}.tar`);
        await git.run(async (session) =>
          session.ok(
            session.repository,
            [
              "--literal-pathspecs",
              "archive",
              "--format=tar",
              `--output=${archive}`,
              commit,
              "--",
              ...group,
            ],
            { config: await mergeOffConfig(session), env: BASE_CHECKOUT_ENV },
          ),
        );
        await unpack(this.#deps.code, archive, dir);
        await rm(archive, { force: true });
      }
      const { format, entries } = await git.run(async (session) => ({
        format: await objectFormat(session),
        entries: await entriesAt(session, commit, changes.written),
      }));
      for (const path of changes.written) {
        if (!(await stagedAs(format, join(dir, path), entries.get(path)))) {
          throw new BoxError(
            "box.failed",
            "a staged file of the merge is missing or differs from its blob (an export attribute?).",
          );
        }
      }
      return { dir, remove };
    } catch (error) {
      await remove();
      throw error;
    }
  }

  /** Removes and writes the merge's paths in the box. */
  async #write(run: PartRun, dir: string, changes: BoxChanges): Promise<void> {
    for (const group of chunks(changes.removed)) {
      const removed = await this.#deps.boxes.exec(
        run.box,
        ["rm", "-f", "--", ...group.map((path) => `${BOX_WORKDIR}/${path}`)],
        { timeoutMs: CATCH_UP_EXEC_TIMEOUT_MS },
      );
      if (removed.code !== 0) {
        throw new BoxError(
          "box.failed",
          `removing files in the box failed (exit ${removed.code}).`,
        );
      }
    }
    if (changes.written.length > 0) {
      // Never a root copy into `/work`, where the worker may have planted links (DIPO-334).
      await copyInAsUser(this.#deps.boxes, run.box, dir, BOX_WORKDIR);
    }
  }
}
