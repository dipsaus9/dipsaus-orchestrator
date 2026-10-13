// Setup step 1 (0010 section 8 and its 0008 amendment): the configured gitignored files come from
// the main checkout into the new worktree, and the main checkout's `.claude/settings.local.json`
// is copied without its permission-widening and MCP keys.
//
// Rules:
// - Each `worktree.files` path is repo-relative and inside the repository: no absolute path, no
//   empty, `.` or `..` segment, nothing under `.git`.
// - Nothing follows a symlink: every component of the source path is checked with `lstat` and a
//   symlink anywhere (on the path or inside a copied directory) refuses the entry, so a copy can
//   never read outside the repository. The destination's existing parents in the worktree must be
//   real directories too, so a tracked symlink cannot redirect a write, and the destination must
//   not exist yet.
// - Every file to place must be ignored per `git check-ignore` in the new worktree (for a
//   directory every file under it, an empty directory itself); a path git would track refuses
//   setup, so a secret cannot be committed by accident.
// - `copy` copies with the source's mode bits (`copyFile` with `COPYFILE_EXCL`, then `chmod`);
//   `link` places a symlink to the source, meant for large read-only data.
// - File contents are never read, hashed or logged; log lines and notices name paths only. The
//   one exception is `.claude/settings.local.json`, which is parsed to drop keys and is never
//   logged either.

import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  type Stats,
  symlinkSync,
  writeFileSync,
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

/** Files (and empty directories) under a source directory, repo-relative; refuses any symlink. */
function walk(root: string, rel: string, shown: string): { files: string[]; empty: string[] } {
  const files: string[] = [];
  const empty: string[] = [];
  const entries = readdirSync(join(root, rel), { withFileTypes: true });
  if (entries.length === 0) empty.push(rel);
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const child = `${rel}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new FileStepError(
        `${shown}: ${child} is a symlink in the main checkout; dipo never follows symlinks when it copies files.`,
      );
    }
    if (entry.isDirectory()) {
      const inner = walk(root, child, shown);
      files.push(...inner.files);
      empty.push(...inner.empty);
    } else if (entry.isFile()) {
      files.push(child);
    } else {
      throw new FileStepError(`${shown}: ${child} is neither a file nor a directory.`);
    }
  }
  return { files, empty };
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

/** Copies one regular file with its mode; never opens it in this process. */
function copyFile(from: string, to: string): void {
  const stats = lstatSync(from);
  if (!stats.isFile()) throw new FileStepError(`${from} changed while dipo copied it.`);
  copyFileSync(from, to, constants.COPYFILE_EXCL);
  chmodSync(to, modeOf(stats));
}

function copyTree(main: string, worktree: string, rel: string): string[] {
  const from = join(main, rel);
  const to = join(worktree, rel);
  const stats = lstatSync(from);
  if (stats.isSymbolicLink())
    throw new FileStepError(`${rel} changed to a symlink while dipo copied it.`);
  if (stats.isFile()) {
    copyFile(from, to);
    return [rel];
  }
  mkdirSync(to, { mode: 0o700 });
  const copied: string[] = [];
  for (const name of readdirSync(from).toSorted())
    copied.push(...copyTree(main, worktree, `${rel}/${name}`));
  chmodSync(to, modeOf(stats));
  return copied;
}

function ensureParents(worktree: string, segments: readonly string[]): void {
  if (segments.length > 1) mkdirSync(join(worktree, ...segments.slice(0, -1)), { recursive: true });
}

/** Runs setup step 1. Throws `FileStepError` on a refusal; anything copied stays for the rollback. */
export async function placeFiles(input: FileStepInput): Promise<FileStepResult> {
  const log: string[] = [];
  const copied: string[] = [];
  const linked: string[] = [];
  const skipped: string[] = [];

  // Plan every entry first, so a refusal happens before anything is written.
  const plans: { spec: WorktreeFileSpec; rel: string; segments: string[]; check: string[] }[] = [];
  for (const spec of input.files) {
    const segments = repoSegments(spec.path);
    const rel = segments.join("/");
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
    const check =
      source.kind === "file"
        ? [rel]
        : (() => {
            const tree = walk(input.main, rel, rel);
            return [...tree.files, ...tree.empty];
          })();
    for (const path of check) plainName(path);
    plans.push({ spec, rel, segments, check });
  }

  const wanted = plans.flatMap((plan) => plan.check);
  const ignored = wanted.length === 0 ? new Set<string>() : await input.ignored(wanted);
  for (const plan of plans) {
    const tracked = plan.check.filter((path) => !ignored.has(path));
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
      symlinkSync(join(input.main, plan.rel), join(input.worktree, plan.rel));
      linked.push(plan.rel);
      log.push(`files: linked ${plan.rel}`);
    } else {
      const placed = copyTree(input.main, input.worktree, plan.rel);
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
 * Copies `.claude/settings.local.json` when present and ignored, without the stripped keys. A
 * file that cannot be copied safely (a symlink, tracked, not a JSON object) is left out with the
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(input.main, rel), "utf8"));
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
