// The code a box gets (0021 section 2 and decision 9, DIPO-271): a plain copy of the repository at
// the story's start commit, with no `.git` and no history, plus only the files outside git the base
// office config lists in `box.files`, each marked as holding no real secrets. dipo stages it in a
// folder of its own and copies that folder into the box; nothing else goes in.
//
// - The tracked files come from git's objects: `git archive` of the start commit into a tar file,
//   unpacked into the stage folder by the system `tar`, which refuses absolute names, `..` and
//   writes through a symlink by default. No worktree file is read. `git archive` applies the
//   smudge filters a commit's `.gitattributes` names, so the call switches off every filter driver
//   git's config defines, with the `_base` checkout's LFS settings (`BASE_CHECKOUT_CONFIG`): no
//   filter program runs.
// - Each listed file comes from the office's main checkout, the registered office path: it is the
//   maintainer's, where files outside git live, and no worker writes it (0021). Never from a story
//   worktree or `_base`, a clean checkout that holds no file outside git. It must be a regular file
//   whose real path stays in that checkout, no folder on its way there may be a symlink, it may not
//   replace a tracked file, and no folder on its way into the stage may be a symlink either. A
//   listed file that is missing is skipped and reported; a refused one too.

import { copyFile, constants, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import type { Clock, Spawn, TimerHandle } from "@dipsaus-orchestrator/contract";

import { BASE_CHECKOUT_CONFIG, BASE_CHECKOUT_ENV } from "../git/hardened";
import type { GitSession, OfficeGit } from "../git/office";
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
/** Git's empty tree, as an attribute source that holds no `.gitattributes`. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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
  /** The office's main checkout (the registered office path), where the listed files are read. */
  readonly source: string;
  /** dipo's temp root; the stage folder is made in it. */
  readonly tmpRoot: string;
  /**
   * No `.gitattributes` applies to the archive (the reviewer's copy, DIPO-276), so no
   * `export-ignore` or `export-subst` can hide or rewrite a file: `--worktree-attributes` stops
   * git reading the archived tree's own, and `GIT_ATTR_SOURCE` set to the empty tree stops it
   * reading the index's (a repository without a work tree reads them from its index). Only
   * `<git dir>/info/attributes`, which no worker writes, still applies. Off by default.
   */
  readonly ignoreTreeAttributes?: boolean;
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
export async function unpack(deps: BoxCodeDeps, archive: string, into: string): Promise<void> {
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

/** The reason when a folder on the way to `path` in `root` is a symlink or no folder; else null. */
async function plainFolders(root: string, path: string): Promise<string | null> {
  const parts = dirname(path)
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  let at = root;
  for (const part of parts) {
    at = join(at, part);
    let stat;
    try {
      stat = await lstat(at);
    } catch (error) {
      return codeOf(error) === "ENOENT"
        ? "missing in the main checkout"
        : `cannot be read (${codeOf(error)})`;
    }
    if (stat.isSymbolicLink()) return `${relative(root, at)} on its way is a symlink`;
    if (!stat.isDirectory()) return `${relative(root, at)} on its way is not a folder`;
  }
  return null;
}

/** Adds one listed file from `source` to `stage`; the reason when it is left out. */
async function addListed(
  source: string,
  stage: string,
  entry: BoxFileEntry,
): Promise<string | null> {
  const way = await plainFolders(source, entry.path);
  if (way !== null) return way;
  const from = join(source, entry.path);
  let stat;
  try {
    stat = await lstat(from);
  } catch (error) {
    return codeOf(error) === "ENOENT"
      ? "missing in the main checkout"
      : `cannot be read (${codeOf(error)})`;
  }
  if (!stat.isFile()) return "not a regular file (a symlink or a folder)";
  let real: string;
  try {
    real = await realpath(from);
  } catch (error) {
    return `cannot be resolved (${codeOf(error)})`;
  }
  if (!within(real, source)) return "leads outside the main checkout";
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

/** A filter driver name a `-c filter.<name>.<key>=` override can name. */
const DRIVER = /^[^=\n]+$/;

/**
 * The config that switches off every filter driver git's config defines, with the `_base`
 * checkout's LFS settings: an empty smudge and process command runs nothing, and `required` false
 * keeps the archive from failing over it. A driver name the override cannot carry refuses.
 */
export async function filtersOffConfig(
  session: GitSession,
): Promise<(readonly [string, string])[]> {
  const listed = await session.step(session.repository, [
    "config",
    "--name-only",
    "--get-regexp",
    "^filter\\..*\\.(smudge|process|required)$",
  ]);
  // 0 lists the drivers and 1 means none; anything else (a broken config) refuses, since the
  // drivers it could not list would run.
  if (listed.code !== 0 && listed.code !== 1) {
    throw new BoxError(
      "box.refused",
      `git could not list its filter drivers (exit ${listed.code}), so they cannot be switched off.`,
    );
  }
  const drivers = new Set<string>();
  for (const line of listed.stdout.split("\n")) {
    const found = /^filter\.(.+)\.(smudge|process|required)$/.exec(line.trim());
    if (found === null) continue;
    const name = found[1] ?? "";
    if (!DRIVER.test(name)) {
      throw new BoxError("box.refused", "a git filter driver's name cannot be switched off.");
    }
    drivers.add(name);
  }
  return [
    ...BASE_CHECKOUT_CONFIG,
    ...[...drivers].flatMap((name): (readonly [string, string])[] => [
      [`filter.${name}.smudge`, ""],
      [`filter.${name}.process`, ""],
      [`filter.${name}.required`, "false"],
    ]),
  ];
}

/**
 * Stages the code of one box: the start commit from git's objects, plus the listed files from
 * the office's main checkout. The caller copies `dir` into the box and then calls `remove`.
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
    await request.git.run(async (session) =>
      session.ok(
        session.repository,
        [
          "archive",
          "--format=tar",
          ...(request.ignoreTreeAttributes === true ? ["--worktree-attributes"] : []),
          `--output=${archive}`,
          request.commit,
        ],
        {
          config: await filtersOffConfig(session),
          env:
            request.ignoreTreeAttributes === true
              ? { ...BASE_CHECKOUT_ENV, GIT_ATTR_SOURCE: EMPTY_TREE }
              : BASE_CHECKOUT_ENV,
        },
      ),
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
        source === null ? "the main checkout cannot be read" : await addListed(source, dir, entry);
      if (why === null) added.push(entry.path);
      else skipped.push({ path: entry.path, why });
    }
    return { dir, added, skipped, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}
