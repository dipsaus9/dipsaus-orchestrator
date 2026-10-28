// GitHub's auto-merge for story PRs (0002) on a migrated state database built from fixtures, with a
// fake code host, a scripted story merge git and the CI state of the PR poll as a map:
//
// - an approved gate leads to the close-out commit, one push, the PR at the pushed head, and
//   `gh pr merge --auto --squash --match-head-commit` at exactly that head, with the PR title;
// - while auto-merge is on, a conflict and red checks turn it off and lead to a fix round, and a
//   hold label or a head dipo did not push turn it off and reopen the merge gate;
// - a release-path PR and a PR labelled `autorelease: pending` never get auto-merge, also when the
//   label or the release path comes after auto-merge went on;
// - the merge gate opens and is decided by rule or waits for the maintainer as before.
//
// The real decision functions run (`StoryMerges` through `AutoMerge`); only git, `gh` and the
// branch writes are fakes.

import { afterEach, describe, expect, it } from "bun:test";

import { conflictFeedbackItem } from "../../src/box/collisions";
import { OFFICE_DEFAULTS } from "../../src/config";
import { decideMergeGate, mergeGatesOfRun, STORY_MERGE_NOTICES } from "../../src/merge";
import { CodeHostError } from "../../src/platform/host";
import { recordReviewOverride, recordReviewVerdict } from "../../src/review/store";
import { openPark } from "../../src/run/park";
import { recordConfigSnapshot, runSteps } from "../../src/run/records";
import { findStoryPr } from "../../src/story-pr/records";

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

describe("an approved merge gate", () => {
  it("commits the close-out, pushes, and runs gh pr merge --auto with exactly that head", async () => {
    s = await storyWorld();
    await toArmed();
    expect(s.git.calls).toEqual([`closeOut ${BRANCH}`, `push ${BRANCH}`]);
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
    expect(s.git.calls).toHaveLength(2);
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

  it("tells a refused auto-merge once and tries again when the head's checks are green", async () => {
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
    // The PR is at C1 now: it waits for green checks on that head first.
    await s.tick();
    expect(s.host.armedAt).toEqual([]);
    s.ci.set(s.run, { kind: "green", head: C1 });
    await s.tick();
    expect(s.host.armedAt).toEqual([{ number: PR, head: C1 }]);
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
    expect(openPark(s.w.office, s.key)).toMatchObject({ reason: "conflict" });
    expect(openPark(s.w.office, s.key)?.detail).toContain(".github/ci.yml");
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
      mergeSlot: { ...OFFICE_DEFAULTS.mergeSlot, holdLabels: ["hold"] },
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
      mergeSlot: { ...OFFICE_DEFAULTS.mergeSlot, holdLabels: ["hold"] },
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
    expect(openPark(s.w.office, s.key)).toMatchObject({
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
    expect(s.git.calls).toHaveLength(2);
  });
});

describe("the merge gate", () => {
  it("waits for the maintainer when mergeSlot.autoMerge is false, and nothing goes on until it is approved", async () => {
    s = await storyWorld();
    s.config = {
      ...OFFICE_DEFAULTS,
      mergeSlot: { ...OFFICE_DEFAULTS.mergeSlot, autoMerge: false },
    };
    await s.tick();
    await s.tick();
    expect(gates()).toHaveLength(1);
    const gate = gates()[0]!;
    expect(gate).toMatchObject({ waitingOn: "maintainer", decision: null });
    expect(gate.summary).toContain("mergeSlot.autoMerge is off");
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
        { ...OFFICE_DEFAULTS, mergeSlot: { ...OFFICE_DEFAULTS.mergeSlot, autoMerge: false } },
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

  it("waits for the maintainer for a flagged story, lists the worktree, phase test", async () => {
    s = await storyWorld();
    s.w.office.immediate(() =>
      s.w.office.run(
        `insert into backlog_mirror (office_id, key, content_hash, kind, status, title, labels,
           read_at, source)
         values ($office_id, $key, 'h', 'task', 'In Review', 'A story', $labels, 0, 'branch')`,
        { key: s.key, labels: JSON.stringify(["test-before-merge"]) },
      ),
    );
    await s.tick();
    const gate = gates()[0]!;
    expect(gate.waitingOn).toBe("maintainer");
    expect(gate.summary).toContain("flagged test-before-merge");
    expect(gate.summary).toContain("Test in the story worktree:");
    expect(
      runSteps(s.w.office, s.run)
        .filter((step) => step.kind === "phase")
        .at(-1)?.value,
    ).toBe("test");
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

  it("opens no gate before the verdict holds for the head and its checks are green on it", async () => {
    s = await storyWorld();
    s.ci.set(s.run, { kind: "pending", head: H1 });
    await s.tick();
    s.ci.set(s.run, { kind: "green", head: "0".repeat(40) });
    await s.tick();
    expect(gates()).toEqual([]);
    // A box run's head with no CI holds like green.
    s.ci.set(s.run, { kind: "none", head: H1 });
    await s.tick();
    expect(s.host.armedAt).toEqual([{ number: PR, head: C1 }]);
  });

  it("opens a new gate for a new head and closes the open one of the old head as superseded", async () => {
    s = await storyWorld();
    s.config = {
      ...OFFICE_DEFAULTS,
      mergeSlot: { ...OFFICE_DEFAULTS.mergeSlot, autoMerge: false },
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
      s.w.office.run(
        `insert into parks (office_id, park_id, key, story_id, run_id, reason, from_state, detail,
           at)
         values ($office_id, 1, $key, 'DIPO-7', $run, 'review-blocked', 'In Review', 'blocked', 0)`,
        { key: s.key, run: s.run },
      ),
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
