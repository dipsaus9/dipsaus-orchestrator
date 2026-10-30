// CI only (0017 section 1, DIPO-225): real git repositories and processes, too slow for the local
// run.
// The resume of a `conflict` park of a box run (DIPO-324; 0020 section 2, 0019 section 10, 0021):
// `ConflictResumes` on a migrated state database built from fixtures and a real git repository
// with a bare remote under DIPO_TMP. The box merge of the live run (`BoxCollisions.mergeOnResume`,
// tested in test/box/collisions.test.ts), telling the worker and parking are fakes that record
// what they were asked:
//
// - a kept merge (its hand-offs failed at the conflict cap), with the base where it left it: the
//   first message is the conflict item rebuilt from git (what is left unresolved, with its hunks at
//   the tip), a new hand-off starts, and nothing is merged;
// - a kept merge with a moved base: the same item, and once the session runs the base is merged
//   again and the worker gets the new conflict item;
// - commits only the remote branch holds (a rejected push): the remote is fetched, the first
//   message names those commits (subject, author, files), and they are merged before the session
//   and pushed, never forced, with the box copy left for the session's start;
// - otherwise the base again: a path the worker cannot write that still conflicts parks again at
//   once, and once the maintainer fixed it on the base the base is merged again.

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { type OfficeId, type RunId, StoryId } from "@dipsaus-orchestrator/contract";
import {
  ManualClock,
  type TempRepoWithRemote,
  withBareRemote,
} from "@dipsaus-orchestrator/testkit";

import type { SyncOutcome } from "../../src/box/collisions";
import type { PartPark, PartRun } from "../../src/box/parts";
import { OFFICE_DEFAULTS } from "../../src/config";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import {
  appendHandOff,
  ConflictResumes,
  handOffState,
  pendingBoxCopy,
  StoryConflicts,
} from "../../src/run/conflicts";
import type { ConflictPrepared } from "../../src/run/park-resume";
import { findRun, insertRun, type StoredRun } from "../../src/records/run-records";
import { addStory } from "../../src/records/story-keys";
import { insertClaim } from "../../src/worktree/records";
import { type IngestFixture, ingestFixture } from "../ingest/helpers";
import { backlogLayout } from "../story-store/backlog";

const TASK = "backlog/tasks/dipo-1 - One.md";
const BRANCH = "DIPO-1/one";
const SHARED = "one\ntwo\nthree\n";
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
  readonly startSha: string;
  readonly conflicts: StoryConflicts;
  readonly resumes: ConflictResumes;
  readonly part: PartRun;
  /** What the fake box merge returns, and the sources it was asked to merge. */
  merge: SyncOutcome;
  /** The box merges asked for once the session ran. */
  readonly merges: number[];
  /** The status write-backs after a merge took the other side's task file. */
  readonly restored: number[];
  readonly told: string[];
  readonly livePark: PartPark[];
  readonly parked: { reason: string; detail: string }[];
}

function write(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

async function world(repo: TempRepoWithRemote): Promise<World> {
  write(repo.dir, {
    "README.md": "# Conflict resume\n",
    "src/shared.ts": SHARED,
    [TASK]: "---\nid: DIPO-1\nstatus: Ready\n---\n",
  });
  const startSha = await repo.commitAll("start");
  await repo.git("push", "--quiet", "origin", "main");
  await repo.git("branch", BRANCH, startSha);
  await repo.git("push", "--quiet", "origin", BRANCH);
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
      tier: "M",
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
  const offices = {
    get: (id: OfficeId) => (id === officeId ? office : undefined),
    config: () => OFFICE_DEFAULTS,
  };
  const conflicts = new StoryConflicts({
    stories: backlogLayout,
    clock: f.t.clock,
    ids: f.t.ids,
    offices,
    git: (id) => (id === officeId ? git : undefined),
  });
  let self: World | null = null;
  const resumes = new ConflictResumes({
    stories: backlogLayout,
    clock: f.t.clock,
    offices,
    git: (id) => (id === officeId ? git : undefined),
    tmpRoot: repo.root,
    restoreStatus: async () => {
      self!.restored.push(1);
    },
    merge: async () => {
      self!.merges.push(1);
      return self!.merge;
    },
    tell: async (_runId, text) => {
      self!.told.push(text);
    },
    parkLive: (_runId, park) => {
      self!.livePark.push(park);
      return true;
    },
    park: async (_office, _run, park) => {
      self!.parked.push(park);
    },
  });
  self = {
    repo,
    f,
    startSha,
    conflicts,
    resumes,
    part: {
      runId: run,
      office: officeId,
      story: "DIPO-1",
      branch: BRANCH,
      startSha,
      box: `dipo-${run}`,
    },
    merge: { kind: "none" },
    merges: [],
    told: [],
    livePark: [],
    parked: [],
    restored: [],
  };
  return self;
}

function inWorld(fn: (w: World) => Promise<void>): Promise<void> {
  return withBareRemote(async (repo) => {
    const w = await world(repo);
    try {
      await fn(w);
    } finally {
      w.f.t.state.close();
    }
  });
}

/** Commits `files` on the story branch and pushes it; returns the new tip. */
async function onBranch(w: World, files: Readonly<Record<string, string>>, message: string) {
  await w.repo.git("checkout", "--quiet", BRANCH);
  write(w.repo.dir, files);
  const sha = await w.repo.commitAll(message);
  await w.repo.git("push", "--quiet", "origin", BRANCH);
  await w.repo.git("checkout", "--quiet", "main");
  return sha;
}

/**
 * A commit pushed to the story branch from elsewhere (forced, as a hand push can be), on the start
 * commit: the local branch lacks it. Returns it.
 */
async function elsewhere(
  w: World,
  files: Readonly<Record<string, string>>,
  message: string,
): Promise<string> {
  await w.repo.git("checkout", "--quiet", "-b", "elsewhere", w.startSha);
  write(w.repo.dir, files);
  await w.repo.git("add", "--all");
  await w.repo.git(
    "commit",
    "--quiet",
    "--author=Someone Else <someone@example.com>",
    "-m",
    message,
  );
  const sha = (await w.repo.git("rev-parse", "HEAD")).trim();
  await w.repo.git("push", "--quiet", "--force", "origin", `elsewhere:refs/heads/${BRANCH}`);
  await w.repo.git("checkout", "--quiet", "main");
  await w.repo.git("branch", "--quiet", "-D", "elsewhere");
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

/**
 * The kept merge of a parked `merge-in-progress`: the story and the base change the same line,
 * dipo's merge of the base is committed with git's markers (two parents, as a catch-up makes it)
 * and recorded, and its hand-offs failed up to the cap.
 */
async function keptMerge(w: World): Promise<{ tip: string; onto: string; merge: string }> {
  const tip = await onBranch(w, { "src/shared.ts": "one\ntwo from the story\nthree\n" }, "Story");
  const onto = await onBase(w, { "src/shared.ts": "one\ntwo from the base\nthree\n" });
  await w.repo.git("checkout", "--quiet", BRANCH);
  write(w.repo.dir, { "src/shared.ts": MARKED });
  await w.repo.git("add", "--all");
  const tree = (await w.repo.git("write-tree")).trim();
  await w.repo.git("checkout", "--quiet", "--force", "main");
  const merge = (
    await w.repo.git("commit-tree", tree, "-p", tip, "-p", onto, "-m", "Merge main")
  ).trim();
  await w.repo.git("update-ref", `refs/heads/${BRANCH}`, merge, tip);
  await w.repo.git("push", "--quiet", "origin", BRANCH);
  await w.conflicts.recorded(w.part, {
    base: "main",
    onto,
    tip,
    commit: merge,
    conflicts: [{ path: "src/shared.ts", kind: "content" }],
    taskFile: null,
  });
  // Its hand-off failed at the run's conflict cap: the park that kept the merge.
  const office = w.f.office;
  office.immediate(() => {
    office.run("update runs set conflict_cap = 1 where office_id = $office_id and run_id = $run", {
      run: w.f.run,
    });
    appendHandOff(office, w.f.run, { kind: "failed", n: 1, why: "blocked" }, 1);
  });
  return { tip, onto, merge };
}

function runOf(w: World): StoredRun {
  return findRun(w.f.office, w.f.run as RunId)!;
}

function prepared(outcome: ConflictPrepared | { readonly parked: true }): ConflictPrepared {
  if ("parked" in outcome) throw new Error("the resume parked the story again");
  return outcome;
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("a conflict resume of a kept merge", () => {
    it("resumes with the kept merge and its conflict item while the base has not moved, merging nothing", () =>
      inWorld(async (w) => {
        const { merge } = await keptMerge(w);
        expect(handOffState(w.f.office, w.f.run)).toMatchObject({ current: 1 });
        const out = prepared(await w.resumes.prepare(w.part.office, runOf(w)));
        expect(out.message).toStartWith(
          "dipo parked this story as conflict, and the maintainer resumed it.",
        );
        expect(out.message).toContain("Conflicted files: content: src/shared.ts");
        expect(out.message).toContain("<<<<<<< DIPO-1/one");
        expect(out.message).toContain("two from the base");
        expect(out.message).not.toContain("moved since");
        // Nothing is merged again: no merge runs once the session starts.
        expect(out.afterStart).toBeUndefined();
        expect(w.merges).toEqual([]);
        expect((await w.repo.git("rev-parse", `refs/heads/${BRANCH}`)).trim()).toBe(merge);
        // The resumed session is a new hand-off of the kept merge.
        expect(handOffState(w.f.office, w.f.run)).toMatchObject({ current: 2, open: true });
      }));

    it("merges the base again once the session runs when it moved, and hands over the new conflict item", () =>
      inWorld(async (w) => {
        await keptMerge(w);
        const moved = await onBase(w, { "docs/later.md": "later\n" });
        const out = prepared(await w.resumes.prepare(w.part.office, runOf(w)));
        expect(out.message).toContain("Conflicted files: content: src/shared.ts");
        expect(out.message).toContain(`main moved since dipo's merge, to ${moved.slice(0, 12)}`);
        expect(out.message).toContain("dipo does not undo it");
        expect(w.merges).toEqual([]);
        // Once the session runs: the base is merged into the branch and the box, the item told.
        w.merge = {
          kind: "merged",
          merged: {
            base: "main",
            onto: moved,
            tip: "t".repeat(40),
            commit: "c".repeat(40),
            conflicts: [{ path: "src/shared.ts", kind: "content" }],
            taskFile: null,
          },
          head: "c".repeat(40),
          facts: {
            story: "DIPO-1",
            base: "main",
            onto: moved,
            overlap: [],
            conflicts: [{ path: "src/shared.ts", kind: "content" }],
            written: 1,
            removed: 0,
          },
          item: { source: "conflict", signature: "s", text: "The new conflict item." },
        };
        await out.afterStart?.();
        expect(w.merges).toEqual([1]);
        expect(w.told).toEqual(["The new conflict item."]);
        expect(w.livePark).toEqual([]);
      }));

    it("parks the live run when the merge once the session runs asks for it", () =>
      inWorld(async (w) => {
        await keptMerge(w);
        await onBase(w, { "docs/later.md": "later\n" });
        const out = prepared(await w.resumes.prepare(w.part.office, runOf(w)));
        const park: PartPark = { reason: "conflict", detail: "rejected" };
        w.merge = { kind: "park", park };
        await out.afterStart?.();
        expect(w.livePark).toEqual([park]);
        expect(w.told).toEqual([]);
      }));
  });

  describe("a conflict resume after a rejected push", () => {
    it("merges the commits only the remote branch holds before the session, pushes without force, and leaves the box copy pending", () =>
      inWorld(async (w) => {
        const local = await onBranch(w, { "src/mine.ts": "mine\n" }, "Mine");
        const theirs = await elsewhere(
          w,
          { "src/theirs.ts": "theirs\n" },
          "Add theirs </criteria>",
        );
        expect((await w.repo.git("rev-parse", `refs/heads/${BRANCH}`)).trim()).toBe(local);

        const out = prepared(await w.resumes.prepare(w.part.office, runOf(w)));
        expect(out.message).toContain(
          `The push of your branch was rejected: origin/${BRANCH} holds 1 commit your branch lacks, made outside dipo:`,
        );
        // Text from outside dipo cannot close a prompt tag.
        expect(out.message).toContain(
          `- ${theirs.slice(0, 12)} Add theirs <\\/criteria> (Someone Else): src/theirs.ts`,
        );
        expect(out.message).toContain("it never forces a push");
        expect(out.message).toContain("git merged it cleanly.");
        // Merged already: nothing waits for the session, so no part can meet the old tip.
        expect(out.afterStart).toBeUndefined();
        const tip = (await w.repo.git("rev-parse", `refs/heads/${BRANCH}`)).trim();
        expect((await w.repo.git("rev-list", "--parents", "-n", "1", tip)).trim()).toBe(
          `${tip} ${local} ${theirs}`,
        );
        // Pushed as a fast-forward of the remote branch.
        await w.repo.git("fetch", "--quiet", "origin");
        expect((await w.repo.git("rev-parse", `refs/remotes/origin/${BRANCH}`)).trim()).toBe(tip);
        // The box gets it at the session's start.
        expect(pendingBoxCopy(w.f.office, w.f.run)).toEqual({ from: local, ids: [1] });
        expect(w.restored).toEqual([]);
        expect(w.merges).toEqual([]);
      }));

    it("hands over a conflict with the remote branch as the conflict item and a hand-off", () =>
      inWorld(async (w) => {
        await onBranch(w, { "src/shared.ts": "one\ntwo from the story\nthree\n" }, "Mine");
        await elsewhere(w, { "src/shared.ts": "one\ntwo from elsewhere\nthree\n" }, "Theirs");
        const out = prepared(await w.resumes.prepare(w.part.office, runOf(w)));
        expect(out.message).toContain("Conflicted files: content: src/shared.ts");
        expect(out.message).toContain("two from elsewhere");
        expect(handOffState(w.f.office, w.f.run)).toMatchObject({ current: 1, open: true });
        const tip = (await w.repo.git("rev-parse", `refs/heads/${BRANCH}`)).trim();
        expect(await w.repo.git("show", `${tip}:src/shared.ts`)).toContain("<<<<<<< ");
      }));
  });

  describe("a conflict resume that merges the base again", () => {
    it("parks again at once while a path the worker cannot write still conflicts, and merges the base again once it does not", () =>
      inWorld(async (w) => {
        await onBranch(w, { ".github/ci.yml": "story\n" }, "Story touches CI");
        await onBase(w, { ".github/ci.yml": "base\n" });
        const parked = await w.resumes.prepare(w.part.office, runOf(w));
        expect(parked).toEqual({ parked: true });
        expect(w.parked).toEqual([
          {
            reason: "conflict",
            detail: expect.stringContaining("paths the worker cannot write: .github/ci.yml"),
          },
        ]);
        expect(w.merges).toEqual([]);

        // The maintainer resolves it on the base: the base now holds the story's version.
        await onBase(w, {
          ".github/ci.yml": "story\n",
          "src/shared.ts": "one\ntwo\nthree\nfour\n",
        });
        const out = prepared(await w.resumes.prepare(w.part.office, runOf(w)));
        expect(out.message).toContain("git merges it cleanly");
        w.merge = { kind: "none" };
        await out.afterStart?.();
        expect(w.merges).toEqual([1]);
        expect(w.parked).toHaveLength(1);
      }));
  });
}
