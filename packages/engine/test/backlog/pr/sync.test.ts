// A merged backlog PR whose check cannot run (DIPO-35): every sync retries it and it stays open,
// but the cause is noticed once, not once per poll. Uses a fake lane and host, no git or CLI.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import type { OfficeLane } from "../../../src/backlog/lane";
import { BacklogPrs, findPr, PR_NOTICES } from "../../../src/backlog/pr";
import { insertPr } from "../../../src/backlog/pr/records";
import type { GitSession } from "../../../src/git/office";
import { addOffice, openTestState } from "../../commands/helpers";
import { notices } from "../lane/helpers";

import { FakeHost, REPO } from "./helpers";

const SHA = "a".repeat(40);

/** A lane whose git finds the head but fails every `merge-base`, so the check cannot run. */
function failingLane(): OfficeLane {
  const session: GitSession = {
    repository: { kind: "repository", commonDir: "/repo/.git" },
    step: async () => ({ code: 0, stdout: `${SHA}\n`, stderr: "" }),
    ok: async (_location, args) => {
      if (args[0] === "merge-base") throw new Error("merge-base broke");
      return "";
    },
  };
  return {
    git: {
      run: <T>(fn: (git: GitSession) => Promise<T>) => fn(session),
      settings: { remote: "origin", base: "main" },
      resolveBaseIn: async () => "main",
    },
    worktreePath: () => "/worktrees/_backlog",
  } as unknown as OfficeLane;
}

describe("syncing a merged backlog PR whose check cannot run", () => {
  it("retries on every sync, keeps the PR open and notices the cause once", async () => {
    await withTempDir(async (dir) => {
      const t = await openTestState(join(dir, "state"));
      const office = addOffice(t);
      const host = new FakeHost();
      const pr = await host.createPr(REPO, {
        base: "main",
        head: "dipo/backlog-x",
        title: "t",
        body: "",
      });
      host.mergedByHand(pr.number, SHA);
      office.immediate(() => {
        insertPr(
          office,
          { number: pr.number, url: pr.url, branch: "dipo/backlog-x", title: "t" },
          0,
        );
      });
      const lane = failingLane();
      const prs = new BacklogPrs({
        host,
        lane: () => lane,
        cli: {
          spawn: () => {
            throw new Error("no CLI in this test");
          },
        },
        offices: { get: () => office },
        clock: t.clock,
      });

      for (let i = 0; i < 2; i++) {
        await expect(prs.sync(office.officeId)).rejects.toThrow("merge-base broke");
      }
      expect(host.calls.filter((call) => call.startsWith("view"))).toHaveLength(2);
      expect(findPr(office, pr.number)).toMatchObject({
        state: "open",
        checkError: "merge-base broke",
      });
      expect(notices(office).filter((n) => n.code === PR_NOTICES.checkError)).toHaveLength(1);
    });
  });
});
