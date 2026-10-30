// The Backlog.md StoryStore (0010): every story read and write the engine makes, through the
// Backlog CLI. Reads of a checkout run the CLI there (`read.ts`, `list.ts`); reads and edits on a
// story's branch run it in dipo's own copy of the story's backlog and commit the task file alone
// on the branch (`story-copy.ts`, `branch-read.ts`, the story lane). Every edit goes through the
// single field write path and reads back what it wrote (`fields/`).

import type { FieldBlock } from "@dipsaus-orchestrator/contract";

import type { GitSession, OfficeGit } from "../git/office";
import type { PlanningHold } from "../story-store/planning";
import type { StoryEditor, StoryStore } from "../story-store/store";

import { readOnBranch } from "./branch-read";
import { appendImplementationNotes, setFinalSummary } from "./fields/summary";
import { journaledPark, pendingLaneOp } from "./lane/journal";
import { backlogCheckBlocked } from "./pr/records";
import { type StoryTarget, viewStory, writeFields } from "./fields/write";
import { listAll } from "./list";
import { parseMilestones } from "./plain";
import { readBacklog, readStory, viewPass } from "./read";
import {
  type BacklogCli,
  BacklogCommandError,
  backlogPointer,
  isTaskFileOf,
  runBacklog,
  TASKS_DIR,
} from "./runner";
import { editInStoryBacklog, inStoryBacklog, repoPath } from "./story-copy";
import { taskFileAt, taskFileStatus } from "./task-file";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when a view failed because Backlog.md 1.53.x has no such story: a stderr line
 * `Task <ID> not found.` (exit 1) or `Draft <ID> not found.` (exit 0), naming this very id. Any
 * other failure, such as a shell's `command not found`, is not.
 */
export function isStoryNotFound(error: unknown, story: string): boolean {
  if (!(error instanceof BacklogCommandError)) return false;
  const line = new RegExp(`^(Task|Draft) ${escapeRegExp(story)} not found\\.`, "i");
  return error.stderr.split("\n").some((text) => line.test(text));
}

/** The edits of the task `target` in the folder the CLI runs in, with the task file `file`. */
function editorOf(target: StoryTarget, file: string): StoryEditor {
  return {
    id: target.id,
    file,
    view: () => viewStory(target),
    async setStatus(status, check = []) {
      await runBacklog(target.cli, target.cwd, [
        "task",
        "edit",
        target.id,
        ...check.flatMap((n) => ["--check-ac", String(n)]),
        "--status",
        status,
      ]);
    },
    writeFields: (change: (fields: FieldBlock) => FieldBlock) => writeFields(target, change),
    appendNotes: (text) => appendImplementationNotes(target, text),
    setFinalSummary: (text) => setFinalSummary(target, text),
    async recordModifiedFiles(paths) {
      if (paths.length === 0) return;
      await runBacklog(target.cli, target.cwd, [
        "task",
        "edit",
        target.id,
        ...paths.flatMap((path) => ["--modified-file", path]),
      ]);
    },
  };
}

/** The StoryStore on Backlog.md, with the CLI `cli`. */
export function backlogStoryStore(cli: BacklogCli): StoryStore {
  return {
    list: (checkout, kind) => listAll(cli, checkout, kind),
    view: (checkout, id, kind = "task") => viewStory({ cli, cwd: checkout, id, kind }),
    async readAll(checkout, reuse) {
      const pass = reuse === undefined ? undefined : await viewPass(checkout, reuse);
      return readBacklog(cli, checkout, pass);
    },
    read: (checkout, kind, listed) => readStory(cli, checkout, kind, listed),
    async milestones(checkout) {
      const listed = await runBacklog(cli, checkout, [
        "milestone",
        "list",
        "--show-completed",
        "--plain",
      ]);
      return parseMilestones(listed.stdout);
    },
    isNotFound: isStoryNotFound,
    readOnBranch: (git, session, target, checkout, listed) =>
      readOnBranch(git, session, cli, target, checkout, listed),
    viewOnBranch: (git: OfficeGit, session: GitSession, target) =>
      inStoryBacklog(git, session, target, async (backlog) => {
        const view = await viewStory({ cli, cwd: backlog.cwd, id: target.story });
        return { view, file: repoPath(backlog.cwd, view.file) };
      }),
    editOnBranch: (git, session, target, message, fn) =>
      editInStoryBacklog(git, session, target, message, (backlog) =>
        fn(editorOf({ cli, cwd: backlog.cwd, id: target.story }, backlog.taskFile)),
      ),
    isStoryFile(path, id) {
      if (!path.startsWith(`${TASKS_DIR}/`)) return false;
      const name = path.slice(TASKS_DIR.length + 1);
      return !name.includes("/") && isTaskFileOf(name, id);
    },
    fileAt: taskFileAt,
    statusIn: taskFileStatus,
    configuredFolder(text) {
      const pointer = backlogPointer(text);
      return pointer.kind === "folder" ? pointer.folder : null;
    },
    planningHold(office, key): PlanningHold | null {
      if (pendingLaneOp(office, key) !== null) return "pending";
      return backlogCheckBlocked(office, key) === null ? null : "checkFailed";
    },
    plannedPark: journaledPark,
  };
}
