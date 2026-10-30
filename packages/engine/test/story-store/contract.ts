// One StoryStore contract (0010, DIPO-356): what the engine relies on from any story store, run
// against the in-memory fake (`fake-contract.test.ts`) and the Backlog.md store with the pinned
// CLI (`backlog-contract.ci.test.ts`). Each world holds the Backlog fixture's stories.

import { describe, expect, it } from "bun:test";

import type { StoryKey } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../../src/db/office";
import type { OfficeGit } from "../../src/git/office";
import { parseFieldBlock } from "../../src/story-store/fields/block";
import { checkoutFiles } from "../../src/story-store/folder";
import { inStoryFolder, repoPathOf } from "../../src/story-store/paths";
import type { PlannedPark } from "../../src/story-store/planning";
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
  /** The office's git, whose queue items give the store its git sessions. */
  readonly git: OfficeGit;
  /** The commit the stories are at. */
  readonly head: string;
  /** A branch of TASK-1 at `head`: the story lane's writes go there. */
  readonly branch: string;
  /** An office of the state database; nothing holds its stories until `journal` or `block`. */
  readonly office: OfficeHandle;
  /** The text of the story's file, as the store keeps it at `head`. */
  fileText(id: string): string;
  /** Journals a planning change of the story `key`, the way the store's planning lane does. */
  journal(key: StoryKey): void;
  /** Records that the office's merged backlog PR failed its check on the story `key`. */
  block(key: StoryKey): void;
  /**
   * Journals a planning change of the story `key` that parks it with `park`, or, with null,
   * moves it back to Refined, the way the store's planning lane does.
   */
  plan(key: StoryKey, park: PlannedPark | null): void;
}

export type WithWorld = (fn: (world: ContractWorld) => Promise<void>) => Promise<void>;

const KEY = "key_contract_1" as StoryKey;
const OTHER = "key_contract_2" as StoryKey;

/** A repository whose files cannot be read. */
async function unreadable(): Promise<string | null> {
  throw new Error("the file cannot be read");
}

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
        const file = await w.git.run((session) => w.store.fileAt(session, w.head, task.id));
        expect(file).not.toBeNull();
        expect((await w.store.view(w.checkout, task.id)).file.endsWith(file as string)).toBe(true);
        expect(w.store.isStoryFile(file as string, task.id)).toBe(true);
        const other = task.id === "TASK-1" ? "TASK-2" : "TASK-1";
        expect(w.store.isStoryFile(file as string, other)).toBe(false);
        expect(w.store.statusIn(w.fileText(task.id))).toBe(task.status);
      }
      expect(await w.git.run((session) => w.store.fileAt(session, w.head, "TASK-99"))).toBeNull();
    });

    test("names the folders it keeps its stories in, and refuses through a read that fails", async (w) => {
      const folders = await w.store.storyFolders(checkoutFiles(w.checkout));
      expect(folders.length).toBeGreaterThan(0);
      for (const folder of folders) expect(repoPathOf(folder)).toBe(folder);
      // Every story file of the checkout lies in one of them.
      for (const task of CONTRACT_TASKS) {
        const file = await w.git.run((session) => w.store.fileAt(session, w.head, task.id));
        expect([file, inStoryFolder(file as string, folders)]).toEqual([file, true]);
      }
      expect(inStoryFolder("src/export.ts", folders)).toBe(false);
      await expect(w.store.storyFolders(unreadable)).rejects.toThrow("cannot be read");
      await expect(w.store.isProject(unreadable)).rejects.toThrow("cannot be read");
      expect(await w.store.isProject(checkoutFiles(w.checkout))).toBe(true);
    });

    test("edits a story on its branch in one commit, and commits nothing for no change", async (w) => {
      const target = { story: "TASK-1", branch: w.branch };
      const unknown = { q: "Which delimiter?", status: "resolved" as const, answer: "A comma." };
      const edit = await w.git.run((session) =>
        w.store.editOnBranch(w.git, session, target, "TASK-1: status In Review", async (story) => {
          expect(story.id).toBe("TASK-1");
          await story.setStatus("In Review", [1]);
          await story.writeFields((fields) => ({ ...fields, unknowns: [unknown] }));
          const notes = await story.appendNotes("Exported with a header row.");
          const summary = await story.setFinalSummary("CSV export done.");
          return { notes, summary };
        }),
      );
      expect(edit.commit).not.toBeNull();
      expect(edit.value.notes).toContain("Exported with a header row.");
      expect(edit.value.summary).toBe("CSV export done.");
      const { view } = await w.git.run((session) => w.store.viewOnBranch(w.git, session, target));
      expect(view.status).toBe("In Review");
      expect(view.acceptanceCriteria.map((c) => [c.index, c.checked])).toEqual([
        [1, true],
        [2, false],
      ]);
      expect(parseFieldBlock(view.description).fields.unknowns).toEqual([unknown]);
      expect(view.implementationNotes).toContain("Exported with a header row.");
      expect(view.finalSummary).toBe("CSV export done.");
      // The base keeps the story as it was: the edit is on the branch alone.
      expect((await w.store.view(w.checkout, "TASK-1")).status).toBe("Ready");

      const again = await w.git.run((session) =>
        w.store.editOnBranch(w.git, session, target, "TASK-1: status In Review", (story) =>
          story.setStatus("In Review"),
        ),
      );
      expect(again.commit).toBeNull();
    });

    test("holds a story from pickup on a failed backlog PR check, and on a journaled change first", async (w) => {
      expect(w.store.planningHold(w.office, KEY)).toBeNull();
      w.block(KEY);
      expect(w.store.planningHold(w.office, KEY)).toBe("checkFailed");
      expect(w.store.planningHold(w.office, OTHER)).toBeNull();
      w.journal(KEY);
      expect(w.store.planningHold(w.office, KEY)).toBe("pending");
      w.journal(OTHER);
      expect(w.store.planningHold(w.office, OTHER)).toBe("pending");
    });

    test("names the park a journaled change writes, the newest first, and none without one", async (w) => {
      const park: PlannedPark = {
        reason: "by-maintainer",
        from: "Ready",
        note: "Waits on design.",
      };
      expect(w.store.plannedPark(w.office, KEY)).toBeUndefined();
      w.plan(KEY, park);
      expect(w.store.plannedPark(w.office, KEY)).toEqual(park);
      expect(w.store.plannedPark(w.office, OTHER)).toBeUndefined();
      w.plan(KEY, null);
      expect(w.store.plannedPark(w.office, KEY)).toBeNull();
    });
  });
}
