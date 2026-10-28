// The task file checks of the Backlog CLI calls dipo makes for a story (DIPO-270; 0021 section 14):
// the front matter a task file may hold and the path it may sit at. The CLI calls of the claim,
// In Review, park, unpark and lane paths on real git, each checked for a clean folder and a minimal
// environment, are in clean-folder.ci.test.ts (CI only, DIPO-225).

import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";

import type { Spawn } from "@dipsaus-orchestrator/contract";
import { git, withTempRepo } from "@dipsaus-orchestrator/testkit";

import {
  BACKLOG_FOLDER_ERROR,
  type BacklogCli,
  KNOWN_TASK_FIELDS,
  taskFieldRefusal,
  taskFilePathRefusal,
} from "../../src/backlog/runner";
import { GitError } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import { gitStoryOps } from "../../src/run/story-git";
import { claimStory, type ClaimOutcome } from "../../src/worktree";
import {
  BACKLOG_FIXTURE,
  BRANCH_1,
  byHandOn,
  claimSetup,
  publish,
  TASK_1,
  TASK_FILE_1,
} from "../worktree/helpers";

import { BACKLOG_CLI } from "./helpers";

// Each test drives the pinned Backlog CLI and real git several times; the GitHub macOS runner needs
// more than the default 5 s (DIPO-316).
setDefaultTimeout(30_000);

const FIXTURE = { fixture: BACKLOG_FIXTURE };

/** A variable of the caller's environment that must not reach the CLI. */
const CALLER_ONLY = "DIPO_CALLER_ONLY";

interface CliCall {
  readonly args: readonly string[];
  /** The real path of the working folder. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>> | undefined;
  /** Every file under `cwd` when the call started, relative to it. */
  readonly files: readonly string[];
  /** The Backlog configuration in `cwd` when the call started, or null without one. */
  readonly config: string | null;
}

function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory() ? filesUnder(dir, path) : [path];
  });
}

/** The CLI on the fixture, recording each call, with a caller environment holding more keys. */
function recordingCli(env: Readonly<Record<string, string>>): {
  cli: BacklogCli;
  calls: CliCall[];
} {
  const calls: CliCall[] = [];
  const spawn: Spawn = (options) => {
    calls.push({
      args: options.cmd.slice(BACKLOG_CLI.length),
      cwd: realpathSync(options.cwd ?? ""),
      env: options.env,
      files: filesUnder(options.cwd ?? "").toSorted(),
      config: existsSync(join(options.cwd ?? "", "backlog", "config.yml"))
        ? readFileSync(join(options.cwd ?? "", "backlog", "config.yml"), "utf8")
        : null,
    });
    return systemSpawn(options);
  };
  return { cli: { spawn, command: BACKLOG_CLI, env: { ...env, [CALLER_ONLY]: "1" } }, calls };
}

function claimed(outcome: ClaimOutcome): Extract<ClaimOutcome, { ok: true }> {
  if (!outcome.ok)
    throw new Error(`expected a claim, got the skip ${outcome.reason}: ${outcome.notice}`);
  return outcome;
}

/** The repository's own task files, written by the Backlog CLI: the real shape. */
const REPO_TASKS = join(import.meta.dir, "..", "..", "..", "..", "backlog", "tasks");

/** A task file holding `front` as its front matter block. */
function taskText(front: string): string {
  return `---\n${front}\n---\n\n## Description\n\nText.\n`;
}

describe("the task file check", () => {
  it("lets every task file the Backlog CLI wrote in this repository and the fixture through", () => {
    const files = readdirSync(REPO_TASKS).filter((name) => name.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      expect([name, taskFieldRefusal(readFileSync(join(REPO_TASKS, name), "utf8"))]).toEqual([
        name,
        null,
      ]);
    }
    for (const name of readdirSync(join(BACKLOG_FIXTURE, "backlog", "tasks"))) {
      const text = readFileSync(join(BACKLOG_FIXTURE, "backlog", "tasks", name), "utf8");
      expect(taskFieldRefusal(text)).toBeNull();
    }
    const every = [...KNOWN_TASK_FIELDS].map((name) => `${name}: x`).join("\n");
    expect(taskFieldRefusal(taskText(every))).toBeNull();
    expect(
      taskFieldRefusal(
        taskText("id: TASK-1\nlabels:\n  - a\n  - 'b:c'\ntitle: >-\n  Long\n  title"),
      ),
    ).toBeNull();
  });

  const refused: readonly (readonly [string, string])[] = [
    ["an unknown field", taskText("id: TASK-1\nunknown_field: 1")],
    ["a quoted unknown key", taskText('id: TASK-1\n"unknown_field": 1')],
    ["a quoted known key", taskText('"id": TASK-1')],
    ["an indented root", taskText("  id: TASK-1\n  unknown_field: 1")],
    ["an indented line before any field", taskText("\n  unknown_field: 1\nid: TASK-1")],
    ["a lone carriage return", taskText("id: TASK-1\rtitle: x\nstatus: Ready")],
    ["a carriage return in a known line", taskText("title: x\runknown_field: 1\nid: TASK-1")],
    ["CRLF line ends", "---\r\nid: TASK-1\r\n---\r\n"],
    ["a byte order mark", `${String.fromCharCode(0xfeff)}${taskText("id: TASK-1")}`],
    ["a control character", taskText("id: TASK-1\ntitle: a\u0001b")],
    ["a line separator", taskText(`id: TASK-1${String.fromCharCode(0x2028)}unknown_field: 1`)],
    ["a paragraph separator", taskText(`id: TASK-1${String.fromCharCode(0x2029)}unknown_field: 1`)],
    ["an anchor", taskText("id: &a TASK-1\ntitle: x")],
    ["an alias", taskText("id: TASK-1\nlabels:\n  - &a x\n  - *a")],
    ["a tag", taskText("id: !!str TASK-1")],
    ["a flow mapping", taskText("id: TASK-1\nlabels: {unknown_field: 1}")],
    ["a duplicate key", taskText("id: TASK-1\nid: TASK-2")],
    ["a merge key", taskText("id: TASK-1\n<<: {unknown_field: 1}")],
    ["a complex key", taskText("id: TASK-1\n? unknown_field\n: 1")],
    ["a second document", taskText("id: TASK-1\n...\nunknown_field: 1")],
    ["a directive", taskText("%YAML 1.2\nid: TASK-1")],
    ["a tab indent", taskText("id: TASK-1\nlabels:\n\t- a")],
    ["a key without a space", taskText("id:TASK-1")],
    ["no front matter", "id: TASK-1\n"],
    ["an unclosed block", "---\nid: TASK-1\n"],
    ["a block closed on another line", "---\nid: TASK-1\n----\n"],
    ["an empty block", "---\n\n---\n"],
  ];
  for (const [what, text] of refused) {
    it(`refuses ${what}`, () => {
      expect(taskFieldRefusal(text)).not.toBeNull();
    });
  }

  it("leaves the body after the block to the CLI", () => {
    expect(taskFieldRefusal(`${taskText("id: TASK-1")}unknown_field: 1\n---\nx: 1\n`)).toBeNull();
  });
});

describe("the task file path check", () => {
  it("accepts only a plain file directly in backlog/tasks", () => {
    expect(taskFilePathRefusal("backlog/tasks/task-1 - A story.md")).toBeNull();
    for (const path of [
      "backlog/tasks/sub/task-1 - A story.md",
      "backlog/task-1 - A story.md",
      "backlog/tasks/../tasks/task-1 - A story.md",
      "backlog/./tasks/task-1 - A story.md",
      "backlog/tasks/.",
      "backlog/tasks/..",
      "backlog/tasks/",
      "other/tasks/task-1 - A story.md",
      "backlog/tasks/task-1 - A\\story.md",
      "backlog/tasks/task-1 - A\nstory.md",
    ]) {
      expect([path, taskFilePathRefusal(path)]).not.toEqual([path, null]);
    }
  });

  it("refuses a story whose task file is committed below backlog/tasks", async () => {
    await withTempRepo(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const { cli, calls } = recordingCli(repo.env);
      claimed(await claimStory(s.deps({ cli }), s.request(s.key())));
      await byHandOn(repo, BRANCH_1, async (dir) => {
        mkdirSync(join(dir, "backlog", "tasks", "nested"));
        await git(
          dir,
          repo.home,
          "mv",
          TASK_FILE_1,
          `backlog/tasks/nested/${basename(TASK_FILE_1)}`,
        );
        await git(dir, repo.home, "commit", "--quiet", "-m", "move the task file");
      });

      calls.length = 0;
      const error = await gitStoryOps({ git: () => s.git, cli })
        .story(s.office.officeId, BRANCH_1, TASK_1)
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(GitError);
      expect((error as GitError).code).toBe(BACKLOG_FOLDER_ERROR);
      expect(calls).toEqual([]);
    }, FIXTURE);
  });
});
