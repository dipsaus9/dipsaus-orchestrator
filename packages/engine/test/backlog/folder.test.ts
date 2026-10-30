// Where Backlog.md keeps a repository's stories (DIPO-379, 0010): the StoryStore's `storyFolders`
// and `isProject` on the Backlog.md store, read through a repository's files.

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { BacklogFolderError } from "../../src/backlog/folder";
import {
  checkoutFiles,
  type RepoFileRead,
  StoryFileRefusedError,
  TREE_FILE_MAX,
} from "../../src/story-store/folder";
import { backlogLayout } from "../story-store/backlog";

/** A repository holding only `files`, read by path. */
function repository(files: Readonly<Record<string, string>>): RepoFileRead {
  return async (path) => files[path] ?? null;
}

const OWN = ["backlog", ".backlog"];

/** A repository whose files cannot be read. */
const failing: RepoFileRead = async () => {
  throw new Error("EIO");
};

describe("the Backlog.md store's folders", () => {
  it("are backlog/ and .backlog/ without a root configuration, or one that names neither", async () => {
    for (const files of [
      {},
      { "backlog.config.yml": "project_name: x\n" },
      { "backlog.config.yml": "backlog_directory: backlog\n" },
      { "backlog.config.yml": "backlog_directory: ./backlog/\n" },
      { "backlog.config.yml": 'backlogDirectory: ".backlog"\n' },
    ]) {
      expect([files, await backlogLayout.storyFolders(repository(files))]).toEqual([files, OWN]);
    }
  });

  it("add the folder the root configuration names, as Backlog.md 1.53 reads it", async () => {
    for (const [text, folder] of [
      ["backlog_directory: planning\n", "planning"],
      ['backlog_directory: "planning/board/"\n', "planning/board"],
      ["backlog_directory: a\nbacklog_directory: b\n", "b"],
      ["backlog_directory: docs\\\\board\n", "docs/board"],
    ] as const) {
      const folders = await backlogLayout.storyFolders(repository({ "backlog.config.yml": text }));
      expect([text, folders]).toEqual([text, [...OWN, folder]]);
    }
  });

  it("refuse a root configuration whose folder does not resolve, and a read that fails", async () => {
    for (const text of [
      "backlog_directory: ../outside\n",
      "backlog_directory: /etc\n",
      "backlog_directory: C:\\\\x\n",
      'backlog_directory: ""\n',
      "backlog_directory: .\n",
      "backlog_directory: a/../..\n",
    ]) {
      const read = repository({ "backlog.config.yml": text });
      expect([
        text,
        await backlogLayout.storyFolders(read).catch((error: unknown) => error),
      ]).toEqual([text, expect.any(BacklogFolderError)]);
      await expect(backlogLayout.isProject(read)).rejects.toBeInstanceOf(BacklogFolderError);
    }
    await expect(backlogLayout.storyFolders(failing)).rejects.toThrow("EIO");
  });
});

describe("a Backlog.md project", () => {
  it("is a repository with backlog/config.yml, read from its checkout", () =>
    withTempDir(async (dir) => {
      expect(await backlogLayout.isProject(checkoutFiles(dir))).toBe(false);
      mkdirSync(join(dir, "backlog"));
      expect(await backlogLayout.isProject(checkoutFiles(dir))).toBe(false);
      writeFileSync(join(dir, "backlog", "config.yml"), "project_name: x\n");
      expect(await backlogLayout.isProject(checkoutFiles(dir))).toBe(true);
      // A root configuration that cannot be resolved refuses the project.
      writeFileSync(join(dir, "backlog.config.yml"), "backlog_directory: ../x\n");
      await expect(backlogLayout.isProject(checkoutFiles(dir))).rejects.toBeInstanceOf(
        BacklogFolderError,
      );
    }));

  it("is refused through a checkout whose configuration is a link or too large", () =>
    withTempDir(async (dir) => {
      mkdirSync(join(dir, "real"));
      writeFileSync(join(dir, "real", "config.yml"), "project_name: x\n");
      writeFileSync(join(dir, "pointer.yml"), "backlog_directory: planning\n");
      const repo = join(dir, "repo");
      mkdirSync(repo);
      // A linked root configuration, and a project folder that is a link.
      symlinkSync(join(dir, "pointer.yml"), join(repo, "backlog.config.yml"));
      await expect(backlogLayout.storyFolders(checkoutFiles(repo))).rejects.toBeInstanceOf(
        StoryFileRefusedError,
      );
      await expect(backlogLayout.isProject(checkoutFiles(repo))).rejects.toThrow("through a link");
      rmSync(join(repo, "backlog.config.yml"));
      symlinkSync(join(dir, "real"), join(repo, "backlog"));
      await expect(backlogLayout.isProject(checkoutFiles(repo))).rejects.toThrow("through a link");
      rmSync(join(repo, "backlog"));
      // A root configuration over the size cap, and one that is a folder.
      writeFileSync(join(repo, "backlog.config.yml"), `# ${"x".repeat(TREE_FILE_MAX)}\n`);
      await expect(backlogLayout.storyFolders(checkoutFiles(repo))).rejects.toThrow("larger than");
      rmSync(join(repo, "backlog.config.yml"));
      mkdirSync(join(repo, "backlog.config.yml"));
      await expect(backlogLayout.storyFolders(checkoutFiles(repo))).rejects.toThrow(
        "not a regular file",
      );
    }));

  it("is read through a checkout's files, which refuse a path out of the checkout", () =>
    withTempDir(async (dir) => {
      mkdirSync(join(dir, "inner"));
      const read = checkoutFiles(join(dir, "inner"));
      expect(await read("missing.yml")).toBeNull();
      await expect(read("../outside.yml")).rejects.toThrow("no file of the repository");
    }));
});
