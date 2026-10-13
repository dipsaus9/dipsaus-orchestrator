// Engine git against real temporary repositories (DIPO-31; 0010 sections 2 and 7, 0008 section 2):
// planted hooks and fsmonitor never run, `_base` follows `origin/main`, the worktree root stays
// outside the main checkout, a failed fetch holds only pickup and planning pushes, a held lock is
// retried and never deleted, and no operation writes the main checkout. The planted hooks through
// fetches and `_base` run in CI only, in office-git.ci.test.ts (DIPO-79).

import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import {
  git,
  ManualClock,
  type TempRepoWithRemote,
  withBareRemote,
  withTempRepo,
} from "@dipsaus-orchestrator/testkit";

import { EngineGit, type GitError } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import { BACKLOG_FIXTURE, errorOf, officeSetup, resultOf, send } from "../office/helpers";

import { OFFICE, officeGit, published, pushFromElsewhere, type Repo } from "./helpers";

async function headOf(repo: Repo, worktree: string): Promise<string> {
  return (await git(worktree, repo.home, "rev-parse", "HEAD")).trim();
}

async function caught(promise: Promise<unknown>): Promise<GitError> {
  return (await promise.then(
    () => {
      throw new Error("expected a GitError");
    },
    (thrown: unknown) => thrown,
  )) as GitError;
}

/** Everything a write to the main checkout would change. */
async function checkoutState(repo: TempRepoWithRemote): Promise<string[]> {
  return Promise.all([
    repo.git("status", "--porcelain=v1", "--untracked-files=all", "--ignored"),
    repo.git("rev-parse", "HEAD"),
    repo.git("symbolic-ref", "HEAD"),
    repo.git("stash", "list"),
    repo.git("diff", "--cached"),
    repo.git("diff"),
  ]);
}

describe("hardened engine git calls", () => {
  // The fast local version: queue calls on the repository and a linked worktree, no remote. The
  // full case through fetches and the `_base` worktree is in office-git.ci.test.ts (DIPO-79).
  it("never run a planted core.hooksPath or core.fsmonitor", async () => {
    await withTempRepo(async (repo) => {
      writeFileSync(join(repo.dir, "README.md"), "hello\n");
      await repo.commitAll("first");
      const linked = join(repo.root, "linked");
      await repo.git("worktree", "add", "--quiet", "--detach", linked);
      const marker = join(repo.root, "ran");
      const hooks = join(repo.root, "hooks");
      mkdirSync(hooks);
      const script = `#!/bin/sh\necho "$0" >> "${marker}"\n`;
      for (const hook of ["post-checkout", "reference-transaction", "post-index-change"]) {
        writeFileSync(join(hooks, hook), script);
        chmodSync(join(hooks, hook), 0o755);
      }
      const fsmonitor = join(repo.root, "fsmonitor.sh");
      writeFileSync(fsmonitor, script);
      chmodSync(fsmonitor, 0o755);
      await repo.git("config", "core.hooksPath", hooks);
      await repo.git("config", "core.fsmonitor", fsmonitor);

      // The plant works for plain git.
      await repo.git("update-ref", "refs/dipo-control", "HEAD");
      await repo.git("status", "--porcelain");
      expect(readFileSync(marker, "utf8")).toContain("reference-transaction");
      expect(readFileSync(marker, "utf8")).toContain("fsmonitor.sh");
      rmSync(marker);

      const office = officeGit(repo);
      await office.run(async (session) => {
        const location = office.worktreeLocation(realpathSync(linked));
        await session.ok(location, ["status", "--porcelain"]);
        await session.ok(location, ["update-index", "--refresh"]);
        await session.ok(session.repository, ["update-ref", "refs/dipo-engine", "HEAD"]);
      });
      expect(existsSync(marker)).toBe(false);
    });
  });
});

describe("the _base read worktree", () => {
  it("is created detached at origin/main and follows it after a push", async () => {
    await withBareRemote(async (repo) => {
      const first = await published(repo);
      const office = officeGit(repo, { base: undefined });
      await repo.git("remote", "set-head", "origin", "main");
      expect(await office.resolveBase()).toBe("main");

      const fetched = await office.fetch();
      expect(fetched).toMatchObject({ ok: true, base: "main" });
      const base = office.baseWorktreePath();
      expect(base).toBe(join(realpathSync(repo.root), "repo.worktrees", "_base"));
      expect(await headOf(repo, base)).toBe(first);
      const detached = await repo.run(["git", "symbolic-ref", "--quiet", "HEAD"], base);
      expect(detached.exitCode).not.toBe(0);

      const second = await pushFromElsewhere(repo, "second.txt");
      expect(await headOf(repo, base)).toBe(first);
      expect(await office.fetch()).toMatchObject({
        ok: true,
        moved: true,
        baseWorktree: { path: base, base: "main", sha: second },
      });
      expect(await headOf(repo, base)).toBe(second);
      expect(existsSync(join(base, "second.txt"))).toBe(true);

      // A fetch that moves nothing leaves it where it is.
      expect(await office.fetch()).toMatchObject({ ok: true, moved: false });
      expect(await headOf(repo, base)).toBe(second);
    });
  });

  it("is re-created when its directory was removed", async () => {
    await withBareRemote(async (repo) => {
      const first = await published(repo);
      const office = officeGit(repo);
      await office.fetch();
      rmSync(office.baseWorktreePath(), { recursive: true });
      expect(await office.ensureBaseWorktree()).toMatchObject({ sha: first });
      expect(await headOf(repo, office.baseWorktreePath())).toBe(first);
    });
  });

  it("leaves a directory it does not own alone", async () => {
    await withBareRemote(async (repo) => {
      await published(repo);
      const office = officeGit(repo);
      await office.run((session) => session.ok(session.repository, ["fetch", "--quiet", "origin"]));
      mkdirSync(office.baseWorktreePath(), { recursive: true });
      writeFileSync(join(office.baseWorktreePath(), "mine.txt"), "keep\n");
      expect((await caught(office.ensureBaseWorktree())).code).toBe("git.basePathTaken");
      expect(readFileSync(join(office.baseWorktreePath(), "mine.txt"), "utf8")).toBe("keep\n");
    });
  });

  it("fails clearly when neither configuration nor origin/HEAD names the base", async () => {
    await withTempRepo(async (repo) => {
      await repo.commitAll("first");
      const office = officeGit(repo, { base: undefined });
      const error = await caught(office.ensureBaseWorktree());
      expect(error.code).toBe("git.baseUnknown");
      expect(error.message).toContain("no base branch");
    });
  });
});

describe("the worktree root", () => {
  it("defaults to ../<repo>.worktrees as an absolute path", async () => {
    await withTempRepo(async (repo) => {
      expect(officeGit(repo, { worktreeRoot: undefined }).worktreeRoot()).toBe(
        join(realpathSync(repo.root), "repo.worktrees"),
      );
      expect(officeGit(repo, { worktreeRoot: "../trees/{repo}" }).worktreeRoot()).toBe(
        join(realpathSync(repo.root), "trees", "repo"),
      );
    });
  });

  it("is refused inside the main checkout", async () => {
    await withBareRemote(async (repo) => {
      await published(repo);
      for (const root of ["worktrees", ".", "./a/../b", `${repo.dir}/nested`]) {
        const office = officeGit(repo, { worktreeRoot: root });
        expect((await caught(office.ensureBaseWorktree())).code).toBe("git.rootInsideCheckout");
      }
      expect(existsSync(join(repo.dir, "worktrees"))).toBe(false);
      expect(existsSync(join(repo.dir, "_base"))).toBe(false);
    });
  });
});

describe("a failed fetch", () => {
  it("makes pickup and planning pushes wait with a retryable error while other work continues", async () => {
    await withBareRemote(async (repo) => {
      const first = await published(repo);
      const office = officeGit(repo);
      await office.fetch();
      office.assertFetched();

      renameSync(repo.remote, `${repo.remote}.away`);
      const failed = await office.fetch();
      expect(failed.ok).toBe(false);
      if (failed.ok) return;
      expect(failed.error).toMatchObject({ code: "git.fetchFailed", retryable: true });
      expect(office.lastFetch).toMatchObject({ ok: false });
      let gate: unknown;
      try {
        office.assertFetched();
      } catch (thrown) {
        gate = thrown;
      }
      expect(gate).toMatchObject({ code: "git.fetchFailed", retryable: true });

      // Other queue items still run.
      expect(await office.ensureBaseWorktree()).toMatchObject({ sha: first });
      expect(await office.resolveBase()).toBe("main");

      renameSync(`${repo.remote}.away`, repo.remote);
      expect((await office.fetch()).ok).toBe(true);
      office.assertFetched();
    });
  });
});

describe("a held lock", () => {
  it("is retried three times, then fails the step, and the lock file stays", async () => {
    await withBareRemote(async (repo) => {
      await published(repo);
      const delays: number[] = [];
      const office = officeGit(repo, {}, async (ms) => void delays.push(ms));
      await office.fetch();
      const admin = office.adminDirOf(office.baseWorktreePath());
      expect(admin).not.toBeNull();
      const lock = join(admin ?? "", "index.lock");
      writeFileSync(lock, "");

      const second = await pushFromElsewhere(repo, "second.txt");
      const error = await caught(office.fetch());
      expect(error.code).toBe("git.lockHeld");
      expect(delays).toHaveLength(3);
      expect(existsSync(lock)).toBe(true);

      rmSync(lock);
      expect(await office.ensureBaseWorktree()).toMatchObject({ sha: second });
    });
  });
});

describe("the main checkout", () => {
  it("is never written by any queue operation", async () => {
    await withBareRemote(async (repo) => {
      await published(repo);
      writeFileSync(join(repo.dir, "README.md"), "changed\n");
      writeFileSync(join(repo.dir, "staged.txt"), "staged\n");
      await repo.git("add", "staged.txt");
      writeFileSync(join(repo.dir, "untracked.txt"), "untracked\n");
      writeFileSync(join(repo.dir, ".gitignore"), "ignored.txt\n");
      writeFileSync(join(repo.dir, "ignored.txt"), "ignored\n");
      await repo.git("remote", "set-head", "origin", "main");
      const before = await checkoutState(repo);

      const delays: number[] = [];
      const office = officeGit(repo, { base: undefined }, async (ms) => void delays.push(ms));
      const engine = new EngineGit({ spawn: systemSpawn, env: repo.env });
      expect(
        await engine.attach({
          officeId: OFFICE,
          office: undefined as never,
          path: office.mainWorktree,
          commonDir: office.commonDir,
          config: undefined,
          clock: new ManualClock(),
          ids: { next: () => "x" },
        }),
      ).toBeNull();
      await office.resolveBase();
      await office.fetch();
      await pushFromElsewhere(repo, "second.txt");
      await office.fetch();
      await office.ensureBaseWorktree();
      await office.run((session) =>
        session.ok(office.worktreeLocation(office.baseWorktreePath()), ["status", "--porcelain"]),
      );
      const lock = join(office.adminDirOf(office.baseWorktreePath()) ?? "", "index.lock");
      writeFileSync(lock, "");
      await pushFromElsewhere(repo, "third.txt");
      await caught(office.fetch());
      rmSync(lock);
      await office.ensureBaseWorktree();
      renameSync(repo.remote, `${repo.remote}.away`);
      await office.fetch();
      renameSync(`${repo.remote}.away`, repo.remote);
      await caught(officeGit(repo, { worktreeRoot: "inside" }).ensureBaseWorktree());

      expect(await checkoutState(repo)).toEqual(before);
    });
  });
});

describe("the git.version load step", () => {
  it("loads an office with a supported git and records its paths", async () => {
    await withTempRepo(
      async (repo) => {
        const engine = new EngineGit({ spawn: systemSpawn, env: repo.env });
        const s = await officeSetup(repo.root, { features: [engine.feature] });
        const office = resultOf<{ office: OfficeId }>(
          await send(s, "office.open", { path: repo.dir }),
        ).office;
        resultOf(await send(s, "fixture.ping", {}, office));
        expect(engine.forOffice(office)).toMatchObject({
          mainWorktree: realpathSync(repo.dir),
          commonDir: realpathSync(join(repo.dir, ".git")),
          settings: { remote: "origin", worktreeRoot: "../{repo}.worktrees" },
        });
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("refuses the office with a notice naming a git older than 2.38", async () => {
    await withTempRepo(
      async (repo) => {
        const engine = new EngineGit({
          exec: async (call) => ({
            code: 0,
            stdout: call.args.includes("--version") ? "git version 2.37.1\n" : "",
            stderr: "",
          }),
        });
        const s = await officeSetup(repo.root, { features: [engine.feature] });
        const office = resultOf<{ office: OfficeId }>(
          await send(s, "office.open", { path: repo.dir }),
        ).office;
        const reply = await send(s, "fixture.ping", {}, office);
        expect(errorOf(reply)).toBe("office.refused");
        expect(!reply.ok && reply.error.details).toMatchObject({ step: "git.version" });
        const notice = s.events.at(-1);
        expect(notice?.type).toBe("engine.notice");
        const text = (notice?.data as { text?: string } | undefined)?.text ?? "";
        expect(text).toContain("git 2.37.1 is older than 2.38");
        expect(engine.forOffice(office)).toBeUndefined();
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });
});
