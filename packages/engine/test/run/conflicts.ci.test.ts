// CI only (0017 section 1, DIPO-225): the flows on real git; the hand-off state as data stays in
// conflicts.test.ts.
// Conflicts with the base before In Review and the conflict hand-off of a box run (DIPO-149, with
// DIPO-291's marker check; 0019 sections 6, 8 and 10): the hand-off state as data, then
// `StoryConflicts` on a migrated state database built from fixtures and a real git repository
// with a bare remote under DIPO_TMP: the markers left at done, the hand-offs and their cap, a
// blocked report, the sync's outcomes at done, the approval carried over a clean merge dipo
// recorded (and not over one it did not), and a conflict found In Review on the story detail.

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { type OfficeId, type RunId, StoryId, type StoryKey } from "@dipsaus-orchestrator/contract";
import {
  ManualClock,
  type TempRepoWithRemote,
  withBareRemote,
} from "@dipsaus-orchestrator/testkit";

import type { CatchUpMerged, SyncMode, SyncOutcome } from "../../src/box/collisions";
import type { PartRun } from "../../src/box/parts";
import { OFFICE_DEFAULTS } from "../../src/config";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import {
  recordReviewOverride,
  recordReviewVerdict,
  reviewVerdictForTree,
} from "../../src/review/store";
import {
  baseConflictOf,
  blockedHandOff,
  catchUpsOf,
  CONFLICT_NOTICES,
  handOffState,
  inReviewRunIds,
  StoryConflicts,
} from "../../src/run/conflicts";
import { findRun, IN_REVIEW_END, insertRun, runRoundCounts } from "../../src/run/records";
import { codeTreeKeyOf } from "../../src/run/story-git";
import { addStory } from "../../src/stories/keys";
import { insertStoryPr, setStoryPrState } from "../../src/story-pr/records";
import { detail } from "../../src/views/feature";
import { insertClaim } from "../../src/worktree/records";
import { type IngestFixture, ingestFixture, loggedEvents } from "../ingest/helpers";
import { backlogLayout } from "../story-store/backlog";

const TASK = "backlog/tasks/dipo-1 - One.md";
const BRANCH = "DIPO-1/one";
const MARKED = [
  "one",
  "<<<<<<< DIPO-1/one",
  "two from the story",
  "=======",
  "two from the base",
  ">>>>>>> main",
  "three",
  "",
].join("\n");

interface World {
  readonly repo: TempRepoWithRemote;
  readonly f: IngestFixture;
  readonly git: OfficeGit;
  readonly key: StoryKey;
  readonly startSha: string;
  readonly part: PartRun;
  readonly conflicts: StoryConflicts;
  readonly warned: string[];
  /** What the fake sync returns, and the modes it was asked for. */
  sync: SyncOutcome;
  readonly modes: SyncMode[];
}

function write(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

async function world(repo: TempRepoWithRemote, tier = "M"): Promise<World> {
  write(repo.dir, {
    "README.md": "# Conflicts\n",
    "src/shared.ts": "one\ntwo\nthree\n",
    [TASK]: "---\nid: DIPO-1\nstatus: Ready\n---\n",
  });
  const startSha = await repo.commitAll("start");
  await repo.git("push", "--quiet", "origin", "main");
  await repo.git("branch", BRANCH, startSha);
  const stateDir = join(repo.root, "state");
  mkdirSync(stateDir);
  const f = await ingestFixture(stateDir);
  const real = realpathSync(repo.dir);
  const officeId = f.office.officeId as OfficeId;
  const git = new OfficeGit({
    officeId,
    mainWorktree: real,
    commonDir: join(real, ".git"),
    settings: { remote: "origin", base: "main" },
    runner: { exec: spawnGitExec(systemSpawn), env: repo.env, sleep: async () => {} },
    clock: new ManualClock(),
  });
  const { office, run } = f;
  const { key } = office.immediate(() =>
    addStory(office, f.t.ids, { story: StoryId.parse("DIPO-1") }, f.t.clock.now()),
  );
  office.immediate(() => {
    insertRun(office, {
      runId: run,
      kind: "story",
      key,
      story: "DIPO-1",
      tier,
      role: "developer",
      model: "haiku",
      startSha,
      branch: BRANCH,
      budgetUnit: "tokens",
      budgetLimit: 300_000,
      loopCap: 3,
      reviewRoundCap: 3,
      ciCap: 2,
      conflictCap: 2,
      configHash: "h",
      overrideKeys: null,
      runProfileId: null,
      startedAt: f.t.clock.now(),
      scope: ["src/"],
    });
    insertClaim(office, {
      runId: run,
      key,
      story: "DIPO-1",
      branch: BRANCH,
      base: "main",
      baseSha: startSha,
      startSha,
      claimSha: startSha,
      reused: false,
      claimedAt: f.t.clock.now(),
    });
  });
  const warned: string[] = [];
  let self: World | null = null;
  const conflicts = new StoryConflicts({
    stories: backlogLayout,
    clock: f.t.clock,
    ids: f.t.ids,
    offices: {
      get: (id) => (id === officeId ? office : undefined),
      config: () => OFFICE_DEFAULTS,
    },
    git: (id) => (id === officeId ? git : undefined),
    sync: async (_runId, mode) => {
      self!.modes.push(mode);
      return self!.sync;
    },
    warn: (message) => warned.push(message),
  });
  self = {
    repo,
    f,
    git,
    key,
    startSha,
    part: {
      runId: run,
      office: officeId,
      story: "DIPO-1",
      branch: BRANCH,
      startSha,
      box: `dipo-${run}`,
    },
    conflicts,
    warned,
    sync: { kind: "none" },
    modes: [],
  };
  return self;
}

function inWorld(fn: (w: World) => Promise<void>, tier?: string): Promise<void> {
  return withBareRemote(async (repo) => {
    const w = await world(repo, tier);
    try {
      await fn(w);
    } finally {
      w.f.t.state.close();
    }
  });
}

/** Commits `files` on the story branch (as parts and dipo's merges do); returns the new tip. */
async function onBranch(w: World, files: Readonly<Record<string, string>>, message: string) {
  await w.repo.git("checkout", "--quiet", BRANCH);
  write(w.repo.dir, files);
  const sha = await w.repo.commitAll(message);
  await w.repo.git("checkout", "--quiet", "main");
  return sha;
}

/** Commits `files` on the base and pushes it; returns the base commit. */
async function onBase(w: World, files: Readonly<Record<string, string>>): Promise<string> {
  write(w.repo.dir, files);
  const sha = await w.repo.commitAll("Change the base");
  await w.repo.git("push", "--quiet", "origin", "main");
  await w.repo.git("fetch", "--quiet", "origin");
  return sha;
}

/** dipo's merge of `onto` into the branch tip, from git objects, as a catch-up makes it. */
async function engineMerge(w: World, onto: string): Promise<{ tip: string; commit: string }> {
  const tip = (await w.repo.git("rev-parse", `refs/heads/${BRANCH}`)).trim();
  const tree = (await w.repo.git("merge-tree", "--write-tree", tip, onto)).trim().split("\n")[0]!;
  const commit = (
    await w.repo.git("commit-tree", tree, "-p", tip, "-p", onto, "-m", "Merge main")
  ).trim();
  await w.repo.git("update-ref", `refs/heads/${BRANCH}`, commit, tip);
  return { tip, commit };
}

function merged(
  w: World,
  input: Pick<CatchUpMerged, "tip" | "commit" | "onto"> & Partial<CatchUpMerged>,
): CatchUpMerged {
  void w;
  return { base: "main", conflicts: [], taskFile: null, ...input };
}

function runOf(w: World) {
  return findRun(w.f.office, w.f.run)!;
}

function atDone(w: World, tip: string, capped = false) {
  return w.conflicts.atDone({ office: w.f.office, run: runOf(w), tip, capped });
}

function notices(w: World): { code: string; text: string }[] {
  return loggedEvents(w.f.office)
    .filter((event) => event.type === "engine.notice")
    .map((event) => event.data as { code: string; text: string });
}

/** An approved verdict on `commit`, as a review round stores it. */
function approve(w: World, commit: string, key: string) {
  const office = w.f.office;
  office.immediate(() =>
    recordReviewVerdict(office, w.f.t.ids, {
      runId: w.f.run,
      key: w.key,
      round: 1,
      agent: null,
      model: "opus",
      commit,
      codeTreeKey: key,
      judged: { verdict: "approved", criteria: [], findings: [], summary: "fine", notes: [] },
      at: w.f.t.clock.now(),
    }),
  );
}

async function keyOf(w: World, commit: string): Promise<string> {
  return codeTreeKeyOf(await w.repo.git("ls-tree", "-r", "-z", commit), TASK);
}

/** A new run of the same story on the same kept branch, as a re-claim makes it. */
function reclaim(w: World): RunId {
  const office = w.f.office;
  const old = findRun(office, w.f.run)!;
  w.f.t.clock.advance(60_000);
  const runId = w.f.t.ids.next("run") as RunId;
  office.immediate(() => {
    office.run(
      "update runs set ended_at = $at, end_kind = 'conflict' where office_id = $office_id and run_id = $run",
      { run: w.f.run, at: w.f.t.clock.now() },
    );
    w.f.t.clock.advance(1_000);
    insertRun(office, {
      runId,
      kind: "story",
      key: old.key,
      story: "DIPO-1",
      tier: "M",
      role: "developer",
      model: "haiku",
      startSha: w.startSha,
      branch: BRANCH,
      budgetUnit: "tokens",
      budgetLimit: 300_000,
      loopCap: 3,
      reviewRoundCap: 3,
      ciCap: 2,
      conflictCap: 2,
      configHash: "h",
      overrideKeys: null,
      runProfileId: null,
      startedAt: w.f.t.clock.now(),
      scope: ["src/"],
    });
  });
  return runId;
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("the markers left at done (DIPO-291) and the hand-offs", () => {
    it("records a conflicted merge as a hand-off and keeps the story from review while markers remain, as report gate feedback", () =>
      inWorld(async (w) => {
        const tip = await onBranch(w, { "src/shared.ts": MARKED }, "Merge main");
        await w.conflicts.recorded(
          w.part,
          merged(w, {
            tip: w.startSha,
            commit: tip,
            onto: w.startSha,
            conflicts: [{ path: "src/shared.ts", kind: "content" }],
          }),
        );
        expect(catchUpsOf(w.f.office, w.f.run).map((row) => [row.kind, row.conflicts])).toEqual([
          ["merged", [{ path: "src/shared.ts", kind: "content" }]],
        ]);
        expect(handOffState(w.f.office, w.f.run)).toMatchObject({ current: 1, open: true });
        // Markers left are the report gate's (0002): the file and its marker lines, at every done
        // that still has them; the loops count them (verify-commit), never the conflict cap. No
        // sync runs.
        for (let done = 0; done < 3; done++) {
          expect(await atDone(w, tip)).toEqual({
            kind: "markers",
            text: expect.stringContaining("- src/shared.ts: lines 2, 4, 6"),
          });
        }
        expect(handOffState(w.f.office, w.f.run)).toEqual({ current: 1, open: true, failed: 0 });
        expect(runRoundCounts(w.f.office, w.f.run).conflictHandoffs).toBe(1);
        expect(w.modes).toEqual([]);
      }));

    it("lets a resolved tip go to review, resolves the hand-off, and runs the sync", () =>
      inWorld(async (w) => {
        const tip = await onBranch(w, { "src/shared.ts": MARKED }, "Merge main");
        await w.conflicts.recorded(
          w.part,
          merged(w, {
            tip: w.startSha,
            commit: tip,
            onto: w.startSha,
            conflicts: [{ path: "src/shared.ts", kind: "content" }],
          }),
        );
        const fixed = await onBranch(
          w,
          { "src/shared.ts": "one\ntwo from both\nthree\n", "docs/title.md": "Title\n========\n" },
          "Resolve",
        );
        expect(await atDone(w, fixed)).toEqual({ kind: "go", tip: fixed });
        expect(handOffState(w.f.office, w.f.run)).toMatchObject({ open: false, failed: 0 });
        expect(w.modes).toEqual(["onConflict"]);
        expect(runRoundCounts(w.f.office, w.f.run).conflictHandoffs).toBe(1);
      }));

    it("fails an open hand-off on a blocked report, parking at the cap", () =>
      inWorld(async (w) => {
        const tip = await onBranch(w, { "src/shared.ts": MARKED }, "Merge main");
        const conflicted = merged(w, {
          tip: w.startSha,
          commit: tip,
          onto: w.startSha,
          conflicts: [{ path: "src/shared.ts", kind: "content" }],
        });
        const office = w.f.office;
        expect(office.immediate(() => blockedHandOff(office, w.f.run, 1))).toBeNull();
        await w.conflicts.recorded(w.part, conflicted);
        expect(office.immediate(() => blockedHandOff(office, w.f.run, 1))).toBeNull();
        expect(handOffState(office, w.f.run)).toMatchObject({ open: false, failed: 1 });
        await w.conflicts.recorded(w.part, conflicted);
        expect(office.immediate(() => blockedHandOff(office, w.f.run, 2))).toMatchObject({
          reason: "conflict",
        });
        // Markers left at a done turn that crossed a cap are the report gate's too: verify and
        // commit parks it `budget-exceeded`.
        await w.conflicts.recorded(w.part, conflicted);
        expect(await atDone(w, tip, true)).toMatchObject({ kind: "markers" });
      }));
  });

  describe("the sync at done", () => {
    it("syncs a tier L story always and any other only on a conflict, and maps what the sync did", () =>
      inWorld(async (w) => {
        const tip = (await w.repo.git("rev-parse", `refs/heads/${BRANCH}`)).trim();
        expect(await atDone(w, tip)).toEqual({ kind: "go", tip });
        expect(w.modes).toEqual(["onConflict"]);
        // A story flagged test-before-merge is riskier too.
        w.f.office.run(
          `insert into backlog_mirror (office_id, key, content_hash, kind, status, title, tier, role,
           labels, read_at, source)
         values ($office_id, $key, 'h', 'task', 'In Progress', 'One', 'M', null, $labels, 0, 'b')`,
          { key: w.key, labels: JSON.stringify(["test-before-merge"]) },
        );
        w.sync = {
          kind: "merged",
          merged: merged(w, { tip, commit: "c".repeat(40), onto: "d".repeat(40) }),
          head: "e".repeat(40),
          facts: {
            story: "DIPO-1",
            base: "main",
            onto: "d".repeat(40),
            overlap: [],
            conflicts: [],
            written: 1,
            removed: 0,
          },
          item: null,
        };
        expect(await atDone(w, tip)).toEqual({ kind: "go", tip: "e".repeat(40) });
        expect(w.modes).toEqual(["onConflict", "always"]);
        w.sync = {
          ...w.sync,
          item: { source: "conflict", signature: "s", text: "the conflict item" },
        };
        expect(await atDone(w, tip)).toEqual({ kind: "feedback", text: "the conflict item" });
        w.sync = {
          kind: "park",
          park: {
            reason: "conflict",
            detail: ".github/workflows/ci.yml",
          },
        };
        expect(await atDone(w, tip)).toEqual({
          kind: "park",
          reason: "conflict",
          detail: ".github/workflows/ci.yml",
        });
      }));

    it("always syncs a tier L story", () =>
      inWorld(async (w) => {
        await atDone(w, w.startSha);
        expect(w.modes).toEqual(["always"]);
      }, "L"));
  });

  describe("an approval carried over a clean merge dipo made (0019 section 6)", () => {
    it("carries the approval of the head to an engine merge plus task-file commits, with no round", () =>
      inWorld(async (w) => {
        const approved = await onBranch(w, { "src/a.ts": "a\n" }, "DIPO-1: add a");
        approve(w, approved, await keyOf(w, approved));
        // The fix round's In Progress commit: the task file only.
        await onBranch(
          w,
          { [TASK]: "---\nid: DIPO-1\nstatus: In Progress\n---\n" },
          "DIPO-1: status",
        );
        const onto = await onBase(w, { "README.md": "# Conflicts, moved\n" });
        const merge = await engineMerge(w, onto);
        await w.conflicts.recorded(w.part, merged(w, { ...merge, onto }));
        const carried = reviewVerdictForTree(w.f.office, w.f.run, await keyOf(w, merge.commit));
        expect(carried).toMatchObject({
          verdict: "approved",
          commit: merge.commit,
          carriedFrom: approved,
          agent: null,
        });
        // The In Review commit on top changes only the task file: its tree has the verdict, so the
        // review starter takes it without a round.
        const inReview = await onBranch(
          w,
          { [TASK]: "---\nid: DIPO-1\nstatus: In Review\n---\n" },
          "DIPO-1: status In Review",
        );
        expect(reviewVerdictForTree(w.f.office, w.f.run, await keyOf(w, inReview))).not.toBeNull();
        expect(notices(w).map((n) => n.code)).toContain(CONFLICT_NOTICES.carried);
      }));

    it("starts a round when a base merge the engine did not record lies between", () =>
      inWorld(async (w) => {
        const approved = await onBranch(w, { "src/a.ts": "a\n" }, "DIPO-1: add a");
        approve(w, approved, await keyOf(w, approved));
        // Someone merged the base into the branch by hand.
        await onBase(w, { "README.md": "# Conflicts, first\n" });
        await w.repo.git("checkout", "--quiet", BRANCH);
        await w.repo.git("merge", "--quiet", "--no-ff", "-m", "Merge main by hand", "main");
        await w.repo.git("checkout", "--quiet", "main");
        const onto = await onBase(w, { "docs/later.md": "later\n" });
        const merge = await engineMerge(w, onto);
        await w.conflicts.recorded(w.part, merged(w, { ...merge, onto }));
        expect(reviewVerdictForTree(w.f.office, w.f.run, await keyOf(w, merge.commit))).toBeNull();
        expect(notices(w).map((n) => n.code)).not.toContain(CONFLICT_NOTICES.carried);
      }));

    it("carries a blocked verdict the maintainer overrode, with its override (DIPO-150)", () =>
      inWorld(async (w) => {
        const office = w.f.office;
        const reviewed = await onBranch(w, { "src/a.ts": "a\n" }, "DIPO-1: add a");
        const tree = await keyOf(w, reviewed);
        const blocked = office.immediate(() =>
          recordReviewVerdict(office, w.f.t.ids, {
            runId: w.f.run,
            key: w.key,
            round: 3,
            agent: null,
            model: "opus",
            commit: reviewed,
            codeTreeKey: tree,
            judged: { verdict: "blocked", criteria: [], findings: [], summary: "no", notes: [] },
            at: w.f.t.clock.now(),
          }),
        );
        office.immediate(() => recordReviewOverride(office, blocked.gate, { note: "ok", at: 5 }));
        const onto = await onBase(w, { "README.md": "# Conflicts, moved\n" });
        const merge = await engineMerge(w, onto);
        await w.conflicts.recorded(w.part, merged(w, { ...merge, onto }));
        expect(
          reviewVerdictForTree(w.f.office, w.f.run, await keyOf(w, merge.commit)),
        ).toMatchObject({
          verdict: "blocked",
          carriedFrom: reviewed,
          override: { note: "ok", at: 5 },
        });
      }));

    it("carries nothing over a merge when the code changed after the approval", () =>
      inWorld(async (w) => {
        const approved = await onBranch(w, { "src/a.ts": "a\n" }, "DIPO-1: add a");
        approve(w, approved, await keyOf(w, approved));
        await onBranch(w, { "src/a.ts": "a, changed\n" }, "DIPO-1: change a");
        const onto = await onBase(w, { "README.md": "# Conflicts, moved\n" });
        const merge = await engineMerge(w, onto);
        await w.conflicts.recorded(w.part, merged(w, { ...merge, onto }));
        expect(reviewVerdictForTree(w.f.office, w.f.run, await keyOf(w, merge.commit))).toBeNull();
      }));
  });

  describe("a Done story is not checked as In Review (DIPO-332)", () => {
    it("leaves out a story whose own PR merged, and one whose status reads Done", () =>
      inWorld(async (w) => {
        const office = w.f.office;
        office.run(
          "update runs set ended_at = $at, end_kind = $kind where office_id = $office_id and run_id = $run",
          { run: w.f.run, at: w.f.t.clock.now(), kind: IN_REVIEW_END },
        );
        expect(inReviewRunIds(office)).toEqual([w.f.run as RunId]);
        // Its PR merged on the host while the teardown of its worktree waits: Done on the base.
        office.immediate(() =>
          insertStoryPr(office, {
            runId: w.f.run as RunId,
            key: w.key,
            number: 325,
            url: "https://github.com/o/r/pull/325",
            branch: BRANCH,
            base: "main",
            headSha: w.startSha,
            state: "open",
            title: "fix(DIPO-1): one",
            bodyHash: "h",
            openedAt: 1,
            closedAt: null,
          }),
        );
        expect(inReviewRunIds(office)).toEqual([w.f.run as RunId]);
        office.immediate(() =>
          setStoryPrState(office, w.f.run as RunId, { state: "merged", closedAt: 2 }),
        );
        expect(inReviewRunIds(office)).toEqual([]);
        // Its status reads Done (the close-out on its branch, or the base's), the PR not yet seen merged.
        office.immediate(() =>
          setStoryPrState(office, w.f.run as RunId, { state: "open", closedAt: null }),
        );
        office.run(
          `insert into backlog_mirror (office_id, key, content_hash, kind, status, title, labels, read_at, source)
         values ($office_id, $key, 'h', 'task', 'Done', 'One', '[]', 1, $branch)`,
          { key: w.key, branch: BRANCH },
        );
        expect(inReviewRunIds(office)).toEqual([]);
        office.run(
          "update backlog_mirror set status = 'In Review' where office_id = $office_id",
          {},
        );
        expect(inReviewRunIds(office)).toEqual([w.f.run as RunId]);
      }));
  });

  describe("a conflict found while the story is In Review", () => {
    it("is recorded and told once per base commit, shows on the story detail, and goes once merged", () =>
      inWorld(async (w) => {
        const office = w.f.office;
        office.run(
          "update runs set ended_at = $at, end_kind = $kind where office_id = $office_id and run_id = $run",
          { run: w.f.run, at: w.f.t.clock.now(), kind: IN_REVIEW_END },
        );
        expect(inReviewRunIds(office)).toEqual([w.f.run as RunId]);
        const found = {
          base: "main",
          onto: "d".repeat(40),
          tip: w.startSha,
          conflicts: [{ path: "src/shared.ts", kind: "content" as const }],
        };
        w.conflicts.found(w.part, found);
        w.conflicts.found(w.part, found);
        const told = notices(w).filter((n) => n.code === CONFLICT_NOTICES.inReview);
        expect(told).toHaveLength(1);
        expect(told[0]!.text).toBe(
          `DIPO-1 is In Review, and main at ${"d".repeat(12)} conflicts with its branch in src/shared.ts. dipo merges the base at the story's next In Review, or when GitHub reports the conflict at its merge, and hands the conflict to its worker then.`,
        );
        expect(baseConflictOf(office, w.key)).toMatchObject({
          base: "main",
          onto: "d".repeat(40),
          paths: ["src/shared.ts"],
        });
        expect(detail(office, w.key).baseConflict).toMatchObject({
          base: "main",
          paths: ["src/shared.ts"],
        });
        // A new base commit is a new finding.
        w.conflicts.found(w.part, { ...found, onto: "f".repeat(40) });
        expect(notices(w).filter((n) => n.code === CONFLICT_NOTICES.inReview)).toHaveLength(2);
        // The next sync merged the base: the finding is handled.
        await w.conflicts.recorded(
          w.part,
          merged(w, { tip: w.startSha, commit: "c".repeat(40), onto: "f".repeat(40) }),
        );
        expect(baseConflictOf(office, w.key)).toBeNull();
        expect(detail(office, w.key).baseConflict).toBeUndefined();
      }));
  });

  describe("the review fixes of DIPO-149", () => {
    it("keeps a re-claim of a kept branch from review while the markers its earlier run left remain", () =>
      inWorld(async (w) => {
        const tip = await onBranch(w, { "src/shared.ts": MARKED }, "Merge main");
        await w.conflicts.recorded(
          w.part,
          merged(w, {
            tip: w.startSha,
            commit: tip,
            onto: w.startSha,
            conflicts: [{ path: "src/shared.ts", kind: "content" }],
          }),
        );
        // Markers left are report gate feedback (0002); the loops, counted by verify and commit,
        // park the run at their cap.
        for (let turn = 0; turn < 3; turn += 1) expect((await atDone(w, tip)).kind).toBe("markers");
        // Dropped with the branch kept, then claimed again: a new run on the same branch.
        const again = reclaim(w);
        const decided = await w.conflicts.atDone({
          office: w.f.office,
          run: findRun(w.f.office, again)!,
          tip,
          capped: false,
        });
        expect(decided).toEqual({
          kind: "markers",
          text: expect.stringContaining("- src/shared.ts: lines 2, 4, 6"),
        });
        // The earlier run's hand-off is still open for the new run, with no failure counted.
        expect(handOffState(w.f.office, again)).toMatchObject({ open: true, failed: 0 });
        expect(w.modes).toEqual([]);
      }));

    it("finds markers in a conflicted file the worker moved, and keeps an untouched binary conflict unresolved", () =>
      inWorld(async (w) => {
        const merge = await onBranch(
          w,
          { "src/shared.ts": MARKED, "logo.png": "\u0089PNG ours\n" },
          "Merge main",
        );
        await w.conflicts.recorded(
          w.part,
          merged(w, {
            tip: w.startSha,
            commit: merge,
            onto: w.startSha,
            conflicts: [
              { path: "logo.png", kind: "binary" },
              { path: "src/shared.ts", kind: "content" },
            ],
          }),
        );
        await w.repo.git("checkout", "--quiet", BRANCH);
        await w.repo.git("mv", "src/shared.ts", "src/moved.ts");
        const moved = await w.repo.commitAll("Move the file");
        await w.repo.git("checkout", "--quiet", "main");
        const first = await atDone(w, moved);
        expect(first.kind).toBe("markers");
        if (first.kind === "markers") {
          expect(first.text).toContain("- logo.png: the binary conflict is still as git left it");
          expect(first.text).toContain("- src/moved.ts: lines 2, 4, 6");
        }
        // The markers gone and the binary changed: resolved.
        const fixed = await onBranch(
          w,
          { "src/moved.ts": "one\ntwo from both\nthree\n", "logo.png": "\u0089PNG both\n" },
          "Resolve",
        );
        expect(await atDone(w, fixed)).toEqual({ kind: "go", tip: fixed });
      }));

    it("clears a conflict found In Review once a later check finds none", () =>
      inWorld(async (w) => {
        w.conflicts.found(w.part, {
          base: "main",
          onto: "d".repeat(40),
          tip: w.startSha,
          conflicts: [{ path: "src/shared.ts", kind: "content" }],
        });
        expect(baseConflictOf(w.f.office, w.key)).not.toBeNull();
        w.conflicts.cleared(w.part);
        expect(baseConflictOf(w.f.office, w.key)).toBeNull();
        expect(detail(w.f.office, w.key).baseConflict).toBeUndefined();
      }));
  });
}
