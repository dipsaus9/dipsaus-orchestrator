// The box's own git repository (DIPO-346, 0008): dipo's init script, run under the real /bin/sh
// and git on a folder that stands in for the box's `/work` (the script's only path is swapped for
// it). The script makes a repository that shares nothing with the maintainer's: one commit of the
// start state, its own identity, no hooks, no remote and no history, and it refuses a `/work` that
// already holds a `.git` of any kind. A catch-up's commit (DIPO-464) runs the same way: only the
// merged paths go into a commit of its own, so the worker's git diff shows only its own work. The
// calls `BoxWorkers.create` makes are in workers.test.ts, and the repository in a real box is in
// box-git.box.test.ts.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { cleanEnv, withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  BOX_GIT_BRANCH,
  BOX_GIT_CATCH_UP_INDEX,
  BOX_GIT_ENV,
  BOX_GIT_EXISTS_EXIT,
  BOX_GIT_IDENTITY,
  BOX_GIT_START_SUBJECT,
  boxGitCatchUpCommand,
  boxGitInitCommand,
  commitInBoxRepository,
} from "../../src/box/box-git";
import type { BoxPort } from "../../src/box/port";
import { BOX_WORKDIR } from "../../src/box/code";

/** An environment like the box user's: a home of its own, plus what the script's env sets. */
function boxEnv(home: string): Record<string, string> {
  const env = cleanEnv();
  return { PATH: env["PATH"] ?? "/usr/bin:/bin", HOME: home, ...BOX_GIT_ENV };
}

function init(work: string, home: string): { status: number | null; stderr: string } {
  const [shell, flag, script] = boxGitInitCommand();
  const ran = spawnSync(shell, [flag, script.replaceAll(`'${BOX_WORKDIR}'`, `'${work}'`)], {
    env: boxEnv(home),
    encoding: "utf8",
  });
  return { status: ran.status, stderr: ran.stderr };
}

function git(work: string, home: string, ...args: string[]): string {
  const ran = spawnSync("git", args, { cwd: work, env: boxEnv(home), encoding: "utf8" });
  expect(ran.stderr).toBe("");
  expect(ran.status).toBe(0);
  return ran.stdout;
}

function code(work: string): void {
  mkdirSync(join(work, "src"), { recursive: true });
  writeFileSync(join(work, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(work, ".gitignore"), "node_modules/\n.env\n");
  writeFileSync(join(work, ".env"), "TOKEN=listed-file\n");
  mkdirSync(join(work, "node_modules", "x"), { recursive: true });
  writeFileSync(join(work, "node_modules", "x", "index.js"), "ignored\n");
}

describe("the box's own git repository", () => {
  it("is a fixed script with no path but /work, run by the box user's shell", () => {
    const command = boxGitInitCommand();
    expect(command.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(command).toHaveLength(3);
    const script = command[2];
    expect(script).toContain(`cd '${BOX_WORKDIR}'`);
    expect(script).toContain("git init -q --template= -b 'main'");
    expect(script).toContain("git commit -q --no-verify --allow-empty");
    expect([...new Set(script.match(/\/[A-Za-z][^\s'"]*/g))]).toEqual([BOX_WORKDIR]);
  });

  it("commits the start state as one commit with its own identity, and shares nothing else", () =>
    withTempDir(async (dir) => {
      const work = join(dir, "work");
      const home = join(dir, "home");
      mkdirSync(home);
      code(work);
      expect(init(work, home)).toEqual({ status: 0, stderr: "" });
      expect(git(work, home, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(BOX_GIT_BRANCH);
      expect(git(work, home, "log", "--format=%s|%an|%ae|%cn").trim()).toBe(
        `${BOX_GIT_START_SUBJECT}|${BOX_GIT_IDENTITY.name}|${BOX_GIT_IDENTITY.email}|${BOX_GIT_IDENTITY.name}`,
      );
      // What git ignores stays out of the start commit, and the tree is clean.
      expect(git(work, home, "ls-files").trim().split("\n")).toEqual([".gitignore", "src/a.ts"]);
      expect(git(work, home, "status", "--porcelain")).toBe("");
      // No remote, no other ref, no hooks and nothing in its config but its own identity.
      expect(git(work, home, "remote")).toBe("");
      expect(git(work, home, "for-each-ref", "--format=%(refname)").trim()).toBe(
        `refs/heads/${BOX_GIT_BRANCH}`,
      );
      expect(existsSync(join(work, ".git", "hooks"))).toBe(false);
      const config = git(work, home, "config", "--local", "--list").trim().split("\n");
      expect(
        config.filter((line) => /^(remote|core\.hookspath|include|url)\b/i.test(line)),
      ).toEqual([]);
      expect(config).toContain(`user.name=${BOX_GIT_IDENTITY.name}`);
      // The worker's own commit works in it.
      writeFileSync(join(work, "src", "a.ts"), "export const a = 2;\n");
      git(work, home, "commit", "-qam", "Work in the box");
      expect(git(work, home, "rev-list", "--count", "HEAD").trim()).toBe("2");
    }));

  it("commits an empty /work too", () =>
    withTempDir(async (dir) => {
      const work = join(dir, "work");
      mkdirSync(work);
      expect(init(work, dir).status).toBe(0);
      expect(git(work, dir, "rev-list", "--count", "HEAD").trim()).toBe("1");
    }));

  for (const [what, plant] of [
    ["a .git folder", (work: string) => mkdirSync(join(work, ".git"))],
    ["a .git file", (work: string) => writeFileSync(join(work, ".git"), "gitdir: /elsewhere\n")],
    ["a .git link", (work: string) => symlinkSync("/nowhere", join(work, ".git"))],
  ] as const) {
    it(`refuses a /work that already holds ${what}, and changes nothing`, () =>
      withTempDir(async (dir) => {
        const work = join(dir, "work");
        code(work);
        plant(work);
        const before = readdirSync(work).toSorted();
        const ran = init(work, dir);
        expect(ran.status).toBe(BOX_GIT_EXISTS_EXIT);
        expect(ran.stderr).toContain("already holds .git");
        expect(readdirSync(work).toSorted()).toEqual(before);
      }));
  }
});

/**
 * The box interface's exec on the Mac for the catch-up commit's steps: the script's `/work` swapped
 * for `work`, run by the real /bin/sh and git with the box user's environment.
 */
function localBox(work: string, home: string): Pick<BoxPort, "exec"> {
  return {
    exec: async (_box, command, options) => {
      const [shell, flag, script, ...rest] = command;
      const ran = spawnSync(
        shell,
        [flag ?? "", (script ?? "").replaceAll(`'${BOX_WORKDIR}'`, `'${work}'`), ...rest],
        { env: { ...boxEnv(home), ...options?.env }, encoding: "utf8" },
      );
      return { code: ran.status, stdout: ran.stdout, stderr: ran.stderr };
    },
  };
}

describe("a catch-up's commit in the box's own git (DIPO-464)", () => {
  it("is a fixed script with no path but /work, its paths and subject passed as argv", () => {
    const command = boxGitCatchUpCommand("add", ["src/b.ts", "-rf"]);
    expect(command.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(command.slice(3)).toEqual(["dipo-box-git", "add", "src/b.ts", "-rf"]);
    const script = command[2] ?? "";
    expect(script).toContain(`cd '${BOX_WORKDIR}'`);
    expect(script).toContain('git update-index --add --remove -- "$@"');
    expect([...new Set(script.match(/(?<![.\w])\/[A-Za-z][^\s'"]*/g))]).toEqual([BOX_WORKDIR]);
  });

  it("commits only the merged paths as a commit of its own, so git log shows the base and git diff only the worker's work", () =>
    withTempDir(async (dir) => {
      const work = join(dir, "work");
      const home = join(dir, "home");
      mkdirSync(home);
      code(work);
      writeFileSync(join(work, "src", "gone.ts"), "gone\n");
      expect(init(work, home).status).toBe(0);
      const start = git(work, home, "rev-parse", "HEAD").trim();
      // The worker's own work, one file staged: stays out of dipo's commit.
      writeFileSync(join(work, "src", "a.ts"), "export const a = 2;\n");
      writeFileSync(join(work, "src", "mine.ts"), "mine\n");
      git(work, home, "add", "src/mine.ts");
      // dipo copied the merge in: a changed file, a new one, a removed one.
      mkdirSync(join(work, "lib"));
      writeFileSync(join(work, "lib", "base.ts"), "from the base\n");
      writeFileSync(join(work, ".gitignore"), "node_modules/\n.env\ndist/\n");
      rmSync(join(work, "src", "gone.ts"));
      const commit = await commitInBoxRepository(
        localBox(work, home),
        "box",
        "Merge main into DIPO-1/one",
        [".gitignore", "lib/base.ts", "src/gone.ts"],
      );
      expect(commit).toMatch(/^[0-9a-f]{40}$/);
      expect(git(work, home, "rev-parse", "HEAD").trim()).toBe(commit);
      expect(git(work, home, "rev-parse", "HEAD^").trim()).toBe(start);
      expect(git(work, home, "log", "-1", "--format=%s|%an").trim()).toBe(
        `Merge main into DIPO-1/one|${BOX_GIT_IDENTITY.name}`,
      );
      expect(
        git(work, home, "show", "--name-status", "--format=", "HEAD").trim().split("\n"),
      ).toEqual(["M\t.gitignore", "A\tlib/base.ts", "D\tsrc/gone.ts"]);
      // git diff (work tree against the index) and git diff HEAD: only the worker's own work.
      expect(git(work, home, "diff", "--name-only").trim()).toBe("src/a.ts");
      expect(git(work, home, "diff", "--name-only", "HEAD").trim().split("\n")).toEqual([
        "src/a.ts",
        "src/mine.ts",
      ]);
      expect(git(work, home, "status", "--porcelain").trim().split("\n")).toEqual([
        "M src/a.ts",
        "A  src/mine.ts",
      ]);
      expect(existsSync(join(work, BOX_GIT_CATCH_UP_INDEX))).toBe(false);
    }));

  it("takes odd file names as plain paths: a space, a quote, a newline, a leading dash, a command substitution", () =>
    withTempDir(async (dir) => {
      const work = join(dir, "work");
      const home = join(dir, "home");
      mkdirSync(home);
      code(work);
      expect(init(work, home).status).toBe(0);
      const odd = [
        "src/with space.ts",
        "src/it's quoted.ts",
        'src/"double".ts',
        "src/new\nline.ts",
        "-rf",
        "--force",
        "src/$(touch pwned).ts",
        "src/`touch pwned2`.ts",
      ];
      for (const path of odd) writeFileSync(join(work, path), `${path}\n`);
      const commit = await commitInBoxRepository(localBox(work, home), "box", "Merge main", odd);
      expect(commit).toMatch(/^[0-9a-f]{40}$/);
      const committed = git(work, home, "show", "-z", "--name-only", "--format=", "HEAD")
        .split("\0")
        .filter((path) => path !== "");
      expect(committed.toSorted()).toEqual([...odd].toSorted());
      // No name ran as a command or an option.
      expect(existsSync(join(work, "pwned"))).toBe(false);
      expect(existsSync(join(work, "src", "pwned"))).toBe(false);
      expect(existsSync(join(work, "pwned2"))).toBe(false);
      expect(existsSync(join(work, "src", "pwned2"))).toBe(false);
      expect(existsSync(join(work, "src", "a.ts"))).toBe(true);
      expect(git(work, home, "status", "--porcelain")).toBe("");
    }));

  it("commits nothing in a box without its repository, or for paths the merge left as they were", () =>
    withTempDir(async (dir) => {
      const work = join(dir, "work");
      const home = join(dir, "home");
      mkdirSync(home);
      code(work);
      const box = localBox(work, home);
      expect(await commitInBoxRepository(box, "box", "Merge main", ["src/a.ts"])).toBe("none");
      expect(existsSync(join(work, ".git"))).toBe(false);
      expect(init(work, home).status).toBe(0);
      const head = git(work, home, "rev-parse", "HEAD").trim();
      expect(await commitInBoxRepository(box, "box", "Merge main", ["src/a.ts"])).toBe("same");
      expect(await commitInBoxRepository(box, "box", "Merge main", [])).toBe("same");
      expect(git(work, home, "rev-parse", "HEAD").trim()).toBe(head);
    }));

  it("throws when a step fails, and leaves HEAD where it was", () =>
    withTempDir(async (dir) => {
      const work = join(dir, "work");
      const home = join(dir, "home");
      mkdirSync(home);
      code(work);
      expect(init(work, home).status).toBe(0);
      const head = git(work, home, "rev-parse", "HEAD").trim();
      writeFileSync(join(work, "src", "a.ts"), "merged\n");
      writeFileSync(join(work, ".git", "index.lock"), "");
      await expect(
        commitInBoxRepository(localBox(work, home), "box", "Merge main", ["src/a.ts"]),
      ).rejects.toThrow("the catch-up commit in the box's git repository failed at add");
      expect(git(work, home, "rev-parse", "HEAD").trim()).toBe(head);
    }));
});
