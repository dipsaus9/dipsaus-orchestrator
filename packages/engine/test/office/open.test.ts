// `office.open` (DIPO-27; 0005 section 4, 0006 decision 4, 0007 sections 2 and 3) on real
// temporary git repositories with the Backlog.md fixture: the main worktree is the office path,
// the marker lives in `<git-common-dir>/dipo/office.json`, a linked worktree opens the same
// office, a copy gets a new id and a moved repository keeps its own.

import { describe, expect, it } from "bun:test";
import { cpSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { OfficeId } from "@dipsaus-orchestrator/contract";
import { git, withTempDir, withTempRepo } from "@dipsaus-orchestrator/testkit";

import { markerPath, officeDirectory } from "../../src/office/marker";
import {
  BACKLOG_FIXTURE,
  errorOf,
  officeRows,
  officeSetup,
  resultOf,
  send,
  type OfficeSetup,
} from "./helpers";

interface Opened {
  readonly office: OfficeId;
  readonly registered: boolean;
  readonly warnings?: string[];
}

async function open(s: OfficeSetup, path: string): Promise<{ opened: Opened; changed: boolean }> {
  const reply = await send(s, "office.open", { path });
  const opened = resultOf<Opened>(reply);
  return { opened, changed: reply.ok && reply.changed };
}

function marker(commonDir: string): { officeId: string; createdAt: string } {
  return JSON.parse(readFileSync(markerPath(commonDir), "utf8")) as {
    officeId: string;
    createdAt: string;
  };
}

describe("office.open", () => {
  it("registers a repository with a marker, a row and office.registered; reopening changes nothing", async () => {
    await withTempRepo(
      async (repo) => {
        const s = await officeSetup(repo.root);
        const first = await open(s, repo.dir);
        expect(first.opened.registered).toBe(true);
        expect(first.changed).toBe(true);
        expect(first.opened.warnings).toBeUndefined();
        expect(first.opened.office).toMatch(/^off_/);

        const commonDir = join(repo.dir, ".git");
        expect(marker(commonDir)).toEqual({
          officeId: first.opened.office,
          createdAt: new Date(s.clock.now()).toISOString(),
        });
        expect(statSync(officeDirectory(commonDir)).mode & 0o777).toBe(0o700);

        const rows = officeRows(s.state);
        expect(rows).toEqual([
          {
            office_id: first.opened.office,
            path: repo.dir,
            display_name: "repo",
            forgotten_at: null,
          },
        ]);
        const epoch = s.state.connection.get<{ epoch: string; next_seq: number }>(
          "select epoch, next_seq from offices where office_id = $office",
          { office: first.opened.office },
        );
        expect(epoch?.epoch).toMatch(/^[0-9a-f]{32}$/);
        expect(epoch?.next_seq).toBe(1);
        expect(s.events.map((event) => [event.type, event.data])).toEqual([
          ["office.registered", { office: first.opened.office, path: repo.dir, name: "repo" }],
        ]);

        const again = await open(s, repo.dir);
        expect(again.opened).toEqual({ office: first.opened.office, registered: false });
        expect(again.changed).toBe(false);
        expect(officeRows(s.state)).toHaveLength(1);
        expect(s.events).toHaveLength(1);
        // Opening writes only inside .git/: the working tree is as the fixture left it.
        expect((await repo.git("status", "--porcelain")).trim()).toBe("?? backlog/");
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("opens the same office from a linked worktree and from a subdirectory", async () => {
    await withTempRepo(
      async (repo) => {
        await repo.commitAll("backlog");
        const linked = join(repo.root, "linked");
        await repo.git("worktree", "add", "--quiet", "-b", "DIPO-1/x", linked);
        const s = await officeSetup(repo.root);
        const fromLinked = await open(s, linked);
        expect(fromLinked.opened.registered).toBe(true);
        expect(officeRows(s.state)[0]?.path).toBe(repo.dir);

        const fromMain = await open(s, repo.dir);
        expect(fromMain.opened).toEqual({ office: fromLinked.opened.office, registered: false });
        expect(fromMain.changed).toBe(false);
        const fromSubdir = await open(s, join(repo.dir, "backlog"));
        expect(fromSubdir.opened.office).toBe(fromLinked.opened.office);
        expect(officeRows(s.state)).toHaveLength(1);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("refuses a missing path, a directory outside git and a repository without Backlog.md", async () => {
    await withTempRepo(async (repo) => {
      const s = await officeSetup(repo.root);
      expect(errorOf(await send(s, "office.open", { path: join(repo.root, "gone") }))).toBe(
        "office.pathMissing",
      );
      const plain = join(repo.root, "plain");
      mkdirSync(plain);
      expect(errorOf(await send(s, "office.open", { path: plain }))).toBe("office.notProject");
      expect(errorOf(await send(s, "office.open", { path: repo.dir }))).toBe("office.notProject");
      expect(errorOf(await send(s, "office.open", { path: "relative/path" }))).toBe("args.invalid");
      expect(officeRows(s.state)).toEqual([]);
      expect(s.events).toEqual([]);
    });
  });

  it("refuses an office.json that is not a marker", async () => {
    await withTempRepo(
      async (repo) => {
        const s = await officeSetup(repo.root);
        mkdirSync(join(repo.dir, ".git", "dipo"));
        writeFileSync(join(repo.dir, ".git", "dipo", "office.json"), "{ not json");
        expect(errorOf(await send(s, "office.open", { path: repo.dir }))).toBe(
          "office.markerInvalid",
        );
        expect(officeRows(s.state)).toEqual([]);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("gives a copied repository a new id with a notice while the original still exists", async () => {
    await withTempRepo(
      async (repo) => {
        const s = await officeSetup(repo.root);
        const original = (await open(s, repo.dir)).opened.office;
        const copy = join(repo.root, "copy");
        cpSync(repo.dir, copy, { recursive: true });

        const opened = await open(s, copy);
        expect(opened.opened.registered).toBe(true);
        expect(opened.opened.office).not.toBe(original);
        expect(opened.opened.warnings).toEqual([
          `${copy} carries the office id ${original} of ${repo.dir}, which still exists, so it is a copy and became the new office ${opened.opened.office}.`,
        ]);
        expect(marker(join(copy, ".git")).officeId).toBe(opened.opened.office);
        expect(marker(join(repo.dir, ".git")).officeId).toBe(original);
        expect(officeRows(s.state).map((row) => [row.office_id, row.path])).toEqual([
          [original, repo.dir],
          [opened.opened.office, copy],
        ]);
        const notices = s.events.filter((event) => event.type === "engine.notice");
        expect(notices.map((event) => event.data)).toEqual([
          { level: "warn", code: "office.open", text: opened.opened.warnings?.[0] },
        ]);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("keeps the id of a moved repository and updates its path", async () => {
    await withTempRepo(
      async (repo) => {
        const s = await officeSetup(repo.root);
        const office = (await open(s, repo.dir)).opened.office;
        const moved = join(repo.root, "moved");
        renameSync(repo.dir, moved);

        const opened = await open(s, moved);
        expect(opened.opened).toEqual({ office, registered: false });
        expect(opened.changed).toBe(true);
        expect(officeRows(s.state)).toEqual([
          { office_id: office, path: moved, display_name: "moved", forgotten_at: null },
        ]);
        expect(s.events.at(-1)?.data).toEqual({ office, path: moved, name: "moved" });
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("registers a repository again under its marker's id after the database lost it", async () => {
    await withTempRepo(
      async (repo) => {
        const first = await officeSetup(join(repo.root, "a"));
        const office = (await open(first, repo.dir)).opened.office;
        first.state.close();

        const fresh = await officeSetup(join(repo.root, "b"));
        const opened = await open(fresh, repo.dir);
        expect(opened.opened).toEqual({ office, registered: true });
        expect(officeRows(fresh.state).map((row) => row.office_id)).toEqual([office]);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("warns about a repository on a network filesystem", async () => {
    await withTempRepo(
      async (repo) => {
        const s = await officeSetup(repo.root, {
          readMounts: async () => [
            { mountPoint: "/", fsType: "apfs" },
            { mountPoint: repo.root, fsType: "nfs" },
          ],
        });
        const opened = await open(s, repo.dir);
        expect(opened.opened.registered).toBe(true);
        expect(opened.opened.warnings).toEqual([
          `${repo.dir} is on a network filesystem (nfs); another machine opening it has its own state, and nothing guards its worktrees and branches.`,
        ]);
        expect(s.events.map((event) => event.type)).toEqual(["office.registered", "engine.notice"]);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("serves a repository with a separate git directory from its common directory", async () => {
    await withTempDir(async (root) => {
      const home = join(root, "home");
      const work = join(root, "work");
      const gitDir = join(root, "store.git");
      mkdirSync(home);
      mkdirSync(work);
      await git(root, home, "init", "--quiet", "-b", "main", `--separate-git-dir=${gitDir}`, work);
      cpSync(join(BACKLOG_FIXTURE, "backlog"), join(work, "backlog"), { recursive: true });
      const s = await officeSetup(root);
      const office = (await open(s, work)).opened.office;
      expect(marker(gitDir).officeId).toBe(office);
      expect(OfficeId.parse(office)).toBe(office);
    });
  });
});
