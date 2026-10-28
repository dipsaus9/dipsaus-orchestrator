// A story PR that changes the release path in the merge slot (DIPO-331; the 0016 amendment of
// 2026-10-23) on a migrated state database built from fixtures, with a fake code host and a
// scripted story slot git whose `releasePaths` answer the test sets per head:
//
// - a held PR: its gate waits for the maintainer and is marked hand-merge only, the PR never enters
//   and never merges, also after an approval recorded by hand; the desk names the PR and says the
//   maintainer merges it by hand on GitHub, with no `dipo approve`;
// - a PR outside the list: decided by rule and merged as before;
// - the hand merge on the host (the Done poll's `decideOnHandMerge`) closes the gate and the desk
//   row goes;
// - the guard runs again right before the host merge: a head approved by rule whose release path
//   appears (the base's CODEOWNERS grew) leaves the slot unmerged and gets a hand-merge-only gate;
// - fail closed: when git cannot tell, nothing opens and nothing merges;
// - a hand-merge-only gate of a head that no longer changes the release path is replaced.

import { afterEach, describe, expect, it } from "bun:test";

import {
  decideMergeGate,
  decideOnHandMerge,
  HAND_MERGE_NOTE,
  mergeGatesOfRun,
  RELEASE_PATH_HOLD,
  STORY_SLOT_NOTICES,
  slotOccupant,
} from "../../src/merge-slot";
import { insertPark } from "../run/park-fixture";
import { desk } from "../../src/views/desk";

import {
  C1,
  H1,
  noticeCodes,
  noticeTexts,
  PR,
  PR_URL,
  type StoryWorld,
  storyWorld,
} from "./story-helpers";

let s: StoryWorld;

afterEach(() => s?.close());

const tick = () => s.slot.tick(s.officeId);
const gates = () => mergeGatesOfRun(s.w.office, s.run);
const mergeRows = () => desk(s.w.office, () => true).filter((item) => item.kind === "MERGE");

const CI_FILE = ".github/workflows/ci.yml";

describe("a story PR whose diff changes the release path", () => {
  it("is held with a gate only the maintainer's merge on the host resolves, and never merges", async () => {
    s = await storyWorld();
    s.git.release.set(H1, [CI_FILE, "install.sh"]);
    expect(await tick()).toBe("idle");
    expect(gates()).toHaveLength(1);
    const gate = gates()[0]!;
    expect(gate).toMatchObject({
      head: H1,
      waitingOn: "maintainer",
      handMerge: RELEASE_PATH_HOLD,
      decision: null,
    });
    expect(gate.summary).toContain(`it changes the release path`);
    expect(gate.summary).toContain(`${CI_FILE}, install.sh`);
    expect(gate.summary).toContain("the maintainer merges it by hand on GitHub");
    expect(gate.summary).not.toContain("dipo approve");
    expect(slotOccupant(s.w.office)).toBeNull();
    // A second tick opens nothing new and still lets nothing in.
    expect(await tick()).toBe("idle");
    expect(gates()).toHaveLength(1);
    // Even an approval recorded behind the command's back does not let it in.
    s.w.office.immediate(() =>
      decideMergeGate(s.w.office, gate.gate, {
        decision: "approved",
        by: "maintainer",
        note: null,
        at: s.w.t.clock.now(),
      }),
    );
    expect(await tick()).toBe("idle");
    expect(slotOccupant(s.w.office)).toBeNull();
    expect(s.host.merges).toEqual([]);
    const [held] = noticeTexts(s.w.office, STORY_SLOT_NOTICES.held);
    expect(held).toContain(`PR #${PR} changes the release path (${CI_FILE}, install.sh)`);
    expect(held).toContain("the maintainer merges it by hand on GitHub");
  });

  it("is on the desk by its PR, with the hand merge on the host and no dipo approve", async () => {
    s = await storyWorld();
    s.git.release.set(H1, [CI_FILE]);
    expect(await tick()).toBe("idle");
    const [row, ...rest] = mergeRows();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      kind: "MERGE",
      story: "DIPO-7",
      gate: gates()[0]!.gate,
      pr: { number: PR, url: PR_URL },
    });
    expect(row?.hand).toBe(
      `the maintainer merges PR #${PR} (${PR_URL}) by hand on GitHub: it changes the release path, which needs the maintainer's code owner approval, so dipo never merges it`,
    );
    expect(row?.actions.map((action) => action.cli)).toEqual([`dipo reject DIPO-7 --note "<why>"`]);
    expect(row?.detail).toContain(CI_FILE);
  });

  it("shows the hand merge and no dipo approve on the row of a review-blocked park whose gate it is", async () => {
    s = await storyWorld();
    s.git.release.set(H1, [CI_FILE]);
    expect(await tick()).toBe("idle");
    const gate = gates()[0]!.gate;
    // A review-blocked park of the story while that gate is open: the desk makes one PARKED row.
    s.w.office.immediate(() =>
      insertPark(s.w.office, {
        parkId: 1,
        key: s.key,
        story: "DIPO-7",
        runId: s.run,
        reason: "review-blocked",
        from: "In Review",
        detail: "round 3 blocked",
        at: s.w.t.clock.now(),
      }),
    );
    const items = desk(s.w.office, () => true);
    expect(items.filter((item) => item.kind === "MERGE")).toEqual([]);
    const [row] = items.filter((item) => item.kind === "PARKED");
    expect(row).toMatchObject({ story: "DIPO-7", gate, reason: "review-blocked" });
    expect(row?.hand).toBe(
      `the maintainer merges PR #${PR} (${PR_URL}) by hand on GitHub: it changes the release path, which needs the maintainer's code owner approval, so dipo never merges it`,
    );
    expect(row?.actions.map((action) => action.command)).not.toContain("gate.approve");
  });

  it("closes its gate when the maintainer merges the PR on the host (the Done poll)", async () => {
    s = await storyWorld();
    s.git.release.set(H1, [CI_FILE]);
    expect(await tick()).toBe("idle");
    const gate = gates()[0]!.gate;
    expect(mergeRows()).toHaveLength(1);
    // The Done poll found the PR merged on the host.
    const entries = s.w.office.immediate(() =>
      decideOnHandMerge(s.w.office, s.key, s.w.t.clock.now()),
    );
    expect(entries).toEqual([
      expect.objectContaining({
        type: "gate.decided",
        delta: { gate, decision: "approved", by: "maintainer", note: HAND_MERGE_NOTE },
      }),
    ]);
    expect(gates()[0]?.decision).toMatchObject({
      decision: "approved",
      by: "maintainer",
      note: HAND_MERGE_NOTE,
    });
    expect(mergeRows()).toEqual([]);
    // The host shows it merged: dipo merges nothing itself.
    s.host.prs.set(PR, { ...s.host.prs.get(PR)!, state: "merged" });
    expect(await tick()).toBe("idle");
    expect(s.host.merges).toEqual([]);
  });
});

describe("a story PR outside the release path", () => {
  it("is decided by rule and merged as before, its release path read for each head", async () => {
    s = await storyWorld();
    expect(await tick()).toBe("waiting");
    expect(gates()[0]).toMatchObject({ waitingOn: "rule", handMerge: null });
    s.ci.set(s.run, { kind: "green", head: C1 });
    expect(await tick()).toBe("merged");
    expect(s.host.merges).toEqual([{ number: PR, headSha: C1 }]);
    // Before its gate opened, and again for the head that merged, after a fresh fetch of the base.
    expect(s.git.releaseReads).toEqual([H1, C1]);
    expect(s.git.calls.filter((call) => call === "fetch")).toHaveLength(2);
    expect(s.git.calls.at(-1)).toBe("fetch");
    expect(mergeRows()).toEqual([]);
  });
});

describe("the release path guard right before the host merge", () => {
  it("lets an approved head whose release path appears leave unmerged, with a hand-merge-only gate", async () => {
    s = await storyWorld();
    expect(await tick()).toBe("waiting");
    expect(slotOccupant(s.w.office)).toMatchObject({ phase: "checks", head: C1 });
    // The base's CODEOWNERS grew meanwhile: the pushed head C1 now changes the release path.
    s.git.release.set(C1, [CI_FILE]);
    s.ci.set(s.run, { kind: "green", head: C1 });
    expect(await tick()).toBe("left");
    expect(s.host.merges).toEqual([]);
    expect(slotOccupant(s.w.office)).toBeNull();
    expect(noticeTexts(s.w.office, STORY_SLOT_NOTICES.held)[0]).toContain(
      "DIPO-7 left the merge slot: PR #7 changes the release path",
    );
    // At the next check the head gets its hand-merge-only gate, on top of the rule's approval.
    expect(await tick()).toBe("idle");
    const [rule, hand] = gates();
    expect(rule).toMatchObject({ head: H1, handMerge: null, decision: { by: "rule" } });
    expect(hand).toMatchObject({ head: C1, handMerge: RELEASE_PATH_HOLD, decision: null });
    expect(await tick()).toBe("idle");
    expect(gates()).toHaveLength(2);
    expect(s.host.merges).toEqual([]);
  });
});

describe("when git cannot tell the release path", () => {
  it("opens no gate and merges nothing, with one notice per head", async () => {
    s = await storyWorld();
    s.git.release.set(H1, null);
    expect(await tick()).toBe("idle");
    expect(await tick()).toBe("idle");
    expect(gates()).toEqual([]);
    expect(slotOccupant(s.w.office)).toBeNull();
    expect(noticeCodes(s.w.office)).toEqual([STORY_SLOT_NOTICES.releaseUnknown]);
    // Readable again, and outside the list: it goes on.
    s.git.release.delete(H1);
    expect(await tick()).toBe("waiting");
  });

  it("leaves the slot unmerged when the head that would merge cannot be read", async () => {
    s = await storyWorld();
    expect(await tick()).toBe("waiting");
    s.git.release.set(C1, null);
    s.ci.set(s.run, { kind: "green", head: C1 });
    expect(await tick()).toBe("left");
    expect(s.host.merges).toEqual([]);
    expect(noticeCodes(s.w.office)).toContain(STORY_SLOT_NOTICES.releaseUnknown);
  });
});

describe("the fetch of the base right before the last check", () => {
  it("leaves the slot unmerged with the release path notice when it fails", async () => {
    s = await storyWorld();
    expect(await tick()).toBe("waiting");
    s.git.fetchOk = false;
    s.ci.set(s.run, { kind: "green", head: C1 });
    expect(await tick()).toBe("left");
    expect(s.host.merges).toEqual([]);
    expect(slotOccupant(s.w.office)).toBeNull();
    // The release path was not read on a stale base.
    expect(s.git.releaseReads).toEqual([H1]);
    expect(noticeTexts(s.w.office, STORY_SLOT_NOTICES.releaseUnknown)[0]).toContain(
      "the fetch of the base failed",
    );
  });
});

describe("a hand-merge-only gate whose head no longer changes the release path", () => {
  it("is superseded by a gate decided as any other", async () => {
    s = await storyWorld();
    s.git.release.set(H1, [CI_FILE]);
    expect(await tick()).toBe("idle");
    // The maintainer took the path out of CODEOWNERS on the base.
    s.git.release.set(H1, []);
    expect(await tick()).toBe("waiting");
    const [held, rule] = gates();
    expect(held).toMatchObject({
      handMerge: RELEASE_PATH_HOLD,
      decision: { decision: "rejected", by: "rule" },
    });
    expect(held?.decision?.note).toContain("superseded: the release path");
    expect(rule).toMatchObject({ handMerge: null, decision: { decision: "approved", by: "rule" } });
  });
});
