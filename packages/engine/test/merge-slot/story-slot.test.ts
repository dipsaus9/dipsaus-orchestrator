// Story PRs in the merge slot (DIPO-150 with DIPO-151; 0019 sections 9 and 11) on a migrated state
// database built from fixtures, with a fake code host, a scripted story slot git and the CI state
// of the PR poll as a map: the merge gate opens and is decided by rule or waits for the
// maintainer, and only an approved gate lets the PR in; the steps close out, sync, push, wait for
// the checks of the pushed head and squash-merge at that head with the PR title; a restart
// continues with the persisted occupant and merges once; labels, a moved host head, a PR closed
// on the host, red checks, a conflict and a host that keeps refusing are handled by section 9.
// The real-git cases are in story-slot.git.test.ts.

import { afterEach, describe, expect, it } from "bun:test";

import type { OfficeLane } from "../../src/backlog/lane";
import { insertPr, recordCheck } from "../../src/backlog/pr/records";
import { conflictFeedbackItem } from "../../src/box/collisions";
import { OFFICE_DEFAULTS } from "../../src/config";
import {
  decideMergeGate,
  mergeGatesOfRun,
  type SlotGit,
  STORY_MERGE_ATTEMPTS,
  STORY_SLOT_NOTICES,
  slotOccupant,
  updateSlot,
} from "../../src/merge-slot";
import { recordReviewOverride, recordReviewVerdict } from "../../src/review/store";
import { openPark } from "../../src/run/park";
import { recordConfigSnapshot, runSteps } from "../../src/run/records";
import { CodeHostError } from "../../src/platform/host";
import { REPO } from "../backlog/pr/helpers";

import {
  APPROVED,
  C1,
  H1,
  hostPr,
  NO_BACKLOG_GIT,
  noticeCodes,
  noticeTexts,
  PR,
  type StoryWorld,
  storyWorld,
  TITLE,
} from "./story-helpers";

let s: StoryWorld;

afterEach(() => s?.close());

const tick = () => s.slot.tick(s.officeId);
const occupant = () => slotOccupant(s.w.office);
const gates = () => mergeGatesOfRun(s.w.office, s.run);

/** Ticks once: the gate opens and the PR goes in, closes out and pushes; then green on C1. */
async function toChecks(): Promise<void> {
  expect(await tick()).toBe("waiting");
  expect(occupant()).toMatchObject({ kind: "story", number: PR, phase: "checks", head: C1 });
}

describe("a story PR with an approved verdict and green checks", () => {
  it("goes through close-out, sync, push, checks and a squash merge with --match-head-commit", async () => {
    s = await storyWorld();
    await toChecks();
    // The gate was decided by rule, recorded, and the run is in phase merge.
    expect(gates()).toHaveLength(1);
    expect(gates()[0]).toMatchObject({
      head: H1,
      waitingOn: "rule",
      decision: { decision: "approved", by: "rule" },
    });
    expect(
      runSteps(s.w.office, s.run)
        .filter((step) => step.kind === "phase")
        .at(-1)?.value,
    ).toBe("merge");
    expect(s.git.calls).toEqual([
      "closeOut DIPO-7/a-story",
      "fetch",
      "sync DIPO-7/a-story onConflict",
      "push DIPO-7/a-story",
    ]);
    expect(s.git.summaries).toEqual(["DIPO-7"]);
    expect(s.prSyncs).toEqual([s.run]);
    expect(s.host.merges).toEqual([]);

    // The checks of the pushed head: still pending, then green.
    expect(await tick()).toBe("waiting");
    s.ci.set(s.run, { kind: "green", head: C1 });
    expect(await tick()).toBe("merged");
    expect(s.host.merges).toEqual([{ number: PR, headSha: C1 }]);
    expect(s.host.calls).toContain(`merge ${REPO} #${PR} at ${C1}`);
    expect(occupant()).toBeNull();
    expect(noticeCodes(s.w.office)).toEqual([
      STORY_SLOT_NOTICES.entered,
      STORY_SLOT_NOTICES.merged,
    ]);
    expect(await tick()).toBe("idle");
  });

  it("passes the PR title as the squash subject", async () => {
    s = await storyWorld();
    const subjects: string[] = [];
    const merge = s.host.squashMerge.bind(s.host);
    s.host.squashMerge = async (repo, number, options) => {
      subjects.push(options?.subject ?? "");
      return merge(repo, number, options);
    };
    await toChecks();
    s.ci.set(s.run, { kind: "green", head: C1 });
    expect(await tick()).toBe("merged");
    expect(subjects).toEqual([TITLE]);
  });

  it("continues with the same occupant after a daemon restart mid-slot and merges once", async () => {
    s = await storyWorld();
    await toChecks();
    // The daemon restarts: a new merge slot on the same database, nothing in memory.
    s.restart();
    expect(occupant()).toMatchObject({ phase: "checks", head: C1 });
    s.ci.set(s.run, { kind: "green", head: C1 });
    expect(await tick()).toBe("merged");
    expect(s.host.merges).toEqual([{ number: PR, headSha: C1 }]);
    // The close-out ran once; no second sync or push.
    expect(s.git.calls.filter((call) => call.startsWith("closeOut"))).toHaveLength(1);
    expect(s.git.calls.filter((call) => call.startsWith("push"))).toHaveLength(1);
    // A restart after the host merged: the step finds the PR merged and merges nothing again.
    s.restart();
    expect(await tick()).toBe("idle");
    expect(s.host.merges).toHaveLength(1);
  });

  it("finds the PR merged when a restart came between the host merge and the slot's record", async () => {
    s = await storyWorld();
    await toChecks();
    s.ci.set(s.run, { kind: "green", head: C1 });
    // The host merged, but the daemon stopped before the slot wrote it down.
    s.w.office.immediate(() =>
      s.w.office.run("update merge_slot set phase = 'merge' where office_id = $office_id"),
    );
    s.host.prs.set(PR, { ...hostPr(C1), state: "merged" });
    s.restart();
    expect(await tick()).toBe("merged");
    expect(s.host.merges).toEqual([]);
    expect(occupant()).toBeNull();
  });

  it("leaves the slot as a CI fix round when the pushed head's checks are red", async () => {
    s = await storyWorld();
    await toChecks();
    s.ci.set(s.run, { kind: "red", head: C1, items: [] });
    expect(await tick()).toBe("left");
    expect(occupant()).toBeNull();
    expect(noticeCodes(s.w.office)).toContain(STORY_SLOT_NOTICES.checksFailed);
    expect(s.host.merges).toEqual([]);
  });

  it("leaves the slot as a conflict hand-off: the merge pushed, one fix round with the item", async () => {
    s = await storyWorld();
    const item = conflictFeedbackItem({
      base: "main",
      onto: "e".repeat(40),
      conflicts: [{ path: "src/greet.ts", kind: "content" }],
      hunks: [],
    });
    const merged = {
      base: "main",
      onto: "e".repeat(40),
      tip: C1,
      commit: "m".repeat(40),
      conflicts: [{ path: "src/greet.ts", kind: "content" as const }],
      taskFile: null,
    };
    s.git.syncs = [{ kind: "planned", merged, item }];
    expect(await tick()).toBe("left");
    expect(s.merges).toEqual([merged]);
    expect(s.git.calls).toContain("moveBranch DIPO-7/a-story");
    expect(s.git.calls).toContain("push DIPO-7/a-story");
    expect(s.conflicts).toEqual([{ run: s.run, head: "m".repeat(40), item }]);
    expect(occupant()).toBeNull();
    expect(noticeCodes(s.w.office)).toContain(STORY_SLOT_NOTICES.conflict);
  });

  it("merges at the slot's clean merge of the base once the approval carried to it", async () => {
    s = await storyWorld();
    await toChecks();
    s.ci.set(s.run, { kind: "green", head: C1 });
    // The host refuses once because the base moved: the slot merges it, records it and pushes.
    s.host.refusals = 1;
    s.git.containsBaseAnswer = false;
    const M = "m".repeat(40);
    s.git.syncs = [{ kind: "planned", merged: cleanMerge(M), item: null }];
    s.git.trees.set(M, "tree-merged");
    expect(await tick()).toBe("waiting");
    expect(occupant()).toMatchObject({ phase: "checks", head: M, merge: null });
    s.ci.set(s.run, { kind: "green", head: M });
    expect(await tick()).toBe("merged");
    expect(s.host.merges.map((merge) => merge.headSha)).toEqual([C1, M]);
  });

  it("never reaches the host merge when the carry of the slot's clean merge fails", async () => {
    s = await storyWorld();
    await toChecks();
    s.ci.set(s.run, { kind: "green", head: C1 });
    s.host.refusals = 1;
    s.git.containsBaseAnswer = false;
    s.git.syncs = [{ kind: "planned", merged: cleanMerge(), item: null }];
    s.carryFails = true;
    expect(await tick()).toBe("left");
    // The refused try at C1 only: the merged head never went to the host, nor was it pushed.
    expect(s.host.merges.map((merge) => merge.headSha)).toEqual([C1]);
    expect(s.git.calls.filter((call) => call.startsWith("push"))).toHaveLength(1);
    expect(occupant()).toBeNull();
    expect(noticeCodes(s.w.office)).toContain(STORY_SLOT_NOTICES.unrecorded);
  });

  it("merges nothing when no approved review holds for the head it would merge", async () => {
    s = await storyWorld();
    await toChecks();
    s.ci.set(s.run, { kind: "green", head: C1 });
    // The pushed head's code tree has no verdict (a merge that carried nothing, say).
    s.git.trees.set(C1, "tree-unreviewed");
    expect(await tick()).toBe("left");
    expect(s.host.merges).toEqual([]);
    expect(noticeCodes(s.w.office)).toContain(STORY_SLOT_NOTICES.unapproved);
  });

  it("records the merge and closes out again after a restart between the branch move and the record", async () => {
    s = await storyWorld();
    await toChecks();
    const M = "m".repeat(40);
    // The daemon stopped right after the branch moved to the planned merge, before its record:
    // the slot's row holds the merge, the branch is at it, no catch-up row exists.
    const merge = {
      merged: { ...cleanMerge(M), taskFile: "backlog/tasks/dipo-7 - A.md" },
      item: null,
    };
    s.w.office.immediate(() =>
      updateSlot(s.w.office, { phase: "record", merge, head: C1, syncMode: "always" }),
    );
    s.git.heads.set("DIPO-7/a-story", M);
    s.git.trees.set(M, "tree-merged");
    s.git.closeOutCommit = "d".repeat(40);
    s.restart();
    expect(await tick()).toBe("waiting");
    // Recorded once, the task file's Done written back by a second close-out, then pushed.
    expect(s.merges).toEqual([merge.merged]);
    expect(s.git.calls.filter((call) => call.startsWith("moveBranch"))).toEqual([]);
    expect(s.git.calls.filter((call) => call.startsWith("closeOut"))).toHaveLength(2);
    expect(s.git.calls.at(-1)).toBe("push DIPO-7/a-story");
    expect(occupant()).toMatchObject({ phase: "checks", head: "d".repeat(40), merge: null });
    // Run again, the record step finds the catch-up row and records nothing more.
    s.w.office.immediate(() => updateSlot(s.w.office, { phase: "record", merge }));
    s.git.heads.set("DIPO-7/a-story", M);
    s.restart();
    await tick();
    expect(s.merges).toHaveLength(1);
  });

  it("parks conflict with cause unwritable-path when the base conflicts where the worker cannot write", async () => {
    s = await storyWorld();
    s.git.syncs = [
      { kind: "unwritable", base: "main", onto: "e".repeat(40), paths: [".github/ci.yml"] },
    ];
    expect(await tick()).toBe("left");
    expect(openPark(s.w.office, s.key)).toMatchObject({
      reason: "conflict",
      cause: "unwritable-path",
    });
    expect(occupant()).toBeNull();
  });

  it("goes back to the sync at most 3 times when the host refuses because the base moved, then parks slot-refused", async () => {
    s = await storyWorld();
    await toChecks();
    s.ci.set(s.run, { kind: "green", head: C1 });
    s.host.refusals = 99;
    s.git.containsBaseAnswer = false;
    expect(await tick()).toBe("left");
    expect(s.host.merges).toHaveLength(STORY_MERGE_ATTEMPTS);
    // After each refusal the next sync merges the base whenever it moved.
    expect(s.git.calls.filter((call) => call === "sync DIPO-7/a-story always")).toHaveLength(
      STORY_MERGE_ATTEMPTS - 1,
    );
    expect(openPark(s.w.office, s.key)).toMatchObject({
      reason: "conflict",
      cause: "slot-refused",
    });
    expect(occupant()).toBeNull();
  });

  it("leaves the slot with a notice when the host refuses for another reason", async () => {
    s = await storyWorld();
    await toChecks();
    s.ci.set(s.run, { kind: "green", head: C1 });
    s.host.refusals = 1;
    s.git.containsBaseAnswer = true;
    expect(await tick()).toBe("left");
    expect(noticeCodes(s.w.office)).toContain(STORY_SLOT_NOTICES.refused);
    expect(openPark(s.w.office, s.key)).toBeNull();
    // It stays out until its head changes.
    expect(await tick()).toBe("idle");
  });
});

describe("labels and hand changes on GitHub", () => {
  it("never merges a story PR labelled autorelease: pending; its gate waits for the maintainer", async () => {
    s = await storyWorld();
    s.host.labels.set(PR, ["autorelease: pending"]);
    expect(await tick()).toBe("idle");
    expect(gates()[0]).toMatchObject({ waitingOn: "maintainer", decision: null });
    expect(gates()[0]?.summary).toContain("merge it by hand on GitHub");
    // Even an approval recorded by hand does not let it in.
    s.w.office.immediate(() =>
      decideMergeGate(s.w.office, gates()[0]!.gate, {
        decision: "approved",
        by: "maintainer",
        note: null,
        at: s.w.t.clock.now(),
      }),
    );
    expect(await tick()).toBe("idle");
    expect(s.host.merges).toEqual([]);
    expect(noticeCodes(s.w.office)).toContain(STORY_SLOT_NOTICES.held);
  });

  it("holds an approved PR with a hold label until the label is gone", async () => {
    s = await storyWorld();
    s.config = {
      ...OFFICE_DEFAULTS,
      mergeSlot: { ...OFFICE_DEFAULTS.mergeSlot, holdLabels: ["hold"] },
    };
    s.host.labels.set(PR, ["hold"]);
    expect(await tick()).toBe("idle");
    const gate = gates()[0]!;
    expect(gate.waitingOn).toBe("maintainer");
    s.w.office.immediate(() =>
      decideMergeGate(s.w.office, gate.gate, {
        decision: "approved",
        by: "maintainer",
        note: null,
        at: s.w.t.clock.now(),
      }),
    );
    expect(await tick()).toBe("idle");
    s.host.labels.set(PR, []);
    expect(await tick()).toBe("waiting");
    expect(occupant()?.kind).toBe("story");
  });

  it("checks the labels again right before the host merge", async () => {
    s = await storyWorld();
    await toChecks();
    s.ci.set(s.run, { kind: "green", head: C1 });
    s.host.labels.set(PR, ["autorelease: pending"]);
    expect(await tick()).toBe("left");
    expect(s.host.merges).toEqual([]);
    expect(noticeTexts(s.w.office, STORY_SLOT_NOTICES.held)[0]).toContain("autorelease: pending");
  });

  it("keeps a PR whose host head differs from the pushed head out, with pr.headChanged naming both", async () => {
    s = await storyWorld();
    const other = "9".repeat(40);
    s.host.prs.set(PR, hostPr(other));
    expect(await tick()).toBe("idle");
    expect(gates()).toEqual([]);
    const [text] = noticeTexts(s.w.office, STORY_SLOT_NOTICES.headChanged);
    expect(text).toContain(other.slice(0, 12));
    expect(text).toContain(H1.slice(0, 12));
    // Told once per pair of heads.
    expect(await tick()).toBe("idle");
    expect(noticeTexts(s.w.office, STORY_SLOT_NOTICES.headChanged)).toHaveLength(1);
  });

  it("parks the story stopped with cause pr-closed when its PR was closed on the host", async () => {
    s = await storyWorld();
    s.host.prs.set(PR, hostPr(H1, "closed"));
    expect(await tick()).toBe("idle");
    expect(openPark(s.w.office, s.key)).toMatchObject({
      reason: "stopped",
      cause: "pr-closed",
      detail: `PR #${PR} was closed on the host`,
    });
    expect(s.parks).toHaveLength(1);
    // Once: a second poll parks nothing more.
    expect(await tick()).toBe("idle");
    expect(s.parks).toHaveLength(1);
  });
});

describe("the merge gate", () => {
  it("is decided approved by rule and recorded when nothing makes it wait", async () => {
    s = await storyWorld();
    await toChecks();
    expect(gates()[0]?.decision).toMatchObject({ decision: "approved", by: "rule" });
  });

  it("waits for the maintainer when mergeSlot.autoMerge is false, and the PR stays out until it is approved", async () => {
    s = await storyWorld();
    s.config = {
      ...OFFICE_DEFAULTS,
      mergeSlot: { ...OFFICE_DEFAULTS.mergeSlot, autoMerge: false },
    };
    expect(await tick()).toBe("idle");
    expect(await tick()).toBe("idle");
    expect(gates()).toHaveLength(1);
    const gate = gates()[0]!;
    expect(gate).toMatchObject({ waitingOn: "maintainer", decision: null });
    expect(gate.summary).toContain("mergeSlot.autoMerge is off");
    expect(occupant()).toBeNull();
    s.w.office.immediate(() =>
      decideMergeGate(s.w.office, gate.gate, {
        decision: "approved",
        by: "maintainer",
        note: null,
        at: s.w.t.clock.now(),
      }),
    );
    expect(await tick()).toBe("waiting");
    expect(occupant()?.number).toBe(PR);
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
    s.config = OFFICE_DEFAULTS;
    expect(await tick()).toBe("idle");
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
    expect(await tick()).toBe("idle");
    expect(gates()[0]).toMatchObject({ waitingOn: "maintainer" });
    expect(gates()[0]?.summary).toContain("#2");
  });

  it("waits for the maintainer for a flagged story, lists its manual entries and the worktree, phase test", async () => {
    s = await storyWorld();
    s.w.office.immediate(() =>
      s.w.office.run(
        `insert into backlog_mirror (office_id, key, content_hash, kind, status, title, labels,
           read_at, source)
         values ($office_id, $key, 'h', 'task', 'In Review', 'A story', $labels, 0, 'branch')`,
        { key: s.key, labels: JSON.stringify(["test-before-merge"]) },
      ),
    );
    expect(await tick()).toBe("idle");
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
    expect(await tick()).toBe("idle");
    expect(gates()[0]).toMatchObject({ waitingOn: "maintainer" });
    expect(gates()[0]?.summary).toContain("override");
  });

  it("opens no gate before the review verdict holds for the head or the checks are green on it", async () => {
    s = await storyWorld();
    s.ci.set(s.run, { kind: "pending", head: H1 });
    expect(await tick()).toBe("idle");
    s.ci.set(s.run, { kind: "green", head: "0".repeat(40) });
    expect(await tick()).toBe("idle");
    expect(gates()).toEqual([]);
    // A box run's head with no CI holds like green (DIPO-299).
    s.ci.set(s.run, { kind: "none", head: H1 });
    expect(await tick()).toBe("waiting");
  });

  it("opens a new gate for a new head and closes the open one of the old head as superseded", async () => {
    s = await storyWorld();
    s.config = {
      ...OFFICE_DEFAULTS,
      mergeSlot: { ...OFFICE_DEFAULTS.mergeSlot, autoMerge: false },
    };
    expect(await tick()).toBe("idle");
    const first = gates()[0]!;
    // A fix round pushed H2 with new code, approved by a new round.
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
    expect(await tick()).toBe("idle");
    const [old, next] = gates();
    expect(old).toMatchObject({ gate: first.gate, decision: { decision: "rejected", by: "rule" } });
    expect(next).toMatchObject({ head: H2, waitingOn: "maintainer", decision: null });
    expect(next?.gate).not.toBe(first.gate);
  });

  it("opens the override gate of a story parked review-blocked, with the blocking findings", async () => {
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
           at, cause)
         values ($office_id, 1, $key, 'DIPO-7', $run, 'review-blocked', 'In Review', 'blocked', 0,
           'rounds')`,
        { key: s.key, run: s.run },
      ),
    );
    expect(await tick()).toBe("idle");
    expect(gates()).toHaveLength(1);
    expect(gates()[0]).toMatchObject({
      waitingOn: "maintainer",
      overrideOf: s.verdict.gate,
      head: H1,
      decision: null,
    });
    expect(gates()[0]?.summary).toContain("criterion #2 unmet: nothing checks an empty name");
    // Once per blocked verdict.
    expect(await tick()).toBe("idle");
    expect(gates()).toHaveLength(1);
  });

  it("carries a gate's approval to a head whose verdict was carried from the gate's head", async () => {
    s = await storyWorld();
    s.config = {
      ...OFFICE_DEFAULTS,
      mergeSlot: { ...OFFICE_DEFAULTS.mergeSlot, autoMerge: false },
    };
    expect(await tick()).toBe("idle");
    const gate = gates()[0]!;
    s.w.office.immediate(() =>
      decideMergeGate(s.w.office, gate.gate, {
        decision: "approved",
        by: "maintainer",
        note: null,
        at: s.w.t.clock.now(),
      }),
    );
    // A clean merge of the base made by the slot: the approval carried to M on a new tree.
    const M = "5".repeat(40);
    s.w.office.immediate(() => {
      s.w.office.run("update story_prs set head_sha = $head where office_id = $office_id", {
        head: M,
      });
      recordReviewVerdict(s.w.office, s.w.t.ids, {
        runId: s.run,
        key: s.key,
        round: 1,
        agent: null,
        model: "opus",
        commit: M,
        codeTreeKey: "tree-merged",
        judged: APPROVED,
        carriedFrom: H1,
        at: s.w.t.clock.now(),
      });
    });
    s.git.trees.set(M, "tree-merged");
    s.git.heads.set("DIPO-7/a-story", M);
    s.host.prs.set(PR, hostPr(M));
    s.ci.set(s.run, { kind: "green", head: M });
    expect(await tick()).toBe("waiting");
    expect(gates()).toHaveLength(1);
    expect(occupant()?.number).toBe(PR);
  });
});

describe("one PR at a time", () => {
  it("lets no second story in while one is in the slot", async () => {
    s = await storyWorld();
    await toChecks();
    const before = s.host.calls.length;
    expect(await tick()).toBe("waiting");
    // The occupant's step and the gates pass read the host; nothing enters.
    expect(occupant()?.number).toBe(PR);
    expect(s.host.calls.length).toBeGreaterThanOrEqual(before);
  });

  it("frees the slot and notices a failure it cannot recover from at once", async () => {
    s = await storyWorld();
    s.git.closeOut = async () => {
      throw new CodeHostError("failed", "boom");
    };
    expect(await tick()).toBe("left");
    expect(occupant()).toBeNull();
    expect(noticeCodes(s.w.office)).toContain("mergeSlot.failed");
  });
});

describe("story and backlog PRs in one slot", () => {
  const BACKLOG_HEAD = "b".repeat(40);
  const backlogGit: SlotGit = {
    ...NO_BACKLOG_GIT,
    fetch: async () => true,
    head: async () => BACKLOG_HEAD,
    syncBase: async () => ({ kind: "contained", head: BACKLOG_HEAD }),
    push: async () => ({ ok: true, pushed: false }),
  };
  const lane = { flush: async () => ({}) } as unknown as OfficeLane;

  /** A backlog PR #1 whose structural check passed at `at`. */
  function backlogPr(at: number): void {
    s.w.office.immediate(() => {
      insertPr(
        s.w.office,
        {
          number: 1,
          url: `https://github.com/${REPO}/pull/1`,
          branch: "dipo/backlog-1",
          title: "chore(backlog): edit",
        },
        at,
      );
      recordCheck(
        s.w.office,
        1,
        { head: BACKLOG_HEAD, base: "e".repeat(40), passed: true, failures: [], touched: [] },
        at,
      );
    });
  }

  it("lets the backlog PR in first when it became eligible before the story's gate was approved", async () => {
    s = await storyWorld({ backlog: { lane, git: backlogGit } });
    backlogPr(s.w.t.clock.now());
    s.w.t.clock.advance(1_000);
    await tick();
    expect(occupant()).toMatchObject({ kind: "backlog", number: 1 });
    // The story's gate opened meanwhile, approved by rule; it waits for the slot.
    expect(gates()[0]?.decision?.decision).toBe("approved");
  });

  it("lets the story PR in first when its gate was approved before the backlog PR became eligible", async () => {
    s = await storyWorld({ backlog: { lane, git: backlogGit } });
    backlogPr(s.w.t.clock.now() + 60_000);
    await tick();
    expect(occupant()).toMatchObject({ kind: "story", number: PR });
  });
});

/** A clean merge of the moved base on top of the close-out commit C1. */
function cleanMerge(commit = "m".repeat(40)) {
  return {
    base: "main",
    onto: "e".repeat(40),
    tip: C1,
    commit,
    conflicts: [],
    taskFile: null as string | null,
  };
}
