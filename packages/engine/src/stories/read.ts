// Reading every active task and draft through the Backlog CLI (0010 sections 1 and 6, 0007
// section 6 step 3). `task list` and `draft list` give the ids; `task view` and `draft view` give
// each story's status, created date, labels and field block. Archived, completed and draft-folder
// files never appear in `task list`, so they are not active tasks; drafts are read as drafts.
//
// A failed list or view stops the read: a story missing from a partial read would look vanished
// and be closed as Removed. So does a list that disagrees with its `--count` (DIPO-323). A view
// that does not parse (R02) still yields the story with what the list printed, so it keeps its
// key; its created date and branch are then unknown.

import { createHash } from "node:crypto";

import { type FieldBlockPark, StoryId } from "@dipsaus-orchestrator/contract";

import { parseFieldBlock } from "../backlog/fields/block";
import { readLabels } from "../backlog/fields/labels";
import { listAll } from "../backlog/list";
import { BacklogParseError, parseView, plainLines } from "../backlog/plain";
import { type BacklogCli, runBacklog } from "../backlog/runner";
import { gateStoryFromView, gateTaskFromView } from "../gate/input";
import { gateContentHash } from "../gate/store/hash";
import type { GateTask } from "../gate/types";
import { openDependencies } from "../run/select";

export type StoryKind = "task" | "draft";

/** One story as the index read it. */
export interface BacklogStory {
  readonly kind: StoryKind;
  readonly story: StoryId;
  readonly title: string;
  /** The status as the CLI printed it, without its icon. */
  readonly status: string;
  /** The created date exactly as the CLI printed it; absent when the view did not parse. */
  readonly created?: string;
  readonly labels: readonly string[];
  /** The tier when exactly one `tier:<T>` label is set. */
  readonly tier?: string;
  /** The role when exactly one `role:<name>` label is set. */
  readonly role?: string;
  /** The frozen branch from the field block (0012 F15), when the block parses and holds one. */
  readonly frozenBranch?: string;
  /** sha256 of the view output without its `File:` line, so moving the worktree changes nothing. */
  readonly contentHash: string;
  /** The dependencies that are not Done (DIPO-52); absent when the view did not parse. */
  readonly waitingOn?: readonly string[];
  /** The field block's park record (0010 section 3), when the block parses and holds one. */
  readonly park?: FieldBlockPark;
  /**
   * Acceptance criteria checked and in all, and their `#n` numbers (DIPO-85); absent when the view
   * did not parse.
   */
  readonly criteria?: {
    readonly met: number;
    readonly total: number;
    readonly numbers?: readonly number[];
  };
  /**
   * The content hash a Ready gate decision applies to (`gateContentHash`), so reconcile can tell a
   * Ready story without a decision for its content (0007 section 6); absent when the view did not
   * parse.
   */
  readonly gateHash?: string;
  /**
   * What the Ready gate reads of this task when it is one of the other active tasks (DIPO-180):
   * its dependencies and frozen branch, as read on `_base`. Set for tasks, never for drafts. A view
   * that did not parse still counts, without dependencies or branch. A claimed story keeps the
   * base read here although the rest of it is read on its branch.
   */
  readonly gateTask?: GateTask;
  /**
   * Where the story was read (0007 section 6 step 3): the story branch while the story is
   * claimed; absent means the pass's own source, `base`.
   */
  readonly source?: string;
}

/** How many CLI views run at once. */
export const VIEW_CONCURRENCY = 4;

/** sha256 of a view's output without the `File:` line that names where it was read. */
export function contentHash(output: string): string {
  const lines = plainLines(output);
  const body = lines[0]?.startsWith("File: ") ? lines.slice(1) : lines;
  return createHash("sha256").update(body.join("\n")).digest("hex");
}

function single(values: readonly string[]): string | undefined {
  return values.length === 1 ? values[0] : undefined;
}

/** Turns one `--plain` view into a story; `listed` fills in when the view does not parse. */
export function storyFromView(
  kind: StoryKind,
  output: string,
  listed: { readonly id: string; readonly title: string; readonly status: string },
): BacklogStory {
  const hash = contentHash(output);
  let view;
  try {
    view = parseView(output);
  } catch (error) {
    if (!(error instanceof BacklogParseError)) throw error;
    return {
      kind,
      story: StoryId.parse(listed.id),
      title: listed.title,
      status: listed.status,
      labels: [],
      contentHash: hash,
      ...(kind === "task" ? { gateTask: { id: listed.id, dependencies: [] } } : {}),
    };
  }
  const labels = readLabels(view.labels);
  let frozenBranch: string | undefined;
  let park: FieldBlockPark | undefined;
  try {
    const { fields } = parseFieldBlock(view.description);
    frozenBranch = fields.branch;
    park = fields.park;
  } catch {
    // An invalid block (R02) leaves the branch and park unknown; the Ready gate reports it.
    frozenBranch = undefined;
  }
  const tier = single(labels.tiers);
  const role = single(labels.roles);
  return {
    kind,
    story: StoryId.parse(view.id),
    title: view.title,
    status: view.status,
    created: view.created,
    labels: view.labels,
    ...(tier === undefined ? {} : { tier }),
    ...(role === undefined ? {} : { role }),
    ...(frozenBranch === undefined ? {} : { frozenBranch }),
    contentHash: hash,
    waitingOn: openDependencies(view),
    ...(park === undefined ? {} : { park }),
    criteria: {
      met: view.acceptanceCriteria.filter((criterion) => criterion.checked).length,
      total: view.acceptanceCriteria.length,
      numbers: view.acceptanceCriteria.map((criterion) => criterion.index),
    },
    gateHash: gateContentHash(
      gateStoryFromView(
        view,
        view.subtasks.map((task) => task.id),
      ),
    ),
    ...(kind === "task" ? { gateTask: gateTaskFromView(view) } : {}),
  };
}

/** `fn` over `items` with at most `limit` running at once; results in item order. */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
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
): Promise<BacklogStory[]> {
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
      pass.stale(entry.kind, entry.id) ? read(entry) : (first[index] as BacklogStory),
  );
}

/**
 * Reads one story in the worktree `cwd` (a claimed story's worktree, DIPO-56); `listed` fills in
 * when the view does not parse. Throws as `runBacklog` does.
 */
export async function readStory(
  cli: BacklogCli,
  cwd: string,
  kind: StoryKind,
  listed: { readonly id: string; readonly title: string; readonly status: string },
): Promise<BacklogStory> {
  return (await readStoryOutput(cli, cwd, kind, listed)).story;
}

/** `readStory` with the view's text. */
async function readStoryOutput(
  cli: BacklogCli,
  cwd: string,
  kind: StoryKind,
  listed: { readonly id: string; readonly title: string; readonly status: string },
): Promise<{ readonly story: BacklogStory; readonly stdout: string }> {
  const { stdout } = await runBacklog(cli, cwd, [kind, "view", listed.id, "--plain"]);
  return { story: storyFromView(kind, stdout, listed), stdout };
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
  readonly story: BacklogStory;
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
  reuse(kind: StoryKind, id: string): BacklogStory | undefined {
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
  record(kind: StoryKind, id: string, story: BacklogStory, output: string): void {
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
