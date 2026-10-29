// The leftover story worktrees of an earlier binary (DIPO-349): at an office load dipo removes a
// clean one with `git worktree remove` through the git module and keeps a dirty one, listed on the
// desk. Only a direct child of the worktree root locked `dipo <run-id>` is a leftover: a builder's
// unlocked worktree, a worktree locked for another reason and `_base` stay untouched. Real git.

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { git, type TempRepo, withTempRepo } from "@dipsaus-orchestrator/testkit";

import {
  heldBlobs,
  keepingPaths,
  LEFTOVER_WORKTREE_DESK,
  leftoverWorktreeDeskItems,
  recordKeptWorktrees,
  sweepLeftoverWorktrees,
} from "../../src/worktree";
import { BACKLOG_FIXTURE, claimSetup, type ClaimSetup, publish } from "./helpers";

/** Adds a worktree of a new branch `branch` at `<root>/<name>`, locked with `lock` when given. */
async function addWorktree(
  repo: TempRepo,
  s: ClaimSetup,
  name: string,
  branch: string | null,
  lock: string | null,
): Promise<string> {
  const root = s.git.worktreeRoot();
  mkdirSync(root, { recursive: true });
  const path = join(root, name);
  const target = branch === null ? ["--detach", path, "main"] : ["-b", branch, path, "main"];
  await git(repo.dir, repo.home, "worktree", "add", "--quiet", ...target);
  if (lock !== null) await git(repo.dir, repo.home, "worktree", "lock", "--reason", lock, path);
  return path;
}

const listed = async (repo: TempRepo): Promise<string> =>
  git(repo.dir, repo.home, "worktree", "list", "--porcelain");

/**
 * Commits `files` on top of `branch` from objects, as a box's part is committed, without touching
 * any worktree, so a worktree that has the branch checked out lags it. Returns the new tip.
 */
function commitFromObjects(repo: TempRepo, branch: string, files: Record<string, string>): string {
  const index = join(mkdtempSync(join(repo.root, "index-")), "index");
  const run = (args: string[], input?: string) =>
    execFileSync("git", args, {
      cwd: repo.dir,
      env: { ...repo.env, GIT_INDEX_FILE: index },
      encoding: "utf8",
      ...(input === undefined ? {} : { input }),
    }).trim();
  const tip = run(["rev-parse", `refs/heads/${branch}`]);
  run(["read-tree", tip]);
  for (const [path, text] of Object.entries(files)) {
    const blob = run(["hash-object", "-w", "--stdin"], text);
    run(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
  }
  const tree = run(["write-tree"]);
  const commit = run(["commit-tree", tree, "-p", tip, "-m", "a part"]);
  run(["update-ref", `refs/heads/${branch}`, commit, tip]);
  return commit;
}

describe("the leftover story worktrees at an office load", () => {
  it("removes a clean leftover, keeps a dirty one for the desk, and touches no other worktree", async () => {
    await withTempRepo(
      async (repo) => {
        await publish(repo);
        const s = await claimSetup(repo);
        // node_modules is rebuilt by an install, so it does not keep a worktree.
        appendFileSync(join(repo.dir, ".git", "info", "exclude"), "node_modules/\n");
        const clean = await addWorktree(repo, s, "DIPO-1", "DIPO-1/clean", "dipo run_01A");
        mkdirSync(join(clean, "node_modules", "x"), { recursive: true });
        writeFileSync(join(clean, "node_modules", "x", "index.js"), "1\n");
        const dirty = await addWorktree(repo, s, "DIPO-2", "DIPO-2/dirty", "dipo run_01B");
        writeFileSync(join(dirty, "notes.txt"), "unsaved work\n");
        const ignored = await addWorktree(repo, s, "DIPO-3", "DIPO-3/ignored", "dipo run_01C");
        appendFileSync(join(repo.dir, ".git", "info", "exclude"), ".env.local\n");
        writeFileSync(join(ignored, ".env.local"), "SECRET=1\n");
        const detached = await addWorktree(repo, s, "DIPO-4", null, "dipo run_01D");
        const builder = await addWorktree(repo, s, "DIPO-5", "DIPO-5/builder", null);
        const foreign = await addWorktree(repo, s, "DIPO-6", "DIPO-6/foreign", "on a USB disk");

        const sweep = await sweepLeftoverWorktrees(s.git);

        expect(sweep.removed).toEqual([clean]);
        expect(existsSync(clean)).toBe(false);
        expect(await listed(repo)).not.toContain(clean);
        // The branch of a removed leftover stays.
        expect((await repo.git("rev-parse", "--verify", "DIPO-1/clean")).trim()).not.toBe("");
        expect(sweep.kept.map((k) => [k.path, k.branch])).toEqual([
          [dirty, "DIPO-2/dirty"],
          [ignored, "DIPO-3/ignored"],
          [detached, null],
        ]);
        expect(sweep.kept[0]?.why).toContain("notes.txt");
        expect(sweep.kept[1]?.why).toContain(".env.local");
        expect(sweep.kept[2]?.why).toContain("detached HEAD");
        // Never delete a dirty worktree: its files and its lock stay.
        for (const path of [dirty, ignored, detached]) expect(existsSync(path)).toBe(true);
        expect(existsSync(join(dirty, "notes.txt"))).toBe(true);
        expect(await listed(repo)).toContain("locked dipo run_01B");
        for (const path of [builder, foreign]) expect(existsSync(path)).toBe(true);
        expect(await listed(repo)).toContain("locked on a USB disk");

        recordKeptWorktrees(s.office, sweep.kept, s.t.clock);
        const items = leftoverWorktreeDeskItems(s.office);
        expect(items.map((item) => item.kind)).toEqual([
          LEFTOVER_WORKTREE_DESK,
          LEFTOVER_WORKTREE_DESK,
          LEFTOVER_WORKTREE_DESK,
        ]);
        expect(items[0]?.detail).toContain(`${dirty} (DIPO-2/dirty)`);
        expect(items[0]?.hand).toContain(`git worktree remove --force ${dirty}`);

        // The next load finds the same kept worktrees and keeps their first sighting.
        const first = items[0]?.since;
        s.t.clock.advance(60_000);
        const again = await sweepLeftoverWorktrees(s.git);
        expect(again.removed).toEqual([]);
        recordKeptWorktrees(s.office, again.kept, s.t.clock);
        expect(leftoverWorktreeDeskItems(s.office)[0]?.since).toBe(first);

        // Once the maintainer cleaned one by hand, it goes too and its desk item with it.
        await git(dirty, repo.home, "clean", "--quiet", "-f");
        const third = await sweepLeftoverWorktrees(s.git);
        expect(third.removed).toEqual([dirty]);
        recordKeptWorktrees(s.office, third.kept, s.t.clock);
        expect(leftoverWorktreeDeskItems(s.office)).toHaveLength(2);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("keeps a leftover with a staged or a committed-but-modified file", async () => {
    await withTempRepo(
      async (repo) => {
        await publish(repo);
        const s = await claimSetup(repo);
        const staged = await addWorktree(repo, s, "DIPO-7", "DIPO-7/staged", "dipo run_01E");
        writeFileSync(join(staged, "new.txt"), "staged\n");
        await git(staged, repo.home, "add", "new.txt");
        const modified = await addWorktree(repo, s, "DIPO-8", "DIPO-8/modified", "dipo run_01F");
        writeFileSync(join(modified, "backlog", "config.yml"), "changed\n");

        const sweep = await sweepLeftoverWorktrees(s.git);

        expect(sweep.removed).toEqual([]);
        expect(sweep.kept.map((k) => k.path)).toEqual([staged, modified]);
        expect(existsSync(join(staged, "new.txt"))).toBe(true);
        expect(existsSync(modified)).toBe(true);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });
});

describe("a leftover of a box run, whose files lag its branch", () => {
  it("is removed when every changed file is held in git, and kept for one unsaved byte", async () => {
    await withTempRepo(
      async (repo) => {
        await publish(repo);
        const s = await claimSetup(repo);
        // The worker wrote two files in the worktree; the box committed the same bytes from
        // objects, so the worktree's index and HEAD disagree and git lists changes.
        const saved = await addWorktree(repo, s, "DIPO-1", "DIPO-1/saved", "dipo run_01G");
        const unsaved = await addWorktree(repo, s, "DIPO-2", "DIPO-2/unsaved", "dipo run_01H");
        for (const [dir, branch] of [
          [saved, "DIPO-1/saved"],
          [unsaved, "DIPO-2/unsaved"],
        ] as const) {
          writeFileSync(join(dir, "README.md"), "changed by the worker\n");
          writeFileSync(join(dir, "src.txt"), "new work\n");
          commitFromObjects(repo, branch, {
            "README.md": "changed by the worker\n",
            "src.txt": "new work\n",
          });
        }
        // One byte the box never delivered.
        writeFileSync(join(unsaved, "src.txt"), "new work!\n");
        expect(await git(saved, repo.home, "status", "--porcelain")).not.toBe("");

        const sweep = await sweepLeftoverWorktrees(s.git);

        expect(sweep.removed).toEqual([saved]);
        expect(existsSync(saved)).toBe(false);
        expect(sweep.kept.map((k) => k.path)).toEqual([unsaved]);
        expect(sweep.kept[0]?.why).toContain("src.txt");
        expect(sweep.kept[0]?.why).not.toContain("README.md");
        expect(existsSync(join(unsaved, "src.txt"))).toBe(true);
        expect(await listed(repo)).toContain("locked dipo run_01H");
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });
});

describe("the paths that keep a leftover", () => {
  it("reads the blobs git log --raw -z gave each path", () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const raw = `\n:100644 100644 ${a} ${b} M\0src.txt\0\n:000000 100644 ${"0".repeat(40)} ${a} A\0src.txt\0`;
    expect([...heldBlobs(raw)].toSorted()).toEqual(
      [`src.txt\0${"0".repeat(40)}`, `src.txt\0${a}`, `src.txt\0${b}`].toSorted(),
    );
  });

  it("lists changes and ignored files but a whole node_modules folder and .DS_Store", () => {
    const status = [
      " M src/a.ts",
      "?? notes.txt",
      "!! node_modules/",
      "!! .DS_Store",
      "!! .env.local",
      "R  b.ts",
      "a.ts",
      "",
    ].join("\0");
    expect(keepingPaths(status)).toEqual(["src/a.ts", "notes.txt", ".env.local", "b.ts"]);
  });
});
