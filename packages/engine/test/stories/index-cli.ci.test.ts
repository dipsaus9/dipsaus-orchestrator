// CI only (0017 section 1, DIPO-225): real git repositories and processes, too slow for the local
// run.
// The story index against the pinned Backlog CLI and real git (DIPO-32 test plan): the office
// loads and indexes the Backlog fixture from `_base`, keys stay stable across passes and a retitle,
// an archived or completed task closes as Removed with a notice, a hand-promoted draft is
// renumbered, an ambiguous created date matches nothing, and a status pushed to the remote is
// indexed after `polling.fetchSeconds` on the manual clock.
// The slower cases run in CI only, in index.ci.test.ts (DIPO-77); so do the second pass and the
// retitle with the CLI (DIPO-79), whose fast local versions are in apply.test.ts.

import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

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

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("story index on the Backlog CLI", () => {
    it("indexes the fixture at load, and a pushed status after polling.fetchSeconds with the key kept", () =>
      withIndexedOffice(async ({ repo, s, index, officeId, office }) => {
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
          // TASK-3 is parked on-hold in its field block (DIPO-52).
          ["TASK-3", "Parked", "held"],
        ]);

        // A status pushed to the remote is indexed by the poll after polling.fetchSeconds, not before.
        // The full case, with a second clone and the CLI, is in index.ci.test.ts.
        const file = join(repo.dir, "backlog", "tasks", "task-2 - Rename-the-export-setting.md");
        writeFileSync(file, readFileSync(file, "utf8").replace(/^status: .*$/m, "status: Ready"));
        await publish(repo, "TASK-2 Ready");
        const key = keyOf(office, "TASK-2");
        const polled = lastSeq(office);
        const interval = OFFICE_DEFAULTS.polling.fetchSeconds * 1000;
        s.clock.advance(interval - 1);
        await index.whenIdle(officeId);
        expect(mirrorStatus(office, "TASK-2")).toBe("Refined");
        s.clock.advance(1);
        await index.whenIdle(officeId);
        expect(mirrorStatus(office, "TASK-2")).toBe("Ready");
        expect(storyRows(office)).toEqual(loaded);
        expect(entriesAfter(office, polled)[0]?.delta).toEqual({
          story: "TASK-2",
          key,
          from: "Refined",
          to: "Ready",
        });
      }));

    it("indexes the new base at the next poll when origin/<base> moved before the poll's fetch", () =>
      withIndexedOffice(async ({ repo, s, index, officeId, office }) => {
        // The push moves origin/main before the poll fetches, as a pull or fetch outside dipo does.
        const file = join(repo.dir, "backlog", "tasks", "task-2 - Rename-the-export-setting.md");
        writeFileSync(file, readFileSync(file, "utf8").replace(/^status: .*$/m, "status: Ready"));
        await publish(repo, "TASK-2 Ready");
        expect(mirrorStatus(office, "TASK-2")).toBe("Refined");
        s.clock.advance(OFFICE_DEFAULTS.polling.fetchSeconds * 1000);
        await index.whenIdle(officeId);
        expect(mirrorStatus(office, "TASK-2")).toBe("Ready");
      }));

    it("does not index again at a poll when origin/<base> is the commit last indexed", () =>
      withIndexedOffice(async ({ s, index, officeId }) => {
        const last = index.lastPass(officeId);
        expect(last).not.toBeNull();
        s.clock.advance(OFFICE_DEFAULTS.polling.fetchSeconds * 1000);
        await index.whenIdle(officeId);
        expect(index.lastPass(officeId)).toBe(last);
      }));
  });
}
