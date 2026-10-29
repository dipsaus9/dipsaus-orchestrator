// The story index against the pinned Backlog CLI and real git (DIPO-32 test plan): the office
// loads and indexes the Backlog fixture from `_base`, keys stay stable across passes and a retitle,
// an archived or completed task closes as Removed with a notice, a hand-promoted draft is
// renumbered, an ambiguous created date matches nothing, and a status pushed to the remote is
// indexed after `polling.fetchSeconds` on the manual clock.
// The slower cases run in CI only, in index.ci.test.ts (DIPO-77); so do the second pass and the
// retitle with the CLI (DIPO-79), whose fast local versions are in apply.test.ts.
//
// One case stays local: the notice when the Backlog CLI fails. The rest is in
// index-cli.ci.test.ts (CI only, DIPO-225).

import { describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import type { OfficeHandle } from "../../src/db/office";
import { EngineGit } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import { StoryIndex } from "../../src/stories/feature";
import { BACKLOG_CLI } from "../backlog/helpers";
import { BACKLOG_FIXTURE, type OfficeSetup, officeSetup, resultOf, send } from "../office/helpers";
import { entriesAfter, storyRows } from "./helpers";
import { backlogStoryStore } from "../../src/backlog/store";

interface Indexed {
  readonly repo: TempRepoWithRemote;
  readonly s: OfficeSetup;
  readonly index: StoryIndex;
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
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
        stories: backlogStoryStore({ spawn: systemSpawn, command, env: repo.env }),
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

describe("story index on the Backlog CLI", () => {
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
});
