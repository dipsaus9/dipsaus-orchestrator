// One StoryStore contract (0010, DIPO-356): what the engine relies on from any story store, run
// against the in-memory fake (`fake-contract.test.ts`) and the Backlog.md store with the pinned
// CLI (`backlog-contract.ci.test.ts`). Each world holds the Backlog fixture's stories.

import { describe, expect, it } from "bun:test";

import type { StoryKey } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../../src/db/office";
import type { GitSession } from "../../src/git/office";
import type { StoryStore } from "../../src/story-store/store";

/** The tasks every contract world holds: the Backlog fixture's. */
export const CONTRACT_TASKS = [
  { id: "TASK-1", title: "Add the CSV export command", status: "Ready" },
  { id: "TASK-2", title: "Rename the export setting", status: "Refined" },
  { id: "TASK-3", title: "Export stories as JSON", status: "Parked" },
] as const;

/** The draft every contract world holds. */
export const CONTRACT_DRAFT = { id: "DRAFT-1", title: "Sketch the export format" } as const;

/** A store holding the contract's stories, with what its reads take. */
export interface ContractWorld {
  readonly store: StoryStore;
  /** A checkout of the base that holds the stories. */
  readonly checkout: string;
  /** A git session on the checkout's repository, and the commit its stories are at. */
  readonly session: GitSession;
  readonly head: string;
  /** An office of the state database; nothing holds its stories until `journal`. */
  readonly office: OfficeHandle;
  /** The text of the story's file, as the store keeps it at `head`. */
  fileText(id: string): string;
  /** Journals a planning change of the story `key`, the way the store's planning lane does. */
  journal(key: StoryKey): void;
}

export type WithWorld = (fn: (world: ContractWorld) => Promise<void>) => Promise<void>;

const KEY = "key_contract_1" as StoryKey;

/** By id: a store may list its stories grouped by status. */
const byId = <T extends { readonly id: string }>(items: readonly T[]): T[] =>
  items.toSorted((a, b) => a.id.localeCompare(b.id));

/** Registers the contract for the store `name`; `timeout` is per test, in ms. */
export function storyStoreContract(name: string, withWorld: WithWorld, timeout?: number): void {
  const test = (title: string, fn: (world: ContractWorld) => Promise<void>) =>
    it(title, () => withWorld(fn), timeout);

  describe(`the StoryStore contract: ${name}`, () => {
    test("lists every task with its title and status, and the drafts", async (w) => {
      const tasks = await w.store.list(w.checkout, "task");
      expect(
        byId(tasks.entries.map(({ id, title, group }) => ({ id, title, status: group }))),
      ).toEqual(CONTRACT_TASKS.map((task) => ({ ...task })));
      const drafts = await w.store.list(w.checkout, "draft");
      expect(drafts.entries.map(({ id, title }) => ({ id, title }))).toEqual([
        { ...CONTRACT_DRAFT },
      ]);
    });

    test("views one story with its fields, a task or a draft", async (w) => {
      for (const task of CONTRACT_TASKS) {
        const view = await w.store.view(w.checkout, task.id);
        expect({ id: view.id, title: view.title, status: view.status }).toEqual({ ...task });
      }
      const draft = await w.store.view(w.checkout, CONTRACT_DRAFT.id, "draft");
      expect({ id: draft.id, title: draft.title }).toEqual({ ...CONTRACT_DRAFT });
    });

    test("tells a story that does not exist from any other failure", async (w) => {
      const error = await w.store.view(w.checkout, "TASK-99").then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).not.toBeNull();
      expect(w.store.isNotFound(error, "TASK-99")).toBe(true);
      expect(w.store.isNotFound(error, "TASK-9")).toBe(false);
      expect(w.store.isNotFound(new Error("TASK-99 not found."), "TASK-99")).toBe(false);
    });

    test("reads every story at once, and one story by its listed facts", async (w) => {
      const all = await w.store.readAll(w.checkout);
      const read = all.map((story) => ({
        id: story.listed.id,
        kind: story.kind,
        title: story.view?.title,
      }));
      expect(byId(read)).toEqual([
        { id: CONTRACT_DRAFT.id, kind: "draft", title: CONTRACT_DRAFT.title },
        ...CONTRACT_TASKS.map((task) => ({
          id: task.id,
          kind: "task" as const,
          title: task.title,
        })),
      ]);
      const [first] = CONTRACT_TASKS;
      const one = await w.store.read(w.checkout, "task", { ...first });
      expect(one.view?.status).toBe(first.status);
      expect(one.contentHash).toBe(
        all.find((story) => story.listed.id === first.id)?.contentHash as string,
      );
    });

    test("knows each story's file, at a commit and in its text", async (w) => {
      for (const task of CONTRACT_TASKS) {
        // The file in the repository, relative to its root; a view may name it where it was read.
        const file = await w.store.fileAt(w.session, w.head, task.id);
        expect(file).not.toBeNull();
        expect((await w.store.view(w.checkout, task.id)).file.endsWith(file as string)).toBe(true);
        expect(w.store.isStoryFile(file as string, task.id)).toBe(true);
        const other = task.id === "TASK-1" ? "TASK-2" : "TASK-1";
        expect(w.store.isStoryFile(file as string, other)).toBe(false);
        expect(w.store.statusIn(w.fileText(task.id))).toBe(task.status);
      }
      expect(await w.store.fileAt(w.session, w.head, "TASK-99")).toBeNull();
    });

    test("holds a story from pickup while a planning change of it is journaled", async (w) => {
      expect(w.store.planningHold(w.office, KEY)).toBeNull();
      w.journal(KEY);
      expect(w.store.planningHold(w.office, KEY)).toBe("pending");
    });
  });
}
