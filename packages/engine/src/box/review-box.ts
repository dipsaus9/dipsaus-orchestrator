// The reviewer's box (0002, 0008): each review session runs in a new box of its own, made from the
// office image, never the developer's. `BoxWorkers.review` makes it and `BoxWorkers.endReview`
// deletes it; this module holds what the copy of the pushed head needs.
//
// - The box is named after the session's agent (`reviewBoxName`), joins the box network with the
//   image's box network tools, and mounts nothing else: no package cache, no `box.files`.
// - The copy is exactly the pushed head, from git's objects alone (`stageBoxCode` with no listed
//   file and the tree's attributes off, so `export-ignore` and `export-subst` hide or rewrite
//   nothing). Its symbolic links and anything that is neither a file nor a folder are left out,
//   every file and folder is made read-only, and it is compared with `git ls-tree` of the commit: a
//   file of the commit that is missing, or a file the commit does not hold, refuses it.
// - It goes into the box at `REVIEW_ROOT` with the backend's copy, which keeps the host owner (not
//   the box user) and the read-only modes: the box user can read it and can neither write nor
//   chmod it. `REVIEW_ROOT` holds the code (`REVIEW_CODE_DIR`) and the session's empty working
//   directory (`REVIEW_SESSION_DIR`), so Claude Code finds no settings, hooks or CLAUDE.md of the
//   commit in its working directory or above it.

import { chmod, lstat, mkdir, readdir, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { OfficeGit } from "../git/office";
import { type BoxCodeDeps, stageBoxCode } from "./code";
import { BoxError, boxName } from "./port";

/** The run id prefix of a reviewer's box: `review-<agent id>`. */
export const REVIEW_BOX_RUN_PREFIX = "review-";
/** Where the reviewer's copy lives in its box: root's, read-only to the box user. */
export const REVIEW_ROOT = "/review";
/** The copy of the pushed head in the reviewer's box. */
export const REVIEW_CODE_DIR = `${REVIEW_ROOT}/code`;
/** The reviewer's working directory in its box: empty, beside the copy. */
export const REVIEW_SESSION_DIR = `${REVIEW_ROOT}/session`;

const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** Git's modes of a regular file; links (120000) and submodules (160000) have no file in the copy. */
const FILE_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);

/** The box name of the review session of `agent`. */
export function reviewBoxName(agent: string): string {
  return boxName(`${REVIEW_BOX_RUN_PREFIX}${agent}`);
}

/** The copy of the head does not hold exactly the commit's files: its review cannot start. */
export class ReviewCopyMismatchError extends BoxError {
  constructor(message: string) {
    super("box.reviewCopyMismatch", message);
    this.name = "ReviewCopyMismatchError";
  }
}

/**
 * Makes everything below `dir` read-only: files 0444 (0555 when executable), folders 0555. A
 * symbolic link is removed: it could point outside the copy; the diff shows it. So is anything
 * that is neither a file nor a folder.
 */
export async function lockReadOnly(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const stat = await lstat(path);
    if (stat.isDirectory()) {
      await lockReadOnly(path);
    } else if (stat.isFile()) {
      await chmod(path, (stat.mode & 0o111) === 0 ? 0o444 : 0o555);
    } else {
      await unlink(path);
    }
  }
  await chmod(dir, 0o555);
}

/** Gives every folder below `dir` its owner's write bit back, so the tree can be removed. */
async function unlock(dir: string): Promise<void> {
  await chmod(dir, 0o700);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await unlock(join(dir, entry.name));
  }
}

/** The paths of every regular file below `dir`, relative to it. */
async function filesBelow(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await filesBelow(join(dir, entry.name), rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Compares the copy with the commit's own file list (`git ls-tree -r -z`, links and submodules
 * left out): throws `ReviewCopyMismatchError` when a file of the commit is missing from it or it
 * holds a file the commit does not, for example one an `export-ignore` attribute left out.
 */
export async function checkCopyComplete(
  git: OfficeGit,
  commit: string,
  dir: string,
): Promise<void> {
  const listed = await git.run((session) =>
    session.ok(session.repository, ["ls-tree", "-r", "-z", "--full-tree", commit]),
  );
  const expected = new Set(
    listed.split("\0").flatMap((record) => {
      const tab = record.indexOf("\t");
      if (tab === -1) return [];
      const mode = record.slice(0, record.indexOf(" "));
      return FILE_MODES.has(mode) ? [record.slice(tab + 1)] : [];
    }),
  );
  const present = new Set(await filesBelow(dir));
  const missing = [...expected].filter((path) => !present.has(path));
  const extra = [...present].filter((path) => !expected.has(path));
  if (missing.length > 0 || extra.length > 0) {
    throw new ReviewCopyMismatchError(
      `the copy of ${commit} does not match the commit: ${missing.length} of its files missing, ${extra.length} files it does not hold`,
    );
  }
}

/** A staged reviewer copy: `root` holds `code` and `session`, as `REVIEW_ROOT` will. */
export interface StagedReviewCopy {
  readonly root: string;
  remove(): Promise<void>;
}

/**
 * Stages the reviewer's copy of `commit` in dipo's temp root (file comment): the code from git's
 * objects with the tree's attributes off, read-only, without links, checked against the commit's
 * file list, and an empty session folder beside it. A failure leaves nothing behind.
 */
export async function stageReviewCopy(
  deps: BoxCodeDeps,
  request: { readonly git: OfficeGit; readonly commit: string; readonly tmpRoot: string },
): Promise<StagedReviewCopy> {
  if (!COMMIT_ID.test(request.commit)) {
    throw new BoxError("box.refused", `${JSON.stringify(request.commit)} is not a commit id.`);
  }
  const staged = await stageBoxCode(deps, {
    git: request.git,
    commit: request.commit,
    files: [],
    source: request.tmpRoot,
    tmpRoot: request.tmpRoot,
    ignoreTreeAttributes: true,
  });
  const root = dirname(staged.dir);
  const remove = async (): Promise<void> => {
    await unlock(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  };
  try {
    await lockReadOnly(staged.dir);
    await checkCopyComplete(request.git, request.commit, staged.dir);
    await mkdir(join(root, "session"), { mode: 0o555 });
    await chmod(root, 0o555);
    return { root, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}
