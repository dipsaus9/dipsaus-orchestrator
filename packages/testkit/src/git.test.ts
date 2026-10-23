// Integration tests on real temporary git repositories (0017 section 3). The Backlog.md fixture
// against the pinned CLI runs in CI only, in git.ci.test.ts (DIPO-79).

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { GIT_DATE, GIT_IDENTITY, isolatedEnv, withBareRemote, withTempRepo } from "./git";
import { tempRoot } from "./temp";

const hashOnce = () =>
  withTempRepo((repo) => repo.commitAll("fixed"), { fixture: { "a.txt": "a\n" } });

describe("withTempRepo", () => {
  it("creates dipo-XXXXXX under the temp root with a repository on main, then removes it", async () => {
    let root = "";
    await withTempRepo(async (repo) => {
      root = repo.root;
      expect(basename(repo.root)).toMatch(/^dipo-[A-Za-z0-9]{6}$/);
      expect(dirname(repo.root)).toBe(realpathSync(tempRoot()));
      expect((await repo.git("symbolic-ref", "--short", "HEAD")).trim()).toBe("main");
      expect((await repo.git("rev-parse", "--show-toplevel")).trim()).toBe(repo.dir);
    });
    if (process.env["DIPO_TEST_KEEP"] !== "1") expect(existsSync(root)).toBe(false);
  });

  it("applies a fixture tree given as files", async () => {
    await withTempRepo(
      async (repo) => {
        expect(readFileSync(join(repo.dir, "src/a.txt"), "utf8")).toBe("alpha\n");
        expect((await repo.git("status", "--porcelain")).trim()).toBe("?? README\n?? src/");
      },
      { fixture: { README: "hello\n", "src/a.txt": "alpha\n" } },
    );
  });

  it("isolates git from the maintainer's config, identity, dates and signing", async () => {
    await withTempRepo(
      async (repo) => {
        expect(repo.env["HOME"]).toBe(repo.home);
        expect(repo.env["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
        expect(repo.env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
        const origins = (await repo.git("config", "--list", "--show-origin", "--show-scope"))
          .split("\n")
          .filter((line) => line !== "");
        expect(origins.filter((line) => !/^(local|command)\t/.test(line))).toEqual([]);
        expect((await repo.git("config", "commit.gpgsign")).trim()).toBe("false");
        expect((await repo.git("config", "tag.gpgsign")).trim()).toBe("false");
        // The repository's own config holds the identity and no signing, read as git reads it.
        expect(
          (await repo.git("config", "--local", "--list")).split("\n").filter((l) => l !== ""),
        ).toEqual(
          expect.arrayContaining([
            `user.name=${GIT_IDENTITY.name}`,
            `user.email=${GIT_IDENTITY.email}`,
            "commit.gpgsign=false",
            "tag.gpgsign=false",
          ]),
        );

        await repo.commitAll("first");
        const log = await repo.git("log", "-1", "--format=%an|%ae|%at|%cn|%ce|%ct|%G?");
        const who = `${GIT_IDENTITY.name}|${GIT_IDENTITY.email}`;
        const when = String(Date.parse(GIT_DATE) / 1000);
        expect(log.trim()).toBe(`${who}|${when}|${who}|${when}|N`);

        const shell = await repo.run(["sh", "-c", 'printf "%s" "$HOME"']);
        expect(shell.stdout).toBe(repo.home);
      },
      { fixture: { "a.txt": "a\n" } },
    );
  });

  it("gives the same commit hash on every run", async () => {
    expect(await hashOnce()).toBe(await hashOnce());
  });

  it("drops inherited GIT_*, ANTHROPIC_*, CLAUDE_* and GH_* variables", () => {
    const names = ["GIT_DIR", "ANTHROPIC_API_KEY", "CLAUDE_TESTKIT_PROBE", "GH_TOKEN"];
    const saved = names.map((name) => process.env[name]);
    for (const name of names) process.env[name] = "leak";
    try {
      const env = isolatedEnv("/nowhere");
      expect(names.map((name) => env[name])).toEqual([undefined, undefined, undefined, undefined]);
    } finally {
      names.forEach((name, i) => {
        const value = saved[i];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
    }
  });
});

describe("withBareRemote", () => {
  it("supports commit, push and fetch against a bare origin, and leaves nothing behind", async () => {
    let root = "";
    await withBareRemote(
      async (repo) => {
        root = repo.root;
        expect(dirname(repo.remote)).toBe(repo.root);
        expect((await repo.git("remote", "get-url", "origin")).trim()).toBe(repo.remote);

        const first = await repo.commitAll("first");
        await repo.git("push", "--quiet", "-u", "origin", "main");
        const remoteHead = await repo.run(["git", "rev-parse", "main"], repo.remote);
        expect(remoteHead.stdout.trim()).toBe(first);

        // A second clone pushes a commit; the first repository fetches it.
        const clone = join(repo.root, "clone");
        await repo.run(["git", "clone", "--quiet", repo.remote, clone], repo.root);
        await repo.run(["git", "commit", "--quiet", "--allow-empty", "-m", "second"], clone);
        const pushed = await repo.run(["git", "push", "--quiet", "origin", "main"], clone);
        expect(pushed.exitCode).toBe(0);

        await repo.git("fetch", "--quiet", "origin");
        const fetched = (await repo.git("log", "-1", "--format=%s", "origin/main")).trim();
        expect(fetched).toBe("second");
      },
      { fixture: { "a.txt": "a\n" } },
    );
    if (process.env["DIPO_TEST_KEEP"] !== "1") expect(existsSync(root)).toBe(false);
  });
});
