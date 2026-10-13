// The merge slot's poll wired as the daemon wires it (DIPO-73, found in the DIPO-36 live test): the
// office manager loads the office and runs the slot's load step, which starts the poll; `office
// init` flushes the lane, whose flush opens the backlog PR and kicks the slot while the required
// checks are still pending; once they turn green, the next poll of `polling.prStateSeconds` merges.
// The office manager's own `config` read is the one that ended the poll in the daemon. Real git
// with a bare remote and the pinned Backlog CLI, against an in-memory code host whose squash merge
// merges on the remote; in CI only (0017). The fast version is in slot.test.ts.

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import { BacklogLane } from "../../src/backlog/lane";
import { BacklogPrs, findPr } from "../../src/backlog/pr";
import { OFFICE_DEFAULTS } from "../../src/config";
import { EngineGit } from "../../src/git";
import { MergeSlot } from "../../src/merge-slot";
import { initKind, OfficeInit } from "../../src/office/init";
import { type RequiredCheck } from "../../src/platform/host";
import { systemSpawn } from "../../src/platform/process";
import { BACKLOG_CLI } from "../backlog/helpers";
import { BACKLOG_FIXTURE, publish, squashMergeOnRemote } from "../backlog/lane/helpers";
import { FakeHost, REMOTE_URL } from "../backlog/pr/helpers";
import { oldOffice } from "../office/init/helpers";
import { officeSetup, resultOf, send } from "../office/helpers";

import { GREEN, PENDING } from "./helpers";

/** A host whose required checks the test sets and whose squash merge merges on the remote. */
class RemoteHost extends FakeHost {
  checks: RequiredCheck[] = PENDING;
  checkReads = 0;

  constructor(readonly repo: TempRepoWithRemote) {
    super();
  }

  override async requiredChecks(): Promise<RequiredCheck[]> {
    this.checkReads += 1;
    return this.checks;
  }

  override async squashMerge(
    repo: string,
    number: number,
    merge?: { headSha: string; subject: string },
  ): Promise<void> {
    this.calls.push(`merge ${repo} #${number}`);
    const pr = this.prs.get(number);
    if (pr === undefined) throw new Error(`no PR #${number}`);
    await squashMergeOnRemote(this.repo, pr.head);
    this.prs.set(number, { ...pr, state: "merged", headSha: merge?.headSha ?? "" });
  }
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("the merge slot's poll in the daemon's wiring", () => {
    it("merges the backlog PR of office init at the poll after its checks turn green", async () => {
      await withBareRemote(
        async (repo) => {
          oldOffice(repo.dir);
          await publish(repo);
          await repo.git("config", `url.${repo.remote}.insteadOf`, REMOTE_URL);
          await repo.git("remote", "set-url", "origin", REMOTE_URL);
          await repo.git("remote", "set-head", "origin", "main");
          const host = new RemoteHost(repo);
          const cli = { spawn: systemSpawn, command: BACKLOG_CLI, env: repo.env };
          const engineGit = new EngineGit({ spawn: systemSpawn, env: repo.env });
          let slot: MergeSlot | undefined;
          let init: OfficeInit | undefined;
          // As in packages/daemon/src/foreground.ts: the slot and the PRs get the office manager.
          const s = await officeSetup(repo.root, {
            features: (offices, clock) => {
              const lane: BacklogLane = new BacklogLane({
                cli,
                git: (office) => engineGit.forOffice(office),
                kinds: [initKind()],
                onFlushed: async (office, report) => {
                  await prs.afterFlush(office, report);
                  made.kick(office);
                },
                held: (office) => made.holding(office),
              });
              const prs = new BacklogPrs({
                host,
                lane: (office) => lane.forOffice(office),
                cli,
                offices,
                clock,
              });
              const made = new MergeSlot({
                host,
                prs,
                lane: (office) => lane.forOffice(office),
                offices,
                clock,
              });
              const officeInit = new OfficeInit({
                offices,
                lane: (office) => lane.forOffice(office),
                git: (office) => engineGit.forOffice(office),
                cli,
                clock,
                prWaiting: (office) => prs.waiting(office),
              });
              slot = made;
              init = officeInit;
              return [engineGit.feature, lane.feature, made.feature, officeInit.feature];
            },
          });
          if (slot === undefined || init === undefined) throw new Error("not wired");
          const office = resultOf<{ office: OfficeId }>(
            await send(s, "office.open", { path: repo.dir }),
          ).office;

          // The flush opens PR #1 and kicks the slot: it enters and waits for `ci-ok`.
          const first = await init.init(office);
          expect(first.result.pr?.number).toBe(1);
          await slot.whenIdle(office);
          expect(slot.occupant(office)).toBe(1);
          expect(host.checkReads).toBe(1);

          // `ci-ok` turns green; the next poll, a `polling.prStateSeconds` after the office loaded,
          // reads the checks again and merges.
          host.checks = GREEN;
          s.clock.advance(OFFICE_DEFAULTS.polling.prStateSeconds * 1000);
          await slot.whenIdle(office);
          expect(host.checkReads).toBe(2);
          expect(host.prs.get(1)?.state).toBe("merged");
          const handle = s.manager.get(office);
          expect(handle === undefined ? null : findPr(handle, 1)?.state).toBe("merged");
          slot.stop();
        },
        { fixture: BACKLOG_FIXTURE },
      );
    }, 60_000);
  });
}
