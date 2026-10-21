// The code a box gets (0021 section 2 and decision 9, DIPO-271): a plain copy of the repository at
// the story's start commit, with no `.git` and no history, plus only the files outside git the base
// office config lists in `box.files`, each marked as holding no real secrets. dipo stages it in a
// folder of its own and copies that folder into the box; nothing else goes in.
//
// - The tracked files come from git's objects: `git archive` of the start commit into a tar file,
//   unpacked into the stage folder by the system `tar`, which refuses absolute names, `..` and
//   writes through a symlink by default. No worktree file is read.
// - Each listed file comes from dipo's checkout of the base (`_base`), never from a story worktree
//   or the main checkout. It must be a regular file whose real path stays in that checkout, it may
//   not replace a tracked file, and no folder on its way into the stage may be a symlink. A listed
//   file that is missing is skipped and reported; a refused one too.

import { copyFile, constants, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import type { Clock, Spawn, TimerHandle } from "@dipsaus-orchestrator/contract";

import type { OfficeGit } from "../git/office";
import type { BoxFileEntry } from "./image";
import { BoxError } from "./port";

/** Where the code lives in a box: the worker's working directory. */
export const BOX_WORKDIR = "/work";
/** dipo's own files in a box (the system file, the Safe-Chain CA bundle); never the code's. */
export const BOX_DIPO_DIR = "/dipo";
/** The system `tar` that unpacks the archive. */
export const SYSTEM_TAR = "/usr/bin/tar";
/** How long unpacking the archive may take. */
export const UNPACK_TIMEOUT_MS = 120_000;
/** The prefix of a stage folder in dipo's temp root. */
export const CODE_STAGE_PREFIX = "dipo-box-code-";

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export interface BoxCodeDeps {
  readonly spawn: Spawn;
  readonly clock: Clock;
  /** `SYSTEM_TAR` unless a test names another. */
  readonly tar?: string;
}

export interface BoxCodeRequest {
  readonly git: OfficeGit;
  /** The story's start commit (`ClaimRecord.startSha`). */
  readonly commit: string;
  /** `box.files` of the base office config (`readBaseBox`). */
  readonly files: readonly BoxFileEntry[];
  /** dipo's checkout of the base, where the listed files are read. */
  readonly source: string;
  /** dipo's temp root; the stage folder is made in it. */
  readonly tmpRoot: string;
}

/** A listed file left out, and why. */
export interface SkippedBoxFile {
  readonly path: string;
  readonly why: string;
}

export interface StagedBoxCode {
  /** The folder whose contents go into the box at `BOX_WORKDIR`. */
  readonly dir: string;
  /** The listed files that were added. */
  readonly added: readonly string[];
  readonly skipped: readonly SkippedBoxFile[];
  /** Removes the stage folder. */
  remove(): Promise<void>;
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "error";
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

/** Unpacks `archive` into `into` with the system tar, within `UNPACK_TIMEOUT_MS`. */
async function unpack(deps: BoxCodeDeps, archive: string, into: string): Promise<void> {
  const child = deps.spawn({
    cmd: [deps.tar ?? SYSTEM_TAR, "-x", "-f", archive, "-C", into],
    env: { PATH: "/usr/bin:/bin" },
  });
  let timer: TimerHandle | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = deps.clock.setTimeout(() => resolve("timeout"), UNPACK_TIMEOUT_MS);
  });
  try {
    const done = Promise.all([readAll(child.stderr), child.exited, readAll(child.stdout)]);
    const result = await Promise.race([done, timedOut]);
    if (result === "timeout") {
      child.kill("SIGKILL");
      throw new BoxError("box.timedOut", "unpacking the start commit for the box timed out.");
    }
    const [stderr, exit] = result;
    if (exit.code !== 0) {
      throw new BoxError(
        "box.failed",
        `unpacking the start commit for the box failed: ${stderr.trim() || `exit ${exit.code}`}`,
      );
    }
  } finally {
    if (timer !== undefined) deps.clock.clearTimeout(timer);
  }
}

/** True when `path` lies in `root` (both real paths). */
function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
}

/** Makes the folders above `path` in `root`, refusing any that exists as something else. */
async function folderFor(root: string, path: string): Promise<string | null> {
  const parts = dirname(path)
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  let at = root;
  for (const part of parts) {
    at = join(at, part);
    try {
      const stat = await lstat(at);
      if (!stat.isDirectory()) return `${relative(root, at)} in the start commit is not a folder`;
    } catch (error) {
      if (codeOf(error) !== "ENOENT") return `${relative(root, at)} cannot be read`;
      await mkdir(at, { mode: 0o755 });
    }
  }
  return null;
}

/** Adds one listed file from `source` to `stage`; the reason when it is left out. */
async function addListed(
  source: string,
  stage: string,
  entry: BoxFileEntry,
): Promise<string | null> {
  const from = join(source, entry.path);
  let stat;
  try {
    stat = await lstat(from);
  } catch (error) {
    return codeOf(error) === "ENOENT"
      ? "missing in dipo's checkout of the base"
      : `cannot be read (${codeOf(error)})`;
  }
  if (!stat.isFile()) return "not a regular file (a symlink or a folder)";
  let real: string;
  try {
    real = await realpath(from);
  } catch (error) {
    return `cannot be resolved (${codeOf(error)})`;
  }
  if (!within(real, source)) return "leads outside dipo's checkout of the base";
  const folder = await folderFor(stage, entry.path);
  if (folder !== null) return folder;
  try {
    // Exclusive: a tracked file of the same path, or anything else already there, is never replaced.
    await copyFile(real, join(stage, entry.path), constants.COPYFILE_EXCL);
  } catch (error) {
    return codeOf(error) === "EEXIST"
      ? "a file of that path is in the start commit"
      : `cannot be copied (${codeOf(error)})`;
  }
  return null;
}

/**
 * Stages the code of one box: the start commit from git's objects, plus the listed files from
 * dipo's checkout of the base. The caller copies `dir` into the box and then calls `remove`.
 */
export async function stageBoxCode(
  deps: BoxCodeDeps,
  request: BoxCodeRequest,
): Promise<StagedBoxCode> {
  if (!COMMIT.test(request.commit)) {
    throw new BoxError("box.refused", `${JSON.stringify(request.commit)} is not a commit id.`);
  }
  const root = await realpath(await mkdtemp(join(request.tmpRoot, CODE_STAGE_PREFIX)));
  const remove = () => rm(root, { recursive: true, force: true });
  try {
    const archive = join(root, "code.tar");
    const dir = join(root, "code");
    await mkdir(dir, { mode: 0o755 });
    await request.git.run((session) =>
      session.ok(session.repository, [
        "archive",
        "--format=tar",
        `--output=${archive}`,
        request.commit,
      ]),
    );
    await unpack(deps, archive, dir);
    await rm(archive, { force: true });
    const added: string[] = [];
    const skipped: SkippedBoxFile[] = [];
    let source: string | null = null;
    if (request.files.length > 0) {
      source = await realpath(request.source).catch(() => null);
    }
    for (const entry of request.files) {
      const why =
        source === null
          ? "dipo's checkout of the base cannot be read"
          : await addListed(source, dir, entry);
      if (why === null) added.push(entry.path);
      else skipped.push({ path: entry.path, why });
    }
    return { dir, added, skipped, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}
