// GitHub's auto-merge for backlog PRs (0010 planning lane, 0002) with a fake host and a scripted
// backlog git: a PR whose structural check passed on its head gets auto-merge at exactly that head,
// the lane holds while it is on, and a merge on GitHub marks the journal entries merged, deletes the
// branch and lets the lane go on. A hold label, `autorelease: pending`, a red required check, a
// conflict or a head dipo did not push keeps auto-merge off, or turns it off, and dipo never passes
// `--admin`.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { openEntries } from "../../src/backlog/lane/journal";
import { findPr, recordCheck } from "../../src/backlog/pr/records";
import { CodeHostError } from "../../src/platform/host";

import {
  BRANCH,
  type BacklogSetup,
  backlogSetup,
  GREEN,
  HEAD,
  noticeTexts,
  openBacklogPr,
  RED,
} from "./helpers";

const TMP = process.env.DIPO_TMP ?? "/tmp";
let dir: string;
let s: BacklogSetup;

beforeEach(async () => {
  dir = await mkdtemp(join(TMP, "merge-backlog-"));
  s = await backlogSetup(dir);
});

afterEach(async () => {
  s.t.state.close();
  await rm(dir, { recursive: true, force: true });
});

describe("auto-merge on", () => {
  it("turns auto-merge on at the head whose structural check passed, and the lane holds", async () => {
    await openBacklogPr(s);
    s.host.checks = GREEN;
    await s.merge.tick(s.officeId);
    expect(s.host.armedAt).toEqual([{ number: 1, head: HEAD }]);
    expect(s.host.calls).toContain(`auto-merge on o/r #1 at ${HEAD}`);
    expect(s.merge.holding(s.officeId)).toBe(BRANCH);
    // A later round leaves it on and asks nothing again.
    await s.merge.tick(s.officeId);
    expect(s.host.armedAt).toHaveLength(1);
    expect(s.host.disarmed).toEqual([]);
  });

  it("turns it on while the checks still run: GitHub waits for them", async () => {
    await openBacklogPr(s);
    await s.merge.tick(s.officeId);
    expect(s.host.armedAt).toEqual([{ number: 1, head: HEAD }]);
  });

  it("gives none to a PR whose check did not pass on the local head", async () => {
    await openBacklogPr(s);
    s.git.heads.set(BRANCH, "2".repeat(40));
    await s.merge.tick(s.officeId);
    s.office.immediate(() =>
      recordCheck(
        s.office,
        1,
        { head: HEAD, base: "b".repeat(40), passed: false, failures: [], touched: [] },
        s.t.clock.now(),
      ),
    );
    s.git.heads.set(BRANCH, HEAD);
    await s.merge.tick(s.officeId);
    expect(s.host.armedAt).toEqual([]);
  });

  it("gives none to a PR whose head on GitHub is not the one dipo pushed", async () => {
    await openBacklogPr(s);
    s.host.set(1, { headSha: "f".repeat(40) });
    await s.merge.tick(s.officeId);
    expect(s.host.armedAt).toEqual([]);
  });

  it("gives none to a PR with a red required check, and turns it on after a re-run passed", async () => {
    await openBacklogPr(s);
    s.host.checks = RED;
    await s.merge.tick(s.officeId);
    expect(s.host.armedAt).toEqual([]);
    s.host.checks = GREEN;
    await s.merge.tick(s.officeId);
    expect(s.host.armedAt).toEqual([{ number: 1, head: HEAD }]);
  });

  it("tells a refused auto-merge once and tries again at the next round", async () => {
    await openBacklogPr(s);
    s.host.enableError = new CodeHostError("failed", "auto-merge is not allowed.");
    await s.merge.tick(s.officeId);
    await s.merge.tick(s.officeId);
    expect(noticeTexts(s.office, "merge.autoMergeFailed")).toHaveLength(1);
    s.host.enableError = null;
    await s.merge.tick(s.officeId);
    expect(s.host.armedAt).toEqual([{ number: 1, head: HEAD }]);
  });
});

describe("the label guard", () => {
  it("never turns auto-merge on for a PR labelled autorelease: pending", async () => {
    await openBacklogPr(s);
    s.host.prLabelsOf.set(1, ["autorelease: pending"]);
    await s.merge.tick(s.officeId);
    await s.merge.tick(s.officeId);
    expect(s.host.armedAt).toEqual([]);
    expect(noticeTexts(s.office, "merge.held")).toEqual([
      'The backlog PR #1 carries "autorelease: pending", so dipo never merges it; merge it by hand on GitHub.',
    ]);
  });

  it("turns auto-merge off when autorelease: pending is added after it went on", async () => {
    await openBacklogPr(s);
    await s.merge.tick(s.officeId);
    expect(s.host.prs.get(1)?.autoMerge).toBe(true);
    s.host.prLabelsOf.set(1, ["autorelease: pending"]);
    await s.merge.tick(s.officeId);
    expect(s.host.disarmed).toEqual([1]);
    expect(s.host.prs.get(1)?.autoMerge).toBe(false);
    expect(s.merge.holding(s.officeId)).toBeNull();
    // It stays off while the label is there.
    await s.merge.tick(s.officeId);
    expect(s.host.armedAt).toHaveLength(1);
  });

  it("holds a PR with a hold label of the office until the label is gone", async () => {
    await openBacklogPr(s);
    s.config = { ...s.config, mergeSlot: { ...s.config.mergeSlot, holdLabels: ["hold"] } };
    s.host.prLabelsOf.set(1, ["Hold"]);
    await s.merge.tick(s.officeId);
    expect(s.host.armedAt).toEqual([]);
    s.host.prLabelsOf.set(1, []);
    await s.merge.tick(s.officeId);
    expect(s.host.armedAt).toEqual([{ number: 1, head: HEAD }]);
  });
});

describe("while auto-merge is on", () => {
  it("turns it off on a red required check and lets the lane go on", async () => {
    await openBacklogPr(s);
    await s.merge.tick(s.officeId);
    s.host.checks = RED;
    await s.lane.journal({
      kind: "edit",
      key: s.keys.two,
      subject: "TASK-2",
      target: { status: "Refined" },
    });
    await s.merge.tick(s.officeId);
    expect(s.host.disarmed).toEqual([1]);
    expect(s.flushes).toEqual([{ rebuild: undefined, heldThen: null }]);
    expect(noticeTexts(s.office, "merge.autoMergeOff")).toEqual([
      "dipo turned auto-merge off for the backlog PR #1: a required check failed.",
    ]);
  });

  it("turns it off on a conflict and rebuilds the branch", async () => {
    await openBacklogPr(s);
    await s.merge.tick(s.officeId);
    s.host.set(1, { mergeable: "conflicting" });
    await s.merge.tick(s.officeId);
    expect(s.host.disarmed).toEqual([1]);
    expect(s.flushes).toEqual([{ rebuild: BRANCH, heldThen: null }]);
  });

  it("turns it off for a head dipo did not push", async () => {
    await openBacklogPr(s);
    await s.merge.tick(s.officeId);
    s.host.set(1, { headSha: "f".repeat(40) });
    await s.merge.tick(s.officeId);
    expect(s.host.disarmed).toEqual([1]);
  });

  it("keeps the lane held and tries again when --disable-auto fails", async () => {
    await openBacklogPr(s);
    await s.merge.tick(s.officeId);
    s.host.checks = RED;
    s.host.disableError = new CodeHostError("failed", "network down");
    await s.merge.tick(s.officeId);
    expect(s.merge.holding(s.officeId)).toBe(BRANCH);
    expect(noticeTexts(s.office, "merge.autoMergeFailed")).toHaveLength(1);
    s.host.disableError = null;
    await s.merge.tick(s.officeId);
    expect(s.host.disarmed).toEqual([1]);
    expect(s.merge.holding(s.officeId)).toBeNull();
  });
});

describe("merged on GitHub", () => {
  it("marks the entries merged, closes the record, deletes the branch and lets the lane go on", async () => {
    await openBacklogPr(s);
    s.host.checks = GREEN;
    await s.merge.tick(s.officeId);
    s.host.githubMerges(1);
    await s.merge.tick(s.officeId);
    expect(openEntries(s.office)).toEqual([]);
    expect(findPr(s.office, 1)?.state).toBe("merged");
    expect(s.git.calls).toEqual([`deleteBranch ${BRANCH}`]);
    expect(s.flushes).toEqual([{ rebuild: undefined, heldThen: null }]);
    expect(s.merge.holding(s.officeId)).toBeNull();
  });

  it("leaves a PR merged by hand at a head the check did not pass on to the backlog PR sync", async () => {
    await openBacklogPr(s);
    s.host.mergedByHand(1, "9".repeat(40));
    await s.merge.tick(s.officeId);
    expect(findPr(s.office, 1)?.state).toBe("open");
    expect(s.git.calls).toEqual([]);
  });
});

describe("the lane's hold", () => {
  it("holds an open backlog PR's branch until a round has read its auto-merge state", async () => {
    await openBacklogPr(s);
    // After a daemon start no round has read GitHub yet: auto-merge may be on.
    expect(s.merge.holding(s.officeId)).toBe(BRANCH);
    s.host.checks = RED;
    await s.merge.tick(s.officeId);
    // Read: off, and the red check keeps it off, so the lane may append.
    expect(s.host.armedAt).toEqual([]);
    expect(s.merge.holding(s.officeId)).toBeNull();
  });

  it("holds the branch before auto-merge is turned on, and lets go when that failed", async () => {
    await openBacklogPr(s);
    let heldDuring: string | null = "unread";
    s.host.enableError = new CodeHostError("failed", "auto-merge is not allowed.");
    const enable = s.host.enableAutoMerge.bind(s.host);
    s.host.enableAutoMerge = async (...args) => {
      heldDuring = s.merge.holding(s.officeId);
      return enable(...args);
    };
    await s.merge.tick(s.officeId);
    expect(heldDuring).toBe(BRANCH);
    expect(s.merge.holding(s.officeId)).toBeNull();
  });
});

describe("the release path of a backlog PR", () => {
  it("gives no auto-merge to a backlog PR that changes the release path", async () => {
    await openBacklogPr(s);
    s.git.release.set(HEAD, [".github/CODEOWNERS"]);
    await s.merge.tick(s.officeId);
    expect(s.host.armedAt).toEqual([]);
    expect(noticeTexts(s.office, "merge.held")[0]).toContain("CODEOWNERS gives an owner");
  });

  it("gives none when git cannot tell, and turns it off when the release path shows up later", async () => {
    await openBacklogPr(s);
    s.git.release.set(HEAD, null);
    await s.merge.tick(s.officeId);
    expect(s.host.armedAt).toEqual([]);
    s.git.release.delete(HEAD);
    await s.merge.tick(s.officeId);
    expect(s.host.armedAt).toEqual([{ number: 1, head: HEAD }]);
    s.git.release.set(HEAD, ["install.sh"]);
    await s.merge.tick(s.officeId);
    expect(s.host.disarmed).toEqual([1]);
  });
});
