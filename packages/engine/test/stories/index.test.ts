// The story index against the pinned Backlog CLI and real git (DIPO-32 test plan): the office
// loads and indexes the Backlog fixture from `_base`, keys stay stable across passes and a retitle,
// an archived or completed task closes as Removed with a notice, a hand-promoted draft is
// renumbered, an ambiguous created date matches nothing, and a status pushed to the remote is
// indexed after `polling.fetchSeconds` on the manual clock.

import { describe, expect, it } from "bun:test";
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { git, type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config";
import type { OfficeHandle } from "../../src/db/office";
import { EngineGit } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import { StoryIndex } from "../../src/stories/feature";
import { BACKLOG_CLI } from "../backlog/helpers";
import { BACKLOG_FIXTURE, type OfficeSetup, officeSetup, resultOf, send } from "../office/helpers";
import { entriesAfter, keyOf, lastSeq, storyRows } from "./helpers";

interface Indexed {
  readonly repo: TempRepoWithRemote;
  readonly s: OfficeSetup;
  readonly index: StoryIndex;
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
}

/** Runs the pinned CLI in `cwd` (the main checkout by default); throws on failure. */
async function backlog(repo: TempRepoWithRemote, args: string[], cwd = repo.dir): Promise<string> {
  const result = await repo.run([...BACKLOG_CLI, ...args], cwd);
  if (result.exitCode !== 0) {
    throw new Error(`backlog ${args.join(" ")} failed: ${result.stderr}${result.stdout}`);
  }
  return result.stdout;
}

/** Commits everything in the main checkout and pushes it to `origin`. */
async function publish(repo: TempRepoWithRemote, message: string): Promise<void> {
  await repo.commitAll(message);
  await repo.git("push", "--quiet", "origin", "main");
}

/**
 * The Backlog fixture pushed to a bare `origin`, opened and loaded as an office with the index.
 * `command` replaces the pinned Backlog CLI.
 */
function withIndexedOffice(
  fn: (o: Indexed) => Promise<void>,
  command: readonly [string, ...string[]] = BACKLOG_CLI,
): Promise<void> {
  return withBareRemote(
    async (repo) => {
      // `task archive` needs the archive folder to exist.
      mkdirSync(join(repo.dir, "backlog", "archive", "tasks"), { recursive: true });
      await repo.commitAll("fixture");
      await repo.git("push", "--quiet", "-u", "origin", "main");
      await repo.git("remote", "set-head", "origin", "main");

      const engineGit = new EngineGit({ spawn: systemSpawn, env: repo.env });
      let setup: OfficeSetup | undefined;
      const index = new StoryIndex({
        git: engineGit,
        cli: { spawn: systemSpawn, command, env: repo.env },
        offices: {
          get: (office) => setup?.manager.get(office),
          config: (office) => setup?.manager.config(office),
        },
        onOfficeChanged: (office) => setup?.changed.push(office),
      });
      const s = await officeSetup(repo.root, { features: [engineGit.feature, index.feature] });
      setup = s;
      try {
        const { office: officeId } = resultOf<{ office: OfficeId }>(
          await send(s, "office.open", { path: repo.dir }),
        );
        const access = await s.manager.load(officeId);
        if (!access.ok) throw new Error(`${access.error.code}: ${access.error.message}`);
        await fn({ repo, s, index, officeId, office: access.office });
      } finally {
        index.stop();
        s.state.close();
      }
    },
    { fixture: BACKLOG_FIXTURE },
  );
}

function mirrorStatus(office: OfficeHandle, id: string): string | undefined {
  return (
    office.get<{ status: string }>(
      `select m.status as status from backlog_mirror m join stories s
         on s.office_id = m.office_id and s.key = m.key
       where m.office_id = $office_id and s.story_id = $id and s.removed_at is null`,
      { id },
    )?.status ?? undefined
  );
}

describe("story index on the Backlog CLI", () => {
  it("indexes the fixture at load; keys are stable across passes and a retitle", () =>
    withIndexedOffice(async ({ repo, index, officeId, office }) => {
      const loaded = storyRows(office);
      expect(loaded.map((row) => [row.story_id, row.removed])).toEqual([
        ["DRAFT-1", false],
        ["TASK-1", false],
        ["TASK-2", false],
        ["TASK-3", false],
      ]);
      expect(mirrorStatus(office, "TASK-1")).toBe("Ready");
      expect(mirrorStatus(office, "DRAFT-1")).toBe("Draft");
      expect(
        office.get<{ backlog_created: string }>(
          "select backlog_created from stories where office_id = $office_id and story_id = 'TASK-1'",
        )?.backlog_created,
      ).toBe("2026-10-12 11:28 (UTC)");
      const states = entriesAfter(office).filter((e) => e.type === "story.state");
      expect(states.map((e) => [e.delta["story"], e.delta["to"], e.view?.["column"]])).toEqual([
        ["DRAFT-1", "Draft", "draft"],
        ["TASK-1", "Ready", "ready"],
        ["TASK-2", "Refined", "refined"],
        ["TASK-3", "Parked", "desk"],
      ]);

      const seq = lastSeq(office);
      const again = await index.indexStories(officeId);
      expect(again.stats).toMatchObject({ stories: 4, added: 0, changed: 0, removed: 0 });
      expect(again.cursor).toBeUndefined();
      expect(storyRows(office)).toEqual(loaded);
      expect(entriesAfter(office, seq)).toEqual([]);

      await backlog(repo, ["task", "edit", "TASK-2", "-t", "Rename the export option"]);
      await publish(repo, "retitle TASK-2");
      const retitled = await index.indexStories(officeId);
      expect(retitled.stats).toMatchObject({ added: 0, removed: 0, changed: 1 });
      expect(storyRows(office)).toEqual(loaded);
      const [entry] = entriesAfter(office, seq);
      expect(entry?.delta).toMatchObject({ story: "TASK-2", from: "Refined", to: "Refined" });
      expect(entry?.view).toMatchObject({ title: "Rename the export option" });
    }));

  it("loads the office with a stories.notIndexed notice when the Backlog CLI fails", () =>
    withIndexedOffice(
      async ({ s, officeId, office }) => {
        expect(s.manager.get(officeId)).toBe(office);
        expect(storyRows(office)).toEqual([]);
        const notices = entriesAfter(office).filter((e) => e.type === "engine.notice");
        expect(notices.map((e) => e.delta)).toEqual([
          expect.objectContaining({ level: "warn", code: "stories.notIndexed" }),
        ]);
        expect(s.changed).toContain(officeId);
      },
      ["false"],
    ));

  it("closes an archived and a completed task as Removed with a notice", () =>
    withIndexedOffice(async ({ repo, s, index, officeId, office }) => {
      const archived = keyOf(office, "TASK-1");
      const completed = keyOf(office, "TASK-3");
      const seq = lastSeq(office);
      await backlog(repo, ["task", "archive", "TASK-1"]);
      mkdirSync(join(repo.dir, "backlog", "completed"), { recursive: true });
      renameSync(
        join(repo.dir, "backlog", "tasks", "task-3 - Export-stories-as-JSON.md"),
        join(repo.dir, "backlog", "completed", "task-3 - Export-stories-as-JSON.md"),
      );
      await publish(repo, "archive TASK-1, complete TASK-3");
      s.changed.length = 0;
      const result = await index.indexStories(officeId);
      expect(result.stats).toMatchObject({ removed: 2, added: 0, stories: 2 });
      expect(s.changed).toEqual([officeId]);
      const entries = entriesAfter(office, seq);
      for (const [key, from] of [
        [archived, "Ready"],
        [completed, "Parked"],
      ] as const) {
        expect(entries.find((e) => e.key === key && e.type === "story.state")?.delta).toMatchObject(
          { from, to: "Removed" },
        );
        expect(
          entries.find((e) => e.key === key && e.type === "engine.notice")?.delta,
        ).toMatchObject({ level: "warn", code: "story.removed" });
      }
      expect(keyOf(office, "TASK-1")).toBeNull();
    }));

  it("matches a hand-promoted draft and emits story.renumbered", () =>
    withIndexedOffice(async ({ repo, index, officeId, office }) => {
      const key = keyOf(office, "DRAFT-1");
      const seq = lastSeq(office);
      await backlog(repo, ["draft", "promote", "DRAFT-1"]);
      await publish(repo, "promote DRAFT-1");
      const result = await index.indexStories(officeId);
      expect(result.stats).toMatchObject({ renumbered: 1, added: 0, removed: 0 });
      const entries = entriesAfter(office, seq);
      const renumbered = entries.find((e) => e.type === "story.renumbered");
      expect(renumbered?.delta).toMatchObject({ key, from: "DRAFT-1", detectedBy: "reconcile" });
      const to = String(renumbered?.delta["to"]);
      expect(to).toMatch(/^TASK-\d+$/);
      expect(keyOf(office, to)).toBe(key);
      expect(entries.find((e) => e.type === "story.state")?.delta).toMatchObject({
        story: to,
        from: "Draft",
        to: "Refined",
      });
    }));

  it("reports story.ambiguous when two vanished stories share the created date", () =>
    withIndexedOffice(async ({ repo, index, officeId, office }) => {
      const oldKeys = [keyOf(office, "TASK-1"), keyOf(office, "DRAFT-1")];
      const seq = lastSeq(office);
      await backlog(repo, ["task", "archive", "TASK-1"]);
      await backlog(repo, ["draft", "promote", "DRAFT-1"]);
      await publish(repo, "archive TASK-1, promote DRAFT-1");
      const result = await index.indexStories(officeId);
      expect(result.stats).toMatchObject({ ambiguous: 1, renumbered: 0, removed: 2, added: 1 });
      const entries = entriesAfter(office, seq);
      expect(entries.find((e) => e.type === "engine.notice")?.delta).toMatchObject({
        level: "warn",
        code: "story.ambiguous",
      });
      expect(entries.some((e) => e.type === "story.renumbered")).toBe(false);
      const live = storyRows(office).filter((row) => !row.removed);
      for (const key of oldKeys) expect(live.map((row) => row.key)).not.toContain(key);
    }));

  it("indexes a status pushed to the remote after polling.fetchSeconds", () =>
    withIndexedOffice(async ({ repo, s, index, officeId, office }) => {
      const other = join(repo.root, "other");
      await git(repo.root, repo.home, "clone", "--quiet", repo.remote, other);
      await backlog(repo, ["task", "edit", "TASK-2", "-s", "Ready"], other);
      await git(other, repo.home, "commit", "--quiet", "-am", "TASK-2 Ready");
      await git(other, repo.home, "push", "--quiet", "origin", "main");
      const key = keyOf(office, "TASK-2");
      const seq = lastSeq(office);

      const interval = OFFICE_DEFAULTS.polling.fetchSeconds * 1000;
      s.clock.advance(interval - 1);
      await index.whenIdle(officeId);
      expect(mirrorStatus(office, "TASK-2")).toBe("Refined");

      s.clock.advance(1);
      await index.whenIdle(officeId);
      expect(mirrorStatus(office, "TASK-2")).toBe("Ready");
      const [entry] = entriesAfter(office, seq);
      expect(entry?.delta).toEqual({ story: "TASK-2", key, from: "Refined", to: "Ready" });
      expect(entry?.view).toMatchObject({ lifecycle: "Ready", column: "ready" });
      expect(s.changed).toContain(officeId);

      // The next poll finds nothing new and writes nothing.
      const after = lastSeq(office);
      s.clock.advance(interval);
      await index.whenIdle(officeId);
      expect(lastSeq(office)).toBe(after);

      // A forgotten office stops polling at its next tick.
      resultOf(await send(s, "office.forget", { office: officeId }));
      s.clock.advance(interval);
      await index.whenIdle(officeId);
      expect(s.clock.pendingTimers).toBe(0);
    }));
});
