// The Done poll and reconcile reach the same answer from the same facts (DIPO-363; 0002, 0020):
// both gather the claim's story PR (dipo's record, else the code host's merged PR of its branch)
// and the story's status on `_base`, and ask the one Done check. One claim on real git with the
// scripted Backlog CLI of helpers.ts; the remote has a GitHub URL (rewritten to the bare remote by
// `insteadOf`), so both ask the host about the run's recorded PR. For every combination of the
// recorded PR, the host's answer and the base status, the Done poll's answer and reconcile's are
// the same, and the expected one.

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import { OFFICE_DEFAULTS } from "../../src/config";
import type { OfficeGit } from "../../src/git/office";
import { CodeHostError, type HostPr, type PrStateHost } from "../../src/platform/host";
import { doneAnswerOf } from "../../src/reconcile/done-on-base";
import { insertStoryPr } from "../../src/story-pr/records";
import { StoryTeardown } from "../../src/worktree/done";
import type { DoneAnswer } from "../../src/worktree/done-check";
import { claim, fakeBacklog, keyOf, type ReconcileOffice, withReconcileOffice } from "./helpers";
import { backlogStoryStore } from "../../src/backlog/store";

const RECORDS = ["none", "open", "closed", "merged"] as const;
const HOSTS = ["none", "merged", "no merged PR", "unreachable"] as const;
const BASES = ["Done", "In Progress", "Parked"] as const;

type HostCase = (typeof HOSTS)[number];

/** The code host as the case answers; `findMergedPr` asks are counted. */
function hostOf(answer: () => HostCase, head: () => string): PrStateHost & { asked: number } {
  const host = {
    asked: 0,
    findMergedPr: async (repo: string, branch: string): Promise<HostPr | null> => {
      host.asked += 1;
      expect(repo).toBe("o/r");
      const now = answer();
      if (now === "unreachable") throw new CodeHostError("unauthenticated", "not logged in");
      if (now !== "merged") return null;
      return {
        number: 40,
        url: "https://github.com/o/r/pull/40",
        state: "merged",
        head: branch,
        headSha: head(),
        base: "main",
        title: "feat(TASK-1): x",
        mergeCommit: "4".repeat(40),
      };
    },
  };
  return host;
}

function gitOf(o: ReconcileOffice): OfficeGit {
  const git = o.engineGit.forOffice(o.officeId);
  if (git === undefined) throw new Error("the office git is not attached");
  return git;
}

describe("the Done poll and reconcile ask the one Done check the same way (DIPO-363)", () => {
  it("gives the same answer for every combination of PR record, host answer and base status", () =>
    withReconcileOffice({ base: [{ id: "TASK-1", status: "In Progress" }] }, async (o) => {
      // A GitHub URL for the remote, so both read the repository `o/r` and ask the host; git
      // fetches from the bare remote through `insteadOf`.
      const bare = (await o.repo.git("config", "--get", "remote.origin.url")).trim();
      await o.repo.git("config", `url.${bare}.insteadOf`, "https://github.com/o/r.git");
      await o.repo.git("remote", "set-url", "origin", "https://github.com/o/r.git");
      const key = keyOf(o.office, "TASK-1");
      const record = await claim(o, o.office, "TASK-1", key, { active: false });
      const head = record.claimSha ?? "";
      let hostCase: HostCase = "none";
      const host = hostOf(
        () => hostCase,
        () => head,
      );
      const officeId = o.officeId as OfficeId;
      const poll = (withHost: boolean) => {
        const teardown = new StoryTeardown({
          git: () => gitOf(o),
          host: withHost ? host : null,
          stories: backlogStoryStore({ spawn: fakeBacklog(o.tables).spawn }),
          offices: { get: () => o.office, config: () => OFFICE_DEFAULTS },
        });
        teardown.track(officeId, o.office, o.s.clock);
        return teardown;
      };

      const seen: string[] = [];
      for (const recorded of RECORDS) {
        o.office.immediate(() => {
          o.office.run("delete from story_prs where office_id = $office_id", {});
          if (recorded === "none") return;
          insertStoryPr(o.office, {
            runId: record.runId,
            key,
            number: 40,
            url: "https://github.com/o/r/pull/40",
            branch: record.branch,
            base: "main",
            headSha: head,
            state: recorded,
            title: "feat(TASK-1): x",
            bodyHash: "h",
            openedAt: 1,
            closedAt: recorded === "open" ? null : 2,
          });
        });
        for (const answer of HOSTS) {
          hostCase = answer;
          for (const base of BASES) {
            o.setBase([{ id: "TASK-1", status: base }]);
            const pass = await o.index.indexStories(o.officeId);
            const withHost = answer !== "none";
            const teardown = poll(withHost);
            const byPoll = await teardown.answer(officeId, record);
            teardown.stop();
            const byReconcile = await doneAnswerOf(
              {
                officeId,
                office: o.office,
                git: gitOf(o),
                clock: o.s.clock,
                ...(withHost ? { prs: host } : {}),
              },
              pass,
              record,
            );
            // The host's merged PR counts only as the run's recorded PR; an open PR the host could
            // not be asked about is not Done this round.
            const merged = recorded === "merged" || (answer === "merged" && recorded !== "none");
            const unread = answer === "unreachable" && recorded === "open";
            const expected: DoneAnswer = merged
              ? "merged"
              : !unread && base === "Done"
                ? "doneOnBase"
                : "notDone";
            const label = `record ${recorded}, host ${answer}, base ${base}`;
            expect(`${label}: ${byPoll}`).toBe(`${label}: ${expected}`);
            expect(`${label}: ${byReconcile}`).toBe(`${label}: ${expected}`);
            seen.push(label);
          }
        }
      }
      expect(seen).toHaveLength(RECORDS.length * HOSTS.length * BASES.length);
      // The host was asked, by both, whenever the record did not say merged.
      expect(host.asked).toBeGreaterThan(0);
    }));
});
