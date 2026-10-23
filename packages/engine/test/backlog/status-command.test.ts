// A status change never runs a command a Backlog file defines (DIPO-312, 0021 section 14): before
// `task edit <id> --status` (or `draft edit`), in whatever folder the call runs, the runner reads
// every place Backlog.md 1.53 takes its configuration from and every task file it loads a task
// from, and refuses the call before spawning when one defines a command for the CLI to run, or
// cannot be checked. The refusal raises an `engine.notice` naming the story and the file. The last
// test runs the pinned CLI on the real path: it does run such a command, and dipo's call does not.

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { withTempDir, withTempRepo } from "@dipsaus-orchestrator/testkit";

import { editKind, EDIT_KIND } from "../../src/backlog/lane/ops";
import {
  type BacklogNotice,
  BacklogRefusedError,
  BacklogStatusCommandError,
  configStatusCommand,
  runBacklog,
  BACKLOG_CHECK_MAX,
  BacklogFileRefusedError,
  STATUS_COMMAND_NOTICE,
  statusChangeOf,
  statusCommandFiles,
  taskStatusCommand,
} from "../../src/backlog/runner";
import { systemSpawn } from "../../src/platform/process";
import { BACKLOG_CLI, BACKLOG_FIXTURE, scriptedSpawn, stubSpawn, viewOutput } from "./helpers";

const TASK = "backlog/tasks/task-1 - Story.md";
const CLEAN_TASK = "---\nid: TASK-1\ntitle: Story\nstatus: Ready\nlabels: []\n---\n\nBody.\n";
const CONFIG = 'project_name: "x"\nstatuses: ["Refined", "Ready", "Done"]\n';

function write(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

/** Runs a status change in `dir` with a stub CLI; returns the error, the spawns and the notices. */
async function statusChange(dir: string, args = ["task", "edit", "TASK-1", "--status", "Done"]) {
  const stub = stubSpawn("");
  const notices: BacklogNotice[] = [];
  const cli = { spawn: stub.spawn, notify: (notice: BacklogNotice) => notices.push(notice) };
  const error = await runBacklog(cli, dir, args).then(
    () => null,
    (failure: unknown) => failure,
  );
  return { error, spawned: stub.calls.length, notices };
}

describe("the calls that change a status", () => {
  it("are task and draft edits with -s or --status, in every option form", () => {
    for (const args of [
      ["task", "edit", "TASK-1", "-s", "Done"],
      ["task", "edit", "TASK-1", "--status", "Done"],
      ["task", "edit", "TASK-1", "--status=Done"],
      ["task", "edit", "TASK-1", "-sDone"],
      ["task", "edit", "TASK-1", "--notes", "x", "-s", "In Review"],
      ["draft", "edit", "DRAFT-1", "--status", "Ready"],
    ]) {
      expect([args, statusChangeOf(args)]).toEqual([args, args[2] ?? null]);
    }
    expect(statusChangeOf(["task", "edit", "--status", "Done"])).toBe("");
  });

  it("are not reads, creates or edits of other fields", () => {
    for (const args of [
      ["task", "view", "TASK-1", "--plain"],
      ["task", "list", "-s", "Ready", "--plain"],
      ["task", "create", "New", "-s", "Ready"],
      ["task", "edit", "TASK-1", "--notes", "-s is no option here"],
      ["task", "edit", "TASK-1", "--add-label", "tier:S"],
      ["task", "archive", "TASK-1"],
    ]) {
      expect([args, statusChangeOf(args)]).toEqual([args, null]);
    }
  });
});

describe("the Backlog configuration", () => {
  for (const [what, text] of [
    ["onStatusChange", `${CONFIG}onStatusChange: 'touch /tmp/x'\n`],
    ["on_status_change", `${CONFIG}on_status_change: "touch /tmp/x"\n`],
    ["an indented key", `${CONFIG}  onStatusChange: touch /tmp/x\n`],
    ["a quoted key", `${CONFIG}"onStatusChange": touch /tmp/x\n`],
    ["another case", `${CONFIG}ONSTATUSCHANGE: touch /tmp/x\n`],
    ["full-width letters", `${CONFIG}${"ｏｎＳｔａｔｕｓＣｈａｎｇｅ"}: touch /tmp/x\n`],
  ] as const) {
    it(`stops a status change on ${what}`, () => {
      expect(configStatusCommand(text)).toBe(
        "defines a command for the Backlog CLI to run on a status change",
      );
    });
  }

  it("lets an ordinary configuration through", () => {
    expect(configStatusCommand(CONFIG)).toBeNull();
    const fixture = readFileSync(join(BACKLOG_FIXTURE, "backlog", "config.yml"), "utf8");
    expect(configStatusCommand(fixture)).toBeNull();
  });

  for (const place of [
    "backlog/config.yml",
    "backlog/config.yaml",
    ".backlog/config.yml",
    ".backlog/config.yaml",
    "backlog.config.yml",
  ]) {
    it(`is read at ${place}: the call is refused before spawning, with a notice`, () =>
      withTempDir(async (dir) => {
        write(dir, {
          [TASK]: CLEAN_TASK,
          "backlog/config.yml": CONFIG,
          [place]: `${CONFIG}onStatusChange: touch marker\n`,
        });
        const { error, spawned, notices } = await statusChange(dir);
        expect(error).toBeInstanceOf(BacklogStatusCommandError);
        expect(error).toBeInstanceOf(BacklogRefusedError);
        expect(spawned).toBe(0);
        const refused = error as BacklogStatusCommandError;
        expect(refused.story).toBe("TASK-1");
        expect(refused.files).toEqual([
          {
            path: place,
            reason: "defines a command for the Backlog CLI to run on a status change",
          },
        ]);
        expect(notices).toEqual([
          {
            level: "error",
            code: STATUS_COMMAND_NOTICE,
            text: `dipo refused to change the status of TASK-1 with the Backlog CLI: ${place} defines a command for the Backlog CLI to run on a status change. dipo runs no command a Backlog file defines; nothing was changed`,
          },
        ]);
      }));
  }

  it("is read in the folder backlog.config.yml names, with its task files", () =>
    withTempDir(async (dir) => {
      write(dir, {
        "backlog.config.yml": 'project_name: "x"\nbacklog_directory: "planning/board"\n',
        "planning/board/config.yml": `${CONFIG}on_status_change: touch marker\n`,
        "planning/board/tasks/task-2 - Other.md": "---\nid: TASK-2\nonStatusChange: x\n---\n",
      });
      const { error, spawned } = await statusChange(dir);
      expect(spawned).toBe(0);
      expect((error as BacklogStatusCommandError).files.map((file) => file.path)).toEqual([
        "planning/board/config.yml",
        "planning/board/tasks/task-2 - Other.md",
      ]);
    }));

  it("follows a link as the CLI does", () =>
    withTempDir(async (dir) => {
      write(dir, {
        "elsewhere.yml": `${CONFIG}onStatusChange: touch marker\n`,
        [TASK]: CLEAN_TASK,
      });
      symlinkSync(join(dir, "elsewhere.yml"), join(dir, "backlog", "config.yml"));
      const { error, spawned } = await statusChange(dir);
      expect(spawned).toBe(0);
      expect((error as BacklogStatusCommandError).files[0]?.path).toBe("backlog/config.yml");
    }));

  it("refuses a file too large to check whole", () =>
    withTempDir(async (dir) => {
      write(dir, {
        "backlog/config.yml": `${CONFIG}#${"x".repeat(BACKLOG_CHECK_MAX)}\n`,
        [TASK]: CLEAN_TASK,
      });
      const { error, spawned } = await statusChange(dir);
      expect(spawned).toBe(0);
      expect(error).toBeInstanceOf(BacklogFileRefusedError);
      expect((error as BacklogFileRefusedError).files).toEqual([
        { path: "backlog/config.yml", reason: "is too large for dipo to check" },
      ]);
    }));
});

describe("the task files", () => {
  for (const [what, text] of [
    ["onStatusChange", "---\nid: TASK-1\nstatus: Ready\nonStatusChange: touch marker\n---\n"],
    ["a quoted key", '---\nid: TASK-1\n"onStatusChange": touch marker\n---\n'],
    ["an escaped key", '---\nid: TASK-1\n"on\\x53tatusChange": touch marker\n---\n'],
    ["a merge key", '---\nid: TASK-1\n<<: {"on\\u0053tatusChange": touch marker}\n---\n'],
    ["a byte order mark", "\ufeff---\nid: TASK-1\nonStatusChange: touch marker\n---\n"],
    ["carriage returns", "---\r\nid: TASK-1\r\nonStatusChange: touch marker\r\n---\r\n"],
  ] as const) {
    it(`stop a status change on ${what} in the front matter`, () => {
      expect(taskStatusCommand(text)).toBe(
        "defines a command for the Backlog CLI to run on a status change",
      );
    });
  }

  it("stop a status change on a front matter block in another language", () => {
    for (const text of ["---js\n{ id: 'TASK-1' }\n---\n", "---javascript\n({})\n---\n"]) {
      expect(taskStatusCommand(text)).toContain("is not plain YAML");
    }
  });

  it("stop a status change on front matter dipo cannot parse", () => {
    expect(taskStatusCommand("---\nid: [TASK-1\n---\n")).toContain("does not parse");
  });

  it("let a task file through that names the key only in its body, or has no front matter", () => {
    expect(taskStatusCommand(`${CLEAN_TASK}\nNever set onStatusChange here.\n`)).toBeNull();
    expect(taskStatusCommand("# Notes\n\nonStatusChange: x\n")).toBeNull();
    expect(taskStatusCommand("")).toBeNull();
    for (const name of [
      "task-1 - Add-the-CSV-export-command.md",
      "task-2 - Rename-the-export-setting.md",
    ]) {
      const text = readFileSync(join(BACKLOG_FIXTURE, "backlog", "tasks", name), "utf8");
      expect([name, taskStatusCommand(text)]).toEqual([name, null]);
    }
  });

  for (const path of [
    TASK,
    "backlog/tasks/task-7 - Another-story.md",
    "backlog/completed/task-3 - Done-story.md",
    ".backlog/tasks/task-1 - Story.md",
  ]) {
    it(`are read at ${path}: any task file the CLI may load stops the call`, () =>
      withTempDir(async (dir) => {
        write(dir, {
          "backlog/config.yml": CONFIG,
          [TASK]: CLEAN_TASK,
          [path]: "---\nid: TASK-1\nonStatusChange: touch marker\n---\n",
        });
        const { error, spawned, notices } = await statusChange(dir);
        expect(spawned).toBe(0);
        expect((error as BacklogStatusCommandError).files.map((file) => file.path)).toEqual([path]);
        expect(notices[0]?.text).toContain("the status of TASK-1");
        expect(notices[0]?.text).toContain(path);
      }));
  }

  it("refuses a draft's status change the same way", () =>
    withTempDir(async (dir) => {
      write(dir, { "backlog/config.yml": `${CONFIG}onStatusChange: x\n` });
      const { error, spawned } = await statusChange(dir, [
        "draft",
        "edit",
        "DRAFT-1",
        "--status",
        "Ready",
      ]);
      expect(spawned).toBe(0);
      expect((error as BacklogStatusCommandError).story).toBe("DRAFT-1");
    }));
});

describe("a call the check lets through", () => {
  it("spawns a status change in a folder whose Backlog files define no command", () =>
    withTempDir(async (dir) => {
      write(dir, { "backlog/config.yml": CONFIG, [TASK]: CLEAN_TASK });
      expect(statusCommandFiles(dir)).toEqual([]);
      const { error, spawned, notices } = await statusChange(dir);
      expect([error, spawned, notices]).toEqual([null, 1, []]);
    }));

  it("spawns an edit that changes no status, whatever the folder holds", () =>
    withTempDir(async (dir) => {
      write(dir, { "backlog/config.yml": `${CONFIG}onStatusChange: x\n` });
      const { error, spawned } = await statusChange(dir, [
        "task",
        "edit",
        "TASK-1",
        "--notes",
        "Progress.",
      ]);
      expect([error, spawned]).toEqual([null, 1]);
    }));
});

describe("the backlog lane", () => {
  it("drops an edit whose status change is refused, with the reason, and does not throw", () =>
    withTempDir(async (dir) => {
      write(dir, { "backlog/config.yml": `${CONFIG}onStatusChange: x\n`, [TASK]: CLEAN_TASK });
      const notices: BacklogNotice[] = [];
      const stub = scriptedSpawn((args) =>
        args[1] === "view" ? { stdout: viewOutput("TASK-1", "Outcome: x.") } : {},
      );
      const outcome = await editKind(EDIT_KIND).apply(
        {
          cli: { spawn: stub.spawn, notify: (notice) => notices.push(notice) },
          cwd: dir,
          story: "TASK-1",
          entry: {} as never,
        },
        { status: "Done" },
      );
      expect(outcome).toEqual({
        applies: false,
        reason:
          "dipo refused to change the status of TASK-1 with the Backlog CLI: backlog/config.yml defines a command for the Backlog CLI to run on a status change. dipo runs no command a Backlog file defines; nothing was changed",
      });
      // Only the view ran; the edit never spawned.
      expect(stub.calls.map((call) => call.cmd.slice(1, 3))).toEqual([["task", "view"]]);
      expect(notices.map((notice) => notice.code)).toEqual([STATUS_COMMAND_NOTICE]);
    }));
});

// The real path, fail closed: the pinned Backlog.md CLI runs the configured command on a status
// change (so the barrier is real), and the same change through dipo's runner spawns nothing.
describe("the pinned Backlog.md CLI", () => {
  it("runs a configured status command itself, and never through dipo's runner", () =>
    withTempRepo(
      async (repo) => {
        const marker = join(repo.dir, "MARKER");
        const config = join(repo.dir, "backlog", "config.yml");
        writeFileSync(config, `${readFileSync(config, "utf8")}onStatusChange: 'touch MARKER'\n`);
        await repo.commitAll("fixture");
        const cli = { spawn: systemSpawn, command: BACKLOG_CLI, env: repo.env };

        const error = await caught(
          runBacklog(cli, repo.dir, ["task", "edit", "TASK-1", "--status", "Done"]),
        );
        expect(error).toBeInstanceOf(BacklogStatusCommandError);
        expect(existsSync(marker)).toBe(false);
        const view = await runBacklog(cli, repo.dir, ["task", "view", "TASK-1", "--plain"]);
        expect(view.stdout).toContain("Status: ○ Ready");

        // Without dipo's runner, the same CLI call runs the command.
        const direct = Bun.spawnSync(
          [...BACKLOG_CLI, "task", "edit", "TASK-1", "--status", "Done"],
          {
            cwd: repo.dir,
            env: { PATH: repo.env["PATH"] ?? "", HOME: repo.env["HOME"] ?? "" },
          },
        );
        expect(direct.exitCode).toBe(0);
        expect(existsSync(marker)).toBe(true);
      },
      { fixture: BACKLOG_FIXTURE },
    ));
});
