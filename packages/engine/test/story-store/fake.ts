// A StoryStore in memory (0010), so engine code runs with no Backlog.md behind it: the base holds
// stories by id, a story's branch holds its own copy once an edit or a test puts one there, and
// every story lane edit that changes the story is one numbered commit. The checkout a read names
// is ignored: the fake has one base.

import { FieldBlock } from "@dipsaus-orchestrator/contract";

import { StoryParseError, StoryStoreError } from "../../src/story-store/errors";
import {
  emitFieldBlock,
  parseFieldBlock,
  spliceFieldBlock,
} from "../../src/story-store/fields/block";
import type { PlanningHold } from "../../src/story-store/planning";
import type {
  ListedStory,
  StoryEditor,
  StoryOnBranch,
  StoryRead,
  StoryStore,
} from "../../src/story-store/store";
import type { PlainList, PlainTask, StoryKind } from "../../src/story-store/story";

/** A story the fake holds, by id, with a file path of its own. */
export function fakeStory(id: string, overrides: Partial<PlainTask> = {}): PlainTask {
  return {
    file: `backlog/tasks/${id.toLowerCase()} - Story-${id}.md`,
    id,
    title: `Story ${id}`,
    status: "Refined",
    created: "2026-10-12 11:28 (UTC)",
    assignee: [],
    labels: [],
    subtasks: [],
    references: [],
    documentation: [],
    dependencies: [],
    description: `Outcome: ${id} works.`,
    acceptanceCriteria: [{ index: 1, checked: false, text: `${id} works.` }],
    definitionOfDone: [],
    modifiedFiles: [],
    comments: [],
    unknown: [],
    ...overrides,
  };
}

/** The fake's "no such story" failure. */
class FakeNotFound extends StoryStoreError {
  constructor(readonly id: string) {
    super(`${id} not found`);
  }
}

export class FakeStoryStore implements StoryStore {
  /** The base's stories by id; `undefined` marks one that does not parse. */
  readonly base = new Map<string, { kind: StoryKind; story: PlainTask | undefined }>();
  /** Each branch's copy of its story, by branch name. */
  readonly branches = new Map<string, PlainTask>();
  readonly milestoneNames: string[] = [];
  /** The stories with a journaled planning change, and those a failed backlog PR check holds. */
  readonly pending = new Set<string>();
  readonly checkFailed = new Set<string>();
  /** Every story lane commit, in order. */
  readonly commits: { readonly branch: string; readonly message: string }[] = [];
  readonly #unparsed = new Map<string, ListedStory>();

  put(story: PlainTask, kind: StoryKind = "task"): this {
    this.base.set(story.id, { kind, story });
    return this;
  }

  /** A story whose text does not parse: listed with `title` and `status` only. */
  putUnparsed(id: string, title: string, status: string): this {
    this.base.set(id, { kind: "task", story: undefined });
    this.#unparsed.set(id, { id, title, status });
    return this;
  }

  #listed(id: string): ListedStory {
    const story = this.base.get(id)?.story;
    return story === undefined
      ? (this.#unparsed.get(id) as ListedStory)
      : { id, title: story.title, status: story.status };
  }

  async list(_checkout: string, kind: StoryKind): Promise<PlainList> {
    const entries = [...this.base]
      .filter(([, held]) => held.kind === kind)
      .map(([id]) => {
        const listed = this.#listed(id);
        return { id, title: listed.title, group: kind === "draft" ? "Drafts" : listed.status };
      });
    return { entries, unknown: [] };
  }

  async view(_checkout: string, id: string, kind: StoryKind = "task"): Promise<PlainTask> {
    const held = this.base.get(id);
    if (held === undefined || held.kind !== kind) throw new FakeNotFound(id);
    if (held.story === undefined) throw new StoryParseError(`${id} does not parse`);
    return held.story;
  }

  #read(kind: StoryKind, listed: ListedStory, story: PlainTask | undefined): StoryRead {
    const contentHash = `hash:${JSON.stringify(story ?? listed)}`;
    return story === undefined
      ? { kind, listed, contentHash }
      : { kind, listed, contentHash, view: story };
  }

  async readAll(): Promise<StoryRead[]> {
    return [...this.base].map(([id, held]) => this.#read(held.kind, this.#listed(id), held.story));
  }

  async read(_checkout: string, kind: StoryKind, listed: ListedStory): Promise<StoryRead> {
    const held = this.base.get(listed.id);
    if (held === undefined) throw new FakeNotFound(listed.id);
    return this.#read(kind, listed, held.story);
  }

  async milestones(): Promise<string[]> {
    return [...this.milestoneNames];
  }

  isNotFound(error: unknown, id: string): boolean {
    return error instanceof FakeNotFound && error.id === id;
  }

  #onBranch(target: StoryOnBranch): PlainTask {
    const story = this.branches.get(target.branch) ?? this.base.get(target.story)?.story;
    if (story === undefined) throw new FakeNotFound(target.story);
    return story;
  }

  async readOnBranch(
    _git: unknown,
    _session: unknown,
    target: StoryOnBranch,
    _checkout: string,
    listed: ListedStory,
  ): Promise<StoryRead> {
    return this.#read("task", listed, this.#onBranch(target));
  }

  async viewOnBranch(_git: unknown, _session: unknown, target: StoryOnBranch) {
    const view = this.#onBranch(target);
    return { view, file: view.file };
  }

  async editOnBranch<T>(
    _git: unknown,
    _session: unknown,
    target: StoryOnBranch,
    message: string,
    fn: (story: StoryEditor) => Promise<T>,
  ) {
    const before = this.#onBranch(target);
    let story = before;
    const set = (next: Partial<PlainTask>) => {
      story = { ...story, ...next };
    };
    const editor: StoryEditor = {
      id: target.story,
      file: before.file,
      view: async () => story,
      async setStatus(status, check = []) {
        set({
          status,
          acceptanceCriteria: story.acceptanceCriteria.map((c) =>
            check.includes(c.index) ? { ...c, checked: true } : c,
          ),
        });
      },
      async writeFields(change) {
        const { fields } = parseFieldBlock(story.description);
        const next = FieldBlock.parse(change(fields));
        if (emitFieldBlock(next) !== emitFieldBlock(fields)) {
          set({ description: spliceFieldBlock(story.description, next) });
        }
        return next;
      },
      async appendNotes(text) {
        const notes = [story.implementationNotes, text].filter((n) => n !== undefined).join("\n\n");
        set({ implementationNotes: notes });
        return notes;
      },
      async setFinalSummary(text) {
        set({ finalSummary: text });
        return text;
      },
      async recordModifiedFiles(paths) {
        set({ modifiedFiles: [...story.modifiedFiles, ...paths] });
      },
    };
    const value = await fn(editor);
    if (JSON.stringify(story) === JSON.stringify(before)) return { value, commit: null };
    this.branches.set(target.branch, story);
    this.commits.push({ branch: target.branch, message });
    return { value, commit: `fake-commit-${this.commits.length}` };
  }

  isStoryFile(path: string, id: string): boolean {
    const held = this.base.get(id)?.story;
    return held !== undefined && held.file === path;
  }

  /** The story's file as the base holds it; the commit is ignored, as the checkout is. */
  async fileAt(_session: unknown, _commit: string, id: string): Promise<string | null> {
    return this.base.get(id)?.story?.file ?? null;
  }

  /** The value of the text's first `status:` line; the fake keeps no files of its own. */
  statusIn(text: string): string | null {
    return /^status:[ \t]*(.+?)[ \t]*$/m.exec(text)?.[1] ?? null;
  }

  /** The `backlog_directory` a root configuration names: a relative folder inside, else null. */
  configuredFolder(text: string): string | null {
    const folder = /^backlog_directory:[ \t]*(.+?)[ \t]*$/m.exec(text)?.[1] ?? "";
    const inside = folder !== "" && !folder.startsWith("/") && !folder.split("/").includes("..");
    return inside ? folder : null;
  }

  /** A journaled change holds a story first, then a failed backlog PR check. */
  planningHold(_office: unknown, key: string): PlanningHold | null {
    if (this.pending.has(key)) return "pending";
    return this.checkFailed.has(key) ? "checkFailed" : null;
  }
}
