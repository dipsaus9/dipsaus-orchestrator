// The Backlog.md StoryStore for the tests that only ask it about the task-file layout (the story's
// file at a commit, the status a task file holds, the folder a configuration names): those reads
// run git or nothing, never the Backlog CLI.

import { backlogStoryStore } from "../../src/backlog/store";
import { systemSpawn } from "../../src/platform/process";

export const backlogLayout = backlogStoryStore({ spawn: systemSpawn });
