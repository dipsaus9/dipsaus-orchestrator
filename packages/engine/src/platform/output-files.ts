// A child's stdout and stderr through regular files instead of pipes (DIPO-333, `SpawnOptions.output`).
// On Linux CI the end of a long Backlog CLI list was lost on its way through a pipe while the CLI
// exited 0, so `systemSpawn` can hand the child two files instead and read them after it exits.
//
// - The temp root must be a folder owned by this user, or a shared world-writable folder with the
//   sticky bit (`/tmp`); any other root is refused before anything is made in it.
// - Each spawn gets a fresh folder (mode 0700, an unpredictable name, `dipo-out-*`) holding two new
//   files (mode 0600), opened read-write without following a link and never over an existing file.
// - dipo keeps its own descriptors of the two files and reads through them, by position, once the
//   direct child has exited. A child that swaps a path for a link or a FIFO changes nothing dipo
//   reads; a descriptor that is not a regular file, or one larger than `OUTPUT_MAX_BYTES`, fails
//   the read.
// - The folder is removed after the read, also when it fails. A folder a crash left between the
//   start and the read is removed by `sweepOutputDirs` once it is older than `OUTPUT_SWEEP_AGE_MS`,
//   from the run temp sweep at daemon start.

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import type { SpawnOutputFile } from "@dipsaus-orchestrator/contract";

/** The name prefix of the private folder a child's output files are made in. */
export const OUTPUT_DIR_PREFIX = "dipo-out-";

/** The most bytes dipo reads from one output file; a larger one fails the read. */
export const OUTPUT_MAX_BYTES = 64 * 1024 * 1024;

/** How old a left-over output folder must be before the sweep removes it. */
export const OUTPUT_SWEEP_AGE_MS = 5 * 60 * 1000;

/** The private folder and dipo's descriptors of the files a child's stdout and stderr go to. */
export interface OutputFiles {
  readonly dir: string;
  readonly stdout: number;
  readonly stderr: number;
}

/** The uid of this process, or undefined where it has none. */
function currentUid(): number | undefined {
  return process.getuid?.();
}

/**
 * Makes `root` (mode 0700) when it is missing and refuses it unless it is a folder owned by `uid`,
 * or a shared world-writable folder with the sticky bit.
 */
export function checkTempRoot(root: string, uid = currentUid()): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = statSync(root);
  if (!info.isDirectory()) throw new Error(`the temp root ${root} is not a folder`);
  if (uid === undefined || info.uid === uid) return;
  const sharedSticky = (info.mode & 0o1000) !== 0 && (info.mode & 0o002) !== 0;
  if (!sharedSticky) {
    throw new Error(
      `the temp root ${root} belongs to another user and is not a shared folder with the sticky bit`,
    );
  }
}

/** Opens a new file at `path` for reading and writing, mode 0600; never over a file or a link. */
function openNew(path: string): number {
  const flags = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  return openSync(path, flags, 0o600);
}

/**
 * Checks the temp root, makes a fresh private folder under it and opens the stdout and stderr files
 * in it. Nothing is left behind when a step fails.
 */
export function openOutputFiles(output: SpawnOutputFile): OutputFiles {
  checkTempRoot(output.tempRoot);
  const dir = mkdtempSync(join(output.tempRoot, OUTPUT_DIR_PREFIX));
  const opened: number[] = [];
  try {
    opened.push(openNew(join(dir, "stdout")));
    opened.push(openNew(join(dir, "stderr")));
    const [stdout = -1, stderr = -1] = opened;
    return { dir, stdout, stderr };
  } catch (error) {
    for (const fd of opened) closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Closes both descriptors and removes the folder; a step that fails does not stop the others. */
export function closeOutputFiles(files: OutputFiles): void {
  for (const fd of [files.stdout, files.stderr]) {
    try {
      closeSync(fd);
    } catch {
      // Already closed.
    }
  }
  rmSync(files.dir, { recursive: true, force: true });
}

/** The whole content of the regular file behind `fd`, read by position; `name` is for errors. */
export function readKept(fd: number, name: string): Uint8Array {
  const info = fstatSync(fd);
  if (!info.isFile()) throw new Error(`the child's ${name} is not a regular file`);
  if (info.size > OUTPUT_MAX_BYTES) {
    throw new Error(`the child's ${name} holds ${info.size} bytes, more than dipo reads`);
  }
  const buffer = Buffer.alloc(info.size);
  let done = 0;
  while (done < info.size) {
    const read = readSync(fd, buffer, done, info.size - done, done);
    if (read === 0) break;
    done += read;
  }
  return buffer.subarray(0, done);
}

/**
 * The content of both files once `exited` settles, read through dipo's own descriptors; the
 * descriptors are closed and the folder removed after the read, also when it fails.
 */
export async function readOutputFiles(
  files: OutputFiles,
  exited: Promise<unknown>,
): Promise<[Uint8Array, Uint8Array]> {
  try {
    await exited;
    return [readKept(files.stdout, "stdout"), readKept(files.stderr, "stderr")];
  } finally {
    closeOutputFiles(files);
  }
}

/** The newest change time of the real folder `dir` and the entries directly in it. */
function newestChange(dir: string, mtimeMs: number): number {
  let newest = mtimeMs;
  for (const name of readdirSync(dir)) {
    newest = Math.max(newest, lstatSync(join(dir, name)).mtimeMs);
  }
  return newest;
}

/**
 * Removes the output folders a crash left under `root`: real folders (not links) named
 * `dipo-out-*`, owned by `uid`, with nothing in them changed for `OUTPUT_SWEEP_AGE_MS` before
 * `now`. Returns the folders removed; one that cannot be checked stays.
 */
export function sweepOutputDirs(root: string, now: number, uid = currentUid()): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.startsWith(OUTPUT_DIR_PREFIX)) continue;
    const dir = join(root, name);
    try {
      const info = lstatSync(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) continue;
      if (uid !== undefined && info.uid !== uid) continue;
      if (now - newestChange(dir, info.mtimeMs) < OUTPUT_SWEEP_AGE_MS) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // Gone meanwhile, or unreadable: it stays.
    }
  }
  return removed;
}
