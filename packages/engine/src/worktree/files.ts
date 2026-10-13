// Setup step 1 (0010 section 8 and its 0008 amendment): the configured gitignored files come from
// the main checkout into the new worktree, and the main checkout's `.claude/settings.local.json`
// is copied without its permission-widening and MCP keys.
//
// Rules:
// - Each `worktree.files` path is repo-relative and inside the repository: no absolute path, no
//   empty, `.` or `..` segment, nothing under `.git`.
// - Nothing follows a symlink: every component of the source path is checked with `lstat` and a
//   symlink anywhere (on the path or inside a copied directory) refuses the entry. The check
//   records each entry with its `lstat`; exactly that list is placed (a directory is never listed
//   again). Right before and after each copy every component is checked again, and each file is
//   opened with `O_NOFOLLOW` and must be the checked node (`fstat` device and inode) before its
//   bytes are copied from that descriptor, so the leaf cannot be swapped between check and copy.
//   A directory above it swapped for a symlink is caught by the re-check after the copy, which
//   stops setup. The destination's existing parents in the worktree must be real directories, so
//   a tracked symlink cannot redirect a write; the destination is created with `O_EXCL` and
//   `O_NOFOLLOW`.
// - Every file to place must be ignored per `git check-ignore` in the new worktree (for a
//   directory every file under it, an empty directory itself); a path git would track refuses
//   setup, so a secret cannot be committed by accident.
// - `copy` copies with the source's mode bits (created 0600, then `fchmod` to the checked mode);
//   `link` places a symlink to the source, meant for large read-only data.
// - `.claude/settings.local.json` reaches the worktree only through its own rule: listed itself
//   or under a copied directory, it is left out of the list and copied stripped; a `link` entry on
//   it or on a directory above it refuses setup.
// - File contents are never inspected, hashed or logged: copies stream bytes from one descriptor
//   to the other in fixed-size chunks; log lines and notices name paths only. The one exception
//   is `.claude/settings.local.json`, which is opened with `O_NOFOLLOW`, parsed to drop keys and
//   never logged.

import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  type Stats,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, join } from "node:path";

import { LOCAL_SETTINGS_FILE, stripLocalSettings } from "../workers/claude-cli/settings-check";

/** One `worktree.files` entry, as the office config holds it. */
export interface WorktreeFileSpec {
  readonly path: string;
  readonly mode: "copy" | "link";
  readonly required: boolean;
}

/** A refusal of setup step 1; the message names the path and the rule. */
export class FileStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileStepError";
  }
}

export interface FileStepInput {
  /** The main checkout (canonical). */
  readonly main: string;
  /** The new story worktree. */
  readonly worktree: string;
  readonly files: readonly WorktreeFileSpec[];
  /**
   * The repo-relative paths among `paths` that git ignores in the new worktree (`git
   * check-ignore`); a tracked path is never in the result.
   */
  readonly ignored: (paths: readonly string[]) => Promise<ReadonlySet<string>>;
  /** Env file paths the run profile knows (0013 section 4). */
  readonly envFiles: ReadonlySet<string>;
}

export interface FileStepResult {
  /** Files copied, repo-relative, including those under copied directories. */
  readonly copied: readonly string[];
  /** Entries linked, repo-relative. */
  readonly linked: readonly string[];
  /** Optional entries whose source is missing. */
  readonly skipped: readonly string[];
  /** The copied files that are env files, for the development-secrets notice. */
  readonly envFiles: readonly string[];
  /** What happened to `.claude/settings.local.json`; null when it is not in the main checkout. */
  readonly settings: SettingsCopy | null;
  /** Log lines, paths only. */
  readonly log: readonly string[];
}

export type SettingsCopy =
  | { readonly copied: true }
  | { readonly copied: false; readonly why: string };

/** True for a file name the engine treats as an env file besides the profile's list. */
export function isEnvFileName(name: string): boolean {
  return /^\.env(?:$|\.)/.test(name) || /^\.dev\.vars(?:$|\.)/.test(name);
}

/** Checks a `worktree.files` path; returns its segments. */
export function repoSegments(path: string): string[] {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const segments = trimmed.split("/");
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    trimmed === "" ||
    segments.some((s) => s === "" || s === "." || s === "..")
  ) {
    throw new FileStepError(
      `worktree.files path "${path}" is not a plain repo-relative path inside the repository.`,
    );
  }
  if (segments[0] === ".git") {
    throw new FileStepError(`worktree.files path "${path}" is inside .git.`);
  }
  return segments;
}

/**
 * Refuses a path git would print quoted (a control character, `"` or `\`), so `git check-ignore`
 * prints every checked path exactly as given.
 */
function plainName(path: string): void {
  // oxlint-disable-next-line no-control-regex -- control characters are what this refuses
  if (/[\u0000-\u001f\u007f"\\]/.test(path)) {
    throw new FileStepError(
      `${JSON.stringify(path)} has a control character, a quote or a backslash in its name; dipo does not copy such files.`,
    );
  }
}

type Source =
  | { readonly kind: "missing" }
  | { readonly kind: "file"; readonly stats: Stats }
  | { readonly kind: "dir"; readonly stats: Stats };

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

/** The source at `segments` under `root`, checked component by component without following links. */
function sourceOf(root: string, segments: readonly string[], shown: string): Source {
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stats = lstatOrNull(current);
    if (stats === null) return { kind: "missing" };
    if (stats.isSymbolicLink()) {
      throw new FileStepError(
        `${shown}: ${segments.slice(0, index + 1).join("/")} is a symlink in the main checkout; dipo never follows symlinks when it copies files.`,
      );
    }
    const last = index === segments.length - 1;
    if (!last && !stats.isDirectory()) return { kind: "missing" };
    if (last) {
      if (stats.isFile()) return { kind: "file", stats };
      if (stats.isDirectory()) return { kind: "dir", stats };
      throw new FileStepError(`${shown} is neither a file nor a directory in the main checkout.`);
    }
  }
  return { kind: "missing" };
}

/** One checked source entry: its repo-relative path and the `lstat` taken when it was checked. */
interface Entry {
  readonly rel: string;
  readonly kind: "file" | "dir";
  readonly stats: Stats;
}

/**
 * Every entry under a source directory, the directory first and parents before children,
 * repo-relative with the `lstat` taken here; refuses any symlink. `skip` paths are left out.
 */
function walk(root: string, rel: string, stats: Stats, shown: string, skip: string): Entry[] {
  const entries: Entry[] = [{ rel, kind: "dir", stats }];
  const names = readdirSync(join(root, rel)).toSorted();
  for (const name of names) {
    const child = `${rel}/${name}`;
    if (child === skip) continue;
    const childStats = lstatSync(join(root, child));
    if (childStats.isSymbolicLink()) {
      throw new FileStepError(
        `${shown}: ${child} is a symlink in the main checkout; dipo never follows symlinks when it copies files.`,
      );
    }
    if (childStats.isDirectory()) {
      entries.push(...walk(root, child, childStats, shown, skip));
    } else if (childStats.isFile()) {
      entries.push({ rel: child, kind: "file", stats: childStats });
    } else {
      throw new FileStepError(`${shown}: ${child} is neither a file nor a directory.`);
    }
  }
  return entries;
}

/** The paths the ignore check covers: every file, and every directory that holds nothing. */
function checkedPaths(entries: readonly Entry[]): string[] {
  const parents = new Set(entries.map((entry) => entry.rel.slice(0, entry.rel.lastIndexOf("/"))));
  return entries
    .filter((entry) => entry.kind === "file" || !parents.has(entry.rel))
    .map((entry) => entry.rel);
}

/**
 * Checks the destination in the worktree: existing parents must be real directories and the
 * destination itself must not exist.
 */
function checkDestination(worktree: string, segments: readonly string[], shown: string): void {
  let current = worktree;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stats = lstatOrNull(current);
    if (stats === null) return;
    const last = index === segments.length - 1;
    if (last) {
      throw new FileStepError(
        `${shown} already exists in the new worktree; dipo does not overwrite it.`,
      );
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new FileStepError(
        `${shown}: ${segments.slice(0, index + 1).join("/")} in the new worktree is not a plain directory, so dipo does not write under it.`,
      );
    }
  }
}

function modeOf(stats: Stats): number {
  return stats.mode & 0o7777;
}

function sameNode(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Re-checks a source entry right before it is used: no component from the main checkout down is
 * a symlink, and the entry is still the node checked earlier (same device and inode, same kind).
 */
function recheck(main: string, entry: Entry): void {
  const segments = entry.rel.split("/");
  let current = main;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stats = lstatOrNull(current);
    const last = index === segments.length - 1;
    if (
      stats === null ||
      stats.isSymbolicLink() ||
      (!last && !stats.isDirectory()) ||
      (last &&
        (!sameNode(stats, entry.stats) ||
          (entry.kind === "file" ? !stats.isFile() : !stats.isDirectory())))
    ) {
      throw new FileStepError(
        `${entry.rel} changed in the main checkout while dipo copied it; setup stopped.`,
      );
    }
  }
}

/** Bytes per read when a file is copied from its descriptor. */
const COPY_CHUNK = 64 * 1024;

/**
 * Copies one checked file: the source is opened with `O_NOFOLLOW` and must be the checked node
 * (`fstat` device and inode), the destination is created with `O_CREAT | O_EXCL | O_NOFOLLOW` and
 * mode 0600, the bytes are streamed from one descriptor to the other in fixed-size chunks (never
 * inspected, hashed or logged), and the destination gets the checked mode bits.
 */
function copyFromDescriptor(from: string, to: string, entry: Entry): void {
  const source = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!sameNode(fstatSync(source), entry.stats)) {
      throw new FileStepError(
        `${entry.rel} changed in the main checkout while dipo copied it; setup stopped.`,
      );
    }
    const target = openSync(
      to,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const chunk = Buffer.allocUnsafe(COPY_CHUNK);
      for (;;) {
        const read = readSync(source, chunk, 0, COPY_CHUNK, null);
        if (read === 0) break;
        let written = 0;
        while (written < read) written += writeSync(target, chunk, written, read - written);
      }
      chunk.fill(0);
      fchmodSync(target, modeOf(entry.stats));
    } finally {
      closeSync(target);
    }
  } finally {
    closeSync(source);
  }
}

/**
 * Copies exactly the checked entries, parents first: directories are created, each file is
 * re-checked and copied from its `O_NOFOLLOW` descriptor (`copyFromDescriptor`) and re-checked
 * after the copy; directory modes are set last.
 */
function copyEntries(main: string, worktree: string, entries: readonly Entry[]): string[] {
  const copied: string[] = [];
  for (const entry of entries) {
    const to = join(worktree, entry.rel);
    recheck(main, entry);
    if (entry.kind === "dir") {
      mkdirSync(to, { mode: 0o700 });
      continue;
    }
    copyFromDescriptor(join(main, entry.rel), to, entry);
    recheck(main, entry);
    copied.push(entry.rel);
  }
  for (const entry of entries.toReversed()) {
    if (entry.kind === "dir") chmodSync(join(worktree, entry.rel), modeOf(entry.stats));
  }
  return copied;
}

function ensureParents(worktree: string, segments: readonly string[]): void {
  if (segments.length > 1) mkdirSync(join(worktree, ...segments.slice(0, -1)), { recursive: true });
}

/** True when `rel` is `.claude/settings.local.json` or a directory above it. */
function holdsLocalSettings(rel: string): boolean {
  return rel === LOCAL_SETTINGS_FILE || LOCAL_SETTINGS_FILE.startsWith(`${rel}/`);
}

interface Plan {
  readonly spec: WorktreeFileSpec;
  readonly rel: string;
  readonly segments: readonly string[];
  /** The checked source entries; exactly these are placed. */
  readonly entries: readonly Entry[];
}

/** Runs setup step 1. Throws `FileStepError` on a refusal; anything copied stays for the rollback. */
export async function placeFiles(input: FileStepInput): Promise<FileStepResult> {
  const log: string[] = [];
  const copied: string[] = [];
  const linked: string[] = [];
  const skipped: string[] = [];

  // Plan every entry first, so a refusal happens before anything is written.
  const plans: Plan[] = [];
  for (const spec of input.files) {
    const segments = repoSegments(spec.path);
    const rel = segments.join("/");
    if (holdsLocalSettings(rel) && spec.mode === "link") {
      throw new FileStepError(
        `${rel} is linked by worktree.files but holds ${LOCAL_SETTINGS_FILE}, which the worktree gets only as a copy without its permission keys; copy it instead.`,
      );
    }
    if (rel === LOCAL_SETTINGS_FILE) {
      log.push(`files: ${rel} is copied by its own rule (permission keys dropped), not as listed`);
      continue;
    }
    const source = sourceOf(input.main, segments, rel);
    if (source.kind === "missing") {
      if (spec.required) {
        throw new FileStepError(
          `${rel} is required by worktree.files but missing in the main checkout.`,
        );
      }
      skipped.push(rel);
      log.push(`files: ${rel} skipped, not in the main checkout (optional)`);
      continue;
    }
    const entries =
      source.kind === "file"
        ? [{ rel, kind: "file" as const, stats: source.stats }]
        : walk(input.main, rel, source.stats, rel, LOCAL_SETTINGS_FILE);
    if (source.kind === "dir" && holdsLocalSettings(rel)) {
      log.push(
        `files: ${LOCAL_SETTINGS_FILE} under ${rel} is copied by its own rule (permission keys dropped), not as listed`,
      );
    }
    for (const entry of entries) plainName(entry.rel);
    plans.push({ spec, rel, segments, entries });
  }

  const wanted = plans.flatMap((plan) => checkedPaths(plan.entries));
  const ignored = wanted.length === 0 ? new Set<string>() : await input.ignored(wanted);
  for (const plan of plans) {
    const tracked = checkedPaths(plan.entries).filter((path) => !ignored.has(path));
    if (tracked.length > 0) {
      const shown =
        tracked.slice(0, 5).join(", ") +
        (tracked.length > 5 ? `, and ${tracked.length - 5} more` : "");
      throw new FileStepError(
        `${plan.rel} is in worktree.files but git does not ignore ${shown} in the new worktree; dipo copies only ignored files, so a secret cannot be committed. Add it to .gitignore or remove it from worktree.files.`,
      );
    }
    checkDestination(input.worktree, plan.segments, plan.rel);
  }

  for (const plan of plans) {
    ensureParents(input.worktree, plan.segments);
    if (plan.spec.mode === "link") {
      const top = plan.entries[0] as Entry;
      recheck(input.main, top);
      symlinkSync(join(input.main, plan.rel), join(input.worktree, plan.rel));
      linked.push(plan.rel);
      log.push(`files: linked ${plan.rel}`);
    } else {
      const placed = copyEntries(input.main, input.worktree, plan.entries);
      copied.push(...placed);
      log.push(
        placed.length === 1 && placed[0] === plan.rel
          ? `files: copied ${plan.rel}`
          : `files: copied ${plan.rel} (${placed.length} files)`,
      );
    }
  }

  const settings = await copyLocalSettings(input, log);
  const envFiles = copied.filter(
    (path) => input.envFiles.has(path) || isEnvFileName(basename(path)),
  );
  return { copied, linked, skipped, envFiles, settings, log };
}

/**
 * Copies `.claude/settings.local.json` when present and ignored, without the stripped keys. It is
 * opened with `O_NOFOLLOW` after its parents are re-checked, and must be the node checked before.
 * A file that cannot be copied safely (a symlink, tracked, not a JSON object) is left out with the
 * reason; the worker then runs without it.
 */
async function copyLocalSettings(
  input: FileStepInput,
  log: string[],
): Promise<SettingsCopy | null> {
  const rel = LOCAL_SETTINGS_FILE;
  const segments = rel.split("/");
  let source: Source;
  try {
    source = sourceOf(input.main, segments, rel);
  } catch (error) {
    return leftOut(log, error instanceof Error ? error.message : String(error));
  }
  if (source.kind === "missing") return null;
  if (source.kind !== "file") return leftOut(log, `${rel} is not a file in the main checkout`);
  if (!(await input.ignored([rel])).has(rel)) {
    return leftOut(log, `${rel} is not ignored by git, so dipo does not copy it`);
  }
  try {
    checkDestination(input.worktree, segments, rel);
  } catch (error) {
    return leftOut(log, error instanceof Error ? error.message : String(error));
  }
  let text: string;
  try {
    recheck(input.main, { rel, kind: "file", stats: source.stats });
    const fd = openSync(join(input.main, rel), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!sameNode(fstatSync(fd), source.stats)) throw new Error("changed");
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return leftOut(log, `${rel} changed in the main checkout while dipo read it`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return leftOut(log, `${rel} in the main checkout is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return leftOut(log, `${rel} in the main checkout does not hold a JSON object`);
  }
  ensureParents(input.worktree, segments);
  const to = join(input.worktree, rel);
  const stripped = stripLocalSettings(parsed as Record<string, unknown>);
  writeFileSync(to, `${JSON.stringify(stripped, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  chmodSync(to, modeOf(source.stats));
  log.push(`files: copied ${rel} without its permission-widening and MCP keys`);
  return { copied: true };
}

function leftOut(log: string[], why: string): SettingsCopy {
  log.push(`files: ${LOCAL_SETTINGS_FILE} not copied: ${why}`);
  return { copied: false, why };
}
