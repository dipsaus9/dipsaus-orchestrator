// Delivery in parts (0021 section 8, DIPO-273). When the worker in a box hands dipo a part (W1,
// `BoxDoor`'s `onPart`), and once more when it says the story is done (`deliverLast`, `finishLast`),
// dipo takes the changes since the last delivered part out of the box, scans them, and
// commits them on the story branch with the worker's message, then pushes the branch:
//
// 1. Out of the box. One `tar` of the box's `/work` streams out through the box interface's exec
//    (`streamFromBox`, shared with the package cache fill): dipo writes the stream itself into a
//    file it creates (O_CREAT|O_EXCL|O_NOFOLLOW) in a fresh folder of its own, cut at
//    `PART_ARCHIVE_LIMITS`, the exec's stdin closed. Never container copy, which keeps symlinks as
//    links. A failed stream kills only the exec client, so the worker's box is kept; the `tar` in
//    the box runs under `timeout` where the box has it, as the door's read does. Paths git would
//    ignore leave out early, inside the box, by an exclude list dipo builds from the delivered
//    root `.gitignore` (`inBoxExcludes`: plain names such as `node_modules`, and names anchored
//    to the root such as `/node_modules`, unless a `!` rule could re-include the name or a
//    tracked path carries it). When the part's own root `.gitignore` no longer ignores a name the
//    box left out, the part is taken again with the exclude list of its own rules, the last of at
//    most `EXCLUDE_TAKES` streams with none, so a path the part un-ignores is delivered in that
//    same part. The box's filtering is never trusted: the Mac checks every path again.
// 2. On the Mac. The extractor (`extractArchive`) writes only files and folders into a fresh
//    folder outside any repository and refuses hostile entries; every symlink or hard link is
//    recorded as data, never written or followed. dipo reads the files there, as data only, and
//    compares them with the last delivered tree: the story branch's tip, with `backlog/` as the box
//    got it at the start commit (dipo's own task-file commits never reach the box). Left out are
//    paths git ignores by the part's own `.gitignore` rules (`box/ignore.ts`), as git would in the
//    part's commit, the files outside git the office config copied in when the box was made (the
//    run's record of `box.files`, `BoxRunRecord.files`, never the base config at part time), and
//    anything below a submodule, unless the delivered tree tracks the path. The matching runs in
//    batches with the event loop free between them, within `IGNORE_WORK_BUDGET`; a part's
//    `.gitignore` over `IGNORE_FILE_MAX` is refused unread.
// 3. The scans (0021 section 8). A path with a control, bidirectional or invisible character is
//    refused. A protected-file check (`protectedKind`, folded as APFS folds names, with a
//    look-alike fold as a second layer: git's own folder, the whole `backlog/` with the story's
//    task file, `.dipo/`, `.github/`, the Claude settings, `.gitattributes`/`.gitmodules`, and
//    the configuration of the tools dipo runs on checkouts of the repository: the Backlog CLI's,
//    Bun's and Claude Code's MCP servers', with the configuration in the backlog folder the
//    delivered `backlog.config.yml` names, DIPO-312) runs
//    over every added, changed and deleted path, where any link other than an unchanged tracked
//    symlink also counts as protected. Then the secret scan, outside the git queue: the cleaned
//    commit subject, every added or changed path's name, and every added or changed file streamed
//    in chunks (a file over `SCAN_FILE_MAX` refuses the part): secret file names (`isSecretPartPath`),
//    content patterns and the values of the listed box files (`listedValues`) that the delivered
//    version of the file did not already hold. A hit parks the story with a fixed text that names
//    only the kinds found, never a path or what matched; nothing is committed or pushed, and the
//    files stay in the box.
// 4. The commit (0021 sections 8 and 14). dipo's own copy of the story branch is the branch in the
//    office repository, built from git objects alone: no checkout holds the part, so no git call
//    runs with a folder of worker-written files as its work tree or reads its `.gitattributes`,
//    hooks or config. Every step runs on the repository without a work tree (`git --bare`, the
//    hardened config: hooks off, no fsmonitor, no system config), with its filters off: the files
//    are stored with `hash-object -w --no-filters`, put into a temporary index in dipo's stage
//    folder read from the tip (`read-tree`, `update-index --cacheinfo`, `rm --cached`), and
//    committed with `commit-tree` (`rm --cached --force`: the repository's own HEAD is not the
//    story branch); `update-ref` moves the branch only from the tip read at the start. A path git
//    does not take refuses the part. GNU tar's exit 1 (a file changed while it read it) is
//    accepted: the Mac checks every entry again. The subject is the worker's message
//    (`partSubject`: cleaned, one line, at most 72 characters) and the body names the story and
//    the part's number. Then the branch is pushed without force. The story's Mac worktree is not
//    written: its HEAD follows the branch, and its files stay as dipo left them.
//
// Parts of one run are delivered one at a time. A part that finds the run not live (being parked,
// stopped, or not followed) is left queued in the box (`onPart` rejects), so it is delivered when
// the run goes on. A stream or git failure rejects too, and the door hands the part again at its
// usual pace: such a part never parks the story, and the worker goes on (DIPO-290). Failures are
// counted at most once per door read; once `PART_STUCK_READS` reads in a row failed over at least
// `PART_STUCK_MIN_MS`, the maintainer gets one warning notice of the run (`PART_NOTICES.stuck`),
// and a part taken out again ends the streak with an info notice (`PART_NOTICES.unstuck`). A run
// that is not live, any part taken out (also the last one, or one in a held turn), or a door that
// did not read for `PART_STREAK_GAP_MS` (the session ended, the run parked and resumed) ends the
// streak, so a resumed run starts a fresh one.
//
// Each part's stage folder is made in this daemon's own folder of stages under its state folder
// (`partStageRoot`, 0700, refused when it is a link or not the user's) and removed when the part
// is done; the ones a stopped daemon left there are removed at daemon start
// (`BoxParts.sweepStages`). No other daemon or user shares that folder.
//
// Story done (`finishLast`) holds the same one-at-a-time turn from the last part until the caller
// has claimed the run's end, so no part or catch-up moves the branch between the last part and In
// Review. dipo runs no verify in the box (0021 amendment of 2026-10-22, DIPO-299): CI on the story
// PR is the verify of a box run.

import { createHash } from "node:crypto";
import { appendFileSync, constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { join } from "node:path";

import type { Clock, OfficeId } from "@dipsaus-orchestrator/contract";

import {
  isSecretPartPath,
  newKeyKinds,
  type SecretKeys,
  secretKeys,
  secretKeysOfBytes,
  secretKeysOfFile,
  type SecretValues,
} from "../context/secrets";
import { backlogPointer } from "../backlog/runner";
import { BASE_CHECKOUT_ENV } from "../git/hardened";
import type { GitSession, OfficeGit } from "../git/office";
import { GitError } from "../git/runner";
import { commitTree, moveBranch, type PushResult, pushBranch } from "../git/write";
import { yieldToEventLoop } from "../platform/clock";
import {
  type ArchiveLink,
  type CacheArchiveLimits,
  extractArchive,
  streamFromBox,
} from "./cache-extract";
import { BOX_WORKDIR, filtersOffConfig } from "./code";
import { cleanDoorText, type DoorPart } from "./door";
import {
  IgnoreBudgetExceeded,
  ignoreFileDir,
  type IgnoreFile,
  IgnoreRules,
  MatchBudget,
} from "./ignore";
import { BoxError, type BoxPort } from "./port";
import { readBoxRun } from "./workers";

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
/** The largest `.gitignore` of a part; a larger one refuses the part, unread. */
export const IGNORE_FILE_MAX = 64 * 1024;
/**
 * The most ignore-matching steps one part may take (`MatchBudget`: characters compared and `**`
 * steps); past it the part is refused.
 */
export const IGNORE_WORK_BUDGET = 200_000_000;
/** How many paths are matched between two turns of the event loop. */
const IGNORE_BATCH = 1_000;
/** The largest file a part may add or change: it is scanned whole, so a larger one refuses the part. */
export const SCAN_FILE_MAX = 64 * 1024 * 1024;
/** The largest listed box file whose values are read. */
const LISTED_FILE_MAX = 1024 * 1024;
/** The shortest value of a listed box file a part may not bring in. */
export const LISTED_VALUE_MIN = 12;
/** The spread (bits per character) an identifier-shaped listed value needs to be looked for. */
const LISTED_VALUE_MIN_ENTROPY = 4;
/** The longest value of a listed box file looked for. */
const LISTED_VALUE_MAX_CHARS = 4096;
/** The most values of the listed box files looked for. */
const LISTED_VALUES_MAX = 5_000;
/** How much of a file one hash read takes. */
const HASH_CHUNK = 1024 * 1024;
/** How often a part is taken again when the branch moved under it. */
const MOVED_ATTEMPTS = 3;
/**
 * The most streams of one part out of the box: the first with the delivered tree's excludes, then
 * with the excludes of the part's own `.gitignore` when it no longer ignores one of them, the last
 * with none.
 */
export const EXCLUDE_TAKES = 3;
/**
 * How many door reads in a row a part must fail (the stream out of the box or a git step) before
 * the maintainer is told (DIPO-290); several parts of one read count once.
 */
export const PART_STUCK_READS = 5;
/** How long a part must keep failing, from its first failure in a row, before the maintainer is told. */
export const PART_STUCK_MIN_MS = 2 * 60_000;
/**
 * The longest time between a failed door read and the next one within one streak; a longer one
 * means the door was not reading (the session ended, the run parked or stopped, a restart), so the
 * next failure starts a fresh streak.
 */
export const PART_STREAK_GAP_MS = 60_000;
/** The name of the folder of a daemon's part stages in its state folder (`partStageRoot`). */
export const PART_STAGE_DIR = "box-parts";
/** The `engine.notice` codes of a part dipo keeps failing to take out of the box. */
export const PART_NOTICES = {
  stuck: "box.partStuck",
  unstuck: "box.partUnstuck",
} as const;

/** The park causes of a part (`run/park.ts` holds the same strings). */
export const PART_CAUSES = {
  protectedFile: "protected-file",
  secret: "secret",
  refused: "part-refused",
  pushRejected: "push-rejected",
  /** The box lacks a merge dipo made on the branch outside it (DIPO-324): `catch-up-failed`. */
  behind: "catch-up-failed",
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
export type ProtectedKind =
  | "git"
  | "backlog"
  | "dipo"
  | "ci"
  | "claude"
  | "gitConfig"
  | "backlogConfig"
  | "bunConfig"
  | "mcpConfig"
  | "link";

/** The fixed text of each kind, for the park detail. */
export const PROTECTED_TEXT: Readonly<Record<ProtectedKind, string>> = {
  git: "git's own folder (.git)",
  backlog: "the backlog (backlog/, with the story's task file)",
  dipo: "dipo's configuration (.dipo/)",
  ci: "CI configuration (.github/)",
  claude: "the Claude settings (.claude/settings.json)",
  gitConfig: "git's attributes or submodules (.gitattributes, .gitmodules)",
  backlogConfig: "the Backlog CLI's configuration (backlog.config.yml, .backlog/)",
  bunConfig: "Bun's configuration (bunfig.toml)",
  mcpConfig: "Claude Code's MCP server configuration (.mcp.json)",
  link: "a symlink or hard link",
};

/**
 * `text` folded as a case- and normalisation-insensitive volume compares names: decomposed, then
 * upper- and lower-cased, so `ſ` and `K` (Kelvin) meet their ASCII letters as `.GitHub/` meets
 * `.github/`.
 */
export function foldName(text: string): string {
  return text.normalize("NFD").toUpperCase().toLowerCase();
}

/** `text` folded harder: compatibility forms (`ｂ`), combining marks dropped, then `foldName`. */
function lookAlike(text: string): string {
  return foldName(text.normalize("NFKD").replace(/\p{M}/gu, ""));
}

/**
 * The protected kind of the repo-relative `path`, or null. Compared folded (`foldName`), as an
 * APFS volume finds files; and, as a second layer, a path with characters outside ASCII is also
 * protected when its look-alike fold (`.gitattributeſ`, `ｂacklog/`) names a protected file.
 * `backlogFolder` is the backlog folder the delivered tree's `backlog.config.yml` names, if any:
 * its `config.yml` and `config.yaml` are the Backlog CLI's configuration too.
 */
export function protectedKind(
  path: string,
  backlogFolder: string | null = null,
): ProtectedKind | null {
  const kind = protectedOf(foldName(path), backlogFolder === null ? null : foldName(backlogFolder));
  if (kind !== null) return kind;
  if (!/[^\p{ASCII}]/u.test(path)) return null;
  return protectedOf(lookAlike(path), backlogFolder === null ? null : lookAlike(backlogFolder));
}

/**
 * Characters a part's path may not hold: every control (`\p{Cc}`), format character (`\p{Cf}`:
 * the bidirectional marks, soft hyphen, zero-width and tag characters, U+180E, U+FFF9 to U+FFFB)
 * and line or paragraph separator (`\p{Zl}`, `\p{Zp}`), and the invisible characters git's HFS
 * check ignores.
 */
const UNSAFE_PATH: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x61c, 0x61c],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
];

/** True when a part's path holds a control, bidirectional or invisible character. */
export function unsafePath(path: string): boolean {
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path)) return true;
  for (const char of path) {
    const code = char.codePointAt(0)!;
    if (UNSAFE_PATH.some(([low, high]) => code >= low && code <= high)) return true;
  }
  return false;
}

function protectedOf(key: string, folder: string | null): ProtectedKind | null {
  const parts = key.split("/");
  if (parts.includes(".git")) return "git";
  if (parts[0] === "backlog") return "backlog";
  if (parts[0] === ".dipo") return "dipo";
  if (parts[0] === ".github") return "ci";
  if (key === ".claude/settings.json" || key === ".claude/settings.local.json") return "claude";
  const name = parts.at(-1);
  if (name === ".gitattributes" || name === ".gitmodules") return "gitConfig";
  if (folder !== null && (key === `${folder}/config.yml` || key === `${folder}/config.yaml`)) {
    return "backlogConfig";
  }
  return toolConfigOf(key, parts);
}

// The configuration of the tools dipo runs on checkouts of the repository (DIPO-312, 0021 section
// 14): after a story merges, dipo runs the Backlog CLI (a program built with Bun) and Bun in
// checkouts of the base, and the reviewer, a Claude Code session, runs on a copy of the story's
// commit. A part may not add, change or delete a file any of them reads its configuration from.
// `backlog/` itself is the `backlog` kind.

/** The protected tool-configuration kind of the folded `key` (split into `parts`), or null. */
function toolConfigOf(key: string, parts: readonly string[]): ProtectedKind | null {
  // Backlog.md 1.53, README section "Configuration": the project configuration is
  // `backlog.config.yml` at the project root when present, otherwise `backlog/config.yml` or
  // `.backlog/config.yml` (its reader also takes `config.yaml` in either folder), and
  // `.backlog/` is the other folder it keeps tasks in. dipo runs the CLI at the repository root.
  if (key === "backlog.config.yml") return "backlogConfig";
  if (parts[0] === ".backlog") return "backlogConfig";
  // Bun: https://bun.sh/docs/runtime/bunfig (Bun reads `bunfig.toml` in the folder it runs in;
  // `.bunfig.toml` is the name of its user-level file, protected too). In any folder, as a
  // workspace script runs Bun in its package's folder.
  const name = parts.at(-1);
  if (name === "bunfig.toml" || name === ".bunfig.toml") return "bunConfig";
  // Claude Code: https://docs.claude.com/en/docs/claude-code/mcp (project-scoped servers live in
  // `.mcp.json` at the project's root).
  if (key === ".mcp.json") return "mcpConfig";
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
  /** Its size in bytes, as dipo read it. */
  readonly size?: number;
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
 * Pure: the in-box exclude list, each `--exclude=<pattern>` for `tar`: the plain names the root
 * `.gitignore` of `rules` ignores at any depth (`node_modules`), then as `./<name>` the ones it
 * ignores at the root only (`/node_modules`; DIPO-290), unless a `!` rule could re-include the
 * name (an exclude list cannot) or a tracked path has a part of that name (it would go missing from
 * the part). A name ignored only as a folder (`node_modules/`, `/dist/`) excludes only what the
 * folder holds (`node_modules/*`, `./dist/*`), so a regular file of that name still leaves the
 * box. Only an early filter: the Mac checks every path again.
 */
export function inBoxExcludes(rules: IgnoreRules, view: ReadonlyMap<string, TreeEntry>): string[] {
  const tracked = new Set([...view.keys()].flatMap((path) => path.split("/")));
  const usable = (name: string) => !tracked.has(name) && !rules.reincludes(name);
  const pattern = (name: string, root: boolean) =>
    `${root ? "./" : ""}${name}${rules.foldersOnly(name, root) ? "/*" : ""}`;
  return [
    ...rules.plainNames.filter(usable).map((name) => pattern(name, false)),
    ...rules.rootNames.filter(usable).map((name) => pattern(name, true)),
  ];
}

/**
 * The command that streams the part out of the box: `tar` of `BOX_WORKDIR` to its stdout, hard
 * links stored as files, the excludes first, under `timeout` where the box has it. A plain name
 * excludes that name at any depth; `./<name>` only the entry at the root of `/work`, since the
 * archive's names start `./` there and nowhere below (GNU tar's unanchored matching). Either may
 * end in `/*`: then only the entries inside a folder of that name, never a file named so.
 */
export function partArchiveCommand(excludes: readonly string[]): [string, ...string[]] {
  for (const name of excludes) {
    const found = /^(?:\.\/)?([A-Za-z0-9._-]+)(?:\/\*)?$/.exec(name);
    if (found === null || found[1] === "." || found[1] === "..") {
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

/** git's id of the blob of the file at `at` (`size` bytes), read in chunks (O_NOFOLLOW). */
async function fileBlobId(format: "sha1" | "sha256", at: string, size: number): Promise<string> {
  const hash = createHash(format).update(`blob ${size}\0`);
  const file = await open(at, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = new Uint8Array(HASH_CHUNK);
    for (let done = 0; done < size;) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(HASH_CHUNK, size - done), done);
      if (bytesRead === 0)
        throw new BoxError(PART_FAILED, "a part file changed while dipo read it.");
      hash.update(buffer.subarray(0, bytesRead));
      done += bytesRead;
    }
  } finally {
    await file.close();
  }
  return hash.digest("hex");
}

/** git's id of a blob holding `content`, in the repository's object format. */
export function blobId(format: "sha1" | "sha256", content: Uint8Array | string): string {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

// ---- the scans -----------------------------------------------------------------------------------

/** The kind a secret file name is reported by. */
export const SECRET_NAME_KIND = "a secret file name";

/**
 * Pure: the protected-file check of a part's changes and link hits; `backlogFolder` as in
 * `protectedKind`.
 */
export function protectedHits(
  changes: readonly PartChange[],
  linkHits: readonly string[],
  backlogFolder: string | null = null,
): { readonly kinds: ProtectedKind[]; readonly paths: string[] } {
  const kinds = new Set<ProtectedKind>();
  const paths: string[] = [];
  for (const change of changes) {
    const kind = protectedKind(change.path, backlogFolder);
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
 * The secret scan of a part, outside the git queue: the cleaned commit subject, the name of every
 * added or changed path (content patterns and listed values, and the secret file names), and every
 * added or changed file, streamed in chunks (`secretKeysOfFile`). A file's key counts only when
 * the delivered version did not hold it: `before` gives the delivered content of the changed files
 * that hit, by blob id (null for one too big to scan, so every key counts). `tooBig` when a file is
 * larger than `maxFileBytes`: dipo does not take a file it does not scan whole.
 */
export async function secretHits(input: {
  readonly changes: readonly PartChange[];
  readonly view: ReadonlyMap<string, TreeEntry>;
  readonly before: (ids: readonly string[]) => Promise<ReadonlyMap<string, string | null>>;
  readonly subject: string;
  readonly literals?: SecretValues;
  readonly maxFileBytes?: number;
}): Promise<{ readonly kinds: string[]; readonly paths: string[] } | "tooBig"> {
  const kinds = new Set<string>();
  const paths = new Set<string>();
  for (const kind of secretKeys(input.subject, input.literals).keys()) kinds.add(kind);
  const pending: { readonly change: PartChange; readonly id: string; readonly keys: SecretKeys }[] =
    [];
  for (const change of input.changes) {
    if (change.kind === "deleted") continue;
    const named = [...secretKeys(change.path, input.literals).keys()];
    if (isSecretPartPath(change.path)) named.push(SECRET_NAME_KIND);
    for (const kind of named) kinds.add(kind);
    if (named.length > 0) paths.add(change.path);
    const keys = await secretKeysOfFile(
      change.at,
      input.maxFileBytes ?? SCAN_FILE_MAX,
      input.literals,
    );
    if (keys === "tooBig") return "tooBig";
    if (keys.size === 0) continue;
    const old = input.view.get(change.path);
    if (change.kind === "changed" && old !== undefined) {
      pending.push({ change, id: old.id, keys });
      continue;
    }
    for (const kind of keys.keys()) kinds.add(kind);
    paths.add(change.path);
  }
  if (pending.length > 0) {
    const olds = await input.before(pending.map((item) => item.id));
    for (const { change, id, keys } of pending) {
      const old = olds.get(id) ?? null;
      const had = old === null ? null : secretKeysOfBytes(Buffer.from(old, "utf8"), input.literals);
      const found = newKeyKinds(keys, had);
      for (const kind of found) kinds.add(kind);
      if (found.length > 0) paths.add(change.path);
    }
  }
  return { kinds: [...kinds], paths: [...paths].toSorted() };
}

/** The kind a value from a listed box file is reported by. */
export const LISTED_VALUE_KIND = "a value from a listed box file";

/**
 * The values of the listed box files (`box.files`) dipo reads from the office's main checkout:
 * the right-hand side of each dotenv-shaped `KEY=VALUE` line (`export` and quotes allowed, a
 * trailing ` #` comment cut from an unquoted value) of at least `LISTED_VALUE_MIN` characters,
 * never the key. A value shaped like an identifier (letters and `_` only, no digit) with little
 * spread of characters is skipped: it is a name, not a secret. A part that brings a value into a
 * file parks as a secret. A listed file that is missing, not a regular file, reached through a
 * link, or larger than `LISTED_FILE_MAX` gives none.
 */
export async function listedValues(main: string, paths: readonly string[]): Promise<string[]> {
  const root = await realpath(main).catch(() => null);
  if (root === null) return [];
  const values = new Set<string>();
  for (const path of paths) {
    const at = join(root, path);
    const real = await realpath(at).catch(() => null);
    if (real !== at) continue;
    const info = await lstat(at).catch(() => null);
    if (info === null || !info.isFile() || info.size > LISTED_FILE_MAX) continue;
    for (const line of (await readFile(at, "utf8")).split(/\r?\n/)) {
      const value = dotenvValue(line);
      if (value === null || !secretLike(value)) continue;
      values.add(value);
      if (values.size >= LISTED_VALUES_MAX) return [...values];
    }
  }
  return [...values];
}

/** The value of a dotenv `KEY=VALUE` line, unquoted, or null for any other line. */
export function dotenvValue(line: string): string | null {
  const found = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*(.*)$/.exec(line);
  if (found === null) return null;
  let value = (found[1] ?? "").trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2) {
    const end = value.indexOf(quote, 1);
    value = end < 0 ? value.slice(1) : value.slice(1, end);
  } else {
    const comment = value.search(/\s#/);
    if (comment >= 0) value = value.slice(0, comment).trimEnd();
  }
  return value === "" ? null : value;
}

/** Shannon entropy of `text` in bits per character. */
function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  const length = [...text].length;
  let bits = 0;
  for (const count of counts.values()) bits -= (count / length) * Math.log2(count / length);
  return bits;
}

/**
 * True for a value worth looking for: long enough, and not a plain identifier (letters and `_`
 * only, no digit) of low spread, such as `development` or `ANTHROPIC_API_KEY`.
 */
export function secretLike(value: string): boolean {
  if (value.length < LISTED_VALUE_MIN || value.length > LISTED_VALUE_MAX_CHARS) return false;
  const identifier = /^[A-Za-z_]+$/.test(value);
  return !identifier || entropy(value) >= LISTED_VALUE_MIN_ENTROPY;
}

/**
 * The untracked paths among `paths` that stay out of the part: listed, or ignored by any of
 * `rules`. Every match counts its real steps against one shared `MatchBudget` of `budget` steps,
 * which stops it the moment it is passed, and a path deeper than `MAX_MATCH_DEPTH` stops it too:
 * then `budget`. The matching runs in batches with the event loop free between them.
 */
export async function leftOutPaths(input: {
  readonly paths: Iterable<string>;
  readonly view: ReadonlyMap<string, TreeEntry>;
  readonly listed: ReadonlySet<string>;
  readonly rules: readonly IgnoreRules[];
  readonly budget: number;
}): Promise<Set<string> | "budget"> {
  const out = new Set<string>();
  const budget = new MatchBudget(input.budget);
  for (const rules of input.rules) rules.withBudget(budget);
  let checked = 0;
  try {
    for (const path of input.paths) {
      if (input.view.has(path)) continue;
      if (input.listed.has(path) || input.rules.some((rules) => rules.ignored(path))) out.add(path);
      checked += 1;
      if (checked % IGNORE_BATCH === 0) await yieldToEventLoop();
    }
  } catch (error) {
    if (error instanceof IgnoreBudgetExceeded) return "budget";
    throw error;
  }
  return out;
}

/** Pure: the fixed park detail of a protected-file hit; it names kinds only. */
export function protectedDetail(kinds: readonly ProtectedKind[]): string {
  return `The part the worker delivered changes protected files: ${kinds.map((kind) => PROTECTED_TEXT[kind]).join("; ")}. dipo committed and pushed nothing, and the change stays in the box. Only dipo or the maintainer writes these files.`;
}

/** Pure: the fixed park detail of a secret hit; it never quotes what matched, nor a path. */
export function secretDetail(kinds: readonly string[], files: number): string {
  return `The part the worker delivered holds what looks like a secret: ${kinds.join("; ")}, in ${files} ${files === 1 ? "file" : "files"}. dipo committed and pushed nothing, and the files stay in the box.`;
}

/** Why dipo did not take a part. */
export type PartRefusal =
  | "cap"
  | "archive"
  | "git"
  | "path"
  | "ignoreFile"
  | "ignoreWork"
  | "bigFile";

/** The fixed park detail of a part dipo could not take, by why. */
export function refusedDetail(why: PartRefusal, maxBytes: number): string {
  const nothing = "dipo committed and pushed nothing.";
  switch (why) {
    case "path":
      return `The part the worker delivered holds a path with a control, bidirectional or invisible character. ${nothing}`;
    case "ignoreFile":
      return `The part the worker delivered holds a .gitignore larger than ${IGNORE_FILE_MAX} bytes, which dipo does not read. ${nothing}`;
    case "ignoreWork":
      return `The part the worker delivered has more paths and ignore rules than dipo matches in one part. ${nothing}`;
    case "bigFile":
      return `The part the worker delivered adds or changes a file larger than ${SCAN_FILE_MAX} bytes, which dipo does not scan. ${nothing}`;
    default:
      break;
  }
  if (why === "cap") {
    return `The part the worker delivered is larger than ${maxBytes} bytes, so dipo did not take it; files git should ignore may be missing from .gitignore. dipo committed and pushed nothing.`;
  }
  if (why === "git") {
    return "The part the worker delivered holds a path git does not take into a commit. dipo committed and pushed nothing.";
  }
  return "The part the worker delivered holds an entry dipo does not take (a path that leaves its folder, a name twice, a link below which a file sits, or an entry other than a file, folder or link). dipo committed and pushed nothing.";
}

/**
 * Pure: the fixed text of the notice of a part that failed on `reads` door reads in a row over
 * `minutes` minutes or more (DIPO-290); it names no path and quotes no error, which may hold the
 * box's paths.
 */
export function partStuckText(reads: number, minutes: number): string {
  return `dipo could not take the worker's part out of the box on ${reads} door reads in a row, for ${minutes} minutes or more: the stream out of the box or a git step failed each time. Nothing of it is committed yet; the part stays queued in the box, dipo keeps trying, and the worker goes on. The daemon log has the reasons.`;
}

/** Pure: the fixed text of the notice that a part came out of the box again after a streak. */
export function partUnstuckText(reads: number): string {
  return `dipo took the worker's part out of the box again, after ${reads} door reads in a row that failed.`;
}

/**
 * The folder of the part stages of the daemon whose state folder is `stateDir`: inside it, so only
 * this user and this daemon own it, never a name in a shared temp root another user could take.
 */
export function partStageRoot(stateDir: string): string {
  return join(stateDir, PART_STAGE_DIR);
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
        files.set(path, { mode, id: await fileBlobId(format, at, info.size), at, size: info.size });
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
  return readViewAt(session, await branchTip(session, branch), startSha);
}

/** `readView` at the commit `tip` instead of a branch's tip. */
async function readViewAt(session: GitSession, tip: string, startSha: string): Promise<PartView> {
  const repo = session.repository;
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
    // A delivered one is never this large (a part refuses it); one of the base is left unread.
    const size = Number((await session.ok(repo, ["cat-file", "-s", entry.id])).trim());
    if (!(size <= IGNORE_FILE_MAX)) continue;
    ignores.push({ dir, text: await session.ok(repo, ["cat-file", "blob", entry.id]) });
  }
  return { tip, tipTree, format, entries, ignores };
}

/**
 * The backlog folder the delivered tree's `backlog.config.yml` names (`backlogPointer`), or null:
 * none, a link or a file too large to read, or a pointer that does not resolve (the runner then
 * refuses every Backlog CLI call there).
 */
async function namedBacklogFolder(
  session: GitSession,
  entries: ReadonlyMap<string, TreeEntry>,
): Promise<string | null> {
  const entry = entries.get("backlog.config.yml");
  if (entry === undefined || entry.type !== "blob" || entry.mode === "120000") return null;
  const size = Number((await session.ok(session.repository, ["cat-file", "-s", entry.id])).trim());
  if (!(size <= IGNORE_FILE_MAX)) return null;
  const pointer = backlogPointer(
    await session.ok(session.repository, ["cat-file", "blob", entry.id]),
  );
  return pointer.kind === "folder" ? pointer.folder : null;
}

/** The commit the story branch points at. */
async function branchTip(session: GitSession, branch: string): Promise<string> {
  return (
    await session.ok(session.repository, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`])
  ).trim();
}

/**
 * The delivered content of the blobs `ids`, read in the git queue for the scan outside it; null for
 * one larger than `SCAN_FILE_MAX`, so every key of the new content counts.
 */
async function deliveredTexts(
  session: GitSession,
  ids: readonly string[],
): Promise<Map<string, string | null>> {
  const texts = new Map<string, string | null>();
  for (const id of new Set(ids)) {
    const size = Number((await session.ok(session.repository, ["cat-file", "-s", id])).trim());
    texts.set(
      id,
      size <= SCAN_FILE_MAX ? await session.ok(session.repository, ["cat-file", "blob", id]) : null,
    );
  }
  return texts;
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += PATHS_PER_CALL) {
    out.push(items.slice(at, at + PATHS_PER_CALL));
  }
  return out;
}

/** The number of the next part: the part commits on the branch's first-parent line, plus one. */
export async function partNumber(
  session: GitSession,
  startSha: string,
  tip: string,
): Promise<number> {
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
  const commit = await commitTree(session, repo, {
    tree,
    parents: [view.tip],
    message: { subject: message.subject, body: [message.body] },
  });
  if (!(await moveBranch(session, input.branch, commit, view.tip, message.subject))) {
    throw new GitError(PART_FAILED, `${ref} moved from ${view.tip} while the part was committed.`);
  }
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
  /**
   * The commit whose delivered tree a rebuilt box holds (DIPO-278): the story branch's tip when the
   * box was rebuilt. `changedSinceStart` compares with it instead of the start commit.
   */
  readonly codeTip?: string;
  /**
   * The run directory, for `PART_RECORD_FILE` and the box's record of the listed files
   * (`BoxRunRecord.files`); absent: no record is kept, and the listed files are read from
   * `BoxPartsDeps.listedFiles`.
   */
  readonly runDir?: string;
}

/** What the box's `/work` holds besides the start commit (`BoxParts.changedSinceStart`). */
export type StartTreeCheck =
  | { readonly kind: "same" }
  /** The paths that differ from the start commit, sorted; untrusted names from the box. */
  | { readonly kind: "changed"; readonly paths: readonly string[] }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * Why dipo could not take the box's `/work` to compare it with the start commit, by the kind of
 * refusal, with no path from the box in it (`BoxParts.changedSinceStart`).
 */
export function startTreeRefusal(why: PartRefusal, maxBytes: number): string {
  switch (why) {
    case "cap":
      return `the archive of the box's /work passed ${maxBytes} bytes; files git should ignore (such as node_modules) may be missing from .gitignore`;
    case "archive":
      return "the archive of the box's /work holds an entry dipo does not take";
    case "ignoreFile":
      return `the box's /work holds a .gitignore larger than ${IGNORE_FILE_MAX} bytes, which dipo does not read`;
    case "ignoreWork":
      return "the box's /work has more paths and ignore rules than dipo matches at once";
    default:
      return `dipo refused the archive of the box's /work (${why})`;
  }
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
  | { readonly kind: "stopped" }
  /**
   * The box lacks a merge dipo committed on the branch outside it (DIPO-324): nothing was taken,
   * since a part against that tip would undo the merge, and the story parks.
   */
  | { readonly kind: "behind"; readonly detail: string };

/** What the caller gets while the run's parts are held after the last part (`BoxParts.finishLast`). */
export interface LastPartAccess {
  /** The branch tip the last part left: the commit In Review is written at. */
  readonly tip: string;
  /** The branch tip now, read again (also after the held turn ended). */
  branchTip(): Promise<string>;
}

/** The last part, and what `finish` returned when it ran. */
export interface LastPartFinish<T> {
  readonly outcome: PartOutcome;
  readonly finished: { readonly result: T } | null;
}

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
    case "behind":
      return { reason: "conflict", cause: PART_CAUSES.behind, detail: outcome.detail };
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
  /**
   * This daemon's own folder of part stages (`partStageRoot`), made 0700 when first used; a part
   * fails while it is a link or not the user's.
   */
  readonly stageRoot: string;
  /** The user the stage folders must belong to; the process's own by default. */
  readonly uid?: number;
  /** The facts of a box run, or null when no loaded office knows it. */
  readonly run: (runId: string) => PartRun | null;
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  /**
   * The files outside git the office config copies into a box (`box.files`), repo-relative: read
   * only for a run whose box record does not hold the list made with the box (`BoxRunRecord.files`,
   * DIPO-290), such as one made before the record kept it.
   */
  readonly listedFiles?: (git: OfficeGit) => Promise<readonly string[]>;
  /** True while the run goes on: tracked and nothing decided for it yet. */
  readonly live: (runId: string) => boolean;
  /**
   * Why the run's box lacks a merge dipo committed on its branch outside the box (the merge
   * slot's, DIPO-324), or null when it holds them all. No part is taken while it lacks one.
   */
  readonly behind?: (run: PartRun) => string | null;
  /** Parks the run, stopping its worker; false when another decision came first. */
  readonly park?: (runId: string, park: PartPark) => boolean;
  /** Tells the maintainer (an `engine.notice` of the run). */
  readonly notice?: (run: PartRun, notice: PartNotice) => void;
  /**
   * Records a part's push of the run's branch on its claim (DIPO-315: every story-branch push sets
   * `claims.pushed_at` once it reaches the remote). A throw is logged; the part stands.
   */
  readonly pushed?: (run: PartRun, push: PushResult) => void;
  /** Reads the run's door now (`BoxWorkers.readDoor`), so queued parts go first. */
  readonly readDoor?: (runId: string) => Promise<unknown> | null;
  readonly limits?: CacheArchiveLimits;
  readonly timeoutMs?: number;
  /** Overrides `IGNORE_WORK_BUDGET`. */
  readonly ignoreWorkBudget?: number;
  /** Overrides `SCAN_FILE_MAX`. */
  readonly scanFileMax?: number;
  readonly warn?: Log;
  readonly info?: Log;
}

/** A notice of a run's part for the maintainer. */
export interface PartNotice {
  readonly level: "info" | "warn";
  readonly code: string;
  readonly text: string;
}

/** The failed door reads in a row of a run's parts. */
interface FailStreak {
  reads: number;
  /** When the first read of the streak failed, on the engine clock. */
  readonly since: number;
  /** The door read (`DoorPart.at`) that failed last: another part of it does not count. */
  lastRead: number;
  /** When the last failure ended, on the engine clock (`PART_STREAK_GAP_MS`). */
  lastFailedAt: number;
  noticed: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when `info` is a folder, not a link, of `uid` (any user when undefined). */
function ownFolder(info: { isDirectory(): boolean; readonly uid: number }, uid?: number): boolean {
  return info.isDirectory() && (uid === undefined || info.uid === uid);
}

/**
 * Removes the part stage folders (`PART_STAGE_PREFIX`) in `stageRoot`, one daemon's own folder
 * of stages (`partStageRoot`), except those in `keep` (the folders as made, before `realpath`).
 * Only folders of `uid`: a link, a file or another user's folder is left alone, and nothing when
 * `stageRoot` itself is not a folder of `uid`. Never rejects; resolves to the number removed.
 */
export async function sweepPartStages(
  stageRoot: string,
  keep: ReadonlySet<string> = new Set(),
  uid: number | undefined = process.getuid?.(),
): Promise<number> {
  let names: string[];
  try {
    if (!ownFolder(await lstat(stageRoot), uid)) return 0;
    names = await readdir(stageRoot);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(PART_STAGE_PREFIX)) continue;
    const at = join(stageRoot, name);
    if (keep.has(at)) continue;
    try {
      if (!ownFolder(await lstat(at), uid)) continue;
      await rm(at, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Left for the next sweep.
    }
  }
  return removed;
}

/** Takes the parts of box runs out of their boxes, scans and commits them (see the file comment). */
export class BoxParts {
  readonly #deps: BoxPartsDeps;
  /** The delivery in flight per run: parts of one run go one at a time. */
  readonly #chains = new Map<string, Promise<unknown>>();
  /** The door reads that failed in a row, per run (`PART_STUCK_READS`). */
  readonly #failed = new Map<string, FailStreak>();
  /** The stage folders in use, which `sweepStages` leaves. */
  readonly #stages = new Set<string>();

  constructor(deps: BoxPartsDeps) {
    this.#deps = deps;
  }

  /**
   * `BoxDoor`'s `onPart`: delivers the changes since the last part with the part's message. A hit
   * or a refused part parks the run; a rejected push parks it `conflict`. Rejects, so the part stays
   * queued in the box, when the run is not live or the delivery failed. A failure never parks: it
   * counts toward the run's notice (`#failedTry`), and the door hands the part again.
   */
  async onPart(part: DoorPart): Promise<void> {
    if (!this.#deps.live(part.runId)) {
      this.#failed.delete(part.runId);
      throw new BoxError(PART_WAITING, `run ${part.runId} is not going on; the part stays queued.`);
    }
    const run = this.#deps.run(part.runId);
    if (run === null) throw new BoxError(PART_WAITING, `run ${part.runId} is not known here.`);
    let outcome: PartOutcome;
    try {
      outcome = await this.#serial(part.runId, () => {
        // Asked again in turn: a part before it may have parked the run.
        if (!this.#deps.live(part.runId)) {
          throw new BoxError(
            PART_WAITING,
            `run ${part.runId} is not going on; the part stays queued.`,
          );
        }
        return this.#deliver(run, part.message);
      });
    } catch (error) {
      this.#failedTry(run, part, error);
      throw error;
    }
    this.#streakEnded(run);
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
   * since becomes a last part with `message`. The caller parks on a hit.
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
    )
      .catch((error: unknown): PartOutcome => {
        if (error instanceof BoxError && error.code === PART_WAITING) return { kind: "stopped" };
        throw error;
      })
      .then((outcome) => this.#settled(run, outcome));
  }

  /**
   * Story done (W2, DIPO-299): as `deliverLast`, then, while the run's part chain is still held,
   * `finish` with the branch tip the last part left. No part of the run is delivered from the
   * moment the last part is taken until `finish` resolves (a part the door reads meanwhile waits
   * its turn), so a caller that claims the run's end in `finish` leaves every later part queued in
   * the box and the branch at that tip. `finish` runs only when the last part asks for no park and
   * the run goes on; `finished` is null otherwise.
   */
  async finishLast<T>(
    runId: string,
    message: string,
    finish: (last: LastPartAccess) => Promise<T>,
  ): Promise<LastPartFinish<T>> {
    try {
      await this.#deps.readDoor?.(runId);
    } catch (error) {
      this.#deps.warn?.("the box door could not be read before the last part", {
        run: runId,
        reason: messageOf(error),
      });
    }
    const stopped: LastPartFinish<T> = { outcome: { kind: "stopped" }, finished: null };
    if (!this.#deps.live(runId)) {
      this.#failed.delete(runId);
      return stopped;
    }
    const run = this.#deps.run(runId);
    if (run === null) throw new BoxError(PART_FAILED, `run ${runId} is not known here.`);
    return this.#serial(runId, async (): Promise<LastPartFinish<T>> => {
      if (!this.#deps.live(runId)) return stopped;
      const outcome = this.#settled(run, await this.#deliver(run, message));
      if (partPark(outcome) !== null || !this.#deps.live(runId)) return { outcome, finished: null };
      const git = this.#gitOf(run);
      const tip = await git.run((session) => branchTip(session, run.branch));
      const result = await finish({
        tip,
        branchTip: () => git.run((session) => branchTip(session, run.branch)),
      });
      return { outcome, finished: { result } };
    }).catch((error: unknown): LastPartFinish<T> => {
      if (error instanceof BoxError && error.code === PART_WAITING) {
        this.#failed.delete(runId);
        return stopped;
      }
      throw error;
    });
  }

  /**
   * Runs `fn` in the run's turn: after the parts before it, and before the next (DIPO-277: a
   * catch-up merges the base into the branch and the box with no part taken in between).
   */
  inTurn<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    return this.#serial(runId, fn);
  }

  /**
   * Inside `inTurn` only (DIPO-277): whatever changed in the box since the last part becomes a part
   * with `message` now, in the turn the caller holds already. `stopped` when the run no longer goes
   * on. The caller parks on a hit.
   */
  async deliverInTurn(runId: string, message: string): Promise<PartOutcome> {
    if (!this.#deps.live(runId)) return { kind: "stopped" };
    const run = this.#deps.run(runId);
    if (run === null) throw new BoxError(PART_FAILED, `run ${runId} is not known here.`);
    return this.#deliver(run, message)
      .catch((error: unknown): PartOutcome => {
        if (error instanceof BoxError && error.code === PART_WAITING) return { kind: "stopped" };
        throw error;
      })
      .then((outcome) => this.#settled(run, outcome));
  }

  /**
   * What the box's `/work` holds besides the start commit (DIPO-294), after the install and before
   * the worker's first session: taken out and compared with the tree of `run.startSha` as a part
   * is, on dipo's own copy, so only paths git ignores and the listed box files may differ. Every
   * added, changed or deleted path, and every link that differs, counts. `unknown` when dipo could
   * not take or read the box's files (the archive refused, a stream or git failure). `run` is
   * given, since the run is not recorded yet at the launch; its branch is not read.
   */
  async changedSinceStart(run: PartRun): Promise<StartTreeCheck> {
    try {
      const git = this.#gitOf(run);
      const view = await git.run((session) =>
        readViewAt(session, run.codeTip ?? run.startSha, run.startSha),
      );
      const listed = await this.#listed(run, git);
      return await this.#inStage(async (stage): Promise<StartTreeCheck> => {
        const taken = await this.#take(run, view, listed, stage);
        if (taken.kind !== "taken") {
          return {
            kind: "unknown",
            reason: startTreeRefusal(
              taken.why,
              (this.#deps.limits ?? PART_ARCHIVE_LIMITS).maxArchiveBytes,
            ),
          };
        }
        const paths = [...taken.changes.map((change) => change.path), ...taken.linkHits];
        return paths.length === 0
          ? { kind: "same" }
          : { kind: "changed", paths: [...new Set(paths)].toSorted() };
      });
    } catch (error) {
      this.#deps.warn?.("the box's files could not be compared with the start commit", {
        run: run.runId,
        reason: messageOf(error),
      });
      return { kind: "unknown", reason: "dipo could not read the box's /work" };
    }
  }

  /**
   * Counts a failed door part of `run`, at most once per door read (`DoorPart.at`); a run that is
   * not live (`PART_WAITING`) is no failure. Once `PART_STUCK_READS` reads in a row failed over at
   * least `PART_STUCK_MIN_MS`, the maintainer gets one warning notice for the streak, with a fixed
   * text since the error may quote the box's paths; the log has the reason. Nothing parks.
   */
  #failedTry(run: PartRun, part: DoorPart, error: unknown): void {
    if (error instanceof BoxError && error.code === PART_WAITING) {
      // The run parked or stopped: a resume starts a fresh streak.
      this.#failed.delete(run.runId);
      return;
    }
    const now = this.#deps.clock.now();
    let streak = this.#failed.get(run.runId);
    if (streak !== undefined && part.at - streak.lastFailedAt > PART_STREAK_GAP_MS) {
      // The door did not read for a while (a session ended, a park and a resume): a fresh streak.
      streak = undefined;
    }
    if (streak === undefined) {
      streak = { reads: 0, since: now, lastRead: Number.NaN, lastFailedAt: now, noticed: false };
      this.#failed.set(run.runId, streak);
    }
    streak.lastFailedAt = now;
    if (streak.lastRead === part.at) return;
    streak.reads += 1;
    streak.lastRead = part.at;
    const elapsed = now - streak.since;
    if (streak.noticed || streak.reads < PART_STUCK_READS || elapsed < PART_STUCK_MIN_MS) return;
    streak.noticed = true;
    // The door logs every failed try with its reason; this line marks the notice.
    this.#deps.warn?.("a part keeps failing to come out of the box; the maintainer is told", {
      run: run.runId,
      reads: streak.reads,
      reason: messageOf(error),
    });
    this.#deps.notice?.(run, {
      level: "warn",
      code: PART_NOTICES.stuck,
      text: partStuckText(streak.reads, Math.floor(elapsed / 60_000)),
    });
  }

  /**
   * `outcome` of a part of `run` outside the door (`deliverLast`, `finishLast`, `deliverInTurn`):
   * a run that is not live forgets its streak, any part taken out ends it (`#streakEnded`).
   */
  #settled(run: PartRun, outcome: PartOutcome): PartOutcome {
    if (outcome.kind === "stopped") this.#failed.delete(run.runId);
    else this.#streakEnded(run);
    return outcome;
  }

  /** A part of `run` was taken out: its streak of failed reads ends, told when it was noticed. */
  #streakEnded(run: PartRun): void {
    const streak = this.#failed.get(run.runId);
    if (streak === undefined) return;
    this.#failed.delete(run.runId);
    if (!streak.noticed) return;
    this.#deps.notice?.(run, {
      level: "info",
      code: PART_NOTICES.unstuck,
      text: partUnstuckText(streak.reads),
    });
  }

  /**
   * Removes the stage folders of parts (`PART_STAGE_PREFIX`) in this daemon's own folder of stages
   * that no part of it uses: the ones it left when it stopped. Runs at daemon start; never rejects.
   */
  sweepStages(): Promise<number> {
    return sweepPartStages(this.#stageRoot, this.#stages, this.#uid);
  }

  get #stageRoot(): string {
    return this.#deps.stageRoot;
  }

  get #uid(): number | undefined {
    return this.#deps.uid ?? process.getuid?.();
  }

  /**
   * This daemon's folder of part stages, made 0700 when missing; refused when it is not a folder
   * of this user (a link in its place, or a folder of another user).
   */
  async #ownStageRoot(): Promise<string> {
    const root = this.#stageRoot;
    // A link in its place is kept, and refused below.
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (!ownFolder(await lstat(root), this.#uid)) {
      throw new BoxError(PART_FAILED, "the folder of dipo's part stages is not this user's own.");
    }
    await chmod(root, 0o700);
    return root;
  }

  /** The listed box files a part of `run` leaves out: the run's record, else `listedFiles`. */
  async #listed(run: PartRun, git: OfficeGit): Promise<Set<string>> {
    const recorded = run.runDir === undefined ? undefined : readBoxRun(run.runDir)?.files;
    if (recorded !== undefined) return new Set(recorded);
    return new Set(await (this.#deps.listedFiles?.(git) ?? Promise.resolve([])));
  }

  #gitOf(run: PartRun): OfficeGit {
    const git = this.#deps.git(run.office);
    if (git === undefined) throw new BoxError(PART_FAILED, `office ${run.office} has no git.`);
    return git;
  }

  /** Runs `fn` with a fresh stage folder in this daemon's folder of stages, removed after. */
  async #inStage<T>(fn: (stage: string) => Promise<T>): Promise<T> {
    const made = await mkdtemp(join(await this.#ownStageRoot(), PART_STAGE_PREFIX));
    this.#stages.add(made);
    try {
      return await fn(await realpath(made));
    } finally {
      await rm(made, { recursive: true, force: true });
      this.#stages.delete(made);
    }
  }

  /** Throws `PART_WAITING` when the run no longer goes on, so the part stays queued. */
  #assertLive(run: PartRun): void {
    if (!this.#deps.live(run.runId)) {
      throw new BoxError(
        PART_WAITING,
        `run ${run.runId} ended while its part was taken; it stays queued.`,
      );
    }
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
    // Never a part against a tip whose files the box has not received (DIPO-324).
    const behind = this.#deps.behind?.(run) ?? null;
    if (behind !== null) return { kind: "behind", detail: behind };
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

  /**
   * One stream of the box's `/work` with `excludes`, extracted into a fresh `folder`, and its
   * regular files read; `refused` when dipo does not take the archive.
   */
  async #stream(
    run: PartRun,
    view: PartView,
    excludes: readonly string[],
    folder: string,
  ): Promise<
    | {
        readonly kind: "taken";
        readonly files: Map<string, PartFile>;
        readonly links: readonly ArchiveLink[];
      }
    | { readonly kind: "refused"; readonly why: PartRefusal }
  > {
    const limits = this.#deps.limits ?? PART_ARCHIVE_LIMITS;
    const archive = join(folder, "archive");
    const dest = join(folder, "files");
    await mkdir(folder, { mode: 0o700 });
    await mkdir(archive, { mode: 0o700 });
    await mkdir(dest, { mode: 0o700 });
    try {
      await streamFromBox({
        boxes: this.#deps.boxes,
        box: run.box,
        command: partArchiveCommand(excludes),
        folder: archive,
        name: "part.tar",
        maxBytes: limits.maxArchiveBytes,
        timeoutMs: this.#deps.timeoutMs ?? PART_STREAM_TIMEOUT_MS,
        clock: this.#deps.clock,
        code: PART_FAILED,
        what: "the part archive",
        // The worker's box: a failed stream ends only the exec client (the module comment).
        stopOnFailure: false,
        // GNU tar exits 1 when a file changed while it read it; the Mac checks every entry again.
        okExits: [0, 1],
      });
    } catch (error) {
      if (error instanceof BoxError && error.details["reason"] === "cap") {
        return { kind: "refused", why: "cap" };
      }
      throw error;
    }
    let links: readonly ArchiveLink[];
    try {
      ({ links } = await extractArchive(archive, dest, {
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
      return { kind: "refused", why: "archive" };
    }
    await rm(archive, { recursive: true, force: true });
    try {
      return { kind: "taken", files: await readPartFiles(dest, view.format), links };
    } catch (error) {
      // An entry that is no file or folder in the stage: refused like a hostile archive.
      if (error instanceof BoxError && error.code === PART_REFUSED) {
        return { kind: "refused", why: "archive" };
      }
      throw error;
    }
  }

  /**
   * The box's `/work` taken out into `stage` and compared with the delivered tree `view` (steps 1
   * and 2 of the module comment); `refused` with the outcome when dipo does not take it.
   */
  async #take(
    run: PartRun,
    view: PartView,
    listed: ReadonlySet<string>,
    stage: string,
  ): Promise<
    | { readonly kind: "taken"; readonly changes: PartChange[]; readonly linkHits: string[] }
    | { readonly kind: "refused"; readonly why: PartRefusal; readonly outcome: PartOutcome }
  > {
    const limits = this.#deps.limits ?? PART_ARCHIVE_LIMITS;
    const refused = (why: PartRefusal) => ({
      kind: "refused" as const,
      why,
      outcome: { kind: "refused" as const, detail: refusedDetail(why, limits.maxArchiveBytes) },
    });
    const viewRules = new IgnoreRules(view.ignores);
    let excludes = inBoxExcludes(viewRules, view.entries);
    let files: Map<string, PartFile>;
    let links: readonly ArchiveLink[];
    let partRules: IgnoreRules;
    for (let take = 1; ; take += 1) {
      const streamed = await this.#stream(run, view, excludes, join(stage, `take-${take}`));
      if (streamed.kind === "refused") return refused(streamed.why);
      ({ files, links } = streamed);
      const partIgnores: IgnoreFile[] = [];
      for (const [path, file] of files) {
        const dir = ignoreFileDir(path);
        if (dir === null) continue;
        // Refused before it is read or split: the worker wrote it.
        if ((file.size ?? Number.POSITIVE_INFINITY) > IGNORE_FILE_MAX) return refused("ignoreFile");
        partIgnores.push({ dir, text: await readFile(file.at, "utf8") });
      }
      // The part's own rules decide, as git's would in its commit (DIPO-290).
      partRules = new IgnoreRules(partIgnores);
      // A name the box left out that the part's own root `.gitignore` no longer ignores: taken
      // again with the part's own exclude list, so what the part un-ignores is delivered in this
      // part; the last take excludes nothing.
      const own = inBoxExcludes(partRules, view.entries);
      if (excludes.every((name) => own.includes(name))) break;
      excludes = take + 1 >= EXCLUDE_TAKES ? [] : own;
      await rm(join(stage, `take-${take}`), { recursive: true, force: true });
    }
    const out = await leftOutPaths({
      paths: [...files.keys(), ...links.map((link) => link.path)],
      view: view.entries,
      listed,
      rules: [partRules],
      budget: this.#deps.ignoreWorkBudget ?? IGNORE_WORK_BUDGET,
    });
    if (out === "budget") return refused("ignoreWork");
    const { changes, linkHits } = comparePart({
      view: view.entries,
      files,
      links,
      leftOut: (path) => out.has(path),
      linkId: (target) => blobId(view.format, target),
    });
    return { kind: "taken", changes, linkHits };
  }

  /** One try of a part; null when the branch moved meanwhile, so it is taken again. */
  async #attempt(run: PartRun, message: string): Promise<PartOutcome | null> {
    const git = this.#gitOf(run);
    const limits = this.#deps.limits ?? PART_ARCHIVE_LIMITS;
    const view = await git.run((session) => readView(session, run.branch, run.startSha));
    const listed = await this.#listed(run, git);
    const refused = (why: PartRefusal): PartOutcome => ({
      kind: "refused",
      detail: refusedDetail(why, limits.maxArchiveBytes),
    });
    return this.#inStage(async (stage): Promise<PartOutcome | null> => {
      const taken = await this.#take(run, view, listed, stage);
      if (taken.kind === "refused") return taken.outcome;
      const { changes, linkHits } = taken;
      if ([...changes.map((change) => change.path), ...linkHits].some(unsafePath)) {
        return refused("path");
      }
      const folder = await git.run((session) => namedBacklogFolder(session, view.entries));
      const guarded = protectedHits(changes, linkHits, folder);
      if (guarded.kinds.length > 0) {
        this.#hitRecord(run, PART_CAUSES.protectedFile, guarded.paths);
        return {
          kind: "hit",
          cause: PART_CAUSES.protectedFile,
          detail: protectedDetail(guarded.kinds),
        };
      }
      if (changes.length === 0) return { kind: "empty" };
      // The scan runs outside the git queue; only the delivered content it needs is read in it.
      const values = await listedValues(git.mainWorktree, [...listed]);
      const secrets = await secretHits({
        changes,
        view: view.entries,
        subject: partSubject(message, ""),
        ...(values.length === 0 ? {} : { literals: { kind: LISTED_VALUE_KIND, values } }),
        before: (ids) => git.run((session) => deliveredTexts(session, ids)),
        ...(this.#deps.scanFileMax === undefined ? {} : { maxFileBytes: this.#deps.scanFileMax }),
      });
      if (secrets === "tooBig") return refused("bigFile");
      if (secrets.kinds.length > 0) {
        this.#hitRecord(run, PART_CAUSES.secret, secrets.paths);
        return {
          kind: "hit",
          cause: PART_CAUSES.secret,
          detail: secretDetail(secrets.kinds, secrets.paths.length),
        };
      }
      // The run may have ended while the part was scanned: the part then stays queued in the box.
      this.#assertLive(run);
      const committed = await git.run((session) =>
        commitPart(session, {
          branch: run.branch,
          story: run.story,
          startSha: run.startSha,
          view,
          changes,
          message,
          index: join(stage, "index"),
        }),
      );
      if (committed === null) return null;
      if (committed === "refused") return refused("git");
      if (committed.commit === null) return { kind: "empty" };
      const { commit, n } = committed;
      this.#assertLive(run);
      const push = await git
        .run((session) => pushBranch(session, git.settings.remote, run.branch))
        .catch((error: unknown) => ({ pushed: false, rejected: false, error: messageOf(error) }));
      this.#recordPush(run, push);
      this.#deps.info?.("a part was committed", { run: run.runId, part: n, commit });
      return { kind: "committed", n, commit, paths: changes.map((c) => c.path), push };
    });
  }

  /** A part's push on the run's claim (DIPO-315); a failure to record it is logged only. */
  #recordPush(run: PartRun, push: PushResult): void {
    try {
      this.#deps.pushed?.(run, push);
    } catch (error) {
      this.#deps.warn?.("a part's push could not be recorded", {
        run: run.runId,
        reason: messageOf(error),
      });
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
