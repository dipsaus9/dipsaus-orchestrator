// Delivery in parts (0021 section 8, DIPO-273). When the worker in a box hands dipo a part (W1,
// `BoxDoor`'s `onPart`), and once more when it says the story is done (`deliverLast`, before
// verify), dipo takes the changes since the last delivered part out of the box, scans them, and
// commits them on the story branch with the worker's message, then pushes the branch:
//
// 1. Out of the box. One `tar` of the box's `/work` streams out through the box interface's exec
//    (`streamFromBox`, shared with the package cache fill): dipo writes the stream itself into a
//    file it creates (O_CREAT|O_EXCL|O_NOFOLLOW) in a fresh folder of its own, cut at
//    `PART_ARCHIVE_LIMITS`, the exec's stdin closed. Never container copy, which keeps symlinks as
//    links. A failed stream kills only the exec client, so the worker's box is kept; the `tar` in
//    the box runs under `timeout` where the box has it, as the door's read does. Paths git would
//    ignore leave out early, inside the box, by an exclude list dipo builds from the delivered
//    root `.gitignore` (`inBoxExcludes`: plain names such as `node_modules`, unless a `!` rule
//    could re-include the name or a tracked path carries it). The box's filtering is never trusted: the Mac
//    checks every path again.
// 2. On the Mac. The extractor (`extractArchive`) writes only files and folders into a fresh
//    folder outside any repository and refuses hostile entries; every symlink or hard link is
//    recorded as data, never written or followed. dipo reads the files there, as data only, and
//    compares them with the last delivered tree: the story branch's tip, with `backlog/` as the box
//    got it at the start commit (dipo's own task-file commits never reach the box). Left out are
//    paths git ignores by the delivered or the part's own `.gitignore` rules (`box/ignore.ts`), the
//    files outside git the office config copies in (`box.files`), and anything below a submodule,
//    unless the delivered tree tracks the path.
// 3. The scans (0021 section 8). A protected-file check (`protectedKind`: git's own folder, the
//    whole `backlog/` with the story's task file, `.dipo/`, `.github/`, the Claude settings and
//    `.gitattributes`/`.gitmodules`) over every added, changed and deleted path, where any link
//    other than an unchanged tracked symlink also counts as protected; then a secret scan of every
//    added and changed file: secret file names (`isSecretPath`) and content patterns that the
//    delivered version of the file did not already hold (`newSecretKinds`). A hit parks the story
//    with a fixed text that names only the kinds found, never a path or what matched; nothing is
//    committed or pushed, and the files stay in the box.
// 4. The commit (0021 sections 8 and 14). dipo's own copy of the story branch is the branch in the
//    office repository, built from git objects alone: no checkout holds the part, so no git call
//    runs with a folder of worker-written files as its work tree or reads its `.gitattributes`,
//    hooks or config. Every step runs on the repository without a work tree (`git --bare`, the
//    hardened config: hooks off, no fsmonitor, no system config), with its filters off: the files
//    are stored with `hash-object -w --no-filters`, put into a temporary index in dipo's stage
//    folder read from the tip (`read-tree`, `update-index --cacheinfo`, `rm --cached`), and
//    committed with `commit-tree` (`rm --cached --force`: the repository's own HEAD is not the story branch); `update-ref` moves the branch only from the tip read at the
//    start. The subject is the worker's message (`partSubject`: cleaned, one line, at most 72
//    characters) and the body names the story and the part's number. Then the branch is pushed
//    without force. The story's Mac worktree is not written: its HEAD follows the branch, and its
//    files stay as dipo left them.
//
// Parts of one run are delivered one at a time. A part that finds the run not live (being parked,
// stopped, or not followed) is left queued in the box (`onPart` rejects), so it is delivered when
// the run goes on. A stream or git failure rejects too, and the door hands the part again.

import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import type { Clock, OfficeId } from "@dipsaus-orchestrator/contract";

import { isSecretPath, newSecretKinds } from "../context/secrets";
import { BASE_CHECKOUT_ENV } from "../git/hardened";
import type { GitSession, OfficeGit } from "../git/office";
import { EXTERNAL_STEP_TIMEOUT_MS, GitError } from "../git/runner";
import { type PushResult, pushBranch } from "../git/task-commit";
import {
  type ArchiveLink,
  type CacheArchiveLimits,
  extractArchive,
  streamFromBox,
} from "./cache-extract";
import { BOX_WORKDIR, filtersOffConfig } from "./code";
import { cleanDoorText, type DoorPart } from "./door";
import { ignoreFileDir, type IgnoreFile, IgnoreRules } from "./ignore";
import { BoxError, type BoxPort } from "./port";

const GIB = 1024 ** 3;
/** The caps of one part: 1 GiB of archive, 500,000 entries, 1 GiB unpacked. */
export const PART_ARCHIVE_LIMITS: CacheArchiveLimits = {
  maxArchiveBytes: GIB,
  maxEntries: 500_000,
  maxTotalBytes: GIB,
};
/** How long one part's stream out of the box may take. */
export const PART_STREAM_TIMEOUT_MS = 10 * 60_000;
/** How long the `tar` in the box may run, where the box has `timeout`: within the stream's deadline. */
export const PART_TAR_SECONDS = 540;
/** The prefix of the stage folder of one part in dipo's temp root. */
export const PART_STAGE_PREFIX = "dipo-box-part-";
/** The longest commit subject. */
export const PART_SUBJECT_MAX = 72;
/** The run directory's record of every part dipo took or refused. */
export const PART_RECORD_FILE = "box-parts.ndjson";
/** A part stream or git step failed; the door hands the part again. */
export const PART_FAILED = "box.partFailed";
/** The part's archive holds what dipo does not take; the story parks. */
export const PART_REFUSED = "box.partRefused";
/** The run is not live, so the part stays queued in the box. */
export const PART_WAITING = "box.partWaiting";
/** The words every part commit's body carries, which `partNumber` counts. */
const PART_MARKER = "delivered from its box by dipo";
/** How many paths one git call names. */
const PATHS_PER_CALL = 100;
/** How often a part is taken again when the branch moved under it. */
const MOVED_ATTEMPTS = 3;

/** The park causes of a part (`run/park.ts` holds the same strings). */
export const PART_CAUSES = {
  protectedFile: "protected-file",
  secret: "secret",
  refused: "part-refused",
  pushRejected: "push-rejected",
} as const;

// ---- the message ---------------------------------------------------------------------------------

/**
 * The commit subject of a part: the worker's message cleaned of control and hidden characters
 * (`cleanDoorText`, also when the door cleaned it already), its first line with runs of white space
 * made one space, cut to `PART_SUBJECT_MAX` characters; `fallback` when nothing is left.
 */
export function partSubject(message: string, fallback: string): string {
  const line =
    cleanDoorText(message)
      .split("\n")
      .find((text) => text.trim() !== "") ?? "";
  const flat = line.replace(/\s+/gu, " ").trim();
  const chars = [...(flat === "" ? fallback : flat)];
  return chars.slice(0, PART_SUBJECT_MAX).join("").trimEnd();
}

/** The commit message of part `n` of `story`: the subject, then a line naming both. */
export function partCommitMessage(
  story: string,
  n: number,
  message: string,
): { readonly subject: string; readonly body: string } {
  return {
    subject: partSubject(message, `Part ${n} of ${story}`),
    body: `Part ${n} of ${story}, ${PART_MARKER}.`,
  };
}

// ---- protected files -----------------------------------------------------------------------------

/** What makes a path protected: written only by dipo or the maintainer. */
export type ProtectedKind = "git" | "backlog" | "dipo" | "ci" | "claude" | "gitConfig" | "link";

/** The fixed text of each kind, for the park detail. */
export const PROTECTED_TEXT: Readonly<Record<ProtectedKind, string>> = {
  git: "git's own folder (.git)",
  backlog: "the backlog (backlog/, with the story's task file)",
  dipo: "dipo's configuration (.dipo/)",
  ci: "CI configuration (.github/)",
  claude: "the Claude settings (.claude/settings.json)",
  gitConfig: "git's attributes or submodules (.gitattributes, .gitmodules)",
  link: "a symlink or hard link",
};

/**
 * The protected kind of the repo-relative `path`, or null. Compared Unicode-decomposed and
 * lower-cased, as an APFS volume finds files: `.GitHub/` is `.github/` there.
 */
export function protectedKind(path: string): ProtectedKind | null {
  const key = path.normalize("NFD").toLowerCase();
  const parts = key.split("/");
  if (parts.includes(".git")) return "git";
  if (parts[0] === "backlog") return "backlog";
  if (parts[0] === ".dipo") return "dipo";
  if (parts[0] === ".github") return "ci";
  if (key === ".claude/settings.json" || key === ".claude/settings.local.json") return "claude";
  const name = parts.at(-1);
  if (name === ".gitattributes" || name === ".gitmodules") return "gitConfig";
  return null;
}

// ---- comparing -----------------------------------------------------------------------------------

/** One entry of the delivered tree (`git ls-tree -r`). */
export interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly id: string;
}

/** One regular file of the part, as dipo read it on the Mac. */
export interface PartFile {
  readonly mode: "100644" | "100755";
  readonly id: string;
  /** Its absolute path in dipo's stage folder. */
  readonly at: string;
}

/** One change of a part against the delivered tree. */
export type PartChange =
  | {
      readonly path: string;
      readonly kind: "added" | "changed";
      readonly mode: "100644" | "100755";
      readonly id: string;
      readonly at: string;
    }
  | { readonly path: string; readonly kind: "deleted" };

const FILE_MODES = new Set(["100644", "100755", "120000"]);

/**
 * Pure: the changes of a part against the delivered tree `view`, and the paths of its links that
 * are not the unchanged tracked symlink of their path (each a protected-file hit). `leftOut` says
 * whether an untracked path stays out (ignored or a listed file); paths below a submodule always
 * do, and a submodule is never deleted.
 */
export function comparePart(input: {
  readonly view: ReadonlyMap<string, TreeEntry>;
  readonly files: ReadonlyMap<string, PartFile>;
  readonly links: readonly ArchiveLink[];
  readonly leftOut: (path: string) => boolean;
  /** The blob id of a symlink whose target is `target`. */
  readonly linkId: (target: string) => string;
}): { readonly changes: PartChange[]; readonly linkHits: string[] } {
  const submodules = [...input.view]
    .filter(([, entry]) => entry.mode === "160000")
    .map(([path]) => path);
  const belowSubmodule = (path: string) =>
    submodules.some((sub) => path === sub || path.startsWith(`${sub}/`));
  const out = (path: string) =>
    belowSubmodule(path) || (!input.view.has(path) && input.leftOut(path));
  const changes: PartChange[] = [];
  const present = new Set<string>();
  for (const [path, file] of input.files) {
    if (out(path)) continue;
    present.add(path);
    const entry = input.view.get(path);
    if (entry === undefined) {
      changes.push({ path, kind: "added", mode: file.mode, id: file.id, at: file.at });
    } else if (entry.mode !== file.mode || entry.id !== file.id) {
      changes.push({ path, kind: "changed", mode: file.mode, id: file.id, at: file.at });
    }
  }
  const linkHits: string[] = [];
  for (const link of input.links) {
    if (out(link.path)) continue;
    present.add(link.path);
    const entry = input.view.get(link.path);
    const unchanged =
      link.kind === "symlink" && entry?.mode === "120000" && entry.id === input.linkId(link.target);
    if (!unchanged) linkHits.push(link.path);
  }
  for (const [path, entry] of input.view) {
    if (FILE_MODES.has(entry.mode) && !present.has(path)) changes.push({ path, kind: "deleted" });
  }
  return {
    changes: changes.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    linkHits: linkHits.toSorted(),
  };
}

/**
 * Pure: the in-box exclude list, `--exclude=<name>` for `tar`: the plain names the delivered root
 * `.gitignore` ignores at any depth, unless a `!` rule could re-include it (an exclude list cannot)
 * or a tracked path has a part of that name (it would go missing from the part). Only an early
 * filter: the Mac checks every path again.
 */
export function inBoxExcludes(rules: IgnoreRules, view: ReadonlyMap<string, TreeEntry>): string[] {
  const tracked = new Set([...view.keys()].flatMap((path) => path.split("/")));
  return rules.plainNames.filter((name) => !tracked.has(name) && !rules.reincludes(name));
}

/**
 * The command that streams the part out of the box: `tar` of `BOX_WORKDIR` to its stdout, hard
 * links stored as files, the excludes first, under `timeout` where the box has it.
 */
export function partArchiveCommand(excludes: readonly string[]): [string, ...string[]] {
  for (const name of excludes) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new BoxError("box.refused", `${JSON.stringify(name)} is not a plain name to exclude.`);
    }
  }
  return [
    "/bin/sh",
    "-c",
    `if command -v timeout >/dev/null 2>&1; then exec timeout ${PART_TAR_SECONDS} "$@"; fi; exec "$@"`,
    "dipo-part-out",
    "tar",
    "--hard-dereference",
    "-C",
    BOX_WORKDIR,
    "-cf",
    "-",
    ...excludes.map((name) => `--exclude=${name}`),
    ".",
  ];
}

/** git's id of a blob holding `content`, in the repository's object format. */
export function blobId(format: "sha1" | "sha256", content: Uint8Array | string): string {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

// ---- the scans -----------------------------------------------------------------------------------

/** The kind a secret file name is reported by. */
export const SECRET_NAME_KIND = "a secret file name";

/** Pure: the protected-file check of a part's changes and link hits. */
export function protectedHits(
  changes: readonly PartChange[],
  linkHits: readonly string[],
): { readonly kinds: ProtectedKind[]; readonly paths: string[] } {
  const kinds = new Set<ProtectedKind>();
  const paths: string[] = [];
  for (const change of changes) {
    const kind = protectedKind(change.path);
    if (kind === null) continue;
    kinds.add(kind);
    paths.push(change.path);
  }
  if (linkHits.length > 0) kinds.add("link");
  const order = Object.keys(PROTECTED_TEXT) as ProtectedKind[];
  return {
    kinds: order.filter((kind) => kinds.has(kind)),
    paths: [...paths, ...linkHits].toSorted(),
  };
}

/**
 * The secret scan of a part's added and changed files: a secret file name, or content patterns
 * the delivered version did not hold. `before` reads a changed file's delivered content; it is
 * asked only for a file whose new content matches a pattern.
 */
export async function secretHits(
  changes: readonly PartChange[],
  before: (id: string) => Promise<string>,
  view: ReadonlyMap<string, TreeEntry>,
): Promise<{ readonly kinds: string[]; readonly paths: string[] }> {
  const kinds = new Set<string>();
  const paths: string[] = [];
  for (const change of changes) {
    if (change.kind === "deleted") continue;
    let hit = false;
    if (isSecretPath(change.path)) {
      kinds.add(SECRET_NAME_KIND);
      hit = true;
    }
    const content = await readFile(change.at);
    let found = newSecretKinds(content, null);
    const old = view.get(change.path);
    if (found.length > 0 && change.kind === "changed" && old !== undefined) {
      found = newSecretKinds(content, await before(old.id));
    }
    for (const kind of found) kinds.add(kind);
    if (hit || found.length > 0) paths.push(change.path);
  }
  return { kinds: [...kinds], paths };
}

/** Pure: the fixed park detail of a protected-file hit; it names kinds only. */
export function protectedDetail(kinds: readonly ProtectedKind[]): string {
  return `The part the worker delivered changes protected files: ${kinds.map((kind) => PROTECTED_TEXT[kind]).join("; ")}. dipo committed and pushed nothing, and the change stays in the box. Only dipo or the maintainer writes these files.`;
}

/** Pure: the fixed park detail of a secret hit; it never quotes what matched, nor a path. */
export function secretDetail(kinds: readonly string[], files: number): string {
  return `The part the worker delivered holds what looks like a secret: ${kinds.join("; ")}, in ${files} ${files === 1 ? "file" : "files"}. dipo committed and pushed nothing, and the files stay in the box.`;
}

/** The fixed park detail of a part dipo could not take, by why. */
export function refusedDetail(why: "cap" | "archive" | "git", maxBytes: number): string {
  if (why === "cap") {
    return `The part the worker delivered is larger than ${maxBytes} bytes, so dipo did not take it; files git should ignore may be missing from .gitignore. dipo committed and pushed nothing.`;
  }
  if (why === "git") {
    return "The part the worker delivered holds a path git does not take into a commit. dipo committed and pushed nothing.";
  }
  return "The part the worker delivered holds an entry dipo does not take (a path that leaves its folder, a name twice, a link below which a file sits, or an entry other than a file, folder or link). dipo committed and pushed nothing.";
}

// ---- reading the part on the Mac -----------------------------------------------------------------

/** The regular files below `dest`, by repo-relative path; folders are walked, nothing else is. */
async function readPartFiles(
  dest: string,
  format: "sha1" | "sha256",
): Promise<Map<string, PartFile>> {
  const files = new Map<string, PartFile>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(dir)).toSorted()) {
      const at = join(dir, name);
      const path = prefix === "" ? name : `${prefix}/${name}`;
      const info = await lstat(at);
      if (info.isDirectory()) {
        await walk(at, path);
      } else if (info.isFile()) {
        const mode = (info.mode & 0o111) === 0 ? "100644" : "100755";
        files.set(path, { mode, id: blobId(format, await readFile(at)), at });
      } else {
        // The extractor writes only files and folders; anything else is not dipo's.
        throw new BoxError(PART_REFUSED, "the part's stage holds an entry that is no file.");
      }
    }
  };
  await walk(dest, "");
  return files;
}

// ---- the git side --------------------------------------------------------------------------------

/** The last delivered tree, as the box holds it. */
interface PartView {
  readonly tip: string;
  readonly tipTree: string;
  readonly format: "sha1" | "sha256";
  readonly entries: ReadonlyMap<string, TreeEntry>;
  readonly ignores: readonly IgnoreFile[];
}

function treeEntries(listed: string): [string, TreeEntry][] {
  return listed
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode = "", type = "", id = ""] = line.slice(0, tab).split(" ");
      return [line.slice(tab + 1), { mode, type, id }];
    });
}

function inBacklog(path: string): boolean {
  return path === "backlog" || path.startsWith("backlog/");
}

/**
 * The last delivered tree: the branch tip's tree with `backlog/` as the start commit holds it, the
 * box's view, since dipo's own task-file commits never reach the box. With the `.gitignore` files
 * it holds.
 */
async function readView(session: GitSession, branch: string, startSha: string): Promise<PartView> {
  const repo = session.repository;
  const tip = (
    await session.ok(repo, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`])
  ).trim();
  const tipTree = (await session.ok(repo, ["rev-parse", "--verify", `${tip}^{tree}`])).trim();
  const shown = (await session.ok(repo, ["rev-parse", "--show-object-format"])).trim();
  const format = shown === "sha256" ? "sha256" : "sha1";
  const entries = new Map<string, TreeEntry>();
  for (const [path, entry] of treeEntries(await session.ok(repo, ["ls-tree", "-r", "-z", tip]))) {
    if (!inBacklog(path)) entries.set(path, entry);
  }
  const atStart = await session.ok(repo, ["ls-tree", "-r", "-z", startSha, "--", "backlog"]);
  for (const [path, entry] of treeEntries(atStart)) entries.set(path, entry);
  const ignores: IgnoreFile[] = [];
  for (const [path, entry] of entries) {
    const dir = ignoreFileDir(path);
    if (dir === null || entry.type !== "blob" || entry.mode === "120000") continue;
    ignores.push({ dir, text: await session.ok(repo, ["cat-file", "blob", entry.id]) });
  }
  return { tip, tipTree, format, entries, ignores };
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += PATHS_PER_CALL) {
    out.push(items.slice(at, at + PATHS_PER_CALL));
  }
  return out;
}

/** The number of the next part: the part commits on the branch's first-parent line, plus one. */
async function partNumber(session: GitSession, startSha: string, tip: string): Promise<number> {
  const counted = await session.ok(session.repository, [
    "rev-list",
    "--count",
    "--first-parent",
    "--fixed-strings",
    `--grep=${PART_MARKER}`,
    `${startSha}..${tip}`,
  ]);
  return Number.parseInt(counted.trim(), 10) + 1;
}

/**
 * The tree of the part in the temporary index: the tip read, the deleted paths removed first (so a
 * file that becomes a folder, or a folder a file, leaves room), then the written files added.
 */
async function partTree(
  session: GitSession,
  changes: readonly PartChange[],
  ids: ReadonlyMap<string, string>,
  tip: string,
  index: { readonly env: Readonly<Record<string, string>> },
): Promise<string> {
  const repo = session.repository;
  await session.ok(repo, ["read-tree", tip], index);
  const deleted = changes.filter((change) => change.kind === "deleted").map((c) => c.path);
  for (const group of chunks(deleted)) {
    await session.ok(
      repo,
      [
        "--literal-pathspecs",
        "rm",
        "--cached",
        "--force",
        "--quiet",
        "--ignore-unmatch",
        "--",
        ...group,
      ],
      index,
    );
  }
  const written = changes.filter((change) => change.kind !== "deleted");
  for (const group of chunks(written)) {
    await session.ok(
      repo,
      [
        "update-index",
        "--add",
        "--replace",
        ...group.flatMap((change) => [
          "--cacheinfo",
          `${change.mode},${ids.get(change.path)},${change.path}`,
        ]),
      ],
      index,
    );
  }
  return (await session.ok(repo, ["write-tree"], index)).trim();
}

/**
 * Commits `changes` on top of `view.tip` from dipo's own copy (see the module comment): null when
 * the branch moved since `view` was read, `{ commit: null }` when the tree did not change, and
 * `refused` when git does not take the part's paths.
 */
async function commitPart(
  session: GitSession,
  input: {
    readonly branch: string;
    readonly story: string;
    readonly startSha: string;
    readonly view: PartView;
    readonly changes: readonly PartChange[];
    readonly message: string;
    readonly index: string;
  },
): Promise<{ readonly commit: string | null; readonly n: number } | "refused" | null> {
  const repo = session.repository;
  const { view } = input;
  const ref = `refs/heads/${input.branch}`;
  const now = (await session.ok(repo, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
  if (now !== view.tip) return null;
  const filesOff = { config: await filtersOffConfig(session), env: BASE_CHECKOUT_ENV };
  const index = { env: { ...BASE_CHECKOUT_ENV, GIT_INDEX_FILE: input.index } };
  const written = input.changes.filter((change) => change.kind !== "deleted");
  const ids = new Map<string, string>();
  for (const group of chunks(written)) {
    const stored = (
      await session.ok(
        repo,
        ["hash-object", "-w", "--no-filters", "--", ...group.map((c) => c.at)],
        filesOff,
      )
    )
      .split("\n")
      .filter((line) => line !== "");
    if (stored.length !== group.length) {
      throw new GitError(PART_FAILED, "git did not store every file of the part.");
    }
    group.forEach((change, at) => ids.set(change.path, stored[at]!));
  }
  let tree: string;
  try {
    tree = await partTree(session, input.changes, ids, view.tip, index);
  } catch (error) {
    // git refuses what it will never take (a path it does not allow): the same on every try.
    if (error instanceof GitError && error.code === "git.failed") return "refused";
    throw error;
  }
  const n = await partNumber(session, input.startSha, view.tip);
  if (tree === view.tipTree) return { commit: null, n };
  const message = partCommitMessage(input.story, n, input.message);
  const commit = (
    await session.ok(
      repo,
      ["commit-tree", tree, "-p", view.tip, "-m", message.subject, "-m", message.body],
      { timeoutMs: EXTERNAL_STEP_TIMEOUT_MS },
    )
  ).trim();
  await session.ok(repo, ["update-ref", "-m", message.subject, ref, commit, view.tip]);
  return { commit, n };
}

// ---- the deliverer -------------------------------------------------------------------------------

/** The facts of a box run a part needs. */
export interface PartRun {
  readonly runId: string;
  readonly office: OfficeId;
  readonly story: string;
  readonly branch: string;
  /** The commit the box's code was made from (`ClaimRecord.startSha`). */
  readonly startSha: string;
  readonly box: string;
  /** The run directory, for `PART_RECORD_FILE`; absent: no record is kept. */
  readonly runDir?: string;
}

/** What delivering one part did. */
export type PartOutcome =
  | {
      readonly kind: "committed";
      readonly n: number;
      readonly commit: string;
      /** Every path the part added, changed or deleted, sorted. */
      readonly paths: readonly string[];
      readonly push: PushResult;
    }
  /** Nothing changed since the last part. */
  | { readonly kind: "empty" }
  /** A scan hit: nothing committed or pushed; the story parks `scope-violation` with `cause`. */
  | {
      readonly kind: "hit";
      readonly cause: typeof PART_CAUSES.protectedFile | typeof PART_CAUSES.secret;
      readonly detail: string;
    }
  /** The part could not be taken (too big, a hostile archive): the story parks. */
  | { readonly kind: "refused"; readonly detail: string }
  /** The run is not live; nothing was taken. */
  | { readonly kind: "stopped" };

/** A park a part asks for. */
export interface PartPark {
  readonly reason: "scope-violation" | "conflict";
  readonly cause: string;
  readonly detail: string;
}

/** Pure: the park of an outcome, or null when the run goes on. */
export function partPark(outcome: PartOutcome): PartPark | null {
  switch (outcome.kind) {
    case "hit":
      return { reason: "scope-violation", cause: outcome.cause, detail: outcome.detail };
    case "refused":
      return { reason: "scope-violation", cause: PART_CAUSES.refused, detail: outcome.detail };
    case "committed":
      return outcome.push.rejected
        ? {
            reason: "conflict",
            cause: PART_CAUSES.pushRejected,
            detail: `${outcome.push.error ?? "the push was rejected"}; the remote branch has commits the story branch lacks`,
          }
        : null;
    default:
      return null;
  }
}

type Log = (message: string, fields: Readonly<Record<string, unknown>>) => void;

export interface BoxPartsDeps {
  readonly boxes: Pick<BoxPort, "execLive" | "stop">;
  readonly clock: Clock;
  /** dipo's temp root; each part's stage folder is made in it. */
  readonly tmpRoot: string;
  /** The facts of a box run, or null when no loaded office knows it. */
  readonly run: (runId: string) => PartRun | null;
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  /** The files outside git the office config copies into a box (`box.files`), repo-relative. */
  readonly listedFiles?: (git: OfficeGit) => Promise<readonly string[]>;
  /** True while the run goes on: tracked and nothing decided for it yet. */
  readonly live: (runId: string) => boolean;
  /** Parks the run, stopping its worker; false when another decision came first. */
  readonly park?: (runId: string, park: PartPark) => boolean;
  /** Reads the run's door now (`BoxWorkers.readDoor`), so queued parts go first. */
  readonly readDoor?: (runId: string) => Promise<unknown> | null;
  readonly limits?: CacheArchiveLimits;
  readonly timeoutMs?: number;
  readonly warn?: Log;
  readonly info?: Log;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Takes the parts of box runs out of their boxes, scans and commits them (see the file comment). */
export class BoxParts {
  readonly #deps: BoxPartsDeps;
  /** The delivery in flight per run: parts of one run go one at a time. */
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(deps: BoxPartsDeps) {
    this.#deps = deps;
  }

  /**
   * `BoxDoor`'s `onPart`: delivers the changes since the last part with the part's message. A hit
   * or a refused part parks the run; a rejected push parks it `conflict`. Rejects, so the part stays
   * queued in the box, when the run is not live or the delivery failed.
   */
  async onPart(part: DoorPart): Promise<void> {
    if (!this.#deps.live(part.runId)) {
      throw new BoxError(PART_WAITING, `run ${part.runId} is not going on; the part stays queued.`);
    }
    const run = this.#deps.run(part.runId);
    if (run === null) throw new BoxError(PART_WAITING, `run ${part.runId} is not known here.`);
    const outcome = await this.#serial(part.runId, () => {
      // Asked again in turn: a part before it may have parked the run.
      if (!this.#deps.live(part.runId)) {
        throw new BoxError(
          PART_WAITING,
          `run ${part.runId} is not going on; the part stays queued.`,
        );
      }
      return this.#deliver(run, part.message);
    });
    const park = partPark(outcome);
    if (park !== null) this.#deps.park?.(part.runId, park);
    else if (outcome.kind === "committed" && outcome.push.error !== null) {
      this.#deps.warn?.("a part was committed but not pushed", {
        run: part.runId,
        part: outcome.n,
        reason: outcome.push.error,
      });
    }
  }

  /**
   * Story done (W2): the parts still queued in the box go first (`readDoor`), then whatever changed
   * since becomes a last part with `message`. The caller parks on a hit, before verify.
   */
  async deliverLast(runId: string, message: string): Promise<PartOutcome> {
    try {
      await this.#deps.readDoor?.(runId);
    } catch (error) {
      // The last part carries every change since the last delivered one either way.
      this.#deps.warn?.("the box door could not be read before the last part", {
        run: runId,
        reason: messageOf(error),
      });
    }
    if (!this.#deps.live(runId)) return { kind: "stopped" };
    const run = this.#deps.run(runId);
    if (run === null) throw new BoxError(PART_FAILED, `run ${runId} is not known here.`);
    return this.#serial(runId, () =>
      this.#deps.live(runId)
        ? this.#deliver(run, message)
        : Promise.resolve<PartOutcome>({ kind: "stopped" }),
    );
  }

  #serial<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const before = this.#chains.get(runId) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(fn);
    const kept = next.catch(() => undefined);
    this.#chains.set(runId, kept);
    void kept.then(() => {
      if (this.#chains.get(runId) === kept) this.#chains.delete(runId);
    });
    return next;
  }

  async #deliver(run: PartRun, message: string): Promise<PartOutcome> {
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await this.#attempt(run, message);
      if (outcome !== null) {
        this.#record(run, outcome);
        return outcome;
      }
      if (attempt >= MOVED_ATTEMPTS) {
        throw new GitError(
          PART_FAILED,
          `the branch ${run.branch} kept moving while a part was taken.`,
        );
      }
    }
  }

  /** One try of a part; null when the branch moved meanwhile, so it is taken again. */
  async #attempt(run: PartRun, message: string): Promise<PartOutcome | null> {
    const git = this.#deps.git(run.office);
    if (git === undefined) throw new BoxError(PART_FAILED, `office ${run.office} has no git.`);
    const limits = this.#deps.limits ?? PART_ARCHIVE_LIMITS;
    const view = await git.run((session) => readView(session, run.branch, run.startSha));
    const listed = new Set(await (this.#deps.listedFiles?.(git) ?? Promise.resolve([])));
    const viewRules = new IgnoreRules(view.ignores);
    const stage = await realpath(await mkdtemp(join(this.#deps.tmpRoot, PART_STAGE_PREFIX)));
    try {
      const folder = join(stage, "archive");
      const dest = join(stage, "files");
      await mkdir(folder, { mode: 0o700 });
      await mkdir(dest, { mode: 0o700 });
      try {
        await streamFromBox({
          boxes: this.#deps.boxes,
          box: run.box,
          command: partArchiveCommand(inBoxExcludes(viewRules, view.entries)),
          folder,
          name: "part.tar",
          maxBytes: limits.maxArchiveBytes,
          timeoutMs: this.#deps.timeoutMs ?? PART_STREAM_TIMEOUT_MS,
          clock: this.#deps.clock,
          code: PART_FAILED,
          what: "the part archive",
          // The worker's box: a failed stream ends only the exec client (the module comment).
          stopOnFailure: false,
        });
      } catch (error) {
        if (error instanceof BoxError && error.details["reason"] === "cap") {
          return { kind: "refused", detail: refusedDetail("cap", limits.maxArchiveBytes) };
        }
        throw error;
      }
      let links: readonly ArchiveLink[];
      try {
        ({ links } = await extractArchive(folder, dest, {
          limits,
          code: PART_REFUSED,
          what: "the part archive",
          links: "record",
        }));
      } catch (error) {
        if (!(error instanceof BoxError) || error.code !== PART_REFUSED) throw error;
        // The message may quote the box's paths: the log only, never the park detail.
        this.#deps.warn?.("a part's archive was refused", {
          run: run.runId,
          reason: error.message,
        });
        return { kind: "refused", detail: refusedDetail("archive", limits.maxArchiveBytes) };
      }
      await rm(folder, { recursive: true, force: true });
      const files = await readPartFiles(dest, view.format);
      const partIgnores: IgnoreFile[] = [];
      for (const [path, file] of files) {
        const dir = ignoreFileDir(path);
        if (dir !== null) partIgnores.push({ dir, text: await readFile(file.at, "utf8") });
      }
      const partRules = new IgnoreRules(partIgnores);
      const { changes, linkHits } = comparePart({
        view: view.entries,
        files,
        links,
        leftOut: (path) => listed.has(path) || viewRules.ignored(path) || partRules.ignored(path),
        linkId: (target) => blobId(view.format, target),
      });
      const guarded = protectedHits(changes, linkHits);
      if (guarded.kinds.length > 0) {
        this.#hitRecord(run, PART_CAUSES.protectedFile, guarded.paths);
        return {
          kind: "hit",
          cause: PART_CAUSES.protectedFile,
          detail: protectedDetail(guarded.kinds),
        };
      }
      if (changes.length === 0) return { kind: "empty" };
      const result = await git.run(async (session) => {
        const secrets = await secretHits(
          changes,
          (id) => session.ok(session.repository, ["cat-file", "blob", id]),
          view.entries,
        );
        if (secrets.kinds.length > 0) return { secrets } as const;
        const committed = await commitPart(session, {
          branch: run.branch,
          story: run.story,
          startSha: run.startSha,
          view,
          changes,
          message,
          index: join(stage, "index"),
        });
        return { committed } as const;
      });
      if ("secrets" in result) {
        this.#hitRecord(run, PART_CAUSES.secret, result.secrets.paths);
        return {
          kind: "hit",
          cause: PART_CAUSES.secret,
          detail: secretDetail(result.secrets.kinds, result.secrets.paths.length),
        };
      }
      if (result.committed === null) return null;
      if (result.committed === "refused") {
        return { kind: "refused", detail: refusedDetail("git", limits.maxArchiveBytes) };
      }
      if (result.committed.commit === null) return { kind: "empty" };
      const { commit, n } = result.committed;
      const push = await git
        .run((session) => pushBranch(session, git.settings.remote, run.branch))
        .catch((error: unknown) => ({ pushed: false, rejected: false, error: messageOf(error) }));
      this.#deps.info?.("a part was committed", { run: run.runId, part: n, commit });
      return { kind: "committed", n, commit, paths: changes.map((c) => c.path), push };
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  /** The paths of a hit, cleaned, in the run directory's record only; never in the park detail. */
  #hitRecord(run: PartRun, cause: string, paths: readonly string[]): void {
    this.#append(run, {
      kind: "hit",
      at: this.#deps.clock.now(),
      cause,
      paths: paths.slice(0, 50).map((path) => cleanDoorText(path).slice(0, 300)),
    });
  }

  #record(run: PartRun, outcome: PartOutcome): void {
    if (outcome.kind === "hit") return;
    const at = this.#deps.clock.now();
    if (outcome.kind === "committed") {
      this.#append(run, {
        kind: "part",
        at,
        n: outcome.n,
        commit: outcome.commit,
        paths: outcome.paths.length,
        pushed: outcome.push.pushed,
      });
    } else {
      this.#append(run, { kind: outcome.kind, at });
    }
  }

  #append(run: PartRun, line: Readonly<Record<string, unknown>>): void {
    if (run.runDir === undefined) return;
    try {
      appendFileSync(join(run.runDir, PART_RECORD_FILE), `${JSON.stringify(line)}\n`, {
        mode: 0o600,
      });
    } catch (error) {
      this.#deps.warn?.("a part could not be recorded", {
        run: run.runId,
        reason: messageOf(error),
      });
    }
  }
}
