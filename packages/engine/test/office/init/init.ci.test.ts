// Office init with the pinned Backlog CLI, a bare remote, the backlog PR (DIPO-35) and the
// auto-merge (0002) against an in-memory code host whose auto-merge really merges on the remote
// (DIPO-36, engine test plan entry). In CI only (0017): every step runs the real CLI, about 0.3 s a
// call. `office.init` opens one backlog PR whose structural check passes, auto-merge goes on and
// GitHub merges it with the required checks green, `officeStatusesReady` refuses before the merge and passes after,
// and a second run adds no commit. The fast versions of the same rules are in init.test.ts.

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import { EDIT_KIND, editKind, OfficeLane } from "../../../src/backlog/lane";
import { BacklogPrs, findPr } from "../../../src/backlog/pr";
import { AutoMerge } from "../../../src/merge";
import { type RequiredCheck } from "../../../src/platform/host";
import {
  INIT_KIND,
  initKind,
  OfficeInit,
  officeStatusesReady,
  previousSettings,
} from "../../../src/office/init";
import {
  BACKLOG_FIXTURE,
  inRemote,
  laneSetup,
  publish,
  squashMergeOnRemote,
} from "../../backlog/lane/helpers";
import { FakeHost, REMOTE_URL } from "../../backlog/pr/helpers";
import { GREEN } from "../../merge/helpers";

import { oldOffice, oneOffice } from "./helpers";

/** A host whose required checks are green and whose auto-merge merges on the remote at once. */
class RemoteHost extends FakeHost {
  checks: RequiredCheck[] = GREEN;

  constructor(readonly repo: TempRepoWithRemote) {
    super();
  }

  override async requiredChecks(): Promise<RequiredCheck[]> {
    return this.checks;
  }

  override async enableAutoMerge(
    repo: string,
    number: number,
    merge: { readonly headSha: string; readonly subject: string },
  ): Promise<void> {
    await super.enableAutoMerge(repo, number, merge);
    const pr = this.prs.get(number);
    if (pr === undefined) throw new Error(`no PR #${number}`);
    await squashMergeOnRemote(this.repo, pr.head);
    this.prs.set(number, { ...pr, state: "merged", headSha: merge.headSha, autoMerge: false });
  }
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("office init with the Backlog CLI, a remote and the auto-merge", () => {
    it("opens one backlog PR that passes the check and merges; runs are refused until then", async () => {
      await withBareRemote(
        async (repo) => {
          oldOffice(repo.dir);
          await publish(repo);
          await repo.git("config", `url.${repo.remote}.insteadOf`, REMOTE_URL);
          await repo.git("remote", "set-url", "origin", REMOTE_URL);
          const base = await laneSetup(repo);
          const officeId = base.office.officeId as OfficeId;
          const host = new RemoteHost(repo);
          let lane: OfficeLane | undefined;
          const prs = new BacklogPrs({
            host,
            lane: () => lane,
            cli: base.cli,
            offices: { get: () => base.office },
            clock: base.t.clock,
          });
          const merge = new AutoMerge({
            host,
            lane: () => lane,
            offices: { get: () => base.office },
            clock: base.t.clock,
          });
          lane = new OfficeLane({
            officeId,
            office: base.office,
            git: base.git,
            cli: base.cli,
            clock: base.t.clock,
            kinds: new Map([
              [EDIT_KIND, editKind(EDIT_KIND)],
              [INIT_KIND, initKind()],
            ]),
            onFlushed: async (office, report) => {
              await prs.afterFlush(office, report);
              merge.kick(office);
            },
            held: (office) => merge.holding(office),
          });
          const made = lane;
          const init = new OfficeInit({
            offices: oneOffice(base.office),
            lane: () => made,
            git: () => base.git,
            cli: base.cli,
            clock: base.t.clock,
            prWaiting: (office) => prs.waiting(office),
          });

          expect(await officeStatusesReady(base.git)).toContain("run `dipo office init`");
          const first = await init.init(officeId);
          expect(first.changed).toBe(true);
          expect(first.result.pr?.number).toBe(1);
          const branch = first.result.branch as string;
          expect(findPr(base.office, 1)?.check).toBe("passed");
          expect(host.prs.get(1)?.title).toBe(
            "chore(backlog): init statuses, init defaultStatus, init settings, init To Do tasks, init .dipo/.gitignore",
          );
          expect(
            (await inRemote(repo, "diff", "--name-only", "main", branch)).trim().split("\n"),
          ).toEqual([
            ".dipo/.gitignore",
            "backlog/config.yml",
            "backlog/tasks/task-1 - Add-the-CSV-export-command.md",
            "backlog/tasks/task-2 - Rename-the-export-setting.md",
          ]);
          expect(previousSettings(base.office).map((p) => p.setting)).toEqual([
            "checkActiveBranches",
            "defaultStatus",
            "remoteOperations",
            "statuses",
          ]);

          // The flush kicked the auto-merge; GitHub merged the PR, and the next round records it.
          await merge.whenIdle(officeId);
          await merge.tick(officeId);
          expect(host.prs.get(1)?.state).toBe("merged");
          expect(findPr(base.office, 1)?.state).toBe("merged");
          await base.git.fetch();
          expect(await officeStatusesReady(base.git)).toBeNull();

          // No task uses `To Do` any more: a second run sets the 0012 list alone in a second PR,
          // which merges too (0010 section 6 step 4).
          base.t.clock.advance(1000);
          const second = await init.init(officeId);
          expect(second.changed).toBe(true);
          expect(second.result.pr?.number).toBe(2);
          expect(host.prs.get(2)?.title).toBe("chore(backlog): init statuses");
          await merge.whenIdle(officeId);
          await merge.tick(officeId);
          expect(host.prs.get(2)?.state).toBe("merged");
          expect(findPr(base.office, 2)?.state).toBe("merged");
          await base.git.fetch();
          expect(await inRemote(repo, "show", "main:backlog/config.yml")).toContain(
            'statuses: ["Refined", "Ready", "In Progress", "In Review", "Parked", "Done"]',
          );

          // A third run finds everything on the base: no commit, no PR.
          base.t.clock.advance(1000);
          const third = await init.init(officeId);
          expect(third.changed).toBe(false);
          expect(third.result.pr).toBeUndefined();
          expect(host.prs.size).toBe(2);
        },
        { fixture: BACKLOG_FIXTURE },
      );
    }, 60_000);
  });
}
