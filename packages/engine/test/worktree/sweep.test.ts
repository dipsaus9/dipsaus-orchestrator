// Leftover branch-read scratch directories (DIPO-90). `readOnBranch` removes its
// `<worktree root>/_branch-read-*` directory in a `finally`, so a daemon killed mid-read leaves it;
// the claims load step sweeps every such directory older than the daemon start when the office
// loads, and never touches a claim worktree, `_base` or any other path.

import { describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { withBareRemote, withTempDir } from "@dipsaus-orchestrator/testkit";

import { EngineGit, resolveWorktreeRoot } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import { StoryIndex } from "../../src/stories/feature";
import { StoryClaims } from "../../src/worktree/feature";
import { BRANCH_READ_PREFIX, SWEEP_MARGIN_MS, sweepBranchReads } from "../../src/worktree/sweep";
import { BACKLOG_FIXTURE, officeSetup, resultOf, send } from "../office/helpers";
import { BASE, fakeBacklog, tableOf, type Tables } from "../reconcile/helpers";
import { backlogStoryStore } from "../../src/backlog/store";

/** The daemon start in these tests. */
const STARTED = Date.parse("2026-01-01T00:00:00Z");
/** A scratch directory a previous daemon left. */
const BEFORE = new Date("2025-06-01T00:00:00Z");
/** A scratch directory this daemon made. */
const AFTER = new Date("2026-06-01T00:00:00Z");

/** A scratch directory under `root` holding a copied backlog, last modified at `at`. */
function leaveScratch(root: string, at: Date): string {
  mkdirSync(root, { recursive: true });
  const scratch = mkdtempSync(join(root, BRANCH_READ_PREFIX));
  mkdirSync(join(scratch, "backlog", "tasks"), { recursive: true });
  writeFileSync(join(scratch, "backlog", "tasks", "task-1 - Story.md"), "---\nid: TASK-1\n---\n");
  utimesSync(scratch, at, at);
  return scratch;
}

/** A directory under `root` named `name`, holding one file, last modified at `at`. */
function leaveDir(root: string, name: string, at: Date): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "keep.txt"), "keep\n");
  utimesSync(dir, at, at);
  return dir;
}

describe("sweepBranchReads", () => {
  it("removes scratch directories older than the start and keeps newer ones", () =>
    withTempDir((dir) => {
      const root = join(dir, "repo.worktrees");
      const old1 = leaveScratch(root, BEFORE);
      const old2 = leaveScratch(root, BEFORE);
      const fresh = leaveScratch(root, AFTER);

      const swept = sweepBranchReads(root, STARTED);

      expect([...swept.removed].toSorted()).toEqual([old1, old2].toSorted());
      expect(swept.failed).toEqual([]);
      expect(existsSync(old1)).toBe(false);
      expect(existsSync(old2)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    }));

  it("never touches _base, a claim worktree or a name without the exact prefix", () =>
    withTempDir((dir) => {
      const root = join(dir, "repo.worktrees");
      const kept = [
        leaveDir(root, "_base", BEFORE),
        leaveDir(root, "TASK-1", BEFORE),
        leaveDir(root, "_backlog", BEFORE),
        leaveDir(root, "_branch-read", BEFORE),
        leaveDir(root, "_branch-readx", BEFORE),
        leaveDir(root, "branch-read-1", BEFORE),
        leaveDir(root, `x${BRANCH_READ_PREFIX}1`, BEFORE),
      ];
      // A prefixed directory that is a git checkout is never a scratch directory.
      const checkout = leaveDir(root, `${BRANCH_READ_PREFIX}checkout`, BEFORE);
      writeFileSync(join(checkout, ".git"), "gitdir: /elsewhere\n");
      utimesSync(checkout, BEFORE, BEFORE);
      // A prefixed regular file is not a directory.
      writeFileSync(join(root, `${BRANCH_READ_PREFIX}file`), "x\n");

      const swept = sweepBranchReads(root, STARTED);

      expect(swept.removed).toEqual([]);
      for (const path of [...kept, checkout]) {
        expect(existsSync(join(path, "keep.txt"))).toBe(true);
      }
      expect(existsSync(join(root, `${BRANCH_READ_PREFIX}file`))).toBe(true);
    }));

  it("never follows a symbolic link, at the root or inside a scratch directory", () =>
    withTempDir((dir) => {
      const root = join(dir, "repo.worktrees");
      const outside = leaveDir(dir, "outside", BEFORE);
      // A prefixed link to a directory outside the root: neither it nor its target goes.
      const link = join(root, `${BRANCH_READ_PREFIX}link`);
      mkdirSync(root, { recursive: true });
      symlinkSync(outside, link);
      // A scratch directory with a link to the outside directory inside: the link goes, the
      // target stays.
      const scratch = leaveScratch(root, BEFORE);
      symlinkSync(outside, join(scratch, "escape"));
      utimesSync(scratch, BEFORE, BEFORE);

      const swept = sweepBranchReads(root, STARTED);

      expect(swept.removed).toEqual([scratch]);
      expect(existsSync(scratch)).toBe(false);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    }));

  it("sweeps nothing when the worktree root does not exist", () =>
    withTempDir((dir) => {
      expect(sweepBranchReads(join(dir, "missing"), STARTED)).toEqual({ removed: [], failed: [] });
    }));

  it("keeps a scratch directory within the margin before the start", () =>
    withTempDir((dir) => {
      const root = join(dir, "repo.worktrees");
      const near = leaveScratch(root, new Date(STARTED - SWEEP_MARGIN_MS + 1_000));
      const past = leaveScratch(root, new Date(STARTED - SWEEP_MARGIN_MS - 1_000));

      expect(sweepBranchReads(root, STARTED).removed).toEqual([past]);
      expect(existsSync(near)).toBe(true);
    }));

  it("reports a root that is a file instead of throwing", () =>
    withTempDir((dir) => {
      const root = join(dir, "repo.worktrees");
      writeFileSync(root, "not a directory\n");

      const swept = sweepBranchReads(root, STARTED);

      expect(swept.removed).toEqual([]);
      expect(swept.failed.map((f) => f.path)).toEqual([root]);
      expect(existsSync(root)).toBe(true);
    }));
});

describe("the claims load step sweeps leftover scratch directories", () => {
  it("leaves only the claim worktree after the office loads", () =>
    withBareRemote(
      async (repo) => {
        await repo.commitAll("fixture");
        await repo.git("push", "--quiet", "-u", "origin", "main");
        await repo.git("remote", "set-head", "origin", "main");
        const tables: Tables = new Map([[BASE, tableOf([{ id: "TASK-1", status: "Ready" }])]]);
        const cli = { spawn: fakeBacklog(tables).spawn };
        const engineGit = new EngineGit({ spawn: systemSpawn, env: repo.env });
        const logged: { message: string; fields: Readonly<Record<string, unknown>> }[] = [];
        const claims = new StoryClaims({
          git: (office) => engineGit.forOffice(office),
          stories: backlogStoryStore(cli),
          startedAt: STARTED,
          info: (message, fields) => logged.push({ message, fields }),
          warn: (message, fields) => logged.push({ message, fields }),
        });
        let index: StoryIndex | undefined;
        const s = await officeSetup(repo.root, {
          // As the daemon registers them: git, then claims, then the story index (branch reads).
          features: (manager) => {
            index = new StoryIndex({
              git: engineGit,
              stories: backlogStoryStore(cli),
              offices: {
                get: (office) => manager.get(office),
                config: (office) => manager.config(office),
              },
            });
            return [engineGit.feature, claims.feature, index.feature];
          },
        });
        try {
          const { office: officeId } = resultOf<{ office: OfficeId }>(
            await send(s, "office.open", { path: repo.dir }),
          );
          const root = resolveWorktreeRoot(realpathSync(repo.dir));
          // A claim worktree on its branch, locked as a claim locks it, and two scratch
          // directories a killed daemon left.
          const worktree = join(root, "TASK-1");
          await repo.git("worktree", "add", "--quiet", "-b", "TASK-1/a-story", worktree, "main");
          await repo.git("worktree", "lock", "--reason", "dipo run", worktree);
          leaveScratch(root, BEFORE);
          leaveScratch(root, BEFORE);
          expect(readdirSync(root).filter((n) => n.startsWith(BRANCH_READ_PREFIX))).toHaveLength(2);

          const access = await s.manager.load(officeId);
          if (!access.ok) throw new Error(`${access.error.code}: ${access.error.message}`);

          expect(readdirSync(root).filter((n) => n !== "_base")).toEqual(["TASK-1"]);
          expect(existsSync(join(worktree, ".git"))).toBe(true);
          expect((await repo.run(["git", "status", "--porcelain"], worktree)).stdout).toBe("");
          expect(logged).toEqual([
            {
              message: "branch-read scratch swept",
              fields: { office: officeId, root, removed: 2 },
            },
          ]);
        } finally {
          index?.stop();
          s.state.close();
        }
      },
      { fixture: BACKLOG_FIXTURE },
    ));

  it("still loads the office when the worktree root cannot be listed, and warns", () =>
    withBareRemote(
      async (repo) => {
        const engineGit = new EngineGit({ spawn: systemSpawn, env: repo.env });
        const logged: { message: string; fields: Readonly<Record<string, unknown>> }[] = [];
        const claims = new StoryClaims({
          git: (office) => engineGit.forOffice(office),
          stories: backlogStoryStore({ spawn: fakeBacklog(new Map()).spawn }),
          startedAt: STARTED,
          info: (message, fields) => logged.push({ message, fields }),
          warn: (message, fields) => logged.push({ message, fields }),
        });
        // Only git and the claims: the sweep is what this checks, not the story index.
        const s = await officeSetup(repo.root, { features: [engineGit.feature, claims.feature] });
        try {
          const { office: officeId } = resultOf<{ office: OfficeId }>(
            await send(s, "office.open", { path: repo.dir }),
          );
          const root = resolveWorktreeRoot(realpathSync(repo.dir));
          writeFileSync(root, "not a directory\n");

          const access = await s.manager.load(officeId);

          expect(access.ok).toBe(true);
          expect(logged.map((l) => l.message)).toEqual([
            "branch-read sweep failed",
            "branch-read scratch swept",
          ]);
          expect(logged[0]?.fields).toMatchObject({ office: officeId, path: root });
          expect(logged[1]?.fields).toEqual({ office: officeId, root, removed: 0 });
        } finally {
          s.state.close();
        }
      },
      { fixture: BACKLOG_FIXTURE },
    ));
});
