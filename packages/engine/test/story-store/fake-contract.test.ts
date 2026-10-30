// The StoryStore contract (`contract.ts`, DIPO-356) on the in-memory fake the engine tests use in
// place of Backlog.md, holding the same stories as the Backlog fixture.

import type { OfficeHandle } from "../../src/db/office";
import type { OfficeGit } from "../../src/git/office";
import { CONTRACT_DRAFT, CONTRACT_TASKS, storyStoreContract } from "./contract";
import { fakeStory, FakeStoryStore } from "./fake";

/** The fixture's file name of a story. */
const fileOf = (folder: string, id: string, title: string): string =>
  `backlog/${folder}/${id.toLowerCase()} - ${title.replaceAll(" ", "-")}.md`;

storyStoreContract("the in-memory fake", async (fn) => {
  const store = new FakeStoryStore();
  for (const task of CONTRACT_TASKS) {
    store.put(
      fakeStory(task.id, {
        title: task.title,
        status: task.status,
        file: fileOf("tasks", task.id, task.title),
        acceptanceCriteria: [
          { index: 1, checked: false, text: "The export command writes one CSV row per story" },
          { index: 2, checked: false, text: "A header row names every column" },
        ],
      }),
    );
  }
  const { id, title } = CONTRACT_DRAFT;
  store.put(fakeStory(id, { title, status: "Draft", file: fileOf("drafts", id, title) }), "draft");
  await fn({
    store,
    checkout: "/base",
    // The fake reads no git and no state database: a queue item runs at once.
    git: {
      run: <T>(item: (session: never) => Promise<T>) => item({} as never),
    } as unknown as OfficeGit,
    head: "head",
    branch: "TASK-1/contract",
    office: {} as OfficeHandle,
    fileText: (story) =>
      `---\nid: ${story}\nstatus: ${store.base.get(story)?.story?.status}\n---\n`,
    journal: (key) => store.pending.add(key),
    block: (key) => store.checkFailed.add(key),
    plan: (key, park) => store.planned.set(key, park),
  });
});
