// Further hardening of engine git calls against temp repositories (DIPO-31 review): inherited
// config variables are dropped, `_base` checkouts run no LFS smudge filter, fetch never allows the
// `ext::` transport, and worktree links are absolute or resolved against the file that holds them.

import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import {
  ManualClock,
  type TempRepoWithRemote,
  withBareRemote,
} from "@dipsaus-orchestrator/testkit";

import type { Spawn, SpawnOptions } from "@dipsaus-orchestrator/contract";

import { EngineGit, OfficeGit, spawnGitExec } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import { createRepoFiles } from "../../src/platform/repo-files";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z00000001" as OfficeId;

function officeGit(
  repo: TempRepoWithRemote,
  options: { remote?: string; env?: Record<string, string> } = {},
): OfficeGit {
  return new OfficeGit({
    officeId: OFFICE,
    mainWorktree: realpathSync(repo.dir),
    commonDir: realpathSync(join(repo.dir, ".git")),
    settings: { remote: options.remote ?? "origin", base: "main" },
    runner: {
      exec: spawnGitExec(systemSpawn),
      env: { ...repo.env, ...options.env },
      sleep: async () => {},
    },
    clock: new ManualClock(),
  });
}

/** A script that appends its name to `marker`; returns its path. */
function markerScript(repo: TempRepoWithRemote, name: string, marker: string): string {
  const path = join(repo.root, name);
  writeFileSync(path, `#!/bin/sh\necho "${name}" >> "${marker}"\ncat\n`);
  chmodSync(path, 0o755);
  return path;
}

async function published(repo: TempRepoWithRemote, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) writeFileSync(join(repo.dir, path), content);
  await repo.commitAll("first");
  await repo.git("push", "--quiet", "origin", "main");
}

describe("the inherited environment", () => {
  it("cannot add config through GIT_CONFIG_COUNT, GIT_CONFIG_KEY_n or GIT_CONFIG_GLOBAL", async () => {
    await withBareRemote(async (repo) => {
      await published(repo, { "README.md": "hello\n" });
      const global = join(repo.root, "planted.gitconfig");
      writeFileSync(global, "[dipo]\n\tglobal = planted\n");
      const planted = {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "dipo.count",
        GIT_CONFIG_VALUE_0: "planted",
        GIT_CONFIG_GLOBAL: global,
      };
      // The plant works for plain git.
      const plain = await repo.run(["git", "config", "--get-regexp", "^dipo\\."]);
      expect(plain.stdout).toBe("");
      const control = await systemSpawnText(repo, planted);
      expect(control).toContain("dipo.count planted");
      expect(control).toContain("dipo.global planted");

      const office = officeGit(repo, { env: planted });
      const result = await office.run((session) =>
        session.step(session.repository, ["config", "--get-regexp", "^dipo\\."]),
      );
      expect(result.stdout).toBe("");
    });
  });
});

/** Plain git (not hardened) with extra environment, for control assertions. */
async function systemSpawnText(
  repo: TempRepoWithRemote,
  env: Record<string, string>,
): Promise<string> {
  const exec = spawnGitExec(systemSpawn);
  const result = await exec({
    args: ["config", "--get-regexp", "^dipo\\."],
    env: { ...repo.env, ...env },
    cwd: repo.dir,
  });
  return result.stdout;
}

describe("_base checkouts", () => {
  it("run no LFS smudge or process filter", async () => {
    await withBareRemote(async (repo) => {
      await published(repo, {
        ".gitattributes": "*.bin filter=lfs\n",
        "data.bin": "pointer\n",
      });
      const marker = join(repo.root, "ran");
      await repo.git("config", "filter.lfs.smudge", markerScript(repo, "smudge.sh", marker));
      // The plant works for plain git.
      rmSync(join(repo.dir, "data.bin"));
      await repo.git("checkout", "--", "data.bin");
      expect(readFileSync(marker, "utf8")).toContain("smudge.sh");
      rmSync(marker);
      await repo.git("config", "filter.lfs.process", markerScript(repo, "process.sh", marker));

      const office = officeGit(repo);
      expect((await office.fetch()).ok).toBe(true);
      const base = office.baseWorktreePath();
      expect(readFileSync(join(base, "data.bin"), "utf8")).toBe("pointer\n");

      // A move runs `checkout`, which must not smudge either.
      const other = join(repo.root, "other");
      await repo.run(["git", "clone", "--quiet", repo.remote, other], repo.root);
      writeFileSync(join(other, "more.bin"), "second pointer\n");
      await repo.run(["git", "add", "more.bin"], other);
      await repo.run(["git", "commit", "--quiet", "-m", "more"], other);
      await repo.run(["git", "push", "--quiet", "origin", "HEAD:main"], other);
      expect(await office.fetch()).toMatchObject({ ok: true, moved: true });
      expect(readFileSync(join(base, "more.bin"), "utf8")).toBe("second pointer\n");
      expect(existsSync(marker)).toBe(false);
    });
  });
});

describe("fetch", () => {
  it("never runs the ext:: transport, even when repository config allows it", async () => {
    await withBareRemote(async (repo) => {
      await published(repo, { "README.md": "hello\n" });
      const marker = join(repo.root, "ran");
      await repo.git("remote", "add", "evil", `ext::sh -c touch% ${marker}`);
      await repo.git("config", "protocol.ext.allow", "always");
      // The plant works for plain git.
      await repo.run(["git", "fetch", "--quiet", "evil"]);
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);

      const office = officeGit(repo, { remote: "evil" });
      const outcome = await office.fetch();
      expect(outcome.ok).toBe(false);
      expect(existsSync(marker)).toBe(false);
    });
  });
});

describe("worktree links", () => {
  it("are written absolute, even when repository config asks for relative paths", async () => {
    await withBareRemote(async (repo) => {
      await published(repo, { "README.md": "hello\n" });
      await repo.git("config", "worktree.useRelativePaths", "true");
      const office = officeGit(repo);
      await office.fetch();
      const base = office.baseWorktreePath();
      const admin = office.adminDirOf(base);
      expect(admin).not.toBeNull();
      expect(isAbsolute(readFileSync(join(admin ?? "", "gitdir"), "utf8").trim())).toBe(true);
      const pointer = readFileSync(join(base, ".git"), "utf8").trim();
      expect(isAbsolute(pointer.slice("gitdir: ".length))).toBe(true);
    });
  });

  it("resolve a relative gitdir against the file that holds it", async () => {
    await withBareRemote(async (repo) => {
      await published(repo, { "README.md": "hello\n" });
      const office = officeGit(repo);
      await office.fetch();
      const base = office.baseWorktreePath();
      const admin = office.adminDirOf(base) ?? "";
      writeFileSync(join(admin, "gitdir"), `${relative(admin, join(base, ".git"))}\n`);
      writeFileSync(join(base, ".git"), `gitdir: ${relative(base, admin)}\n`);

      expect(office.adminDirOf(base)).toBe(admin);
      expect(office.worktreeLocation(base)).toMatchObject({ gitDir: admin, workTree: base });
      expect(await office.ensureBaseWorktree()).toMatchObject({ path: base });
    });
  });
});

describe("the git executable", () => {
  it("is the absolute path the daemon resolved", async () => {
    const seen: SpawnOptions[] = [];
    const spawn: Spawn = (options) => {
      seen.push(options);
      return {
        pid: 1,
        stdin: null,
        stdout: new Response("git version 2.40.0\n").body as ReadableStream<Uint8Array>,
        stderr: new Response("").body as ReadableStream<Uint8Array>,
        exited: Promise.resolve({ code: 0, signal: null }),
        kill: () => {},
      };
    };
    const engine = new EngineGit({ spawn, git: "/opt/dipo-test/bin/git", env: {} });
    const refused = await engine.attach({
      officeId: OFFICE,
      office: undefined as never,
      path: "/repo",
      commonDir: "/repo/.git",
      config: undefined,
      clock: new ManualClock(),
      ids: { next: () => "x" },
    });
    expect(refused).toBeNull();
    expect(seen.map((options) => options.cmd[0])).toEqual(["/opt/dipo-test/bin/git"]);
  });
});

describe("the scan's git calls", () => {
  it("drop inherited GIT_DIR and GIT_INDEX_FILE and use the hardened environment", async () => {
    await withBareRemote(async (repo) => {
      await published(repo, { "README.md": "hello\n", "notes.txt": "notes\n" });
      const files = createRepoFiles(repo.dir, {
        env: {
          ...repo.env,
          GIT_DIR: join(repo.root, "elsewhere.git"),
          GIT_INDEX_FILE: join(repo.root, "elsewhere.index"),
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "status.showUntrackedFiles",
          GIT_CONFIG_VALUE_0: "no",
        },
      });
      expect((await files.listFiles()).toSorted()).toEqual(["README.md", "notes.txt"]);
      expect(existsSync(join(repo.root, "elsewhere.index"))).toBe(false);
    });
  });
});
