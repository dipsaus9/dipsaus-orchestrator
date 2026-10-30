// The guards that keep the story store's folder out of a worker's reach (0010, 0008; DIPO-379,
// R30): the parts guard (`protectedKind`), which refuses a part that adds, changes or deletes a path
// in it, and the collisions guard, which never writes the folder into a box on a catch-up
// (`boxChangesOf`) and never counts it as a story's changed file (`storyChangedFiles`). The tables
// below are what each guard refused before the folder came from the store; the adapters are the
// only lines that follow the guards' signatures.

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock, type TempRepo, withTempRepo } from "@dipsaus-orchestrator/testkit";

import { boxChangesOf, parseBoxChanges, storyChangedFiles } from "../../src/box/collisions";
import { protectedHits, protectedKind } from "../../src/box/parts";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";

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

/** The parts guard on `path`, in a repository whose `backlog.config.yml` names `named`, if any. */
function partsGuard(path: string, named?: string): string | null {
  return protectedKind(path, named ?? null);
}

/** The parts guard on a part that deletes each of `paths`. */
function partsGuardOnPart(paths: readonly string[]): readonly string[] {
  return protectedHits(
    paths.map((path) => ({ path, kind: "deleted" as const })),
    [],
  ).paths;
}

/** What the collisions guard writes into a box of a merge changing each of `paths`. */
function collisionsGuard(paths: readonly string[]): readonly string[] {
  const tree = "a".repeat(40);
  return parseBoxChanges(
    [...paths.flatMap((path) => [`:100644 100644 ${tree} ${tree} M`, path]), ""].join("\0"),
  ).written;
}

// ---- the tests ---------------------------------------------------------------------------------------

describe("the parts guard keeps refusing what it refused", () => {
  it("refuses every path in the story folder", () => {
    for (const path of PARTS_REFUSED) {
      expect([path, partsGuard(path)]).toEqual([path, "backlog"]);
    }
    expect(partsGuardOnPart([...PARTS_REFUSED, "src/a.ts"])).toEqual([...PARTS_REFUSED].toSorted());
  });

  it("refuses the configuration of the folder backlog.config.yml names", () => {
    for (const [path, named] of PARTS_REFUSED_NAMED) {
      expect([path, partsGuard(path, named)]).not.toEqual([path, null]);
    }
  });

  it("leaves paths that only share a name with the folder", () => {
    for (const path of PARTS_ALLOWED) {
      expect([path, partsGuard(path)]).toEqual([path, null]);
    }
  });
});

describe("the collisions guard keeps leaving out what it left out", () => {
  it("never writes the story folder into a box", () => {
    expect(collisionsGuard([...COLLISIONS_LEFT_OUT, ...COLLISIONS_KEPT])).toEqual(
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
        storyChangedFiles(session, { branch: "DIPO-1/story", startSha: start, baseRef: null }),
      );
      expect(files?.files).toEqual([...COLLISIONS_KEPT].toSorted());
      const box = await git.run((session) => boxChangesOf(session, start, tip));
      expect(box.written).toEqual([...COLLISIONS_KEPT].toSorted());
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
