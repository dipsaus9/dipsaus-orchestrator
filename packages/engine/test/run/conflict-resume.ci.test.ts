// CI only (0017, DIPO-225): real git repositories and processes, too slow for the local
// run.
// The resume of a `conflict` park of a box run (DIPO-324; 0020, 0002, 0008):
// `ConflictResumes` on a migrated state database built from fixtures and a real git repository
// with a bare remote under DIPO_TMP, with the merge of a moved base before the session
// (`BaseCatchUps.beforeSession`, DIPO-464) on the same office and git. Parking is a fake that
// records what it was asked:
//
// - a kept merge (its hand-offs failed at the conflict cap), with the base where it left it: the
//   first message is the conflict item rebuilt from git (what is left unresolved, with its hunks at
//   the tip), a new hand-off starts, and nothing is merged;
// - a kept merge with a moved base, clean or conflicting: the same item, the message says so, and
//   the session's start merges the base again on top of the kept merge;
// - commits only the remote branch holds (a rejected push): the remote is fetched, the first
//   message names those commits (subject, author, files), and they are merged before the session
//   and pushed, never forced, with the box copy left for the session's start;
// - otherwise the base again: a path the worker cannot write that still conflicts parks again at
//   once, and once the maintainer fixed it on the base the session's start merges it, since git merges it
//   cleanly.

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { type OfficeId, type RunId, StoryId } from "@dipsaus-orchestrator/contract";
import {
  ManualClock,
  type TempRepoWithRemote,
  withBareRemote,
} from "@dipsaus-orchestrator/testkit";

import type { PartRun } from "../../src/box/parts";
import { OFFICE_DEFAULTS } from "../../src/config";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import { BaseCatchUps, type BoxPartTaken } from "../../src/run/base-merges";
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
import { type IngestFixture, ingestFixture, loggedEvents } from "../ingest/helpers";
import { heldFeedback } from "../../src/run/feedback";
import { BASE_MERGE_NOTICES } from "../../src/run/base-merges";
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
  /** The merges of a moved base outside the box (DIPO-464), on the same office and git. */
  readonly catchUps: BaseCatchUps;
  /** The status write-backs after a merge took the other side's task file. */
  readonly restored: number[];
  /**
   * What the box's part before a merge does (`BaseCatchUpsDeps.takePart`, DIPO-464); by default
   * nothing was undelivered. Each call is counted in `takes`.
   */
  takePart: (run: StoredRun) => Promise<BoxPartTaken>;
  readonly takes: string[];
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
    clock: f.t.clock,
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
    park: async (_office, _run, park) => {
      self!.parked.push(park);
    },
  });
  const catchUps = new BaseCatchUps({
    stories: backlogLayout,
    clock: f.t.clock,
    offices,
    git: (id) => (id === officeId ? git : undefined),
    tmpRoot: repo.root,
    restoreStatus: async () => {
      self!.restored.push(1);
    },
    takePart: async (_office, stored) => {
      self!.takes.push(stored.runId);
      return self!.takePart(stored);
    },
  });
  self = {
    repo,
    f,
    startSha,
    conflicts,
    resumes,
    catchUps,
    part: {
      runId: run,
      office: officeId,
      story: "DIPO-1",
      branch: BRANCH,
      startSha,
      box: `dipo-${run}`,
    },
    parked: [],
    restored: [],
    takePart: async () => ({ kind: "taken" }),
    takes: [],
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

/** The story branch's tip. */
async function head(w: World): Promise<string> {
  return (await w.repo.git("rev-parse", `refs/heads/${BRANCH}`)).trim();
}

/** The messages held for the run's next session, joined as its first message carries them. */
function held(w: World): string {
  return heldFeedback(w.f.office, w.f.run).texts.join("\n\n");
}

/** The `engine.notice` entries of the office, each as JSON text. */
function notices(w: World): string[] {
  return loggedEvents(w.f.office)
    .filter((event) => event.type === "engine.notice")
    .map((event) => JSON.stringify(event.data));
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
        // Nothing is merged again: the session's start finds the branch holding the base.
        expect(await w.catchUps.beforeSession(w.part.office, runOf(w))).toEqual({ kind: "none" });
        expect((await w.repo.git("rev-parse", `refs/heads/${BRANCH}`)).trim()).toBe(merge);
        // The resumed session is a new hand-off of the kept merge.
        expect(handOffState(w.f.office, w.f.run)).toMatchObject({ current: 2, open: true });
      }));

    it("merges the base again before the session when it moved without a conflict (DIPO-464)", () =>
      inWorld(async (w) => {
        const { merge } = await keptMerge(w);
        const moved = await onBase(w, { "docs/later.md": "later\n" });
        const out = prepared(await w.resumes.prepare(w.part.office, runOf(w)));
        expect(out.message).toContain("Conflicted files: content: src/shared.ts");
        expect(out.message).toContain(`main moved since dipo's merge, to ${moved.slice(0, 12)}`);
        expect(out.message).toContain("before this session starts");
        const caught = await w.catchUps.beforeSession(w.part.office, runOf(w));
        expect(caught.kind).toBe("merged");
        const tip = (await w.repo.git("rev-parse", `refs/heads/${BRANCH}`)).trim();
        expect((await w.repo.git("rev-list", "--parents", "-n", "1", tip)).trim()).toBe(
          `${tip} ${merge} ${moved}`,
        );
      }));

    it("merges the base again before the session when it moved with a conflict", () =>
      inWorld(async (w) => {
        await keptMerge(w);
        const moved = await onBase(w, {
          "src/shared.ts": "one\ntwo from the base, again\nthree\n",
        });
        const out = prepared(await w.resumes.prepare(w.part.office, runOf(w)));
        expect(out.message).toContain("Conflicted files: content: src/shared.ts");
        expect(out.message).toContain(`main moved since dipo's merge, to ${moved.slice(0, 12)}`);
        expect(out.message).toContain("dipo does not undo it");
        // Before the session: the base merged again on top of the kept merge, its markers kept.
        const caught = await w.catchUps.beforeSession(w.part.office, runOf(w));
        expect(caught.kind).toBe("merged");
        const tip = (await w.repo.git("rev-parse", `refs/heads/${BRANCH}`)).trim();
        expect(await w.repo.git("show", `${tip}:src/shared.ts`)).toContain(
          "two from the base, again",
        );
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
        // Merged already, before the session, so no part can meet the old tip.
        const tip = (await w.repo.git("rev-parse", `refs/heads/${BRANCH}`)).trim();
        expect((await w.repo.git("rev-list", "--parents", "-n", "1", tip)).trim()).toBe(
          `${tip} ${local} ${theirs}`,
        );
        // Pushed as a fast-forward of the remote branch.
        await w.repo.git("fetch", "--quiet", "origin");
        expect((await w.repo.git("rev-parse", `refs/remotes/origin/${BRANCH}`)).trim()).toBe(tip);
        // The box gets it at the session's start.
        expect(pendingBoxCopy(w.f.office, w.f.run)).toEqual({
          from: local,
          ids: [1],
          bases: [`origin/${BRANCH}`],
        });
        expect(w.restored).toEqual([]);
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
    it("parks again at once while a path the worker cannot write still conflicts, and merges nothing once git merges the base cleanly", () =>
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

        // The maintainer resolves it on the base: the base now holds the story's version.
        await onBase(w, {
          ".github/ci.yml": "story\n",
          "src/shared.ts": "one\ntwo\nthree\nfour\n",
        });
        const out = prepared(await w.resumes.prepare(w.part.office, runOf(w)));
        expect(out.message).toContain("Before this session starts, dipo merges main");
        expect(out.message).toContain("git merges it without a conflict");
        expect(w.parked).toHaveLength(1);
      }));

    it("says the base is merged before the session while it conflicts in a path the worker can write", () =>
      inWorld(async (w) => {
        await onBranch(w, { "src/shared.ts": "one\ntwo from the story\nthree\n" }, "Story");
        await onBase(w, { "src/shared.ts": "one\ntwo from the base\nthree\n" });
        const out = prepared(await w.resumes.prepare(w.part.office, runOf(w)));
        expect(out.message).toContain("git cannot merge src/shared.ts cleanly");
        expect(out.message).toContain("Before this session starts");
      }));
  });

  describe("the merge of a moved base before a resumed or fix round session (DIPO-464)", () => {
    it("merges a clean base before the worker's first turn: committed, pushed without force, pending for the box, and told", () =>
      inWorld(async (w) => {
        const tip = await onBranch(w, { "src/mine.ts": "mine\n" }, "Mine");
        const onto = await onBase(w, { "docs/later.md": "later\n", "src/other.ts": "other\n" });
        const caught = await w.catchUps.beforeSession(w.part.office, runOf(w));
        const merge = await head(w);
        expect(caught).toEqual({ kind: "merged", commit: merge });
        // A merge of the tip and the base, from git objects, the branch's history kept.
        expect((await w.repo.git("rev-list", "--parents", "-n", "1", merge)).trim()).toBe(
          `${merge} ${tip} ${onto}`,
        );
        expect((await w.repo.git("log", "-1", "--format=%s", merge)).trim()).toBe(
          `Merge main into ${BRANCH}`,
        );
        // Pushed as a fast-forward of the remote branch, never forced.
        await w.repo.git("fetch", "--quiet", "origin");
        expect((await w.repo.git("rev-parse", `refs/remotes/origin/${BRANCH}`)).trim()).toBe(merge);
        // The box copy waits for the session's start (`boxSync`); no hand-off for a clean merge.
        expect(pendingBoxCopy(w.f.office, w.f.run)).toEqual({
          from: tip,
          ids: [1],
          bases: ["main"],
        });
        expect(handOffState(w.f.office, w.f.run)).toMatchObject({ current: 0, open: false });
        // The worker's first message: main is merged, the files it changed, no fetch from the box.
        const message = held(w);
        expect(message).toContain("main is already merged into your branch");
        expect(message).toContain("The merge changed 2 files: docs/later.md, src/other.ts.");
        expect(message).toContain("Your box cannot fetch main");
        expect(message).toContain("your git diff only your own work");
        // The maintainer's notice names the merged files.
        expect(notices(w).find((text) => text.includes(BASE_MERGE_NOTICES.merged))).toContain(
          "docs/later.md, src/other.ts",
        );
        // The PR's diff against the base holds only the story's own changes.
        expect(
          (await w.repo.git("diff", "--name-only", `refs/remotes/origin/main...${merge}`)).trim(),
        ).toBe("src/mine.ts");
        // A branch that holds the base now merges nothing more.
        expect(await w.catchUps.beforeSession(w.part.office, runOf(w))).toEqual({ kind: "none" });
        expect(await head(w)).toBe(merge);
      }));

    it("commits a conflicted merge as git left it and hands the conflicting files to the worker in its first message", () =>
      inWorld(async (w) => {
        await onBranch(w, { "src/shared.ts": "one\ntwo from the story\nthree\n" }, "Story");
        await onBase(w, { "src/shared.ts": "one\ntwo from the base\nthree\n" });
        const caught = await w.catchUps.beforeSession(w.part.office, runOf(w));
        expect(caught.kind).toBe("merged");
        const merge = await head(w);
        expect(await w.repo.git("show", `${merge}:src/shared.ts`)).toContain("<<<<<<< ");
        // A hand-off starts, and the box copy waits for the session's start.
        expect(handOffState(w.f.office, w.f.run)).toMatchObject({ current: 1, open: true });
        expect(pendingBoxCopy(w.f.office, w.f.run)?.ids).toEqual([1]);
        const message = held(w);
        expect(message).toContain("main is already merged into your branch");
        expect(message).toContain("1 file conflicted and stays as git left it");
        expect(message).toContain("Conflicted files: content: src/shared.ts");
        expect(message).toContain("two from the base");
        expect(notices(w).find((text) => text.includes(BASE_MERGE_NOTICES.conflict))).toContain(
          "src/shared.ts",
        );
      }));

    it("merges nothing and parks conflict when the conflict is in a path the worker cannot write", () =>
      inWorld(async (w) => {
        const tip = await onBranch(w, { ".github/ci.yml": "story\n" }, "Story touches CI");
        await onBase(w, { ".github/ci.yml": "base\n" });
        const caught = await w.catchUps.beforeSession(w.part.office, runOf(w));
        expect(caught).toEqual({
          kind: "park",
          reason: "conflict",
          detail: expect.stringContaining("paths the worker cannot write: .github/ci.yml"),
        });
        expect(await head(w)).toBe(tip);
        expect(pendingBoxCopy(w.f.office, w.f.run)).toBeNull();
        expect(held(w)).toBe("");
      }));

    it("takes the box's undelivered work as a part first, so the merge holds it (DIPO-464)", () =>
      inWorld(async (w) => {
        await onBranch(w, { "src/mine.ts": "mine\n" }, "Mine");
        await onBase(w, { "src/shared.ts": "one\ntwo\nthree from the base\n" });
        // The part the box gives: the worker's edit no part took before it parked.
        w.takePart = async () => {
          await onBranch(w, { "src/shared.ts": "one from the worker\ntwo\nthree\n" }, "Part");
          return { kind: "taken" };
        };
        const caught = await w.catchUps.beforeSession(w.part.office, runOf(w));
        expect(caught.kind).toBe("merged");
        expect(w.takes).toEqual([w.f.run]);
        expect(await w.repo.git("show", `${await head(w)}:src/shared.ts`)).toBe(
          "one from the worker\ntwo\nthree from the base\n",
        );
      }));

    it("merges nothing and parks, the box's files kept, when the part cannot be taken or asks for a park", () =>
      inWorld(async (w) => {
        const tip = await onBranch(w, { "src/mine.ts": "mine\n" }, "Mine");
        await onBase(w, { "docs/later.md": "later\n" });
        w.takePart = async () => {
          throw new Error("the box did not start");
        };
        expect(await w.catchUps.beforeSession(w.part.office, runOf(w))).toEqual({
          kind: "park",
          reason: "worker-failed",
          detail:
            "dipo could not take the box's work as a part before merging main into the story branch, so it merged nothing and the box keeps its files: the box did not start",
        });
        w.takePart = async () => ({
          kind: "park",
          reason: "scope-violation",
          detail: "the part touched a protected file",
        });
        expect(await w.catchUps.beforeSession(w.part.office, runOf(w))).toEqual({
          kind: "park",
          reason: "scope-violation",
          detail: "the part touched a protected file",
        });
        expect(await head(w)).toBe(tip);
        expect(pendingBoxCopy(w.f.office, w.f.run)).toBeNull();
        expect(held(w)).toBe("");
      }));

    it("takes no part when the base has not moved", () =>
      inWorld(async (w) => {
        await onBranch(w, { "src/mine.ts": "mine\n" }, "Mine");
        expect(await w.catchUps.beforeSession(w.part.office, runOf(w))).toEqual({ kind: "none" });
        expect(w.takes).toEqual([]);
      }));

    it("merges nothing for a branch that holds the base", () =>
      inWorld(async (w) => {
        const tip = await onBranch(w, { "src/mine.ts": "mine\n" }, "Mine");
        expect(await w.catchUps.beforeSession(w.part.office, runOf(w))).toEqual({ kind: "none" });
        expect(await head(w)).toBe(tip);
        expect(pendingBoxCopy(w.f.office, w.f.run)).toBeNull();
      }));

    it("parks conflict when the remote branch holds commits the push cannot meet", () =>
      inWorld(async (w) => {
        await onBranch(w, { "src/mine.ts": "mine\n" }, "Mine");
        await elsewhere(w, { "src/theirs.ts": "theirs\n" }, "Theirs");
        await onBase(w, { "docs/later.md": "later\n" });
        const caught = await w.catchUps.beforeSession(w.part.office, runOf(w));
        expect(caught).toEqual({
          kind: "park",
          reason: "conflict",
          detail: expect.stringContaining("the remote branch has commits the story branch lacks"),
        });
      }));
  });

  describe("a story In Review whose branch conflicts with the base (DIPO-464)", () => {
    it("is merged at once, pushed, and its conflict comes back for one fix round on the merge", () =>
      inWorld(async (w) => {
        await onBranch(w, { "src/shared.ts": "one\ntwo from the story\nthree\n" }, "Story");
        const onto = await onBase(w, { "src/shared.ts": "one\ntwo from the base\nthree\n" });
        const merge = await w.catchUps.inReview(w.part.office, runOf(w));
        if (merge.kind !== "handOff") throw new Error(`no hand-off: ${merge.kind}`);
        const tip = (await w.repo.git("rev-parse", `refs/heads/${BRANCH}`)).trim();
        expect(merge.head).toBe(tip);
        expect((await w.repo.git("rev-parse", `${tip}^2`)).trim()).toBe(onto);
        expect(merge.item.source).toBe("conflict");
        expect(merge.item.text).toContain("Conflicted files: content: src/shared.ts");
        await w.repo.git("fetch", "--quiet", "origin");
        expect((await w.repo.git("rev-parse", `refs/remotes/origin/${BRANCH}`)).trim()).toBe(tip);
        expect(handOffState(w.f.office, w.f.run)).toMatchObject({ current: 1, open: true });
        expect(pendingBoxCopy(w.f.office, w.f.run)?.ids).toEqual([1]);
      }));

    it("merges nothing for a base that merges cleanly: its next session does", () =>
      inWorld(async (w) => {
        const tip = await onBranch(w, { "src/mine.ts": "mine\n" }, "Mine");
        await onBase(w, { "docs/later.md": "later\n" });
        expect(await w.catchUps.inReview(w.part.office, runOf(w))).toEqual({ kind: "none" });
        expect((await w.repo.git("rev-parse", `refs/heads/${BRANCH}`)).trim()).toBe(tip);
      }));

    it("parks conflict, merging nothing, when the conflict is in a path the worker cannot write", () =>
      inWorld(async (w) => {
        const tip = await onBranch(w, { ".github/ci.yml": "story\n" }, "Story touches CI");
        await onBase(w, { ".github/ci.yml": "base\n" });
        const merge = await w.catchUps.inReview(w.part.office, runOf(w));
        expect(merge).toEqual({
          kind: "park",
          detail: expect.stringContaining("paths the worker cannot write: .github/ci.yml"),
        });
        expect((await w.repo.git("rev-parse", `refs/heads/${BRANCH}`)).trim()).toBe(tip);
      }));
  });
}
