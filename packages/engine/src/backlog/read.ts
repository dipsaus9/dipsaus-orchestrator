// Reading every active task and draft through the Backlog CLI (0010 sections 1 and 6, 0007
// section 6 step 3), the StoryStore's `readAll` and `read`. `task list` and `draft list` give the
// ids; `task view` and `draft view` give each story. Archived, completed and draft-folder files
// never appear in `task list`, so they are not active tasks; drafts are read as drafts.
//
// A failed list or view stops the read: a story missing from a partial read would look vanished
// and be closed as Removed. So does a list that disagrees with its `--count` (DIPO-323). A view
// that does not parse (R02) still yields the story with what the list printed, so it keeps its
// key; its created date and branch are then unknown.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { mapLimited, VIEW_CONCURRENCY } from "../stories/read";
import type { ListedStory, ReadReuse, StoryRead } from "../story-store/store";
import type { StoryKind } from "../story-store/story";

import { listAll } from "./list";
import { BacklogParseError, parseView, plainLines } from "./plain";
import { type BacklogCli, ROOT_CONFIG, runBacklog, storyFoldersOf } from "./runner";

/** sha256 of a view's output without the `File:` line that names where it was read. */
export function contentHash(output: string): string {
  const lines = plainLines(output);
  const body = lines[0]?.startsWith("File: ") ? lines.slice(1) : lines;
  return createHash("sha256").update(body.join("\n")).digest("hex");
}

/** One `--plain` view as a story read; `listed` stands in when the view does not parse. */
export function storyRead(kind: StoryKind, output: string, listed: ListedStory): StoryRead {
  const known = { id: listed.id, title: listed.title, status: listed.status };
  const hash = contentHash(output);
  try {
    return { kind, listed: known, contentHash: hash, view: parseView(output) };
  } catch (error) {
    if (!(error instanceof BacklogParseError)) throw error;
    return { kind, listed: known, contentHash: hash };
  }
}

/**
 * Reads every active task and draft in the worktree `cwd`, in list order. With `pass` (DIPO-314)
 * a story whose printed files are unchanged is taken from the cache instead of the CLI, and a kept
 * view a read or gone story named is read again after the first round. Throws
 * `BacklogCommandError` or `BacklogRefusedError` when the CLI fails (`BacklogListIncompleteError`
 * when a list disagrees with its count), and `BacklogParseError` when a list does not parse.
 */
export async function readBacklog(
  cli: BacklogCli,
  cwd: string,
  pass?: ViewPass,
): Promise<StoryRead[]> {
  const listed: { kind: StoryKind; id: string; title: string; status: string }[] = [];
  for (const kind of ["task", "draft"] as const) {
    for (const entry of (await listAll(cli, cwd, kind)).entries) {
      listed.push({
        kind,
        id: entry.id,
        title: entry.title,
        status: kind === "draft" ? "Draft" : entry.group,
      });
    }
  }
  if (pass === undefined) {
    return mapLimited(listed, VIEW_CONCURRENCY, (entry) => readStory(cli, cwd, entry.kind, entry));
  }
  const read = (entry: (typeof listed)[number]) =>
    readStoryOutput(cli, cwd, entry.kind, entry).then(({ story, stdout }) => {
      pass.record(entry.kind, entry.id, story, stdout);
      return story;
    });
  const first = await mapLimited(
    listed,
    VIEW_CONCURRENCY,
    async (entry) => pass.reuse(entry.kind, entry.id) ?? read(entry),
  );
  pass.forgetOthers(new Set(listed.map((entry) => `${entry.kind}:${entry.id.toUpperCase()}`)));
  // A kept view a story read or gone in this pass named may print something new: read it again.
  return mapLimited(
    listed.map((entry, index) => ({ entry, index })),
    VIEW_CONCURRENCY,
    async ({ entry, index }) =>
      pass.stale(entry.kind, entry.id) ? read(entry) : (first[index] as StoryRead),
  );
}

/**
 * Reads one story in the folder `cwd` (a checkout, or dipo's copy of a story's backlog);
 * `listed` fills in when the view does not parse. Throws as `runBacklog` does.
 */
export async function readStory(
  cli: BacklogCli,
  cwd: string,
  kind: StoryKind,
  listed: ListedStory,
): Promise<StoryRead> {
  return (await readStoryOutput(cli, cwd, kind, listed)).story;
}

/** `readStory` with the view's text. */
async function readStoryOutput(
  cli: BacklogCli,
  cwd: string,
  kind: StoryKind,
  listed: ListedStory,
): Promise<{ readonly story: StoryRead; readonly stdout: string }> {
  const { stdout } = await runBacklog(cli, cwd, [kind, "view", listed.id, "--plain"]);
  return { story: storyRead(kind, stdout, listed), stdout };
}

// ---- reading only what changed (DIPO-314) -------------------------------------------------------
//
// An index pass reads every story's view again only when something its view prints may have
// changed. What a view prints comes from Backlog files: the story's own task file, the files of
// the stories it names (its dependency graph, its dependents, its parent and subtasks), and the
// project's other Backlog files (its configuration, milestones). The pass lists the blob of every
// such file at the commit it reads (`backlogBlobs`, from `git ls-tree`), and a view is taken from
// the office's `StoryViewCache` when the story's own files, and those of every story id its view
// printed (with or without a file then), have the same blobs as when it was read, and no other
// Backlog file changed. The pass lists the folders the CLI reads (`backlogFolders`): `backlog/`,
// `.backlog/` and the folder `backlog.config.yml` names.
//
// A story read again, added or gone may change what the views of the stories it names print (a
// new subtask, a new dependent), so each story id a new or an old view of such a story prints is
// read again after the first round when its view was taken from the cache. The cache lives in
// memory; a daemon start reads every view once.

/** The Backlog files of one commit: a fingerprint of each story id's files, and of all others. */
export interface BacklogBlobs {
  /** By story id in upper case: its files' paths and blob ids. */
  readonly byId: ReadonlyMap<string, string>;
  /** Every other Backlog file's path and blob id. */
  readonly rest: string;
}

/** The ids a view text may name: `PREFIX-n` and `PREFIX-n.m`, in upper case. */
const ID_TOKEN = /\b[A-Za-z][A-Za-z0-9_]*-\d+(?:\.\d+)*\b/g;

/** The story id of a Backlog file name (`<id> - <title>.md`), upper case, or null. */
function idOfFileName(name: string): string | null {
  if (!name.toLowerCase().endsWith(".md")) return null;
  const end = name.indexOf(" - ");
  if (end <= 0) return null;
  const id = name.slice(0, end);
  return /^[A-Za-z][A-Za-z0-9_]*-\d+(?:\.\d+)*$/.test(id) ? id.toUpperCase() : null;
}

/**
 * Pure: the `BacklogBlobs` of `git ls-tree -r -z <commit> -- backlog backlog.config.yml`.
 */
export function backlogBlobs(output: string): BacklogBlobs {
  const byId = new Map<string, string[]>();
  const rest: string[] = [];
  for (const record of output.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const path = record.slice(tab + 1);
    const item = `${path}\u0000${record.slice(0, tab)}`;
    const id = idOfFileName(path.slice(path.lastIndexOf("/") + 1));
    if (id === null) {
      rest.push(item);
      continue;
    }
    const items = byId.get(id) ?? [];
    items.push(item);
    byId.set(id, items);
  }
  return {
    byId: new Map([...byId].map(([id, items]) => [id, items.toSorted().join("\n")])),
    rest: rest.toSorted().join("\n"),
  };
}

/**
 * Every story id `output` names, the story's own left out, whether or not it has a file yet: a
 * dependency on a story that does not exist yet prints differently once it does.
 */
function namedIds(output: string, own: string): Set<string> {
  const ids = new Set<string>();
  for (const match of output.matchAll(ID_TOKEN)) {
    const id = match[0].toUpperCase();
    if (id !== own) ids.add(id);
  }
  return ids;
}

interface CachedView {
  /** The fingerprint of the story's own files when it was read. */
  readonly own: string;
  /** The fingerprint of each story id the view named when it was read; "" when it had no file. */
  readonly named: ReadonlyMap<string, string>;
  readonly story: StoryRead;
}

/** One office's views as last read, by `<kind>:<ID>` (see the section comment). */
export class StoryViewCache {
  readonly #views = new Map<string, CachedView>();
  #rest: string | null = null;

  /** How many views are kept. */
  get size(): number {
    return this.#views.size;
  }

  /** A pass over the backlog at `blobs`; a change to any other Backlog file drops every view. */
  pass(blobs: BacklogBlobs): ViewPass {
    if (this.#rest !== blobs.rest) this.#views.clear();
    this.#rest = blobs.rest;
    return new ViewPass(this.#views, blobs);
  }
}

/** What one index pass takes from and puts in the cache. */
export class ViewPass {
  /** Story ids whose view may print something new: named by a view read or gone in this pass. */
  readonly touched = new Set<string>();
  /** The keys whose view this pass took from the cache. */
  readonly reused = new Set<string>();

  constructor(
    readonly views: Map<string, CachedView>,
    readonly blobs: BacklogBlobs,
  ) {}

  /** The kept view of the story, when none of the files it printed changed. */
  reuse(kind: StoryKind, id: string): StoryRead | undefined {
    const key = `${kind}:${id.toUpperCase()}`;
    const kept = this.views.get(key);
    const own = this.blobs.byId.get(id.toUpperCase());
    if (kept === undefined || own === undefined || kept.own !== own) return undefined;
    for (const [named, fingerprint] of kept.named) {
      if ((this.blobs.byId.get(named) ?? "") !== fingerprint) return undefined;
    }
    this.reused.add(key);
    return kept.story;
  }

  /** Keeps a view the CLI printed in this pass; the ids its old and new view named are touched. */
  record(kind: StoryKind, id: string, story: StoryRead, output: string): void {
    const upper = id.toUpperCase();
    const key = `${kind}:${upper}`;
    this.reused.delete(key);
    const old = this.views.get(key);
    for (const named of old?.named.keys() ?? []) this.touched.add(named);
    const own = this.blobs.byId.get(upper);
    const ids = namedIds(output, upper);
    for (const named of ids) this.touched.add(named);
    if (own === undefined) {
      this.views.delete(key);
      return;
    }
    const named = new Map([...ids].map((other) => [other, this.blobs.byId.get(other) ?? ""]));
    this.views.set(key, { own, named, story });
  }

  /** Drops the views of stories this pass did not list; the ids they named are touched. */
  forgetOthers(listed: ReadonlySet<string>): void {
    for (const [key, kept] of this.views) {
      if (listed.has(key)) continue;
      for (const named of kept.named.keys()) this.touched.add(named);
      this.views.delete(key);
    }
  }

  /** True when the story's view came from the cache and a story read or gone named it. */
  stale(kind: StoryKind, id: string): boolean {
    const upper = id.toUpperCase();
    return this.reused.has(`${kind}:${upper}`) && this.touched.has(upper);
  }
}

/** The kept views of each `ReadReuse` key (the office), for as long as the key lives. */
const VIEW_CACHES = new WeakMap<object, StoryViewCache>();

/** The kept views of `key`. */
export function viewCacheOf(key: object): StoryViewCache {
  let cache = VIEW_CACHES.get(key);
  if (cache === undefined) {
    cache = new StoryViewCache();
    VIEW_CACHES.set(key, cache);
  }
  return cache;
}

/**
 * The folders the Backlog CLI reads its files from in the checkout `cwd`, as `scanBacklogFiles`
 * resolves them: `backlog/`, `.backlog/` and the folder `backlog.config.yml` names, with that
 * file itself; null when the file names a folder dipo cannot resolve, or cannot be read.
 */
export function backlogFolders(cwd: string): string[] | null {
  let text: string | null;
  try {
    text = readFileSync(join(cwd, ROOT_CONFIG), "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") return null;
    text = null;
  }
  try {
    const [own = "", hidden = "", ...named] = storyFoldersOf(text);
    return [own, hidden, ROOT_CONFIG, ...named];
  } catch {
    return null;
  }
}

/**
 * A pass over the kept views of `reuse.key` at the checkout `cwd`, or undefined when the blobs
 * cannot be listed or the Backlog folders cannot be resolved: then every view is read.
 */
export async function viewPass(cwd: string, reuse: ReadReuse): Promise<ViewPass | undefined> {
  const folders = backlogFolders(cwd);
  if (folders === null) return undefined;
  try {
    const listing = await reuse.session.ok(reuse.location, [
      "ls-tree",
      "-r",
      "-z",
      reuse.sha,
      "--",
      ...folders,
    ]);
    return viewCacheOf(reuse.key).pass(backlogBlobs(listing));
  } catch {
    return undefined;
  }
}
