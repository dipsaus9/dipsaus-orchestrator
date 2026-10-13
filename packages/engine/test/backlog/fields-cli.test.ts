// The field write path against the pinned Backlog.md CLI (DIPO-29): NFD text outside the block is
// written back byte for byte. Writing a park record, reading it back and changing labels on the
// real CLI run in CI only, in fields-cli.ci.test.ts (DIPO-79); fields-write.test.ts has the fast
// local versions with a scripted CLI.

import { describe, expect, it } from "bun:test";

import { withTempRepo } from "@dipsaus-orchestrator/testkit";

import {
  runBacklog,
  viewStory,
  writeFields,
  type BacklogCli,
  type StoryTarget,
} from "../../src/backlog";
import { systemSpawn } from "../../src/platform/process";
import { BACKLOG_CLI, BACKLOG_FIXTURE } from "./helpers";

describe("the field write path with the pinned Backlog.md CLI", () => {
  it("writes NFD text outside the block back byte for byte", async () => {
    await withTempRepo(
      async (repo) => {
        await repo.commitAll("fixture");
        const cli: BacklogCli = { spawn: systemSpawn, command: BACKLOG_CLI, env: repo.env };
        const target: StoryTarget = { cli, cwd: repo.dir, id: "TASK-2" };
        const nfd = "Outcome: the café export keeps every röw as written.";
        await runBacklog(cli, repo.dir, ["task", "edit", "TASK-2", "--description", nfd]);

        await writeFields(target, (fields) => ({ ...fields, unknowns: [] }));

        const raw = (await viewStory(target, false)).description;
        expect(raw).toBe(`${nfd}\n\n\`\`\`dipo\nunknowns: []\n\`\`\``);
        expect(raw).not.toBe(raw.normalize("NFC"));
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });
});
