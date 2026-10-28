// The git writer (0010; DIPO-348) against a real temporary repository and its bare `origin`: a
// branch is created only where none exists and never overwritten, a push is never forced, a
// branch is deleted locally only at the tip read, and a remote branch delete carries a lease on
// the tip dipo pushed, so a remote tip that moved since is never deleted.

import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { git, type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import {
  createBranch,
  deleteBranch,
  deleteRemoteBranch,
  moveBranch,
  pushBranch,
} from "../../src/git/write";

import { officeGit, published } from "./helpers";

const BRANCH = "DIPO-1/story";

/** Commits one file on `main` and returns the commit. */
async function commitOnMain(repo: TempRepoWithRemote, file: string): Promise<string> {
  writeFileSync(join(repo.dir, file), `${file}\n`);
  return repo.commitAll(file);
}

/** The tip of `branch` on `origin`, or null. */
async function remoteTip(repo: TempRepoWithRemote, branch: string): Promise<string | null> {
  const listed = await git(repo.root, repo.home, "ls-remote", repo.remote, `refs/heads/${branch}`);
  return listed.trim().split(/\s+/)[0] || null;
}

describe("the git writer", () => {
  it("creates a branch only where none exists and never moves an existing one", async () => {
    await withBareRemote(async (repo) => {
      const first = await published(repo);
      const second = await commitOnMain(repo, "b.txt");
      const office = officeGit(repo);
      expect(await office.run((s) => createBranch(s, BRANCH, first))).toBe(true);
      expect((await repo.git("rev-parse", BRANCH)).trim()).toBe(first);
      // The same name again, even at another start: refused, the branch stays where it was.
      expect(await office.run((s) => createBranch(s, BRANCH, second))).toBe(false);
      expect((await repo.git("rev-parse", BRANCH)).trim()).toBe(first);
    });
  });

  it("lets exactly one of two parallel creations of one branch win", async () => {
    await withBareRemote(async (repo) => {
      const first = await published(repo);
      const second = await commitOnMain(repo, "b.txt");
      // Two office gits, so neither waits for the other's queue.
      const [a, b] = await Promise.all([
        officeGit(repo).run((s) => createBranch(s, BRANCH, first)),
        officeGit(repo).run((s) => createBranch(s, BRANCH, second)),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect((await repo.git("rev-parse", BRANCH)).trim()).toBe(a ? first : second);
    });
  });

  it("moves and deletes a local branch only from the tip the caller read", async () => {
    await withBareRemote(async (repo) => {
      const first = await published(repo);
      const second = await commitOnMain(repo, "b.txt");
      const office = officeGit(repo);
      await office.run((s) => createBranch(s, BRANCH, first));
      expect(await office.run((s) => moveBranch(s, BRANCH, second, second))).toBe(false);
      expect(await office.run((s) => moveBranch(s, BRANCH, second, first))).toBe(true);
      expect((await office.run((s) => deleteBranch(s, BRANCH, first))).code).not.toBe(0);
      expect((await repo.git("rev-parse", BRANCH)).trim()).toBe(second);
      expect((await office.run((s) => deleteBranch(s, BRANCH, second))).code).toBe(0);
      expect(await repo.git("branch", "--list", BRANCH)).toBe("");
    });
  });

  it("never forces a push: a remote branch that moved elsewhere refuses it and stays", async () => {
    await withBareRemote(async (repo) => {
      const first = await published(repo);
      const office = officeGit(repo);
      await office.run((s) => createBranch(s, BRANCH, first));
      expect(await office.run((s) => pushBranch(s, "origin", BRANCH))).toEqual({
        pushed: true,
        rejected: false,
        error: null,
      });
      // Someone else moves the remote branch; the local branch moves elsewhere.
      const theirs = await commitOnMain(repo, "theirs.txt");
      await repo.git("push", "--quiet", "origin", `${theirs}:refs/heads/${BRANCH}`);
      await repo.git("reset", "--quiet", "--hard", first);
      const ours = await commitOnMain(repo, "ours.txt");
      await office.run((s) => moveBranch(s, BRANCH, ours, first));
      const pushed = await office.run((s) => pushBranch(s, "origin", BRANCH));
      expect(pushed).toMatchObject({ pushed: false, rejected: true });
      expect(await remoteTip(repo, BRANCH)).toBe(theirs);
    });
  });

  it("deletes a remote branch only while it is at the tip dipo pushed", async () => {
    await withBareRemote(async (repo) => {
      const first = await published(repo);
      const office = officeGit(repo);
      await office.run((s) => createBranch(s, BRANCH, first));
      await office.run((s) => pushBranch(s, "origin", BRANCH));
      // A push lands on the remote branch after dipo's.
      const later = await commitOnMain(repo, "later.txt");
      await repo.git("push", "--quiet", "origin", `${later}:refs/heads/${BRANCH}`);

      const refused = await office.run((s) => deleteRemoteBranch(s, "origin", BRANCH, first));
      expect(refused.ok).toBe(false);
      expect(refused.ok ? "" : refused.problem).toContain("stale info");
      expect(await remoteTip(repo, BRANCH)).toBe(later);

      // At the tip the lease names, the delete goes through; a branch already gone is fine.
      expect(await office.run((s) => deleteRemoteBranch(s, "origin", BRANCH, later))).toEqual({
        ok: true,
      });
      expect(await remoteTip(repo, BRANCH)).toBeNull();
      expect(await office.run((s) => deleteRemoteBranch(s, "origin", BRANCH, later))).toEqual({
        ok: true,
      });
    });
  });
});
