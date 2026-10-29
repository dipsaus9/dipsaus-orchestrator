// CI only (0017 section 1), kept out of the local suite for its time budget. Reconcile (DIPO-56
// test plan): one case per row of the 0007 section 6 table with a fixture mismatch, asserting the
// facts and the notice; the load step and `office.rescan`. Real git and the real story index, with
// a scripted Backlog CLI (see helpers.ts). The fast local check of the branch read reconcile relies
// on is stories/branch.test.ts.

import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { OfficeId, type StoryKey } from "@dipsaus-orchestrator/contract";

import type { FeatureModule } from "../../src/commands/registry";
import type { OfficeHandle } from "../../src/db/office";
import { storeGateDecision } from "../../src/gate/store/decisions";
import type { GateResult } from "../../src/gate/types";
import { LAUNCH_FILE } from "../../src/host/protocol";
import { officeDirectory, writeMarker } from "../../src/office/marker";
import {
  ORPHANED,
  RECONCILE_NOTICES,
  reconcileOffice,
  Reconciler,
  type ReconcileRuns,
  RECORDED_BY_HAND,
} from "../../src/reconcile";
import { endRun, findRun } from "../../src/run/records";
import { openPark } from "../../src/run/park";
import { desk } from "../../src/views/desk";
import { storyView } from "../../src/views/story";
import { runDirectory } from "../../src/runs/worker-hosts";
import { addStory } from "../../src/stories/keys";
import { RunProfiles } from "../../src/scan";
import { type ClaimRecord, liveClaimOf, releaseClaim } from "../../src/worktree/records";
import { resultOf, send } from "../office/helpers";
import { lastSeq } from "../stories/helpers";
import {
  BASE,
  claim,
  type FakeTask,
  keyOf,
  noticesAfter,
  type ReconcileOffice,
  setBranch,
  withReconcileOffice,
} from "./helpers";

const BY_YOU = 'park: { reason: "by-maintainer", from: "Ready", note: "Waiting for the export" }';
const AMBIGUOUS = 'park: { reason: "ambiguous-spec", from: "In Progress", note: "Which flag?" }';

interface RunCall {
  readonly kind: "stop" | "park";
  readonly run: string;
  readonly code: string;
  readonly detail?: string;
}

function end(office: OfficeHandle, run: string): void {
  office.immediate(() => endRun(office, run as never, 1, "reconciled"));
}

/** Run control as reconcile sees it: records each call and ends the run. */
function fakeRuns(): { runs: ReconcileRuns; calls: RunCall[] } {
  const calls: RunCall[] = [];
  return {
    calls,
    runs: {
      isEnding: () => false,
      stopForReconcile: async (office, run, notice) => {
        calls.push({ kind: "stop", run: run.runId, code: notice.code });
        end(office, run.runId);
      },
      parkForReconcile: async (office, run, detail, notice) => {
        calls.push({ kind: "park", run: run.runId, code: notice.code, detail });
        end(office, run.runId);
      },
    },
  };
}

interface World {
  readonly o: ReconcileOffice;
  readonly reconciler: Reconciler;
  readonly calls: RunCall[];
  readonly refused: string[];
  /** One `office.rescan` as far as reconcile goes: an index pass, then reconcile. */
  rescan(): ReturnType<Reconciler["reconcile"]>;
}

function withWorld(
  base: readonly FakeTask[] | undefined,
  fn: (w: World) => Promise<void>,
): Promise<void> {
  const { runs, calls } = fakeRuns();
  const refused: string[] = [];
  let reconciler: Reconciler | undefined;
  return withReconcileOffice(
    {
      ...(base === undefined ? {} : { base }),
      features: ({ engineGit, index }): FeatureModule[] => {
        reconciler = new Reconciler({
          git: (office) => engineGit.forOffice(office),
          stories: index,
          runs,
          refuse: (_office, text) => refused.push(text),
        });
        return [reconciler.feature];
      },
    },
    async (o) => {
      const r = reconciler as Reconciler;
      await fn({
        o,
        reconciler: r,
        calls,
        refused,
        rescan: async () => {
          await o.index.indexStories(o.officeId);
          return r.reconcile(o.officeId);
        },
      });
    },
  );
}

function codes(office: OfficeHandle, after: number): string[] {
  return noticesAfter(office, after).map((notice) => notice.code);
}

function parks(office: OfficeHandle): { reason: string; detail: string; how: string | null }[] {
  return office.all(
    "select reason, detail, resolved_how as how from parks where office_id = $office_id order by park_id",
  );
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("office.json (row 1)", () => {
    it("refuses the office with a notice when office.json names another office", () =>
      withWorld(undefined, async (w) => {
        const other = OfficeId.parse("off_01JZZZZZZZZZZZZZZZZZZZZZZZ");
        writeMarker(join(w.o.repo.dir, ".git"), {
          officeId: other,
          createdAt: new Date(0).toISOString(),
        });
        const seq = lastSeq(w.o.office);
        expect(await w.reconciler.reconcile(w.o.officeId)).toBeNull();
        expect(codes(w.o.office, seq)).toEqual([RECONCILE_NOTICES.markerMismatch]);
        expect(w.refused).toHaveLength(1);
        expect(w.refused[0]).toContain(`names office ${other}`);
      }));
  });

  describe("lifecycle status (row 3)", () => {
    it("stops an active run whose story is no longer In Progress on its branch", () =>
      withWorld(undefined, async (w) => {
        const key = keyOf(w.o.office, "TASK-1");
        const claimed = await claim(w.o, w.o.office, "TASK-1", key);
        await setBranch(w.o, claimed, { id: "TASK-1", status: "Done" });
        const report = await w.rescan();
        expect(w.calls).toEqual([
          { kind: "stop", run: claimed.runId, code: RECONCILE_NOTICES.runStopped },
        ]);
        expect(report?.findings.map((f) => f.code)).toEqual([RECONCILE_NOTICES.runStopped]);
        expect(findRun(w.o.office, claimed.runId)?.endedAt).not.toBeNull();
      }));

    it("leaves a run In Progress on its branch alone, though the base still says Ready", () =>
      withWorld(undefined, async (w) => {
        const key = keyOf(w.o.office, "TASK-1");
        await claim(w.o, w.o.office, "TASK-1", key);
        const seq = lastSeq(w.o.office);
        const report = await w.rescan();
        expect(w.calls).toEqual([]);
        expect(report?.findings).toEqual([]);
        expect(codes(w.o.office, seq)).toEqual([]);
      }));

    it("stops an active run whose story was removed from Backlog.md", () =>
      withWorld(
        [
          { id: "TASK-1", status: "Ready" },
          { id: "TASK-2", status: "Refined" },
        ],
        async (w) => {
          const key = keyOf(w.o.office, "TASK-2");
          const claimed = await claim(w.o, w.o.office, "TASK-2", key);
          w.o.setBase([{ id: "TASK-1", status: "Ready" }]);
          await w.rescan();
          expect(w.calls.map((c) => [c.kind, c.run])).toEqual([["stop", claimed.runId]]);
        },
      ));

    it("shows In Progress with no claim as an unknown run with a notice, and never starts it", () =>
      withWorld(
        [
          { id: "TASK-1", status: "Ready" },
          { id: "TASK-2", status: "In Progress" },
        ],
        async (w) => {
          const seq = lastSeq(w.o.office);
          const report = await w.rescan();
          const unknown = report?.findings.filter((f) => f.code === RECONCILE_NOTICES.unknownRun);
          expect(unknown?.map((f) => f.key)).toEqual([keyOf(w.o.office, "TASK-2")]);
          expect(codes(w.o.office, seq)).toContain(RECONCILE_NOTICES.unknownRun);
          expect(w.calls).toEqual([]);
          expect(liveClaimOf(w.o.office, keyOf(w.o.office, "TASK-2"))).toBeNull();
        },
      ));
  });

  describe("current park state (row 5)", () => {
    it("closes an open park with no F16 record as resolved by reconcile, and keeps Backlog.md's status", () =>
      withWorld(undefined, async (w) => {
        const key = keyOf(w.o.office, "TASK-1");
        const status = storyView(w.o.office, key)?.lifecycle;
        expect(status).not.toBe("Parked");
        w.o.office.immediate(() =>
          w.o.office.run(
            `insert into parks (office_id, park_id, key, story_id, run_id, reason, detail, at)
           values ($office_id, 1, $key, 'TASK-1', null, 'by-maintainer', 'old', 0)`,
            { key },
          ),
        );
        const seq = lastSeq(w.o.office);
        await w.rescan();
        expect(parks(w.o.office)).toEqual([
          { reason: "by-maintainer", detail: "old", how: "reconcile" },
        ]);
        expect(codes(w.o.office, seq)).toContain(RECONCILE_NOTICES.parkClosed);
        // Backlog.md wins (DIPO-360): the story keeps the status it has there, and is not parked.
        expect(storyView(w.o.office, key)?.lifecycle).toBe(status);
        expect(w.o.tables.get(BASE)?.get("TASK-1")?.status).toBe(status);
        expect(openPark(w.o.office, key)).toBeNull();
      }));

    it("records an F16 park with no park row as recorded by hand", () =>
      withWorld(
        [
          { id: "TASK-1", status: "Ready" },
          { id: "TASK-3", status: "Parked", fields: [BY_YOU] },
        ],
        async (w) => {
          // The load already reconciled once: the park is recorded exactly once.
          expect(parks(w.o.office)).toEqual([
            { reason: "by-maintainer", detail: RECORDED_BY_HAND, how: null },
          ]);
          const seq = lastSeq(w.o.office);
          await w.rescan();
          expect(parks(w.o.office)).toHaveLength(1);
          expect(codes(w.o.office, seq)).not.toContain(RECONCILE_NOTICES.parkRecorded);
        },
      ));

    it("replays DIPO-129: a Done story whose F16 block outlived its park gets the stale notice and no park row, while a Parked one is recorded by hand", () =>
      withWorld(
        [
          { id: "TASK-1", status: "Done", fields: [AMBIGUOUS] },
          { id: "TASK-3", status: "Parked", fields: [AMBIGUOUS] },
        ],
        async (w) => {
          // The load reconciled once: only the Parked story has a park row.
          expect(parks(w.o.office)).toEqual([
            { reason: "ambiguous-spec", detail: RECORDED_BY_HAND, how: null },
          ]);
          const seq = lastSeq(w.o.office);
          await w.rescan();
          expect(parks(w.o.office)).toHaveLength(1);
          // One warn notice per pass for the Done story, naming its status and the park reason.
          const stale = noticesAfter(w.o.office, seq).filter(
            (notice) => notice.code === RECONCILE_NOTICES.parkStale,
          );
          expect(stale).toHaveLength(1);
          expect(stale[0]?.text).toContain("TASK-1 is Done");
          expect(stale[0]?.text).toContain("ambiguous-spec");
          // The desk shows the Parked story, never a PARKED row for the stale record (DIPO-158).
          const parked = desk(w.o.office, () => true).filter((item) => item.kind === "PARKED");
          expect(parked.map((item) => String(item.story))).toEqual(["TASK-3"]);
        },
      ));
  });

  describe("Ready (row 6)", () => {
    it("raises a notice for Ready without a passing gate decision for the current content, and none with one", () =>
      withWorld(undefined, async (w) => {
        const key = keyOf(w.o.office, "TASK-1");
        const seq = lastSeq(w.o.office);
        await w.rescan();
        expect(codes(w.o.office, seq)).toEqual([RECONCILE_NOTICES.readyUngated]);

        const hash = w.o.index.lastPass(w.o.officeId)?.read.find((s) => s.story === "TASK-1")
          ?.gateHash as string;
        const passed: GateResult = { mode: "ready", passed: true, failures: [] } as never;
        w.o.office.immediate(() =>
          storeGateDecision(w.o.office, w.o.s.ids, {
            key,
            result: passed,
            contentHash: hash,
            at: 1,
          }),
        );
        const after = lastSeq(w.o.office);
        await w.rescan();
        expect(codes(w.o.office, after)).toEqual([]);
      }));
  });

  // A claim has no worktree (DIPO-349): reconcile finds hand changes from the branch ref and the
  // commits dipo recorded for it.
  describe("branch and recorded commits (row 7)", () => {
    it("parks a running story whose branch was reset by hand past its claim commit", () =>
      withWorld(undefined, async (w) => {
        const key = keyOf(w.o.office, "TASK-1");
        const claimed = await claim(w.o, w.o.office, "TASK-1", key);
        await w.o.repo.run(
          ["git", "reset", "--quiet", "--hard", claimed.startSha],
          claimed.worktree,
        );
        await w.rescan();
        expect(w.calls.map((c) => [c.kind, c.code])).toEqual([
          ["park", RECONCILE_NOTICES.handChanged],
        ]);
        expect(w.calls[0]?.detail).toContain(
          `which does not hold the claim commit ${claimed.claimSha}`,
        );
      }));

    it("parks a running story, without failing, when a recorded commit no longer exists", () =>
      withWorld(undefined, async (w) => {
        const key = keyOf(w.o.office, "TASK-1");
        const claimed = await claim(w.o, w.o.office, "TASK-1", key);
        // A recorded SHA git does not have (a gc after a forced update, or a wrong record).
        const missing = "e".repeat(40);
        w.o.office.run(
          "update claims set claim_sha = $sha where office_id = $office_id and run_id = $run",
          { sha: missing, run: claimed.runId },
        );
        const report = await w.rescan();
        expect(report).not.toBeNull();
        expect(w.calls.map((c) => [c.kind, c.code])).toEqual([
          ["park", RECONCILE_NOTICES.handChanged],
        ]);
        expect(w.calls[0]?.detail).toContain(`does not hold the claim commit ${missing}`);
      }));

    it("parks a running story whose branch was deleted by hand", () =>
      withWorld(undefined, async (w) => {
        const key = keyOf(w.o.office, "TASK-1");
        const claimed = await claim(w.o, w.o.office, "TASK-1", key);
        await w.o.repo.git("worktree", "remove", "--force", claimed.worktree);
        await w.o.repo.git("branch", "-D", claimed.branch);
        await w.rescan();
        expect(w.calls.map((c) => c.kind)).toEqual(["park"]);
        expect(w.calls[0]?.detail).toContain(`the branch ${claimed.branch} no longer exists`);
      }));

    it("leaves a running story alone whose branch moved on from its claim commit", () =>
      withWorld(undefined, async (w) => {
        const key = keyOf(w.o.office, "TASK-1");
        const claimed = await claim(w.o, w.o.office, "TASK-1", key);
        writeFileSync(join(claimed.worktree, "part.txt"), "a delivered part\n");
        await w.o.repo.run(["git", "add", "part.txt"], claimed.worktree);
        await w.o.repo.run(["git", "commit", "--quiet", "-m", "a part"], claimed.worktree);
        const after = lastSeq(w.o.office);
        await w.rescan();
        expect(w.calls).toEqual([]);
        expect(codes(w.o.office, after)).not.toContain(RECONCILE_NOTICES.handChanged);
      }));

    it("reports a locked dipo worktree of an earlier binary whose folder is gone, and runs neither the unlock nor the prune", () =>
      withWorld(undefined, async (w) => {
        const tree = join(w.o.repo.root, "trees", "TASK-9");
        await w.o.repo.git("worktree", "add", "--quiet", "-b", "TASK-9/old", tree, "origin/main");
        await w.o.repo.git("worktree", "lock", "--reason", "dipo run_1", tree);
        rmSync(tree, { recursive: true, force: true });
        const report = await w.rescan();
        const text = report?.findings.find((f) => f.code === RECONCILE_NOTICES.prunable)?.text;
        expect(text).toContain(`git worktree unlock ${tree} && git worktree prune`);
        expect(await w.o.repo.git("worktree", "list", "--porcelain")).toContain("locked dipo");
      }));

    it("only reports a hand change under a claimed story that is not running", () =>
      withWorld(undefined, async (w) => {
        const key = keyOf(w.o.office, "TASK-1");
        const claimed = await claim(w.o, w.o.office, "TASK-1", key, {
          active: false,
          task: { id: "TASK-1", status: "Parked" },
        });
        await w.o.repo.git("worktree", "remove", "--force", claimed.worktree);
        await w.o.repo.git("branch", "-D", claimed.branch);
        const report = await w.rescan();
        expect(w.calls).toEqual([]);
        expect(report?.findings.map((f) => f.code)).toContain(RECONCILE_NOTICES.handChanged);
      }));
  });

  describe("at daemon start", () => {
    it("leaves a claim alone whose worker host may have started without its record", () =>
      withWorld(undefined, async (w) => {
        const key = keyOf(w.o.office, "TASK-1");
        const claimed = await claim(w.o, w.o.office, "TASK-1", key);
        const git = w.o.engineGit.forOffice(w.o.officeId);
        if (git === undefined) throw new Error("no git");
        const runDir = runDirectory(officeDirectory(git.commonDir), claimed.runId);
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, LAUNCH_FILE), "{}");
        const released: string[] = [];
        const report = await reconcileOffice(
          {
            officeId: w.o.officeId,
            office: w.o.office,
            git,
            clock: w.o.s.clock,
            releaseClaim: async (record) => {
              released.push(record.runId);
            },
          },
          {
            trigger: "start",
            pass: await w.o.index.indexStories(w.o.officeId),
            reindex: () => w.o.index.indexStories(w.o.officeId),
          },
        );
        expect(released).toEqual([]);
        expect(report.findings.map((f) => f.code)).toEqual([RECONCILE_NOTICES.orphanClaim]);
        expect(liveClaimOf(w.o.office, key)).not.toBeNull();
      }));

    it("releases a claim whose worker never started and indexes again", () =>
      withWorld(undefined, async (w) => {
        const key = keyOf(w.o.office, "TASK-1");
        const claimed = await claim(w.o, w.o.office, "TASK-1", key);
        const released: ClaimRecord[] = [];
        let passes = 0;
        const git = w.o.engineGit.forOffice(w.o.officeId);
        if (git === undefined) throw new Error("no git");
        const report = await reconcileOffice(
          {
            officeId: w.o.officeId,
            office: w.o.office,
            git,
            clock: w.o.s.clock,
            releaseClaim: async (record, reason) => {
              released.push(record);
              w.o.office.immediate(() =>
                releaseClaim(w.o.office, record.runId, { at: 1, reason, keepBranch: true }),
              );
            },
          },
          {
            trigger: "start",
            pass: await w.o.index.indexStories(w.o.officeId),
            reindex: () => {
              passes += 1;
              return w.o.index.indexStories(w.o.officeId);
            },
          },
        );
        expect(released.map((c) => c.runId)).toEqual([claimed.runId]);
        expect(passes).toBe(1);
        expect(report.findings.map((f) => f.code)).toContain(RECONCILE_NOTICES.orphanClaim);
        expect(findRun(w.o.office, claimed.runId)?.endKind).toBe(ORPHANED);
        expect(
          w.o.office.get<{ n: number }>(
            "select count(*) as n from run_outcomes where office_id = $office_id and run_id = $run",
            { run: claimed.runId },
          )?.n,
        ).toBe(1);
      }));

    it("runs as the last office load step, so a mismatch found at load is acted on before any command", () => {
      const { runs, calls } = fakeRuns();
      let runId = "";
      return withReconcileOffice(
        {
          features: ({ engineGit, index }) => [
            new Reconciler({ git: (office) => engineGit.forOffice(office), stories: index, runs })
              .feature,
          ],
          beforeLoad: async (o, office) => {
            const { key } = office.immediate(() =>
              addStory(office, o.s.ids, { story: "TASK-1" as never }, 0),
            );
            const claimed = await claim(o, office, "TASK-1", key as StoryKey, {
              task: { id: "TASK-1", status: "Done" },
            });
            runId = claimed.runId;
            expect(calls).toEqual([]);
          },
        },
        async () => {
          // The load finished only after reconcile stopped the run.
          expect(calls).toEqual([{ kind: "stop", run: runId, code: RECONCILE_NOTICES.runStopped }]);
        },
      );
    });
  });

  describe("office.rescan", () => {
    it("reconciles again after its index pass", () => {
      let profiles: RunProfiles | undefined;
      let reconciler: Reconciler | undefined;
      return withReconcileOffice(
        {
          base: [
            { id: "TASK-1", status: "Ready" },
            { id: "TASK-2", status: "In Progress" },
          ],
          features: ({ engineGit, index }) => {
            reconciler = new Reconciler({ git: (o) => engineGit.forOffice(o), stories: index });
            profiles = new RunProfiles({
              git: engineGit,
              stories: index,
              reconcile: (office) => (reconciler as Reconciler).reconcile(office),
            });
            return [profiles.feature, reconciler.feature];
          },
        },
        async (o) => {
          const seq = lastSeq(o.office);
          resultOf(await send(o.s, "office.rescan", {}, o.officeId));
          await profiles?.whenIdle(o.officeId);
          await reconciler?.whenIdle(o.officeId);
          expect(codes(o.office, seq)).toContain(RECONCILE_NOTICES.unknownRun);
        },
      );
    });
  });

  describe("the office's open backlog PR (DIPO-80)", () => {
    it("looks for one to adopt at load and on office.rescan; a failure is a notice", () => {
      const adopts: string[] = [];
      let fail = false;
      let profiles: RunProfiles | undefined;
      let reconciler: Reconciler | undefined;
      return withReconcileOffice(
        {
          features: ({ engineGit, index }) => {
            reconciler = new Reconciler({
              git: (o) => engineGit.forOffice(o),
              stories: index,
              adoptBacklogPr: async (office) => {
                adopts.push(office);
                if (fail) throw new Error("the host answered nonsense");
              },
            });
            profiles = new RunProfiles({
              git: engineGit,
              stories: index,
              reconcile: (office) => (reconciler as Reconciler).reconcile(office),
            });
            return [profiles.feature, reconciler.feature];
          },
        },
        async (o) => {
          expect(adopts).toEqual([o.officeId]);
          fail = true;
          const seq = lastSeq(o.office);
          resultOf(await send(o.s, "office.rescan", {}, o.officeId));
          await profiles?.whenIdle(o.officeId);
          await reconciler?.whenIdle(o.officeId);
          expect(adopts).toEqual([o.officeId, o.officeId]);
          const failed = noticesAfter(o.office, seq).filter(
            (notice) => notice.code === RECONCILE_NOTICES.adoptFailed,
          );
          expect(failed.map((notice) => notice.text)).toEqual([
            "dipo could not look for an open backlog PR to adopt: the host answered nonsense. It looks again at the next rescan.",
          ]);
          expect(codes(o.office, seq)).not.toContain(RECONCILE_NOTICES.failed);
        },
      );
    });
  });
}
