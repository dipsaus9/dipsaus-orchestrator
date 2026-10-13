// CI only (0017 section 1): the field write path against the pinned Backlog.md CLI (DIPO-29),
// moved out of the local suite for its time budget (DIPO-79): write a park record into a temporary
// copy of the Backlog fixture project, read it back, check that every byte of the description
// outside the block is unchanged, clear it again, and change labels with --add-label and
// --remove-label. The fast local tests of the same rules use a scripted CLI in fields-write.test.ts;
// the NFD write on the real CLI stays local in fields-cli.test.ts.

import { describe, expect, it } from "bun:test";

import { withTempRepo } from "@dipsaus-orchestrator/testkit";

import {
  editLabels,
  locateBlock,
  parseFieldBlock,
  viewStory,
  writeFields,
  type BacklogCli,
  type StoryTarget,
} from "../../src/backlog";
import { systemSpawn } from "../../src/platform/process";
import { BACKLOG_CLI, BACKLOG_FIXTURE } from "./helpers";

/** The description with the block's content cut out. */
function outside(description: string): [string, string] {
  const block = locateBlock(description);
  if (block === undefined) throw new Error("expected a block");
  return [description.slice(0, block.contentStart), description.slice(block.contentEnd)];
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("the field write path with the pinned Backlog.md CLI", () => {
    it("writes a park record and reads it back, keeping the rest of the description", async () => {
      await withTempRepo(
        async (repo) => {
          await repo.commitAll("fixture");
          const cli: BacklogCli = { spawn: systemSpawn, command: BACKLOG_CLI, env: repo.env };
          const target: StoryTarget = { cli, cwd: repo.dir, id: "TASK-1" };

          const before = (await viewStory(target)).description;
          const park = {
            reason: "on-hold",
            from: "Ready",
            note: 'Waiting for "Bun 1.4.3": port 5173 \\ ü',
          } as const;
          const stored = await writeFields(target, (fields) => ({ ...fields, park }));

          const after = await viewStory(target);
          expect(parseFieldBlock(after.description).fields).toEqual(stored);
          expect(stored.park).toEqual(park);
          expect(stored.branch).toBe("TASK-1/add-the-csv-export-command");
          expect(stored.test_plan?.entries).toHaveLength(2);
          expect(outside(after.description)).toEqual(outside(before));

          const cleared = await writeFields(target, (fields) => ({ ...fields, park: undefined }));
          expect(cleared.park).toBeUndefined();
          expect(parseFieldBlock((await viewStory(target)).description).fields).toEqual(cleared);

          const labels = await editLabels(target, {
            add: ["tier:M", "test-before-merge"],
            remove: ["tier:S"],
          });
          expect(labels).toMatchObject({ tiers: ["M"], testBeforeMerge: true, invalid: [] });
        },
        { fixture: BACKLOG_FIXTURE },
      );
    });
  });
}
