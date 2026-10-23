// dipo refuses a Backlog CLI call when a task file's front matter is not plain YAML (DIPO-312,
// 0021 section 14): before every call, whatever the subcommand, the runner checks every Markdown
// file in the backlog folders and every configuration file of the folder the call runs in. A front
// matter block that names a language or does not parse, a special file or one too large to check
// refuses the call before spawning, with an `engine.notice` the first time a file's verdict is
// found. Verdicts are kept per file by its identity and change times, so a pass over an unchanged
// backlog reads no file again. The last tests run the pinned CLI on the real path.

import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { tempRoot, withTempDir, withTempRepo } from "@dipsaus-orchestrator/testkit";

import {
  type BacklogNotice,
  BACKLOG_FILE_NOTICE,
  BacklogFileRefusedError,
  BacklogRefusedError,
  backlogPointer,
  frontMatterRefusal,
  hasProjectName,
  preparedFrontMatter,
  taskStatusCommand,
  runBacklog,
  scanBacklogFiles,
  VerdictCache,
} from "../../src/backlog/runner";
import { systemSpawn } from "../../src/platform/process";
import { BACKLOG_CLI, BACKLOG_FIXTURE, stubSpawn } from "./helpers";

const CONFIG = 'project_name: "x"\nstatuses: ["Refined", "Ready", "Done"]\n';
const CLEAN = "---\nid: TASK-1\ntitle: Story\nstatus: Ready\n---\n\nBody.\n";
const NOT_PLAIN =
  "opens a front matter block that is not plain YAML, which dipo does not let the Backlog CLI read";

/** Front matter blocks that are not plain YAML, in the forms the opening line can take. */
const NOT_PLAIN_FORMS: readonly (readonly [string, (body: string) => string])[] = [
  ["a language tag", (body) => `---js\n${body}\n---\n`],
  ["a tag in upper case", (body) => `---JS\n${body}\n---\n`],
  ["a tag in mixed case", (body) => `---JavaScript\n${body}\n---\n`],
  ["a tag after a space", (body) => `--- js\n${body}\n---\n`],
  ["a tag after a tab, with trailing space", (body) => `---\tjs  \n${body}\n---\n`],
  ["a byte order mark", (body) => `\ufeff---js\n${body}\n---\n`],
  ["two byte order marks", (body) => `\ufeff\ufeff---js\n${body}\n---\n`],
  ["carriage returns", (body) => `---js\r\n${body}\r\n---\r\n`],
  ["a YAML tag too", (body) => `---yaml\n${body}\n---\n`],
  ["a fourth dash", (body) => `----\n${body}\n---\n`],
];

function write(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/** One `notify` per list of notices, as the daemon has one for all its calls. */
const notifiers = new WeakMap<BacklogNotice[], (notice: BacklogNotice) => void>();

async function call(dir: string, args: readonly string[], notices: BacklogNotice[] = []) {
  const stub = stubSpawn("");
  let notify = notifiers.get(notices);
  if (notify === undefined) {
    notify = (notice: BacklogNotice) => notices.push(notice);
    notifiers.set(notices, notify);
  }
  const cli = { spawn: stub.spawn, notify };
  const error = await runBacklog(cli, dir, args).then(
    () => null,
    (failure: unknown) => failure,
  );
  return { error, spawned: stub.calls.length, notices };
}

describe("a front matter block dipo lets the Backlog CLI read", () => {
  for (const [what, form] of NOT_PLAIN_FORMS) {
    it(`is refused with ${what}`, () => {
      expect(frontMatterRefusal(form("{ id: 'TASK-1' }"))).toBe(NOT_PLAIN);
    });
  }

  it("is refused when it does not parse", () => {
    expect(frontMatterRefusal("---\nid: [TASK-1\n---\n")).toBe(
      "holds a front matter block that does not parse, so dipo cannot check it",
    );
  });

  it("is plain YAML, with line feeds or carriage returns, or there is none", () => {
    for (const text of [
      CLEAN,
      CLEAN.replaceAll("\n", "\r\n"),
      `\ufeff${CLEAN}`,
      "--- \nid: TASK-1\n---\n",
      "# A document\n\n---js\nnot front matter\n---\n",
      "",
    ]) {
      expect([text, frontMatterRefusal(text)]).toEqual([text, null]);
    }
    for (const name of [
      "task-1 - Add-the-CSV-export-command.md",
      "task-3 - Export-stories-as-JSON.md",
    ]) {
      const text = readFileSync(join(BACKLOG_FIXTURE, "backlog", "tasks", name), "utf8");
      expect([name, frontMatterRefusal(text)]).toEqual([name, null]);
    }
  });
});

describe("every Backlog CLI call", () => {
  const SUBCOMMANDS: readonly (readonly string[])[] = [
    ["task", "list", "--plain"],
    ["task", "view", "TASK-1", "--plain"],
    ["draft", "list", "--plain"],
    ["task", "create", "New story"],
    ["task", "edit", "TASK-1", "--notes", "Progress."],
    ["task", "edit", "TASK-1", "--status", "Done"],
    ["task", "archive", "TASK-1"],
    ["config", "get", "statuses"],
    ["milestone", "list", "--plain"],
    ["doctor"],
    ["--version"],
  ];

  for (const args of SUBCOMMANDS) {
    it(`is refused before spawning: \`backlog ${args.join(" ")}\``, () =>
      withTempDir(async (dir) => {
        write(dir, {
          "backlog/config.yml": CONFIG,
          "backlog/tasks/task-1 - Story.md": CLEAN,
          "backlog/tasks/task-2 - Other.md": "---js\n{ id: 'TASK-2' }\n---\n",
        });
        const { error, spawned } = await call(dir, args);
        expect(spawned).toBe(0);
        expect(error).toBeInstanceOf(BacklogFileRefusedError);
        expect(error).toBeInstanceOf(BacklogRefusedError);
        expect((error as BacklogFileRefusedError).files).toEqual([
          { path: "backlog/tasks/task-2 - Other.md", reason: NOT_PLAIN },
        ]);
      }));
  }

  for (const path of [
    "backlog/drafts/draft-1 - Sketch.md",
    "backlog/completed/task-3 - Done.md",
    "backlog/archive/tasks/task-4 - Old.md",
    "backlog/archive/drafts/draft-2 - Old.md",
    "backlog/docs/guides/doc-1 - Guide.md",
    "backlog/decisions/decision-1 - Choice.md",
    "backlog/milestones/m-0 - Start.md",
    ".backlog/tasks/task-5 - Hidden.md",
  ]) {
    it(`checks ${path}`, () =>
      withTempDir(async (dir) => {
        write(dir, { "backlog/config.yml": CONFIG, [path]: "---js\n{}\n---\n" });
        const { error, spawned } = await call(dir, ["task", "list", "--plain"]);
        expect(spawned).toBe(0);
        expect((error as BacklogFileRefusedError).files.map((file) => file.path)).toEqual([path]);
      }));
  }

  it("checks the backlog folder backlog.config.yml names", () =>
    withTempDir(async (dir) => {
      write(dir, {
        "backlog.config.yml": 'project_name: x\nbacklog_directory: "planning"\n',
        "planning/tasks/task-1 - Story.md": "--- JS\n{}\n---\n",
      });
      const { error } = await call(dir, ["task", "list", "--plain"]);
      expect((error as BacklogFileRefusedError).files.map((file) => file.path)).toEqual([
        "planning/tasks/task-1 - Story.md",
      ]);
    }));

  it("follows a linked folder once, and a link loop does not stop it", () =>
    withTempDir(async (dir) => {
      write(dir, {
        "backlog/config.yml": CONFIG,
        "elsewhere/notes.md": "---js\n{}\n---\n",
      });
      mkdirSync(join(dir, "backlog", "docs"), { recursive: true });
      symlinkSync(join(dir, "elsewhere"), join(dir, "backlog", "docs", "linked"));
      symlinkSync(join(dir, "backlog"), join(dir, "backlog", "docs", "loop"));
      const { error } = await call(dir, ["task", "list", "--plain"]);
      expect((error as BacklogFileRefusedError).files.map((file) => file.path)).toEqual([
        "backlog/docs/linked/notes.md",
      ]);
    }));

  it("refuses a special file where a Markdown file would be", () =>
    withTempDir(async (dir) => {
      write(dir, { "backlog/config.yml": CONFIG });
      mkdirSync(join(dir, "backlog", "tasks"));
      const made = Bun.spawnSync(["mkfifo", join(dir, "backlog", "tasks", "task-1 - Pipe.md")]);
      expect(made.exitCode).toBe(0);
      const { error, spawned } = await call(dir, ["task", "list", "--plain"]);
      expect(spawned).toBe(0);
      expect((error as BacklogFileRefusedError).files).toEqual([
        { path: "backlog/tasks/task-1 - Pipe.md", reason: "is not a plain file dipo can check" },
      ]);
    }));

  it("raises the notice once for an unchanged file, and again after it changed", () =>
    withTempDir(async (dir) => {
      write(dir, {
        "backlog/config.yml": CONFIG,
        "backlog/tasks/task-2 - Other.md": "---js\n{}\n---\n",
      });
      const notices: BacklogNotice[] = [];
      await call(dir, ["task", "list", "--plain"], notices);
      await call(dir, ["task", "view", "TASK-2", "--plain"], notices);
      expect(notices).toEqual([
        {
          level: "error",
          code: BACKLOG_FILE_NOTICE,
          text: `dipo refused a Backlog CLI call: backlog/tasks/task-2 - Other.md ${NOT_PLAIN}. dipo runs the Backlog CLI only on Backlog files whose front matter is plain YAML; nothing was run`,
        },
      ]);
      writeFileSync(join(dir, "backlog/tasks/task-2 - Other.md"), "---JS\n{ }\n---\n");
      await call(dir, ["task", "list", "--plain"], notices);
      expect(notices).toHaveLength(2);
    }));

  it("spawns in a folder whose Backlog files are all plain", () =>
    withTempDir(async (dir) => {
      write(dir, {
        "backlog/config.yml": CONFIG,
        "backlog/tasks/task-1 - Story.md": CLEAN,
        "backlog/docs/readme.md": "# No front matter\n",
        "backlog/tasks/notes.txt": "---js\nnot Markdown\n",
      });
      const { error, spawned, notices } = await call(dir, ["task", "list", "--plain"]);
      expect([error, spawned, notices]).toEqual([null, 1, []]);
    }));
});

describe("the verdict cache", () => {
  it("reads an unchanged backlog once: a second pass only stats each file", () =>
    withTempDir((dir) => {
      const files: Record<string, string> = { "backlog/config.yml": CONFIG };
      for (let i = 1; i <= 20; i++) files[`backlog/tasks/task-${i} - Story.md`] = CLEAN;
      write(dir, files);
      const cache = new VerdictCache();
      const first = scanBacklogFiles(dir, cache);
      expect([first.files, first.read, first.refused]).toEqual([21, 21, []]);
      const second = scanBacklogFiles(dir, cache);
      expect([second.files, second.read, second.fresh.size]).toEqual([21, 0, 0]);
    }));

  it("reads a file again after any write, even one that keeps its size and modification time", () =>
    withTempDir((dir) => {
      const path = join(dir, "backlog/tasks/task-1 - Story.md");
      const clean = "---\nid: TASK-1\n---\n";
      const tagged = "---js\n{ id: 1 }\n---\n".slice(0, clean.length).padEnd(clean.length, " ");
      write(dir, { "backlog/config.yml": CONFIG, "backlog/tasks/task-1 - Story.md": clean });
      const cache = new VerdictCache();
      expect(scanBacklogFiles(dir, cache).refused).toEqual([]);
      const before = statSync(path);
      writeFileSync(path, tagged);
      utimesSync(path, before.atime, before.mtime);
      expect(statSync(path).size).toBe(before.size);
      const after = scanBacklogFiles(dir, cache);
      expect(after.read).toBe(1);
      expect(after.refused.map((file) => file.reason)).toEqual([NOT_PLAIN]);
    }));

  it("drops the least recently used path past its limit", () => {
    const cache = new VerdictCache(2);
    const stat = statSync(import.meta.path);
    const verdict = { refusal: null, statusCommand: false, content: "c" };
    cache.set("/a", stat, verdict);
    cache.set("/b", stat, verdict);
    expect(cache.get("/a", stat)).toEqual(verdict);
    cache.set("/c", stat, verdict);
    expect(cache.size).toBe(2);
    expect(cache.get("/b", stat)).toBeUndefined();
    expect(cache.get("/a", stat)).toEqual(verdict);
    expect(cache.get("/c", stat)).toEqual(verdict);
  });
});

// The real path, fail closed: a checkout holding a task file whose front matter is not plain YAML
// gets no Backlog CLI read through dipo's runner, in each form of the opening line; the same
// checkout without it is read as before.
describe("the pinned Backlog.md CLI", () => {
  it("is never run on a checkout with front matter that is not plain YAML, and runs on a clean one", () =>
    withTempRepo(
      async (repo) => {
        await repo.commitAll("fixture");
        const cli = { spawn: systemSpawn, command: BACKLOG_CLI, env: repo.env };
        const task = join(repo.dir, "backlog", "tasks", "task-9 - Probe.md");
        const body = '{ id: "TASK-9", title: "Probe", status: "Ready" }';
        for (const [what, form] of [
          ...NOT_PLAIN_FORMS,
          ["two byte order marks", (inner: string) => `\ufeff\ufeff---js\n${inner}\n---\n`],
        ] as const) {
          writeFileSync(task, form(body));
          const error = await runBacklog(cli, repo.dir, ["task", "list", "--plain"]).then(
            () => null,
            (failure: unknown) => failure,
          );
          expect([what, error instanceof BacklogFileRefusedError]).toEqual([what, true]);
          expect([what, (error as BacklogFileRefusedError).files.map((file) => file.path)]).toEqual(
            [what, ["backlog/tasks/task-9 - Probe.md"]],
          );
        }
        rmSync(task);
        const listed = await runBacklog(cli, repo.dir, ["task", "list", "--plain"]);
        expect(listed.stdout).toContain("TASK-1 - Add the CSV export command");
        expect(listed.stdout).not.toContain("TASK-9");
      },
      { fixture: BACKLOG_FIXTURE },
    ));
});

describe("front matter written by hand (DIPO-312)", () => {
  it("is read as Backlog.md 1.53 reads it: unquoted due dates and people are quoted first", () => {
    for (const text of [
      "---\nid: TASK-1\nassignee: @dennis\n---\n",
      "---\nid: TASK-1\nassignee: [@dennis, 'b', @c]\n---\n",
      "---\nid: TASK-1\nreporter: @dennis # who asked\n---\n",
      "---\nid: TASK-1\ndue_date: 2026-10-23 10:00 # soon\n---\n",
      "---\nid: TASK-1\ndue_date: ~\n---\n",
    ]) {
      expect([text, frontMatterRefusal(text)]).toEqual([text, null]);
    }
    expect(preparedFrontMatter('assignee: @a "b"')).toBe('assignee: "@a \\"b\\""');
    expect(preparedFrontMatter("assignee:\n  - @a")).toBe("assignee:\n  - @a");
  });

  it("still refuses a block that does not parse after that", () => {
    expect(frontMatterRefusal("---\nid: TASK-1\nlabels: [a\n---\n")).toContain("does not parse");
  });
});

describe("the task folders, by their identity on disk (DIPO-312)", () => {
  const COMMAND = "---\nid: TASK-1\nonStatusChange: touch x\n---\n";

  it("counts a folder named in another case as the task folder when the volume does", () =>
    withTempDir((dir) => {
      write(dir, { "backlog/Tasks/task-1 - Story.md": COMMAND });
      const folded = existsSync(join(dir, "backlog", "tasks"));
      const scan = scanBacklogFiles(dir, new VerdictCache());
      // On a volume that folds case the CLI opens backlog/Tasks as backlog/tasks; elsewhere it
      // does not open it at all.
      expect(scan.statusCommands.length).toBe(folded ? 1 : 0);
    }));

  it("counts a link that sorts before tasks/ and points at it as the task folder", () =>
    withTempDir((dir) => {
      write(dir, { "backlog/tasks/task-1 - Story.md": COMMAND });
      symlinkSync(join(dir, "backlog", "tasks"), join(dir, "backlog", "a-link"));
      const scan = scanBacklogFiles(dir, new VerdictCache());
      expect(scan.statusCommands.map((hit) => hit.path)).toEqual([
        "backlog/tasks/task-1 - Story.md",
      ]);
    }));

  it("counts a link from a task folder to another folder as part of it", () =>
    withTempDir((dir) => {
      write(dir, {
        "elsewhere/task-2 - Other.md": COMMAND,
        "backlog/tasks/task-1 - Story.md": CLEAN,
      });
      symlinkSync(
        join(dir, "elsewhere", "task-2 - Other.md"),
        join(dir, "backlog", "tasks", "task-2 - Other.md"),
      );
      const scan = scanBacklogFiles(dir, new VerdictCache());
      expect(scan.statusCommands.map((hit) => hit.path)).toEqual([
        "backlog/tasks/task-2 - Other.md",
      ]);
    }));

  it("finds a status command behind two byte order marks", () => {
    expect(taskStatusCommand(`\ufeff\ufeff${COMMAND}`)).toBe(
      "defines a command for the Backlog CLI to run on a status change",
    );
  });
});

describe("the backlog folder backlog.config.yml names (DIPO-312)", () => {
  it("is read as 1.53 reads it: the last line wins, backslashes become slashes", () => {
    expect(backlogPointer('backlog_directory: "first"\nbacklog_directory: "second"\n')).toEqual({
      kind: "folder",
      folder: "second",
    });
    expect(backlogPointer("backlogDirectory: planning\\board\n")).toEqual({
      kind: "folder",
      folder: "planning/board",
    });
    expect(backlogPointer("project_name: x\n")).toEqual({ kind: "none" });
  });

  it("is unresolved when empty, absolute or outside the folder", () => {
    for (const value of [
      '""',
      "/srv/backlog",
      "C:\\backlog",
      "..",
      "../up",
      "a/../../up",
      "a\\..\\..\\up",
      ".",
    ]) {
      expect([value, backlogPointer(`backlog_directory: ${value}\n`)]).toEqual([
        value,
        { kind: "unresolved" },
      ]);
    }
  });

  it("checks the folder the last line names, with the backslash form", () =>
    withTempDir(async (dir) => {
      write(dir, {
        "backlog.config.yml":
          'project_name: x\nbacklog_directory: "first"\nbacklog_directory: "plan\\board"\n',
        "plan/board/tasks/task-1 - Story.md": "---js\n{}\n---\n",
      });
      const { error } = await call(dir, ["task", "list", "--plain"]);
      expect((error as BacklogFileRefusedError).files.map((file) => file.path)).toEqual([
        "plan/board/tasks/task-1 - Story.md",
      ]);
    }));

  it("refuses every call when it cannot be resolved", () =>
    withTempDir(async (dir) => {
      write(dir, { "backlog.config.yml": "project_name: x\nbacklog_directory: ../elsewhere\n" });
      const { error, spawned } = await call(dir, ["task", "list", "--plain"]);
      expect(spawned).toBe(0);
      expect((error as BacklogFileRefusedError).files).toEqual([
        {
          path: "backlog.config.yml",
          reason:
            "names a backlog folder dipo cannot resolve inside the repository, so dipo cannot check it",
        },
      ]);
    }));
});

describe("notices of refused calls (DIPO-312)", () => {
  it("are raised once per file and content, also across dipo's copies of a backlog", () =>
    withTempDir(async (root) => {
      const notices: BacklogNotice[] = [];
      const notify = (notice: BacklogNotice) => notices.push(notice);
      const stub = stubSpawn("");
      for (const copy of ["one", "two"]) {
        const dir = join(root, copy);
        write(dir, { "backlog/tasks/task-2 - Other.md": "---js\n{}\n---\n" });
        for (const args of [
          ["task", "list"],
          ["task", "view", "TASK-2"],
        ]) {
          await runBacklog({ spawn: stub.spawn, notify }, dir, args).catch(() => undefined);
        }
      }
      expect(notices.map((notice) => notice.code)).toEqual([BACKLOG_FILE_NOTICE]);
      expect(stub.calls).toEqual([]);
    }));

  it("of a status change are raised once per story, file and content", () =>
    withTempDir(async (root) => {
      const notices: BacklogNotice[] = [];
      const notify = (notice: BacklogNotice) => notices.push(notice);
      const stub = stubSpawn("");
      for (const copy of ["one", "two"]) {
        const dir = join(root, copy);
        write(dir, { "backlog/config.yml": `${CONFIG}onStatusChange: touch x\n` });
        for (const story of ["TASK-1", "TASK-1", "TASK-2"]) {
          await runBacklog({ spawn: stub.spawn, notify }, dir, [
            "task",
            "edit",
            story,
            "--status",
            "Done",
          ]).catch(() => undefined);
        }
      }
      expect(notices.map((notice) => notice.text.includes("TASK-2"))).toEqual([false, true]);
      expect(stub.calls).toEqual([]);
    }));
});

describe("a folder without a project configuration of its own (DIPO-312)", () => {
  it("is refused, so the CLI never looks for a project in a folder above it", () =>
    withTempDir(async (root) => {
      write(root, { "backlog/config.yml": CONFIG, "backlog/tasks/task-1 - Story.md": CLEAN });
      const inner = join(root, "packages", "inner");
      write(inner, { "backlog/tasks/task-1 - Story.md": CLEAN });
      const { error, spawned } = await call(inner, ["task", "list", "--plain"]);
      expect(spawned).toBe(0);
      expect(error).toBeInstanceOf(BacklogFileRefusedError);
      expect((error as BacklogFileRefusedError).files).toEqual([
        {
          path: ".",
          reason:
            "holds no Backlog project configuration (backlog.config.yml with a project name, or config.yml in backlog/ or .backlog/), so dipo does not run the Backlog CLI there",
        },
      ]);
      // The parent itself is a project.
      expect((await call(root, ["task", "list", "--plain"])).spawned).toBe(1);
    }));

  it("is refused when backlog.config.yml names no project", () =>
    withTempDir(async (dir) => {
      write(dir, { "backlog.config.yml": 'backlog_directory: "backlog"\n' });
      const { error } = await call(dir, ["task", "list", "--plain"]);
      expect((error as BacklogFileRefusedError).files.map((file) => file.path)).toEqual(["."]);
    }));

  it("passes with each kind of project configuration", () =>
    withTempDir(async (root) => {
      for (const [name, files] of [
        ["folder config.yml", { "backlog/config.yml": CONFIG }],
        ["folder config.yaml", { "backlog/config.yaml": CONFIG }],
        ["hidden folder config.yml", { ".backlog/config.yml": CONFIG }],
        ["hidden folder config.yaml", { ".backlog/config.yaml": CONFIG }],
        ["root config with a project", { "backlog.config.yml": "project_name: 'x'\n" }],
      ] as const) {
        const dir = join(root, name.replaceAll(" ", "-"));
        write(dir, files);
        expect([name, (await call(dir, ["task", "list", "--plain"])).spawned]).toEqual([name, 1]);
      }
      expect(hasProjectName('projectName: "x"\n')).toBe(true);
      expect(hasProjectName('project_name: ""\n# project_name: x\n')).toBe(false);
    }));

  it("leaves a folder that does not exist to the CLI, which cannot start in it", async () => {
    const missing = join(tempRoot(), "dipo-no-such-folder");
    expect((await call(missing, ["task", "list", "--plain"])).spawned).toBe(1);
  });

  it("lets `--version` through, which reads no project", () =>
    withTempDir(async (dir) => {
      expect((await call(dir, ["--version"])).spawned).toBe(1);
      expect((await call(dir, ["task", "list", "--plain"])).spawned).toBe(0);
    }));
});
