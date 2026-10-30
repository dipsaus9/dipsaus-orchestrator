// The guards that keep the story store's folder out of a worker's reach (0010, 0008; DIPO-379,
// R30): the parts guard (`protectedKind`), which refuses a part that adds, changes or deletes a path
// in it, and the collisions guard, which never writes the folder into a box on a catch-up
// (`boxChangesOf`) and never counts it as a story's changed file (`storyChangedFiles`). The tables
// below are what each guard refused before the folder came from the store, kept unchanged; the
// adapters are the only lines that follow the guards' signatures, and they take the folders from the
// real Backlog.md store (`backlogLayout`). Then the bypass forms of each guard, and the guards with
// the real store whose folder lookup fails: they refuse. The parts guard's bypass forms and its
// fail-closed test through a whole part on real git are in run/parts-commit.test.ts.

import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock, type TempRepo, withTempRepo } from "@dipsaus-orchestrator/testkit";

import { BacklogFolderError } from "../../src/backlog/folder";
import {
  BoxCollisions,
  boxChangesOf,
  MERGE_REFUSED,
  parseBoxChanges,
  storyChangedFiles,
} from "../../src/box/collisions";
import { type PartRun, protectedHits, protectedKind } from "../../src/box/parts";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import type { RepoFileRead } from "../../src/story-store/folder";
import { inStoryFolder } from "../../src/story-store/paths";
import { FakeStoryStore } from "../story-store/fake";
import { backlogLayout } from "../story-store/backlog";

// ---- what each guard refused before ---------------------------------------------------------------

/** Paths the parts guard refused as the story folder, in a repository with no root configuration. */
const PARTS_REFUSED: readonly string[] = [
  "backlog",
  "backlog/config.yml",
  "backlog/config.yaml",
  "backlog/tasks/dipo-1 - One.md",
  "backlog/drafts/draft-1 - Sketch.md",
  "backlog/completed/dipo-2 - Two.md",
  "backlog/archive/tasks/dipo-3 - Three.md",
  "backlog/docs/notes.md",
  "backlog/new-folder/anything.txt",
  // Folded as APFS finds files, and look-alike names as a second layer.
  "Backlog/tasks/x.md",
  "BACKLOG/config.yml",
  `${String.fromCodePoint(0xff42)}acklog/config.yml`,
];

/**
 * Paths the parts guard refused because `backlog.config.yml` names another folder (DIPO-312): that
 * folder's configuration, by the folder the configuration names.
 */
const PARTS_REFUSED_NAMED: readonly (readonly [string, string])[] = [
  ["planning/board/config.yml", "planning/board"],
  ["planning/board/config.yaml", "planning/board"],
  ["Planning/Board/CONFIG.yml", "planning/board"],
  ["planning/config.yml", "planning"],
];

/** Paths the parts guard let through: only their name looks like the folder's. */
const PARTS_ALLOWED: readonly string[] = [
  "docs/backlog.md",
  "packages/backlog/x.ts",
  "src/backlog/tasks.ts",
  "backlog.md",
  "backlogs/x.md",
];

/** Paths the collisions guard never wrote into a box nor counted as changed. */
const COLLISIONS_LEFT_OUT: readonly string[] = [
  "backlog/config.yml",
  "backlog/tasks/dipo-1 - One.md",
  "backlog/drafts/draft-1 - Sketch.md",
  "backlog/archive/tasks/dipo-3 - Three.md",
  "backlog/docs/notes.md",
];

/** Paths the collisions guard wrote and counted: outside the folder. */
const COLLISIONS_KEPT: readonly string[] = [
  "src/a.ts",
  "docs/backlog.md",
  "packages/backlog/x.ts",
  "backlog.md",
];

// ---- the adapters ------------------------------------------------------------------------------------

/** A repository with only a root `backlog.config.yml` holding `text`, or none, read by path. */
function rootConfig(text: string | null): RepoFileRead {
  return async (path) => (path === "backlog.config.yml" ? text : null);
}

/** The folders the real Backlog.md store names where `backlog.config.yml` names `named`, if any. */
function foldersOf(named?: string): Promise<readonly string[]> {
  return backlogLayout.storyFolders(
    rootConfig(named === undefined ? null : `backlog_directory: ${named}\n`),
  );
}

/** The parts guard on `path`, in a repository whose `backlog.config.yml` names `named`, if any. */
async function partsGuard(path: string, named?: string): Promise<string | null> {
  return protectedKind(path, await foldersOf(named));
}

/** The parts guard on a part that deletes each of `paths`. */
async function partsGuardOnPart(paths: readonly string[]): Promise<readonly string[]> {
  return protectedHits(
    paths.map((path) => ({ path, kind: "deleted" as const })),
    [],
    await foldersOf(),
  ).paths;
}

/** The raw `git diff-tree -r -z` output of a merge that changes each of `paths`. */
function diffOf(paths: readonly string[]): string {
  const tree = "a".repeat(40);
  return [...paths.flatMap((path) => [`:100644 100644 ${tree} ${tree} M`, path]), ""].join("\0");
}

/** What the collisions guard writes into a box of a merge changing each of `paths`. */
async function collisionsGuard(
  paths: readonly string[],
  named?: string,
): Promise<readonly string[]> {
  return parseBoxChanges(diffOf(paths), await foldersOf(named)).written;
}

// ---- the old barriers --------------------------------------------------------------------------------

describe("the parts guard keeps refusing what it refused", () => {
  it("refuses every path in the story folder", async () => {
    for (const path of PARTS_REFUSED) {
      expect([path, await partsGuard(path)]).toEqual([path, "backlog"]);
    }
    expect(await partsGuardOnPart([...PARTS_REFUSED, "src/a.ts"])).toEqual(
      [...PARTS_REFUSED].toSorted(),
    );
  });

  it("refuses the configuration of the folder backlog.config.yml names", async () => {
    for (const [path, named] of PARTS_REFUSED_NAMED) {
      expect([path, await partsGuard(path, named)]).not.toEqual([path, null]);
    }
  });

  it("leaves paths that only share a name with the folder", async () => {
    for (const path of PARTS_ALLOWED) {
      expect([path, await partsGuard(path)]).toEqual([path, null]);
    }
  });
});

describe("the collisions guard keeps leaving out what it left out", () => {
  it("never writes the story folder into a box", async () => {
    expect(await collisionsGuard([...COLLISIONS_LEFT_OUT, ...COLLISIONS_KEPT])).toEqual(
      [...COLLISIONS_KEPT].toSorted(),
    );
  });

  it("on real git: never counts the folder as changed, nor writes it into a box", () =>
    inRepo(async ({ repo, git }) => {
      const start = await commit(repo, { "src/a.ts": "a\n", "backlog/config.yml": "x: 1\n" });
      await repo.git("checkout", "--quiet", "-b", "DIPO-1/story");
      const changed = Object.fromEntries(
        [...COLLISIONS_LEFT_OUT, ...COLLISIONS_KEPT].map((path) => [path, `${path}\n`]),
      );
      const tip = await commit(repo, changed);
      const files = await git.run((session) =>
        storyChangedFiles(session, {
          stories: backlogLayout,
          branch: "DIPO-1/story",
          startSha: start,
          baseRef: null,
        }),
      );
      expect(files?.files).toEqual([...COLLISIONS_KEPT].toSorted());
      const box = await git.run((session) => boxChangesOf(session, start, tip, backlogLayout));
      expect(box.written).toEqual([...COLLISIONS_KEPT].toSorted());
    }));
});

// ---- the bypass forms ----------------------------------------------------------------------------------

/** Every way of naming a path in the folder that a plain prefix check would miss. */
const BYPASS_FORMS: readonly (readonly [string, string])[] = [
  ["a ./ segment", "./backlog/tasks/dipo-9 - Nine.md"],
  ["a ../ segment", "src/../backlog/tasks/dipo-9 - Nine.md"],
  ["repeated slashes", "backlog//tasks/dipo-9 - Nine.md"],
  ["an absolute path", "/backlog/tasks/dipo-9 - Nine.md"],
  ["a trailing slash", "backlog/tasks/"],
  ["the folder itself with a trailing slash", "backlog/"],
  ["another case, as the Mac's volume finds it", "BackLog/Tasks/dipo-9 - Nine.md"],
  [
    "a Kelvin sign for the k, as the volume folds it",
    `bac${String.fromCodePoint(0x212a)}log/tasks/x.md`,
  ],
  ["Backlog.md's other folder", ".backlog/tasks/task-1 - x.md"],
];

describe("the parts guard refuses the bypass forms", () => {
  it("in every spelling of a path in the folder", async () => {
    for (const [form, path] of BYPASS_FORMS) {
      expect([form, await partsGuard(path)]).toEqual([form, "backlog"]);
    }
  });

  it("a rename into the folder, as a part delivers it: a deletion and an addition", async () => {
    const hits = protectedHits(
      [
        { path: "src/a.ts", kind: "deleted" },
        { path: "backlog/tasks/a.md", kind: "added", mode: "100644", id: "1", at: "/x" },
      ],
      [],
      await foldersOf(),
    );
    expect(hits).toEqual({ kinds: ["backlog"], paths: ["backlog/tasks/a.md"] });
  });

  it("a symlink into the folder: every link a part adds is a hit, whatever it points at", async () => {
    const hits = protectedHits([], ["docs/tasks"], await foldersOf());
    expect(hits).toEqual({ kinds: ["link"], paths: ["docs/tasks"] });
  });

  it("but not a folder that only shares the prefix", async () => {
    for (const path of ["backlog-x/tasks/a.md", "backlogs/a.md", "backlog.d/a.md", "x/backlog/a"]) {
      expect([path, await partsGuard(path)]).toEqual([path, null]);
    }
  });

  it("a configured folder other than backlog/, and backlog/ beside it", async () => {
    for (const path of ["planning/tasks/task-1 - x.md", "Planning/config.yml", "./planning/x"]) {
      expect([path, await partsGuard(path, "planning")]).toEqual([path, "backlog"]);
    }
    expect(await partsGuard("backlog/tasks/a.md", "planning")).toBe("backlog");
    expect(await partsGuard("planning-notes/a.md", "planning")).toBeNull();
  });

  it("the folders another store names, and only those", () => {
    const tracker = ["tracker"];
    expect(protectedKind("tracker/items/1.md", tracker)).toBe("backlog");
    expect(protectedKind("./Tracker/", tracker)).toBe("backlog");
    expect(protectedKind("backlog/tasks/a.md", tracker)).toBeNull();
  });
});

describe("the collisions guard leaves out the bypass forms", () => {
  it("in every spelling of a path in the folder", async () => {
    const paths = BYPASS_FORMS.map(([, path]) => path);
    expect(await collisionsGuard([...paths, "src/a.ts"])).toEqual(["src/a.ts"]);
  });

  it("but not a folder that only shares the prefix", async () => {
    const paths = ["backlog-x/tasks/a.md", "backlogs/a.md"];
    expect(await collisionsGuard(paths)).toEqual(paths);
  });

  it("a configured folder other than backlog/, and backlog/ beside it", async () => {
    const paths = ["planning/tasks/task-1 - x.md", "backlog/tasks/a.md", "planning-notes/a.md"];
    expect(await collisionsGuard(paths, "planning")).toEqual(["planning-notes/a.md"]);
  });

  it("on real git: a rename into the folder only removes, and its new path is no changed file", () =>
    inRepo(async ({ repo, git }) => {
      const start = await commit(repo, { "src/a.ts": "a\n", "backlog/config.yml": "x: 1\n" });
      await repo.git("checkout", "--quiet", "-b", "DIPO-1/story");
      await repo.git("mv", "src/a.ts", "backlog/a.md");
      const tip = await repo.commitAll("rename into the folder");
      const box = await git.run((session) => boxChangesOf(session, start, tip, backlogLayout));
      expect(box).toEqual({ written: [], removed: ["src/a.ts"] });
      const files = await git.run((session) =>
        storyChangedFiles(session, {
          stories: backlogLayout,
          branch: "DIPO-1/story",
          startSha: start,
          baseRef: null,
        }),
      );
      expect(files?.files).toEqual(["src/a.ts"]);
    }));

  it("on real git: a symlink a merge writes into the folder refuses the copy", () =>
    inRepo(async ({ repo, git }) => {
      const start = await commit(repo, { "src/a.ts": "a\n", "backlog/config.yml": "x: 1\n" });
      for (const [link, target] of [
        ["docs/tasks", "../backlog/tasks"],
        ["docs/hidden", "../.Backlog"],
        ["docs/deep", "./../backlog/../backlog/drafts/"],
        // A folder above a story folder: a write below it reaches the folder too.
        ["docs/up", ".."],
        ["docs/root", "../"],
        ["here", "."],
      ] as const) {
        await repo.git("checkout", "--quiet", "-B", "DIPO-1/story", start);
        mkdirSync(join(repo.dir, "docs"), { recursive: true });
        symlinkSync(target, join(repo.dir, link));
        const tip = await repo.commitAll(`link ${link}`);
        const refused = await git
          .run((session) => boxChangesOf(session, start, tip, backlogLayout))
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect([link, (refused as { code?: string } | null)?.code]).toEqual([link, MERGE_REFUSED]);
      }
      // A symlink that points anywhere else is copied as before, a folder that only shares the
      // prefix included.
      await repo.git("checkout", "--quiet", "-B", "DIPO-1/story", start);
      symlinkSync("src/a.ts", join(repo.dir, "a-link"));
      symlinkSync("backlog-x/notes", join(repo.dir, "b-link"));
      symlinkSync("../../outside", join(repo.dir, "c-link"));
      const tip = await repo.commitAll("link elsewhere");
      const box = await git.run((session) => boxChangesOf(session, start, tip, backlogLayout));
      expect(box.written).toEqual(["a-link", "b-link", "c-link"]);
    }));

  it("on real git: a chain of symlinks into the folder, or a loop, refuses the copy", () =>
    inRepo(async ({ repo, git }) => {
      mkdirSync(join(repo.dir, "docs"), { recursive: true });
      symlinkSync("../backlog", join(repo.dir, "docs/hop"));
      symlinkSync("loop-b", join(repo.dir, "loop-a"));
      symlinkSync("loop-a", join(repo.dir, "loop-b"));
      const start = await commit(repo, { "src/a.ts": "a\n", "backlog/config.yml": "x: 1\n" });
      for (const [link, target] of [
        ["next", "docs/hop"],
        ["deeper", "docs/hop/tasks"],
        ["round", "loop-a"],
      ] as const) {
        await repo.git("checkout", "--quiet", "-B", "DIPO-1/story", start);
        symlinkSync(target, join(repo.dir, link));
        const tip = await repo.commitAll(`link ${link}`);
        const refused = await git
          .run((session) => boxChangesOf(session, start, tip, backlogLayout))
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect([link, (refused as { code?: string } | null)?.code]).toEqual([link, MERGE_REFUSED]);
      }
    }));

  it("the folders another store names: a fake store with its own folder", () =>
    inRepo(async ({ repo, git }) => {
      const start = await commit(repo, { "src/a.ts": "a\n" });
      const tip = await commit(repo, { "tracker/1.md": "x\n", "backlog/b.md": "y\n" });
      const store = new FakeStoryStore();
      store.folders = ["tracker"];
      const box = await git.run((session) => boxChangesOf(session, start, tip, store));
      expect(box.written).toEqual(["backlog/b.md"]);
    }));
});

// ---- fail closed -----------------------------------------------------------------------------------------

/** A repository whose files cannot be read. */
const unreadable: RepoFileRead = async () => {
  throw new Error("EACCES");
};

/** Root configurations the real Backlog.md store cannot resolve a folder from. */
const UNRESOLVED: readonly string[] = [
  "backlog_directory: ../outside\n",
  "backlog_directory: /etc\n",
  'backlog_directory: ""\n',
  "backlog_directory: .\n",
];

describe("with the real Backlog.md store whose folder lookup fails", () => {
  it("the lookup refuses every root configuration it cannot resolve", async () => {
    for (const text of UNRESOLVED) {
      const refused = await backlogLayout.storyFolders(rootConfig(text)).then(
        () => null,
        (error: unknown) => error,
      );
      expect([text, refused instanceof BacklogFolderError]).toEqual([text, true]);
    }
    await expect(backlogLayout.storyFolders(unreadable)).rejects.toThrow("EACCES");
  });

  it("on real git: the collisions guard copies nothing and counts nothing", () =>
    inRepo(async ({ repo, git }) => {
      const start = await commit(repo, {
        "src/a.ts": "a\n",
        "backlog.config.yml": UNRESOLVED[0]!,
      });
      await repo.git("checkout", "--quiet", "-b", "DIPO-1/story");
      const tip = await commit(repo, { "src/a.ts": "b\n", "backlog/tasks/x.md": "x\n" });
      await expect(
        git.run((session) => boxChangesOf(session, start, tip, backlogLayout)),
      ).rejects.toBeInstanceOf(BacklogFolderError);
      await expect(
        git.run((session) =>
          storyChangedFiles(session, {
            stories: backlogLayout,
            branch: "DIPO-1/story",
            startSha: start,
            baseRef: null,
          }),
        ),
      ).rejects.toBeInstanceOf(BacklogFolderError);
    }));

  it("on real git: the overlap check leaves out only the run whose lookup refuses", () =>
    inRepo(async ({ repo, git }) => {
      const start = await commit(repo, {
        "src/shared.ts": "one\n",
        "backlog/config.yml": "x: 1\n",
      });
      const runs: PartRun[] = [];
      for (const [n, files] of [
        // The refusing run changes the same file as the others.
        [1, { "backlog.config.yml": UNRESOLVED[0]!, "src/shared.ts": "a\n" }],
        [2, { "src/shared.ts": "b\n" }],
        [3, { "src/shared.ts": "c\n" }],
      ] as const) {
        const branch = `DIPO-${n}/story`;
        await repo.git("checkout", "--quiet", "-B", branch, start);
        await commit(repo, files);
        runs.push({
          runId: `run_${n}`,
          office: OFFICE,
          story: `DIPO-${n}`,
          branch,
          startSha: start,
          box: `b${n}`,
        });
      }
      await repo.git("checkout", "--quiet", "main");
      const notices: string[] = [];
      const told: string[] = [];
      const warned: { message: string; run?: unknown }[] = [];
      const collisions = new BoxCollisions({
        stories: backlogLayout,
        boxes: { copyIn: async () => {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }) },
        code: { spawn: systemSpawn, clock: new ManualClock() },
        tmpRoot: realpathSync(repo.root),
        runs: () => runs,
        git: (office) => (office === OFFICE ? git : undefined),
        live: () => true,
        parts: {} as never,
        park: () => true,
        tell: async (runId) => {
          told.push(runId);
        },
        notice: (_office, _runId, notice) => notices.push(notice.text),
        warn: (message, fields) => warned.push({ message, run: fields["run"] }),
      });
      await collisions.check();
      // The two runs dipo can read are told of each other; the refusing one is in no overlap.
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("DIPO-2");
      expect(notices[0]).toContain("DIPO-3");
      expect(notices[0]).not.toContain("DIPO-1");
      expect(told.toSorted()).toEqual(["run_2", "run_3"]);
      expect(warned.filter((w) => w.run === "run_1").map((w) => w.message)).toContain(
        "a box run's changed files could not be read for the overlap check",
      );
      expect(warned.some((w) => w.message.startsWith("comparing the box runs"))).toBe(false);
    }));

  it("on real git: a root configuration that is a symlink refuses too", () =>
    inRepo(async ({ repo, git }) => {
      writeFileSync(join(repo.dir, "config-target.yml"), "backlog_directory: planning\n");
      symlinkSync("config-target.yml", join(repo.dir, "backlog.config.yml"));
      const start = await commit(repo, { "src/a.ts": "a\n" });
      const tip = await commit(repo, { "src/a.ts": "b\n" });
      const refused = await git
        .run((session) => boxChangesOf(session, start, tip, backlogLayout))
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(refused).not.toBeNull();
      expect(inStoryFolder("src/a.ts", await foldersOf())).toBe(false);
    }));
});

// ---- real git ----------------------------------------------------------------------------------------

const OFFICE = "office-tracker-folder" as OfficeId;

async function commit(repo: TempRepo, files: Readonly<Record<string, string>>): Promise<string> {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo.dir, path, ".."), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  }
  return repo.commitAll("change");
}

function inRepo(
  fn: (world: { readonly repo: TempRepo; readonly git: OfficeGit }) => Promise<void>,
): Promise<void> {
  return withTempRepo(async (repo) => {
    const real = realpathSync(repo.dir);
    const git = new OfficeGit({
      officeId: OFFICE,
      mainWorktree: real,
      commonDir: join(real, ".git"),
      settings: { remote: "origin", base: "main" },
      runner: { exec: spawnGitExec(systemSpawn), env: repo.env, sleep: async () => {} },
      clock: new ManualClock(),
    });
    await fn({ repo, git });
  });
}
