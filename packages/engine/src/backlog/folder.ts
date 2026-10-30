// Where Backlog.md keeps a repository's stories (0010), the StoryStore's `storyFolders` and
// `isProject`: the one place the engine learns the folders' names. dipo keeps the project in
// `backlog/` (its story lane reads and writes `backlog/tasks`, `TASKS_DIR`). Backlog.md 1.53 also
// keeps a project in `.backlog/`, and a root `backlog.config.yml` may name another folder it then
// reads its stories from: those folders are the store's too, the same ones the runner checks
// before every CLI call (`scanBacklogFiles`). A root configuration whose folder does not resolve
// (empty, absolute, `.`, or out of the repository) refuses, as the runner refuses every Backlog CLI
// call there: a guard that asks refuses with it.

import type { RepoFileRead } from "../story-store/folder";

import { BACKLOG_FOLDER, ROOT_CONFIG, storyFoldersOf } from "./runner";

export { BacklogFolderError } from "./runner";

/** The project configuration that makes a repository a Backlog.md project (0006). */
export const PROJECT_CONFIG = `${BACKLOG_FOLDER}/config.yml`;

/** The folders Backlog.md keeps the stories of the repository `read` reads in (`storyFoldersOf`). */
export async function backlogStoryFolders(read: RepoFileRead): Promise<readonly string[]> {
  return storyFoldersOf(await read(ROOT_CONFIG));
}

/** True when the repository `read` reads holds a Backlog.md project (`PROJECT_CONFIG`). */
export async function isBacklogProject(read: RepoFileRead): Promise<boolean> {
  await backlogStoryFolders(read);
  return (await read(PROJECT_CONFIG)) !== null;
}
