// Where Backlog.md keeps a repository's stories (0010), the StoryStore's `storyFolders` and
// `isProject`: the one place the engine learns the folders' names. dipo keeps the project in
// `backlog/` (its story lane reads and writes `backlog/tasks`, `TASKS_DIR`). Backlog.md 1.53 also
// keeps a project in `.backlog/`, and a root `backlog.config.yml` may name another folder it then
// reads its stories from: those folders are the store's too, the same ones the runner checks
// before every CLI call (`scanBacklogFiles`). A root configuration whose folder does not resolve
// (empty, absolute, `.`, or out of the repository) refuses, as the runner refuses every Backlog CLI
// call there: a guard that asks refuses with it.

import { StoryStoreError } from "../story-store/errors";
import type { RepoFileRead } from "../story-store/folder";

import { BACKLOG_FOLDER, backlogPointer } from "./runner";

/** The Backlog CLI's root configuration, read before the project folder's own. */
export const ROOT_CONFIG = "backlog.config.yml";

/** The other folder Backlog.md 1.53 keeps a project in. */
export const HIDDEN_FOLDER = ".backlog";

/** The project configuration that makes a repository a Backlog.md project (0006). */
export const PROJECT_CONFIG = `${BACKLOG_FOLDER}/config.yml`;

/** The repository's root configuration names a folder dipo cannot resolve. */
export class BacklogFolderError extends StoryStoreError {
  constructor(readonly folder: string) {
    super(
      `${ROOT_CONFIG} names a backlog folder dipo cannot resolve (${JSON.stringify(folder)}); it must be a folder inside the repository.`,
    );
    this.name = "BacklogFolderError";
  }
}

/** The folders Backlog.md keeps the stories of the repository `read` reads in. */
export async function backlogStoryFolders(read: RepoFileRead): Promise<readonly string[]> {
  const own = [BACKLOG_FOLDER, HIDDEN_FOLDER];
  const text = await read(ROOT_CONFIG);
  if (text === null) return own;
  const pointer = backlogPointer(text);
  if (pointer.kind === "unresolved") {
    const named = /^\s*(?:backlog_directory|backlogDirectory)\s*:(.*)$/m.exec(text)?.[1] ?? "";
    throw new BacklogFolderError(named.trim());
  }
  if (pointer.kind === "none" || own.includes(pointer.folder)) return own;
  return [...own, pointer.folder];
}

/** True when the repository `read` reads holds a Backlog.md project (`PROJECT_CONFIG`). */
export async function isBacklogProject(read: RepoFileRead): Promise<boolean> {
  await backlogStoryFolders(read);
  return (await read(PROJECT_CONFIG)) !== null;
}
