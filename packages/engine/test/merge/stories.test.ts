// GitHub's auto-merge for story PRs (0002) on a migrated state database built from fixtures, with a
// fake code host, a scripted story merge git and the CI state of the PR poll as a map:
//
// - an approved gate leads to the close-out commit, one push, the PR at the pushed head, and
//   `gh pr merge --auto --squash --match-head-commit` at exactly that head, with the PR title;
// - while auto-merge is on, a conflict and red checks turn it off and lead to a fix round, and a
//   hold label or a head dipo did not push turn it off and reopen the merge gate;
// - a release-path PR and a PR labelled `autorelease: pending` never get auto-merge, also when the
//   label or the release path comes after auto-merge went on;
// - the merge gate opens and is decided by rule or waits for the maintainer;
// - by rule (DIPO-382) the gate opens on the approved verdict without waiting for the head's checks:
//   verdict, close-out, auto-merge, one wait for the close-out head's checks, merge; red checks
//   there turn auto-merge off, and the next close-out replaces the final summary;
// - every path that waits for the maintainer keeps green checks, then the maintainer, then the
//   close-out, so no task file reads Done on a PR that waits.
//
// The real decision functions run (`StoryMerges` through `AutoMerge`); only git, `gh` and the
// branch writes are fakes.

import { afterEach, describe, expect, it } from "bun:test";

import { conflictFeedbackItem } from "../../src/box/collisions";
import { OFFICE_DEFAULTS } from "../../src/config";
import { appendEntries } from "../../src/changelog/log";
import {
  type AutoMergeGuard,
  decideMergeGate,
  decideTestedMergeGates,
  guardedParkWriter,
  guardedUnparkWriter,
  mergeGatesOfRun,
  STORY_MERGE_NOTICES,
} from "../../src/merge";
import { CodeHostError } from "../../src/platform/host";
import { recordReviewOverride, recordReviewVerdict } from "../../src/review/store";
import { recordCatchUp } from "../../src/run/conflicts";
import { insertPark } from "../run/park-fixture";
import {
  openPark,
  PARK_NOTICES,
  parkStory,
  type ParkBranchRequest,
  type ParkWriter,
  type UnparkBranchRequest,
  type UnparkWriter,
} from "../../src/run/park";
import {
  appendRunStep,
  findRun,
  recordConfigSnapshot,
  runSteps,
} from "../../src/records/run-records";
import { reopen } from "../../src/run/rounds";
import { insertTest, recordTestResult } from "../../src/run/test-records";
import { findStoryPr, updateStoryPr } from "../../src/records/story-prs";
import type { JudgedReview } from "../../src/review/verdict";
import { reviewedAt } from "../run/in-review";

import {
  APPROVED,
  BRANCH,
  C1,
  H1,
  hostPr,
  noticeCodes,
  noticeTexts,
  PR,
  type StoryWorld,
  storyWorld,
  TITLE,
} from "./story-helpers";
import { backlogLayout } from "../story-store/backlog";

let s: StoryWorld;

afterEach(() => s?.close());

const gates = () => mergeGatesOfRun(s.w.office, s.run);
const armed = () => s.host.prs.get(PR)?.autoMerge === true;

/** One round: the gate opens by rule, the close-out is pushed and auto-merge goes on at C1. */
async function toArmed(): Promise<void> {
  await s.tick();
  expect(s.host.armedAt).toEqual([{ number: PR, head: C1 }]);
  expect(armed()).toBe(true);
}

function approve(gate: string): void {
  s.w.office.immediate(() =>
    decideMergeGate(s.w.office, gate, {
      decision: "approved",
      by: "maintainer",
      note: null,
      at: s.w.t.clock.now(),
    }),
  );
}

/** Flags the story test-before-merge in the mirror. */
function flag(): void {
  s.w.office.immediate(() =>
    s.w.office.run(
      `insert into backlog_mirror (office_id, key, content_hash, kind, status, title, labels,
         read_at, source)
       values ($office_id, $key, 'h', 'task', 'In Review', 'A story', $labels, 0, 'branch')
       on conflict (office_id, key) do update set labels = excluded.labels,
         source = excluded.source`,
      { key: s.key, labels: JSON.stringify(["test-before-merge"]) },
    ),
  );
}

/** Records the maintainer's test of `head` with `result` (DIPO-309). */
function tested(head: string, result: "pass" | "fail"): void {
  s.w.office.immediate(() => {
    const testId = s.w.t.ids.next("tst");
    insertTest(s.w.office, {
      testId,
      key: s.key,
      runId: s.run,
      head,
      box: `dipo-${testId}`,
      steps: [{ check: "Open it" }],
      at: s.w.t.clock.now(),
    });
    recordTestResult(s.w.office, s.w.t.ids, testId, {
      result,
      note: result === "fail" ? "broken" : null,
      at: s.w.t.clock.now(),
    });
    if (result === "pass") {
      decideTestedMergeGates(s.w.office, s.key, head, { testId, at: s.w.t.clock.now() });
    }
  });
}

describe("an approved merge gate", () => {
  it("commits the close-out, pushes, and runs gh pr merge --auto with exactly that head", async () => {
    s = await storyWorld();
    await toArmed();
    // The base is fetched and the release path read before the close-out (DIPO-382), and again for
    // the head that merges.
    expect(s.git.calls).toEqual(["fetch", `closeOut ${BRANCH}`, `push ${BRANCH}`, "fetch"]);
    expect(s.prSyncs).toEqual([s.run]);
    expect(findStoryPr(s.w.office, s.run)?.headSha).toBe(C1);
    expect(s.host.calls).toContain(`auto-merge on o/r #${PR} at ${C1}`);
    expect(s.host.subjects).toEqual([TITLE]);
    expect(gates()[0]?.decision).toMatchObject({ decision: "approved", by: "rule" });
    expect(noticeTexts(s.w.office, STORY_MERGE_NOTICES.autoMergeOn)[0]).toContain(
      `turned GitHub's auto-merge on at ${C1.slice(0, 12)}`,
    );
    // While nothing stops it, later rounds change nothing.
    await s.tick();
    await s.tick();
    expect(s.host.armedAt).toHaveLength(1);
    expect(s.host.disarmed).toEqual([]);
    expect(s.git.calls).toHaveLength(4);
  });

  it("does not turn auto-merge on when the push failed, and says why", async () => {
    s = await storyWorld();
    s.git.pushAnswer = { ok: false, detail: "the remote refused" };
    await s.tick();
    expect(s.host.armedAt).toEqual([]);
    expect(noticeTexts(s.w.office, STORY_MERGE_NOTICES.pushFailed)[0]).toContain(
      "the remote refused",
    );
  });

  it("tells a refused auto-merge once and tries again at the next round, with no second close-out", async () => {
    s = await storyWorld();
    s.host.enableError = new CodeHostError(
      "failed",
      "auto-merge is not allowed for this repository.",
    );
    await s.tick();
    await s.tick();
    expect(s.host.armedAt).toEqual([]);
    expect(noticeTexts(s.w.office, STORY_MERGE_NOTICES.autoMergeFailed)).toHaveLength(1);
    s.host.enableError = null;
    // The PR is at C1 now, whose checks run: the gate decided by rule holds for it (DIPO-382).
    s.ci.set(s.run, { kind: "pending", head: C1 });
    await s.tick();
    expect(s.host.armedAt).toEqual([{ number: PR, head: C1 }]);
    expect(s.git.heads.get(BRANCH)).toBe(C1);
  });

  it("hands a conflict GitHub reports to the worker instead of turning auto-merge on", async () => {
    s = await storyWorld();
    s.host.prs.set(PR, { ...hostPr(H1), mergeable: "conflicting" });
    const M = "3".repeat(40);
    const item = conflictFeedbackItem({
      base: "main",
      onto: "b".repeat(40),
      conflicts: [{ path: "src/greet.ts", kind: "content" }],
      hunks: [],
    });
    s.git.merges = [
      {
        kind: "planned",
        merged: {
          base: "main",
          onto: "b".repeat(40),
          tip: H1,
          commit: M,
          conflicts: [{ path: "src/greet.ts", kind: "content" }],
          taskFile: null,
          outsideBox: true,
        },
        item,
      },
    ];
    await s.tick();
    expect(s.host.armedAt).toEqual([]);
    expect(s.git.calls).toEqual([
      "fetch",
      `conflictMerge ${BRANCH}`,
      `moveBranch ${BRANCH}`,
      `push ${BRANCH}`,
    ]);
    expect(s.merges.map((merged) => merged.commit)).toEqual([M]);
    expect(s.conflicts).toEqual([{ run: s.run, head: M, item }]);
  });
});

describe("while auto-merge is on", () => {
  it("turns it off on a conflict and starts a fix round with the conflict", async () => {
    s = await storyWorld();
    await toArmed();
    const M = "3".repeat(40);
    const item = conflictFeedbackItem({
      base: "main",
      onto: "b".repeat(40),
      conflicts: [{ path: "src/greet.ts", kind: "content" }],
      hunks: [],
    });
    s.git.merges = [
      {
        kind: "planned",
        merged: {
          base: "main",
          onto: "b".repeat(40),
          tip: C1,
          commit: M,
          conflicts: [{ path: "src/greet.ts", kind: "content" }],
          taskFile: null,
          outsideBox: true,
        },
        item,
      },
    ];
    s.host.set(PR, { mergeable: "conflicting" });
    await s.tick();
    expect(s.host.disarmed).toEqual([PR]);
    expect(armed()).toBe(false);
    expect(s.conflicts).toEqual([{ run: s.run, head: M, item }]);
    expect(noticeTexts(s.w.office, STORY_MERGE_NOTICES.autoMergeOff)[0]).toContain(
      "GitHub reports that the base conflicts with it",
    );
  });

  it("parks the story conflict when the base conflicts where the worker cannot write", async () => {
    s = await storyWorld();
    await toArmed();
    s.git.merges = [
      { kind: "unwritable", base: "main", onto: "b".repeat(40), paths: [".github/ci.yml"] },
    ];
    s.host.set(PR, { mergeable: "conflicting" });
    await s.tick();
    expect(s.host.disarmed).toEqual([PR]);
    expect(openPark(backlogLayout, s.w.office, s.key)).toMatchObject({ reason: "conflict" });
    expect(openPark(backlogLayout, s.w.office, s.key)?.detail).toContain(".github/ci.yml");
    expect(s.conflicts).toEqual([]);
  });

  it("turns it off on red required checks and leaves the fix round to the CI path", async () => {
    s = await storyWorld();
    await toArmed();
    s.ci.set(s.run, { kind: "red", head: C1, items: [] });
    await s.tick();
    expect(s.host.disarmed).toEqual([PR]);
    expect(s.conflicts).toEqual([]);
    expect(noticeTexts(s.w.office, STORY_MERGE_NOTICES.autoMergeOff)[0]).toContain(
      "its required checks are red. The CI feedback goes back to its worker in a fix round.",
    );
    // Red on that head: it stays off.
    await s.tick();
    expect(s.host.armedAt).toHaveLength(1);
  });

  it("turns it off on a hold label and reopens the merge gate for the maintainer", async () => {
    s = await storyWorld();
    s.config = {
      ...OFFICE_DEFAULTS,
      merge: { ...OFFICE_DEFAULTS.merge, holdLabels: ["hold"] },
    };
    await toArmed();
    s.host.prLabelsOf.set(PR, ["hold"]);
    await s.tick();
    expect(s.host.disarmed).toEqual([PR]);
    const [first, reopened] = gates();
    expect(first?.decision).toMatchObject({ decision: "approved", by: "rule" });
    expect(reopened).toMatchObject({ head: C1, waitingOn: "maintainer", decision: null });
    expect(reopened?.summary).toContain('the PR carries the hold label "hold"');
    // Nothing turns it on again while the gate waits, even with the label gone.
    s.host.prLabelsOf.set(PR, []);
    s.ci.set(s.run, { kind: "green", head: C1 });
    await s.tick();
    expect(s.host.armedAt).toHaveLength(1);
    // The maintainer approves: it goes on again at the same head.
    approve(reopened!.gate);
    await s.tick();
    expect(s.host.armedAt).toEqual([
      { number: PR, head: C1 },
      { number: PR, head: C1 },
    ]);
  });

  it("turns it off for a head dipo did not push and reopens the gate for a hand merge or a discard", async () => {
    s = await storyWorld();
    await toArmed();
    const other = "9".repeat(40);
    s.host.set(PR, { headSha: other });
    await s.tick();
    expect(s.host.disarmed).toEqual([PR]);
    const reopened = gates().at(-1);
    expect(reopened).toMatchObject({ head: C1, waitingOn: "maintainer", decision: null });
    expect(reopened?.summary).toContain(`its head on GitHub is ${other.slice(0, 12)}`);
    expect(reopened?.summary).toContain("dipo discard DIPO-7");
    expect(noticeTexts(s.w.office, STORY_MERGE_NOTICES.headChanged)[0]).toContain(
      other.slice(0, 12),
    );
    // Even an approval of that gate does not turn auto-merge on for the foreign head.
    approve(reopened!.gate);
    s.ci.set(s.run, { kind: "green", head: C1 });
    await s.tick();
    expect(s.host.armedAt).toHaveLength(1);
  });

  it("keeps trying to turn it off when --disable-auto fails, and does nothing else meanwhile", async () => {
    s = await storyWorld();
    s.config = {
      ...OFFICE_DEFAULTS,
      merge: { ...OFFICE_DEFAULTS.merge, holdLabels: ["hold"] },
    };
    await toArmed();
    s.host.prLabelsOf.set(PR, ["hold"]);
    s.host.disableError = new CodeHostError("failed", "network down");
    await s.tick();
    await s.tick();
    expect(armed()).toBe(true);
    expect(gates()).toHaveLength(1);
    expect(noticeTexts(s.w.office, STORY_MERGE_NOTICES.autoMergeFailed)).toHaveLength(1);
    s.host.disableError = null;
    await s.tick();
    expect(s.host.disarmed).toEqual([PR]);
    expect(gates()).toHaveLength(2);
  });
});

describe("the release-path and autorelease guard", () => {
  it("never turns auto-merge on for a PR labelled autorelease: pending, even with an approved gate", async () => {
    s = await storyWorld();
    s.host.prLabelsOf.set(PR, ["autorelease: pending"]);
    await s.tick();
    expect(gates()[0]).toMatchObject({ waitingOn: "maintainer", decision: null });
    expect(gates()[0]?.summary).toContain("merge it by hand on GitHub");
    approve(gates()[0]!.gate);
    await s.tick();
    await s.tick();
    expect(s.host.armedAt).toEqual([]);
    expect(s.git.calls).toEqual([]);
    expect(noticeCodes(s.w.office)).toContain(STORY_MERGE_NOTICES.held);
  });

  it("turns auto-merge off when autorelease: pending is added after it went on", async () => {
    s = await storyWorld();
    await toArmed();
    s.host.prLabelsOf.set(PR, ["autorelease: pending"]);
    await s.tick();
    expect(s.host.disarmed).toEqual([PR]);
    expect(armed()).toBe(false);
    expect(gates().at(-1)?.summary).toContain('It carries "autorelease: pending"');
    approve(gates().at(-1)!.gate);
    s.ci.set(s.run, { kind: "green", head: C1 });
    await s.tick();
    expect(s.host.armedAt).toHaveLength(1);
  });

  it("never turns auto-merge on for a PR that changes the release path; its gate is hand-merge only", async () => {
    s = await storyWorld();
    s.git.release.set(H1, [".github/workflows/ci.yml"]);
    await s.tick();
    expect(gates()[0]).toMatchObject({ handMerge: "release-path", decision: null });
    approve(gates()[0]!.gate);
    await s.tick();
    expect(s.host.armedAt).toEqual([]);
    expect(s.git.calls).toEqual([]);
  });

  it("turns auto-merge on for nothing whose release path git cannot read", async () => {
    s = await storyWorld();
    s.git.release.set(H1, null);
    await s.tick();
    expect(s.host.armedAt).toEqual([]);
    expect(gates()).toEqual([]);
    expect(noticeCodes(s.w.office)).toContain(STORY_MERGE_NOTICES.releaseUnknown);
  });

  it("turns auto-merge off when the head changes the release path after it went on", async () => {
    s = await storyWorld();
    await toArmed();
    // The base's CODEOWNERS grew to cover a path the PR changes.
    s.git.release.set(C1, ["install.sh"]);
    await s.tick();
    expect(s.host.disarmed).toEqual([PR]);
    s.ci.set(s.run, { kind: "green", head: C1 });
    await s.tick();
    expect(gates().at(-1)).toMatchObject({ handMerge: "release-path", decision: null });
    expect(s.host.armedAt).toHaveLength(1);
  });
});

describe("PRs changed on GitHub", () => {
  it("keeps a PR whose host head differs from the pushed head out, with pr.headChanged naming both", async () => {
    s = await storyWorld();
    const other = "9".repeat(40);
    s.host.prs.set(PR, hostPr(other));
    await s.tick();
    expect(gates()).toEqual([]);
    const [text] = noticeTexts(s.w.office, STORY_MERGE_NOTICES.headChanged);
    expect(text).toContain(other.slice(0, 12));
    expect(text).toContain(H1.slice(0, 12));
    await s.tick();
    expect(noticeTexts(s.w.office, STORY_MERGE_NOTICES.headChanged)).toHaveLength(1);
  });

  it("parks the story by-maintainer when its PR was closed on the host, once", async () => {
    s = await storyWorld();
    s.host.prs.set(PR, hostPr(H1, "closed"));
    await s.tick();
    expect(openPark(backlogLayout, s.w.office, s.key)).toMatchObject({
      reason: "by-maintainer",
      detail: `PR #${PR} closed on GitHub`,
    });
    await s.tick();
    expect(s.parks).toHaveLength(1);
  });

  it("does nothing more for a PR GitHub merged: the Done poll takes it", async () => {
    s = await storyWorld();
    await toArmed();
    s.host.githubMerges(PR);
    await s.tick();
    expect(s.host.disarmed).toEqual([]);
    expect(s.git.calls).toHaveLength(4);
  });
});

describe("the merge gate", () => {
  it("waits for the maintainer when merge.autoMerge is false, and nothing goes on until it is approved", async () => {
    s = await storyWorld();
    s.config = {
      ...OFFICE_DEFAULTS,
      merge: { ...OFFICE_DEFAULTS.merge, autoMerge: false },
    };
    await s.tick();
    await s.tick();
    expect(gates()).toHaveLength(1);
    const gate = gates()[0]!;
    expect(gate).toMatchObject({ waitingOn: "maintainer", decision: null });
    expect(gate.summary).toContain("merge.autoMerge is off");
    expect(s.host.armedAt).toEqual([]);
    approve(gate.gate);
    await s.tick();
    expect(s.host.armedAt).toEqual([{ number: PR, head: C1 }]);
  });

  it("reads autoMerge from the run's configuration snapshot, not the configuration in force", async () => {
    s = await storyWorld();
    s.w.office.immediate(() =>
      recordConfigSnapshot(
        s.w.office,
        "h",
        { ...OFFICE_DEFAULTS, merge: { ...OFFICE_DEFAULTS.merge, autoMerge: false } },
        0,
      ),
    );
    await s.tick();
    expect(gates()[0]).toMatchObject({ waitingOn: "maintainer", decision: null });
  });

  it("waits for the maintainer when the reviewer marked a criterion maintainer", async () => {
    s = await storyWorld({
      judged: {
        ...APPROVED,
        criteria: [
          { n: 1, status: "met", evidence: "fine" },
          { n: 2, status: "maintainer", evidence: "an approval only the maintainer gives" },
        ],
      },
    });
    await s.tick();
    expect(gates()[0]).toMatchObject({ waitingOn: "maintainer" });
    expect(gates()[0]?.summary).toContain("#2");
  });

  it("waits for the maintainer for a flagged story, offers dipo test, phase test", async () => {
    s = await storyWorld();
    flag();
    await s.tick();
    const gate = gates()[0]!;
    expect(gate.waitingOn).toBe("maintainer");
    expect(gate.waits).toEqual(["testBeforeMerge"]);
    expect(gate.summary).toContain("flagged test-before-merge");
    expect(gate.summary).toContain("dipo test");
    expect(
      runSteps(s.w.office, s.run)
        .filter((step) => step.kind === "phase")
        .at(-1)?.value,
    ).toBe("test");
  });

  // DIPO-309: a pass decides the story's test gate for its head; the merge gate no longer waits on
  // the flag for that head.
  it("decides a flagged story's gate by rule when a pass is recorded for the head first", async () => {
    s = await storyWorld();
    flag();
    tested(H1, "pass");
    await s.tick();
    const gate = gates()[0]!;
    expect(gate.waits).toEqual([]);
    expect(gate.decision).toMatchObject({ decision: "approved", by: "rule" });
    expect(gate.summary).toContain(`The maintainer's test of ${H1.slice(0, 12)} passed.`);
  });

  it("lets a pass decide an open gate that waits only on the flag, by the maintainer", async () => {
    s = await storyWorld();
    flag();
    await s.tick();
    expect(gates()[0]?.decision).toBeNull();
    tested(H1, "pass");
    expect(gates()[0]?.decision).toMatchObject({ decision: "approved", by: "maintainer" });
    expect(gates()[0]?.decision?.note).toContain("passed");
  });

  it("keeps a gate waiting after a fail, a pass on an older head, or another reason", async () => {
    s = await storyWorld();
    flag();
    await s.tick();
    tested(H1, "fail");
    tested("0".repeat(40), "pass");
    expect(gates()[0]?.decision).toBeNull();
  });

  it("waits for the maintainer when the story passed only by an override", async () => {
    s = await storyWorld({ judged: { ...APPROVED, verdict: "blocked" } });
    s.w.office.immediate(() =>
      recordReviewOverride(s.w.office, s.verdict.gate, { note: "fine", at: s.w.t.clock.now() }),
    );
    await s.tick();
    expect(gates()[0]).toMatchObject({ waitingOn: "maintainer" });
    expect(gates()[0]?.summary).toContain("override");
  });

  it("opens no gate before an approved verdict holds for the head", async () => {
    s = await storyWorld({ judged: { ...APPROVED, verdict: "blocked" } });
    await s.tick();
    expect(gates()).toEqual([]);
    expect(s.git.calls).toEqual([]);
  });

  // DIPO-382: a gate decided by rule does not wait for the reviewed head's checks.
  for (const [name, state] of [
    ["pending on the head", { kind: "pending", head: H1 }],
    ["stuck on the head", { kind: "stuck", head: H1 }],
    ["green on another head", { kind: "green", head: "0".repeat(40) }],
    ["not watched yet", null],
  ] as const) {
    it(`opens a gate decided by rule on the approved verdict with checks ${name}`, async () => {
      s = await storyWorld();
      if (state === null) s.ci.delete(s.run);
      else s.ci.set(s.run, state);
      await s.tick();
      expect(gates()).toEqual([
        expect.objectContaining({
          head: H1,
          waitingOn: "rule",
          decision: expect.objectContaining({ decision: "approved", by: "rule" }),
        }),
      ]);
      expect(gates()[0]?.summary).toContain(
        "GitHub merges it once its required checks pass on the close-out head",
      );
      expect(s.host.armedAt).toEqual([{ number: PR, head: C1 }]);
    });
  }

  it("opens no gate while the head's checks are red: the CI path's fix round takes it", async () => {
    s = await storyWorld();
    s.ci.set(s.run, { kind: "red", head: H1, items: [] });
    await s.tick();
    expect(gates()).toEqual([]);
    expect(s.git.calls).toEqual([]);
    expect(s.git.task.status).toBe("In Review");
  });

  it("opens a new gate for a new head and closes the open one of the old head as superseded", async () => {
    s = await storyWorld();
    s.config = {
      ...OFFICE_DEFAULTS,
      merge: { ...OFFICE_DEFAULTS.merge, autoMerge: false },
    };
    await s.tick();
    const first = gates()[0]!;
    const H2 = "2".repeat(40);
    s.w.office.immediate(() => {
      s.w.office.run("update story_prs set head_sha = $head where office_id = $office_id", {
        head: H2,
      });
      recordReviewVerdict(s.w.office, s.w.t.ids, {
        runId: s.run,
        key: s.key,
        round: 2,
        agent: null,
        model: "opus",
        commit: H2,
        codeTreeKey: "tree-2",
        judged: APPROVED,
        at: s.w.t.clock.now(),
      });
    });
    s.git.trees.set(H2, "tree-2");
    s.host.prs.set(PR, hostPr(H2));
    s.ci.set(s.run, { kind: "green", head: H2 });
    await s.tick();
    const [old, next] = gates();
    expect(old).toMatchObject({ gate: first.gate, decision: { decision: "rejected", by: "rule" } });
    expect(next).toMatchObject({ head: H2, waitingOn: "maintainer", decision: null });
  });

  it("opens the override gate of a story parked review-blocked, with the blocking findings, once", async () => {
    s = await storyWorld({
      judged: {
        ...APPROVED,
        verdict: "blocked",
        criteria: [
          { n: 1, status: "met", evidence: "fine" },
          { n: 2, status: "unmet", evidence: "nothing checks an empty name" },
        ],
      },
    });
    s.w.office.immediate(() =>
      insertPark(s.w.office, {
        key: s.key,
        story: "DIPO-7",
        runId: s.run,
        reason: "review-blocked",
        from: "In Review",
        detail: "blocked",
        at: 0,
      }),
    );
    await s.tick();
    await s.tick();
    expect(gates()).toHaveLength(1);
    expect(gates()[0]).toMatchObject({
      waitingOn: "maintainer",
      overrideOf: s.verdict.gate,
      head: H1,
      decision: null,
    });
    expect(gates()[0]?.summary).toContain("criterion #2 unmet: nothing checks an empty name");
  });
});

/** Opens a park of the story's run, as a CI-cap or a maintainer park records it. */
function parkRun(reason: "verify-failing" | "by-maintainer"): void {
  s.w.office.immediate(() =>
    insertPark(s.w.office, {
      key: s.key,
      story: "DIPO-7",
      runId: s.run,
      reason,
      from: "In Review",
      detail: "parked",
      at: 0,
    }),
  );
}

/** A park writer and a lift writer that only record what reached the branch. */
function branchWriters(): {
  readonly parks: ParkBranchRequest[];
  readonly lifts: UnparkBranchRequest[];
  readonly park: ParkWriter;
  readonly unpark: UnparkWriter;
} {
  const parks: ParkBranchRequest[] = [];
  const lifts: UnparkBranchRequest[] = [];
  return {
    parks,
    lifts,
    park: {
      write: async (_office, request) => {
        parks.push(request);
        return {
          commit: "p".repeat(40),
          lastGoodCommit: C1,
          from: "In Review",
          pushed: true,
          pushError: null,
        };
      },
    },
    unpark: {
      lift: async (_office, request) => {
        lifts.push(request);
        return { commit: "u".repeat(40), pushed: true, pushError: null };
      },
    },
  };
}

describe("a story that stops waiting for its merge while auto-merge is on", () => {
  it("gets auto-merge off at the next round when a fix round reopened its run", async () => {
    s = await storyWorld();
    await toArmed();
    // The CI path reopened the run for a fix round: it no longer waits In Review.
    s.w.office.immediate(() =>
      s.w.office.run(
        "update runs set ended_at = null, end_kind = null where office_id = $office_id and run_id = $run",
        { run: s.run },
      ),
    );
    await s.tick();
    expect(s.host.disarmed).toEqual([PR]);
    expect(noticeTexts(s.w.office, STORY_MERGE_NOTICES.autoMergeOff)[0]).toContain(
      "its story no longer waits for its merge",
    );
  });

  for (const reason of ["verify-failing", "by-maintainer"] as const) {
    it(`gets auto-merge off at the next round when it parked ${reason}`, async () => {
      s = await storyWorld();
      await toArmed();
      parkRun(reason);
      await s.tick();
      expect(s.host.disarmed).toEqual([PR]);
      // Off for good: nothing turns it on again while the story is parked.
      await s.tick();
      expect(s.host.armedAt).toHaveLength(1);
    });
  }

  it("turns auto-merge off before a CI-cap or maintainer park and before a fix round's lift is written", async () => {
    s = await storyWorld();
    const w = branchWriters();
    const park = guardedParkWriter(w.park, guard());
    const unpark = guardedUnparkWriter(w.unpark, guard());
    const request = { story: "DIPO-7", branch: BRANCH, worktree: "/w" };
    for (const reason of ["verify-failing", "by-maintainer"] as const) {
      await toArmedAgain();
      await park.write(s.officeId, { ...request, reason, note: "parked" });
      expect(s.host.prs.get(PR)?.autoMerge).toBe(false);
    }
    await toArmedAgain();
    await unpark.lift(s.officeId, { ...request, to: "In Progress" });
    expect(s.host.prs.get(PR)?.autoMerge).toBe(false);
    expect(s.host.disarmed).toEqual([PR, PR, PR]);
    expect(w.parks).toHaveLength(2);
    expect(w.lifts).toHaveLength(1);
  });

  it("fails closed: nothing is written to the branch while GitHub refuses to turn auto-merge off", async () => {
    s = await storyWorld();
    await toArmed();
    const w = branchWriters();
    s.host.disableError = new CodeHostError("failed", "network down");
    const request = { story: "DIPO-7", branch: BRANCH, worktree: "/w" };
    await expect(
      guardedParkWriter(w.park, guard()).write(s.officeId, {
        ...request,
        reason: "verify-failing",
        note: "red",
      }),
    ).rejects.toThrow("turning auto-merge off for PR #7 failed (GitHub refused: network down)");
    await expect(
      guardedUnparkWriter(w.unpark, guard()).lift(s.officeId, { ...request, to: "In Progress" }),
    ).rejects.toThrow("so dipo wrote nothing to");
    // GitHub cannot be read at all: no write either.
    s.host.failWith = "failed";
    await expect(
      guardedParkWriter(w.park, guard()).write(s.officeId, {
        ...request,
        reason: "by-maintainer",
        note: "stop",
      }),
    ).rejects.toThrow("GitHub could not be read");
    s.host.failWith = null;
    expect(w.parks).toEqual([]);
    expect(w.lifts).toEqual([]);
    s.host.disableError = null;
    await guardedParkWriter(w.park, guard()).write(s.officeId, {
      ...request,
      reason: "verify-failing",
      note: "red",
    });
    expect(w.parks).toHaveLength(1);
  });
});

/** The guard the daemon builds: `AutoMerge.guarded`. */
function guard(): AutoMergeGuard {
  return (office, branch, write) => s.merge.guarded(office, branch, write);
}

/** `parkStory` as the daemon composes it: a guarded writer over `writer`. */
async function guardedPark(writer: ParkWriter, reason: "verify-failing" | "by-maintainer") {
  const run = findRun(s.w.office, s.run);
  if (run === null) throw new Error("no run");
  return parkStory(
    {
      office: s.w.office,
      writer: guardedParkWriter(writer, guard()),
      now: () => s.w.t.clock.now(),
      write: (fn) =>
        s.w.office.immediate(() => {
          appendEntries(s.w.office, fn(), { at: s.w.t.clock.now() });
        }),
      implemented: () => true,
    },
    { run, reason, detail: "parked" },
  );
}

/** A gate a test opens: a promise the fake waits on, and its release. */
function latch(): { readonly wait: Promise<void>; readonly open: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { wait: promise, open: () => resolve() };
}

describe("a park through the composed writer, racing a round", () => {
  it("turns auto-merge off before the park is written, and records it", async () => {
    s = await storyWorld();
    await toArmed();
    const w = branchWriters();
    const order: string[] = [];
    const disable = s.host.disableAutoMerge.bind(s.host);
    s.host.disableAutoMerge = async (...args) => {
      order.push("off");
      return disable(...args);
    };
    const write = w.park.write.bind(w.park);
    await guardedPark(
      { write: async (o, r) => (order.push("write"), write(o, r)) },
      "by-maintainer",
    );
    expect(order).toEqual(["off", "write"]);
    expect(openPark(backlogLayout, s.w.office, s.key)).toMatchObject({ reason: "by-maintainer" });
    await s.tick();
    expect(s.host.armedAt).toHaveLength(1);
  });

  it("says the park was not written because turning auto-merge off failed", async () => {
    s = await storyWorld();
    await toArmed();
    const w = branchWriters();
    s.host.disableError = new CodeHostError("failed", "network down");
    await guardedPark(w.park, "verify-failing");
    expect(w.parks).toEqual([]);
    expect(noticeTexts(s.w.office, PARK_NOTICES.notWritten)[0]).toContain(
      "turning auto-merge off for PR #7 failed (GitHub refused: network down)",
    );
  });

  it("waits for a round that is turning auto-merge on, then turns it off before the park", async () => {
    s = await storyWorld();
    const held = latch();
    const enable = s.host.enableAutoMerge.bind(s.host);
    s.host.enableAutoMerge = async (...args) => {
      await held.wait;
      return enable(...args);
    };
    const w = branchWriters();
    const round = s.tick();
    // Let the round reach GitHub's enable call before the park starts.
    for (let i = 0; i < 50 && s.host.armedAt.length === 0 && !s.git.calls.includes("fetch"); i++) {
      await Bun.sleep(0);
    }
    const parked = guardedPark(w.park, "by-maintainer");
    await Bun.sleep(1);
    // The park waits for the round: nothing is written yet.
    expect(w.parks).toEqual([]);
    held.open();
    await round;
    await parked;
    expect(s.host.armedAt).toEqual([{ number: PR, head: C1 }]);
    expect(s.host.disarmed).toEqual([PR]);
    expect(w.parks).toHaveLength(1);
    expect(s.host.prs.get(PR)?.autoMerge).toBe(false);
  });

  it("keeps a round that comes during the park from turning auto-merge on", async () => {
    s = await storyWorld();
    const held = latch();
    const w = branchWriters();
    const write = w.park.write.bind(w.park);
    const parked = guardedPark(
      {
        write: async (o, r) => {
          await held.wait;
          return write(o, r);
        },
      },
      "by-maintainer",
    );
    await Bun.sleep(1);
    // A round comes while the park is being written: it waits for the park.
    const round = s.tick();
    await Bun.sleep(1);
    expect(s.git.calls).toEqual([]);
    held.open();
    await parked;
    await round;
    expect(openPark(backlogLayout, s.w.office, s.key)).toMatchObject({ reason: "by-maintainer" });
    expect(s.host.armedAt).toEqual([]);
    expect(s.git.calls).toEqual([]);
  });
});

/** Auto-merge on again for PR #7 at its current head, as an earlier round left it. */
async function toArmedAgain(): Promise<void> {
  if (s.host.armedAt.length === 0) {
    await toArmed();
    return;
  }
  s.host.set(PR, { autoMerge: true });
}

describe("a conflict hand-off a crash cut short", () => {
  const M = "3".repeat(40);
  const conflicts = [{ path: "src/greet.ts", kind: "content" as const }];

  it("records the merge before the branch moves to it, and moves nothing when the record fails", async () => {
    s = await storyWorld();
    await toArmed();
    s.git.merges = [
      {
        kind: "planned",
        merged: {
          base: "main",
          onto: "b".repeat(40),
          tip: C1,
          commit: M,
          conflicts,
          taskFile: null,
          outsideBox: true,
        },
        item: conflictFeedbackItem({ base: "main", onto: "b".repeat(40), conflicts, hunks: [] }),
      },
    ];
    s.failRecord = true;
    s.host.set(PR, { mergeable: "conflicting" });
    await s.tick();
    expect(s.git.calls).not.toContain(`moveBranch ${BRANCH}`);
    expect(s.conflicts).toEqual([]);
    expect(noticeCodes(s.w.office)).toContain(STORY_MERGE_NOTICES.unrecorded);
  });

  for (const where of ["before the branch moved", "after the branch moved"] as const) {
    it(`finishes it at the next round when the crash came ${where}`, async () => {
      s = await storyWorld();
      await toArmed();
      // The record of the merge is there; the crash left the branch at C1 or at the merge.
      s.w.office.immediate(() =>
        recordCatchUp(
          s.w.office,
          s.run,
          { kind: "merged", base: "main", onto: "b".repeat(40), tip: C1, commit: M, conflicts },
          s.w.t.clock.now(),
        ),
      );
      if (where === "after the branch moved") s.git.heads.set(BRANCH, M);
      s.host.set(PR, { mergeable: "conflicting" });
      await s.tick();
      expect(s.git.calls).not.toContain(`conflictMerge ${BRANCH}`);
      expect(s.git.heads.get(BRANCH)).toBe(M);
      expect(s.git.calls).toContain(`conflictItem ${M}`);
      expect(s.git.calls.at(-1)).toBe(`push ${BRANCH}`);
      expect(s.conflicts.map((c) => c.head)).toEqual([M]);
    });
  }
});

describe("the release path read again before auto-merge goes on", () => {
  it("turns nothing on when the base cannot be fetched", async () => {
    s = await storyWorld();
    s.git.fetchOk = false;
    await s.tick();
    expect(s.host.armedAt).toEqual([]);
    expect(noticeTexts(s.w.office, STORY_MERGE_NOTICES.releaseUnknown)[0]).toContain(
      "the fetch of the base failed",
    );
  });
});

/** A short name of the heads these tests push, for an order log. */
const nameOf = (sha: string): string => ({ [H1]: "H1", [C1]: "C1" })[sha] ?? sha.slice(0, 12);

// DIPO-382 (0002): a gate decided by rule opens on the approved verdict, and CI runs once, on the
// close-out head, while GitHub's auto-merge waits for it.
describe("the by-rule path", () => {
  it("goes verdict, close-out commit, auto-merge, one wait for checks, merge", async () => {
    s = await storyWorld();
    // storyWorld recorded the approved verdict on H1.
    const order: string[] = [`verdict ${nameOf(s.verdict.commit)}`];
    const closeOut = s.git.closeOut.bind(s.git);
    s.git.closeOut = async (office, run, summary) => {
      const ci = s.ci.get(s.run);
      const commit = await closeOut(office, run, summary);
      if (commit !== null) {
        order.push(`close-out ${nameOf(commit)}, checks ${ci?.kind} on ${nameOf(ci?.head ?? "")}`);
      }
      return commit;
    };
    const enable = s.host.enableAutoMerge.bind(s.host);
    s.host.enableAutoMerge = async (repo, number, merge) => {
      await enable(repo, number, merge);
      order.push(`auto-merge ${nameOf(merge.headSha)}`);
    };
    // The verdict came minutes after the In Review push: H1's checks still run.
    s.ci.set(s.run, { kind: "pending", head: H1 });
    await s.tick();
    // The close-out push cancelled H1's run; the PR poll watches C1, whose checks run once.
    s.ci.set(s.run, { kind: "pending", head: C1 });
    for (let i = 0; i < 3; i++) await s.tick();
    expect(s.host.prs.get(PR)?.state).toBe("open");
    s.ci.set(s.run, { kind: "green", head: C1 });
    order.push("checks green on C1");
    await s.tick();
    // GitHub merges once the required checks pass on the head auto-merge was given.
    s.host.githubMerges(PR);
    order.push(`merged at ${nameOf(s.host.prs.get(PR)?.headSha ?? "")}`);
    await s.tick();
    expect(order).toEqual([
      "verdict H1",
      "close-out C1, checks pending on H1",
      "auto-merge C1",
      "checks green on C1",
      "merged at C1",
    ]);
    // One close-out, one auto-merge, never turned off.
    expect(s.git.calls.filter((call) => call.startsWith("push"))).toHaveLength(1);
    expect(s.host.armedAt).toEqual([{ number: PR, head: C1 }]);
    expect(s.host.disarmed).toEqual([]);
    expect(s.git.task.status).toBe("Done");
    expect(s.git.task.finalSummary).toStartWith("Closed ");
  });

  it("turns auto-merge off on red checks of the close-out head; after the fix round the next close-out replaces the final summary", async () => {
    s = await storyWorld();
    s.ci.set(s.run, { kind: "pending", head: H1 });
    await toArmed();
    const first = s.git.task.finalSummary;
    expect(first).toContain(
      "CI attempts: 0 (red heads, reviewed or closed out, before this close-out)",
    );
    // The close-out head's checks turn red: auto-merge goes off, and the CI path takes the round.
    s.ci.set(s.run, { kind: "red", head: C1, items: [] });
    await s.tick();
    expect(s.host.disarmed).toEqual([PR]);
    expect(noticeTexts(s.w.office, STORY_MERGE_NOTICES.autoMergeOff)[0]).toContain(
      "its required checks are red",
    );
    // As the PR poll records the red head and the fix round reopens the run and commits its status
    // through the auto-merge guard (fix-rounds.test.ts runs the round itself).
    s.w.office.immediate(() => {
      appendRunStep(s.w.office, s.run, "ci", C1, s.w.t.clock.now());
      const run = findRun(s.w.office, s.run);
      if (run !== null) reopen(s.w.office, run, s.w.t.clock.now(), { kind: "fix" });
    });
    await guardedUnparkWriter(
      {
        lift: async (_office, request) => {
          s.git.task.status = request.to;
          return { commit: "f".repeat(40), pushed: true, pushError: null };
        },
      },
      guard(),
    ).lift(s.officeId, { story: "DIPO-7", branch: BRANCH, to: "In Progress" });
    expect(s.git.task.status).toBe("In Progress");
    await s.tick();
    expect(s.host.armedAt).toHaveLength(1);

    // The worker's fix comes back In Review at H2, and the review approves it.
    const H2 = "2".repeat(40);
    const C2 = "d".repeat(40);
    s.w.t.clock.advance(60_000);
    s.git.heads.set(BRANCH, H2);
    s.git.trees.set(H2, "tree-2");
    s.git.closeOutCommit = C2;
    s.w.office.immediate(() => {
      updateStoryPr(s.w.office, s.run, { headSha: H2, title: TITLE, bodyHash: "hash" });
      recordReviewVerdict(s.w.office, s.w.t.ids, {
        runId: s.run,
        key: s.key,
        round: 2,
        agent: null,
        model: "opus",
        commit: H2,
        codeTreeKey: "tree-2",
        judged: APPROVED,
        at: s.w.t.clock.now(),
      });
    });
    reviewedAt(s.w.office, s.run, s.w.t.clock.now());
    s.host.prs.set(PR, hostPr(H2));
    s.ci.set(s.run, { kind: "pending", head: H2 });
    await s.tick();
    expect(s.host.armedAt).toEqual([
      { number: PR, head: C1 },
      { number: PR, head: C2 },
    ]);
    expect(s.git.task.status).toBe("Done");
    expect(s.git.task.finalSummary).not.toBe(first);
    expect(s.git.task.finalSummary).toContain(
      "CI attempts: 1 (red heads, reviewed or closed out, before this close-out)",
    );
  });
});

/** A path on which the merge gate waits for the maintainer (0002). */
interface WaitingPath {
  readonly name: string;
  readonly judged?: JudgedReview;
  /** Makes the gate wait for the maintainer. */
  readonly setup: () => void;
  /** The maintainer's decision; null: only a merge by hand on GitHub merges the PR. */
  readonly decide: ((gate: string) => void) | null;
}

const HOLD = { ...OFFICE_DEFAULTS.merge, holdLabels: ["hold"] };

const WAITING: readonly WaitingPath[] = [
  {
    name: "merge.autoMerge off (dipo approve)",
    setup: () => {
      s.config = { ...OFFICE_DEFAULTS, merge: { ...OFFICE_DEFAULTS.merge, autoMerge: false } };
    },
    decide: approve,
  },
  { name: "test before merge", setup: flag, decide: () => tested(H1, "pass") },
  {
    name: "a maintainer criterion",
    judged: {
      ...APPROVED,
      criteria: [
        { n: 1, status: "met", evidence: "fine" },
        { n: 2, status: "maintainer", evidence: "an approval only the maintainer gives" },
      ],
    },
    setup: () => undefined,
    decide: approve,
  },
  {
    name: "an override",
    judged: { ...APPROVED, verdict: "blocked" },
    setup: () =>
      s.w.office.immediate(() =>
        recordReviewOverride(s.w.office, s.verdict.gate, { note: "fine", at: s.w.t.clock.now() }),
      ),
    decide: approve,
  },
  {
    name: "a hold label",
    setup: () => {
      s.config = { ...OFFICE_DEFAULTS, merge: HOLD };
      s.host.prLabelsOf.set(PR, ["hold"]);
    },
    decide: (gate) => {
      approve(gate);
      s.host.prLabelsOf.set(PR, []);
    },
  },
  {
    name: "the release path",
    setup: () => s.git.release.set(H1, [".github/workflows/ci.yml"]),
    decide: null,
  },
  {
    name: "autorelease: pending",
    setup: () => s.host.prLabelsOf.set(PR, ["autorelease: pending"]),
    decide: null,
  },
];

// DIPO-382 (0002): every path where the gate waits for the maintainer keeps its order: green
// checks on the head, then the maintainer, then the close-out. No task file reads Done meanwhile.
describe("a merge gate that waits for the maintainer", () => {
  for (const path of WAITING) {
    it(`${path.name}: green checks on the head, then the maintainer, then the close-out`, async () => {
      s = await storyWorld(path.judged === undefined ? {} : { judged: path.judged });
      path.setup();
      s.ci.set(s.run, { kind: "pending", head: H1 });
      await s.tick();
      await s.tick();
      // No gate and no close-out while the head's checks run.
      expect(gates()).toEqual([]);
      expect(s.git.calls).toEqual([]);
      expect(s.git.task.status).toBe("In Review");
      s.ci.set(s.run, { kind: "green", head: H1 });
      await s.tick();
      const gate = gates()[0];
      expect(gate).toMatchObject({ head: H1, waitingOn: "maintainer", decision: null });
      // The gate waits for the maintainer: still nothing on the branch.
      await s.tick();
      expect(s.git.calls).toEqual([]);
      expect(s.git.task.status).toBe("In Review");
      if (path.decide === null) {
        // Even an approval in the database never closes out a PR only a hand merge merges.
        approve(gate!.gate);
        await s.tick();
        expect(s.git.calls).toEqual([]);
        expect(s.git.task.status).toBe("In Review");
        expect(s.host.armedAt).toEqual([]);
        return;
      }
      path.decide(gate!.gate);
      await s.tick();
      expect(s.git.calls.slice(0, 2)).toEqual(["fetch", `closeOut ${BRANCH}`]);
      expect(s.git.task.status).toBe("Done");
      expect(s.host.armedAt).toEqual([{ number: PR, head: C1 }]);
    });
  }
});

// The DIPO-382 review's fix round: what still holds a by-rule close-out, and what a later hold does.
describe("the by-rule path's holds", () => {
  it("a hold label after the close-out, while its checks run, turns auto-merge off and waits for the maintainer and green", async () => {
    s = await storyWorld();
    s.config = { ...OFFICE_DEFAULTS, merge: HOLD };
    s.ci.set(s.run, { kind: "pending", head: H1 });
    await toArmed();
    s.ci.set(s.run, { kind: "pending", head: C1 });
    s.host.prLabelsOf.set(PR, ["hold"]);
    await s.tick();
    expect(s.host.disarmed).toEqual([PR]);
    const reopened = gates().at(-1);
    expect(reopened).toMatchObject({ head: C1, waitingOn: "maintainer", decision: null });
    // The closed-out head's Done stands on the branch while the gate waits (0002).
    expect(s.git.task.status).toBe("Done");
    // The maintainer approves and the label goes: nothing turns auto-merge on before green.
    approve(reopened!.gate);
    s.host.prLabelsOf.set(PR, []);
    await s.tick();
    await s.tick();
    expect(s.host.armedAt).toHaveLength(1);
    expect(s.host.prs.get(PR)?.state).toBe("open");
    s.ci.set(s.run, { kind: "green", head: C1 });
    await s.tick();
    expect(s.host.armedAt).toEqual([
      { number: PR, head: C1 },
      { number: PR, head: C1 },
    ]);
  });

  it("reads the release path on the fetched base before the close-out: a PR that became release-path gets no Done", async () => {
    s = await storyWorld();
    s.ci.set(s.run, { kind: "pending", head: H1 });
    // The base's CODEOWNERS grew since the last fetch: the gate's read still sees none.
    const fetch = s.git.fetch.bind(s.git);
    s.git.fetch = async () => {
      s.git.release.set(H1, ["install.sh"]);
      return fetch();
    };
    await s.tick();
    expect(s.git.calls).toEqual(["fetch"]);
    expect(s.git.task.status).toBe("In Review");
    expect(s.host.armedAt).toEqual([]);
    // It now waits for green checks, then for the maintainer's merge by hand.
    await s.tick();
    expect(gates()).toHaveLength(1);
    s.ci.set(s.run, { kind: "green", head: H1 });
    await s.tick();
    expect(gates().at(-1)).toMatchObject({ handMerge: "release-path", decision: null });
    expect(s.git.calls).not.toContain(`closeOut ${BRANCH}`);
    expect(s.git.task.status).toBe("In Review");
  });

  it("holds the gate while a required check already failed and others still run", async () => {
    s = await storyWorld();
    s.ci.set(s.run, { kind: "failing", head: H1 });
    await s.tick();
    expect(gates()).toEqual([]);
    expect(s.git.calls).toEqual([]);
    expect(s.git.task.status).toBe("In Review");
  });

  it("keeps a flagged story waiting for green checks even with a pass recorded while it was reviewed", async () => {
    s = await storyWorld();
    flag();
    tested(H1, "pass");
    s.ci.set(s.run, { kind: "pending", head: H1 });
    await s.tick();
    await s.tick();
    expect(gates()).toEqual([]);
    expect(s.git.calls).toEqual([]);
    expect(s.git.task.status).toBe("In Review");
    // Green: the pass is the maintainer's decision, so the gate is decided and the close-out follows.
    s.ci.set(s.run, { kind: "green", head: H1 });
    await s.tick();
    expect(gates()[0]).toMatchObject({ head: H1, decision: { decision: "approved" } });
    expect(s.git.task.status).toBe("Done");
    expect(s.host.armedAt).toEqual([{ number: PR, head: C1 }]);
  });
});
