// Setup step 1 against a real temporary repository and a linked worktree (DIPO-39; 0010 section 8
// and its 0008 amendment): only paths git ignores in the new worktree are placed, copies keep
// their modes, links point into the main checkout, nothing follows a symlink, contents never reach
// the log, and `.claude/settings.local.json` loses its permission-widening and MCP keys.

import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { git, type TempRepo, withTempRepo } from "@dipsaus-orchestrator/testkit";

import {
  FileStepError,
  type FileStepResult,
  placeFiles,
  repoSegments,
  type WorktreeFileSpec,
} from "../../src/worktree";

const SECRET = "SECRET-VALUE-4f9a1c";

const GITIGNORE = [
  ".env",
  ".env.*",
  "!.env.example",
  "apps/server/.dev.vars",
  ".cache/",
  ".claude/settings.local.json",
  ".claude/notes.local.md",
  "data/",
  "partly/ignored.txt",
  "outside-link",
  "",
].join("\n");

interface Layout {
  readonly main: string;
  readonly worktree: string;
  readonly repo: TempRepo;
}

/** A repository with tracked and ignored files, and a fresh linked worktree on a new branch. */
async function layout(repo: TempRepo): Promise<Layout> {
  writeFileSync(join(repo.dir, ".gitignore"), GITIGNORE);
  writeFileSync(join(repo.dir, "config.json"), "{}\n");
  mkdirSync(join(repo.dir, "partly"));
  writeFileSync(join(repo.dir, "partly", "tracked.txt"), "tracked\n");
  mkdirSync(join(repo.dir, "apps", "server"), { recursive: true });
  writeFileSync(join(repo.dir, "apps", "server", "index.ts"), "export {};\n");
  await repo.commitAll("base");
  // Ignored files, created after the commit.
  writeFileSync(join(repo.dir, ".env"), `TOKEN=${SECRET}\n`);
  chmodSync(join(repo.dir, ".env"), 0o600);
  writeFileSync(join(repo.dir, "apps", "server", ".dev.vars"), `KEY=${SECRET}\n`);
  chmodSync(join(repo.dir, "apps", "server", ".dev.vars"), 0o640);
  mkdirSync(join(repo.dir, ".cache", "fixtures", "deep"), { recursive: true });
  writeFileSync(join(repo.dir, ".cache", "fixtures", "a.bin"), "a");
  writeFileSync(join(repo.dir, ".cache", "fixtures", "deep", "b.sh"), "#!/bin/sh\n");
  chmodSync(join(repo.dir, ".cache", "fixtures", "deep", "b.sh"), 0o755);
  writeFileSync(join(repo.dir, "partly", "ignored.txt"), "ignored\n");
  const worktree = join(repo.root, "wt");
  await repo.git("worktree", "add", "--quiet", "-b", "story", worktree);
  return { main: realpathSync(repo.dir), worktree: realpathSync(worktree), repo };
}

/** The real `git check-ignore` in the worktree. */
function ignoredIn(l: Layout): (paths: readonly string[]) => Promise<ReadonlySet<string>> {
  return async (paths) => {
    const result = await l.repo.run(["git", "check-ignore", "--", ...paths], l.worktree);
    if (result.exitCode > 1) throw new Error(result.stderr);
    return new Set(result.stdout.split("\n").filter((p) => p !== ""));
  };
}

function place(l: Layout, files: WorktreeFileSpec[], envFiles: string[] = []) {
  return placeFiles({
    main: l.main,
    worktree: l.worktree,
    files,
    ignored: ignoredIn(l),
    envFiles: new Set(envFiles),
  });
}

const copy = (path: string, required = false): WorktreeFileSpec => ({
  path,
  mode: "copy",
  required,
});

async function refused(promise: Promise<FileStepResult>): Promise<string> {
  return promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(FileStepError);
      return (error as Error).message;
    },
  );
}

describe("placing worktree files", () => {
  it("copies ignored files with their modes, links a directory and never logs contents", async () => {
    await withTempRepo(async (repo) => {
      const l = await layout(repo);
      const result = await place(l, [
        copy(".env"),
        copy("apps/server/.dev.vars", true),
        { path: ".cache/fixtures", mode: "link", required: false },
        copy("data/seed.sql"),
      ]);

      expect(result.copied).toEqual([".env", "apps/server/.dev.vars"]);
      expect(result.linked).toEqual([".cache/fixtures"]);
      expect(result.skipped).toEqual(["data/seed.sql"]);
      expect(result.envFiles).toEqual([".env", "apps/server/.dev.vars"]);
      expect(statSync(join(l.worktree, ".env")).mode & 0o777).toBe(0o600);
      expect(statSync(join(l.worktree, "apps/server/.dev.vars")).mode & 0o777).toBe(0o640);
      expect(readFileSync(join(l.worktree, ".env"), "utf8")).toBe(`TOKEN=${SECRET}\n`);
      expect(lstatSync(join(l.worktree, ".cache/fixtures")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(l.worktree, ".cache/fixtures"))).toBe(
        join(l.main, ".cache/fixtures"),
      );
      expect(result.log.join("\n")).not.toContain(SECRET);
      expect(JSON.stringify(result)).not.toContain(SECRET);
      // Nothing is tracked or staged in the worktree.
      expect(await git(l.worktree, repo.home, "status", "--porcelain")).toBe("");
    });
  });

  it("copies a directory file by file with modes, all checked as ignored", async () => {
    await withTempRepo(async (repo) => {
      const l = await layout(repo);
      const result = await place(l, [copy(".cache/fixtures")]);
      expect(result.copied).toEqual([".cache/fixtures/a.bin", ".cache/fixtures/deep/b.sh"]);
      expect(statSync(join(l.worktree, ".cache/fixtures/deep/b.sh")).mode & 0o777).toBe(0o755);
    });
  });

  it("refuses a tracked path and a directory with one tracked file, before writing anything", async () => {
    await withTempRepo(async (repo) => {
      const l = await layout(repo);
      expect(await refused(place(l, [copy(".env"), copy("config.json")]))).toContain(
        "git does not ignore config.json",
      );
      expect(existsSync(join(l.worktree, ".env"))).toBe(false);
      expect(await refused(place(l, [copy("partly")]))).toContain("partly/tracked.txt");
      expect(existsSync(join(l.worktree, "partly", "ignored.txt"))).toBe(false);
    });
  });

  it("fails on a missing required source and skips a missing optional one", async () => {
    await withTempRepo(async (repo) => {
      const l = await layout(repo);
      expect(await refused(place(l, [copy(".env.local", true)]))).toContain(
        "required by worktree.files but missing",
      );
      expect((await place(l, [copy(".env.local")])).skipped).toEqual([".env.local"]);
    });
  });

  it("never follows a symlink out of the repository", async () => {
    await withTempRepo(async (repo) => {
      const l = await layout(repo);
      const outside = join(repo.root, "outside-secret");
      writeFileSync(outside, SECRET);
      symlinkSync(outside, join(l.main, "outside-link"));
      expect(await refused(place(l, [copy("outside-link")]))).toContain("is a symlink");
      symlinkSync(outside, join(l.main, ".cache", "fixtures", "escape"));
      expect(await refused(place(l, [copy(".cache/fixtures")]))).toContain("is a symlink");
      expect(existsSync(join(l.worktree, "outside-link"))).toBe(false);
    });
  });

  it("refuses paths outside the repository or under .git", () => {
    for (const path of ["/etc/passwd", "../x", "a/../b", "./a", "", ".git/config", "a//b"]) {
      expect(() => repoSegments(path)).toThrow(FileStepError);
    }
    expect(repoSegments(".cache/fixtures/")).toEqual([".cache", "fixtures"]);
  });

  it("copies .claude/settings.local.json without the permission-widening and MCP keys", async () => {
    await withTempRepo(async (repo) => {
      const l = await layout(repo);
      mkdirSync(join(l.main, ".claude"));
      const local = {
        $schema: "x",
        permissions: {
          allow: ["Bash(*)"],
          ask: ["Edit"],
          additionalDirectories: ["/"],
          defaultMode: "bypassPermissions",
          deny: ["Read(./.env)"],
        },
        enableAllProjectMcpServers: true,
        enabledMcpjsonServers: ["a"],
        disabledMcpjsonServers: ["b"],
        includeCoAuthoredBy: false,
        model: "custom",
      };
      writeFileSync(join(l.main, ".claude", "settings.local.json"), JSON.stringify(local));
      chmodSync(join(l.main, ".claude", "settings.local.json"), 0o600);

      const result = await place(l, []);
      expect(result.settings).toEqual({ copied: true });
      const path = join(l.worktree, ".claude", "settings.local.json");
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        $schema: "x",
        permissions: { deny: ["Read(./.env)"] },
        includeCoAuthoredBy: false,
        model: "custom",
      });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(result.log.join("\n")).not.toContain("bypassPermissions");
    });
  });

  it("routes settings.local.json under a copied .claude through its own rule and refuses linking it", async () => {
    await withTempRepo(async (repo) => {
      const l = await layout(repo);
      mkdirSync(join(l.main, ".claude"));
      writeFileSync(
        join(l.main, ".claude", "settings.local.json"),
        JSON.stringify({ permissions: { allow: ["Bash(*)"], deny: ["Read(./.env)"] } }),
      );
      writeFileSync(join(l.main, ".claude", "notes.local.md"), "notes\n");

      for (const path of [".claude", ".claude/settings.local.json"]) {
        expect(await refused(place(l, [{ path, mode: "link", required: false }]))).toContain(
          "holds .claude/settings.local.json",
        );
      }
      expect(existsSync(join(l.worktree, ".claude"))).toBe(false);

      const result = await place(l, [copy(".claude")]);
      expect(result.copied).toEqual([".claude/notes.local.md"]);
      expect(result.settings).toEqual({ copied: true });
      expect(
        JSON.parse(readFileSync(join(l.worktree, ".claude", "settings.local.json"), "utf8")),
      ).toEqual({ permissions: { deny: ["Read(./.env)"] } });
      expect(lstatSync(join(l.worktree, ".claude")).isSymbolicLink()).toBe(false);
    });
  });

  it("leaves out a tracked or symlinked settings.local.json and copies nothing when absent", async () => {
    await withTempRepo(async (repo) => {
      const l = await layout(repo);
      expect((await place(l, [])).settings).toBeNull();

      const outside = join(repo.root, "settings.json");
      writeFileSync(outside, "{}");
      mkdirSync(join(l.main, ".claude"));
      symlinkSync(outside, join(l.main, ".claude", "settings.local.json"));
      const linked = await place(l, []);
      expect(linked.settings).toMatchObject({ copied: false });
      expect(existsSync(join(l.worktree, ".claude", "settings.local.json"))).toBe(false);
    });
  });
});
