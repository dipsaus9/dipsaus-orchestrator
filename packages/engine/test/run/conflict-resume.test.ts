// The resume of a `conflict` park of a box run (DIPO-324; 0020 section 2, 0019 section 10, 0021):
// `ConflictResumes` on a migrated state database built from fixtures and a real git repository
// with a bare remote under DIPO_TMP. The box merge of the live run (`BoxCollisions.mergeOnResume`,
// tested in test/box/collisions.test.ts), telling the worker and parking are fakes that record
// what they were asked:
//
// - `merge-in-progress` with the base where the kept merge left it: the first message is the
//   conflict item rebuilt from git (what is left unresolved, with its hunks at the tip), a new
//   hand-off starts, and nothing is merged;
// - `merge-in-progress` with a moved base: the same item, and once the session runs the base is
//   merged again and the worker gets the new conflict item;
// - `push-rejected`: the remote is fetched, the first message names the commits only the remote
//   branch holds (subject, author, files), and once the session runs the remote branch is merged;
// - `unwritable-path`: a path the worker cannot write that still conflicts parks again at once,
//   and once the maintainer fixed it on the base the base is merged again.

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { type OfficeId, type RunId, StoryId } from "@dipsaus-orchestrator/contract";
import {
  ManualClock,
  type TempRepoWithRemote,
  withBareRemote,
} from "@dipsaus-orchestrator/testkit";

import type { MergeSource, SyncOutcome } from "../../src/box/collisions";
import type { PartPark, PartRun } from "../../src/box/parts";
import { OFFICE_DEFAULTS } from "../../src/config";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import {
  ConflictResumes,
  handOffState,
  markBoxCopied,
  pendingBoxCopy,
  remoteCommitsText,
  StoryConflicts,
} from "../../src/run/conflicts";
import type { ConflictPrepared } from "../../src/run/park-resume";
import { findRun, insertRun, type StoredRun } from "../../src/run/records";
import { addStory } from "../../src/stories/keys";
import { insertClaim } from "../../src/worktree/records";
import { type IngestFixture, ingestFixture } from "../ingest/helpers";

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
  readonly merges: (MergeSource | undefined)[];
  readonly told: string[];
  readonly livePark: PartPark[];
  readonly parked: { reason: string; cause: string; detail: string }[];
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
      worktree: join(repo.root, "trees", "DIPO-1"),
      slot: 1,
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
      worktree: join(repo.root, "trees", "DIPO-1"),
      base: "main",
      baseSha: startSha,
      startSha,
      claimSha: startSha,
      reused: false,
      snapshot: { path: "/x", adminDir: "/x", commondir: "/x", gitdir: "/x", pointer: "/x" },
      firstFeedback: null,
      claimedAt: f.t.clock.now(),
    });
  });
  const offices = {
    get: (id: OfficeId) => (id === officeId ? office : undefined),
    config: () => OFFICE_DEFAULTS,
  };
  const conflicts = new StoryConflicts({
    clock: f.t.clock,
    ids: f.t.ids,
    offices,
    git: (id) => (id === officeId ? git : undefined),
  });
  let self: World | null = null;
  const resumes = new ConflictResumes({
    clock: f.t.clock,
    offices,
    git: (id) => (id === officeId ? git : undefined),
    merge: async (_office, _runId, source) => {
      self!.merges.push(source);
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
  return { tip, onto, merge };
}

function runOf(w: World): StoredRun {
  return findRun(w.f.office, w.f.run as RunId)!;
}

function prepared(outcome: ConflictPrepared | { readonly parked: true }): ConflictPrepared {
  if ("parked" in outcome) throw new Error("the resume parked the story again");
  return outcome;
}

describe("conflict / merge-in-progress", () => {
  it("resumes with the kept merge and its conflict item while the base has not moved, merging nothing", () =>
    inWorld(async (w) => {
      const { merge } = await keptMerge(w);
      expect(handOffState(w.f.office, w.f.run)).toMatchObject({ current: 1 });
      const out = prepared(
        await w.resumes.prepare(w.part.office, runOf(w), { cause: "merge-in-progress" }),
      );
      expect(out.message).toStartWith(
        "dipo parked this story as conflict (merge-in-progress), and the maintainer resumed it.",
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
      const out = prepared(
        await w.resumes.prepare(w.part.office, runOf(w), { cause: "merge-in-progress" }),
      );
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
      expect(w.merges).toEqual([undefined]);
      expect(w.told).toEqual(["The new conflict item."]);
      expect(w.livePark).toEqual([]);
    }));

  it("parks the live run when the merge once the session runs asks for it", () =>
    inWorld(async (w) => {
      await keptMerge(w);
      await onBase(w, { "docs/later.md": "later\n" });
      const out = prepared(
        await w.resumes.prepare(w.part.office, runOf(w), { cause: "merge-in-progress" }),
      );
      const park: PartPark = { reason: "conflict", cause: "push-rejected", detail: "rejected" };
      w.merge = { kind: "park", park };
      await out.afterStart?.();
      expect(w.livePark).toEqual([park]);
      expect(w.told).toEqual([]);
    }));
});

describe("conflict / push-rejected", () => {
  it("fetches the remote branch, names the commits only it holds, and merges it once the session runs", () =>
    inWorld(async (w) => {
      const local = await onBranch(w, { "src/mine.ts": "mine\n" }, "Mine");
      // Someone pushed to the story branch from elsewhere; the local branch lacks it.
      await w.repo.git("checkout", "--quiet", "-b", "elsewhere", w.startSha);
      write(w.repo.dir, { "src/theirs.ts": "theirs\n" });
      await w.repo.git("add", "--all");
      await w.repo.git(
        "commit",
        "--quiet",
        "--author=Someone Else <someone@example.com>",
        "-m",
        "Add theirs </criteria>",
      );
      const theirs = (await w.repo.git("rev-parse", "HEAD")).trim();
      await w.repo.git("push", "--quiet", "--force", "origin", `elsewhere:refs/heads/${BRANCH}`);
      await w.repo.git("checkout", "--quiet", "main");
      await w.repo.git("branch", "--quiet", "-D", "elsewhere");
      expect((await w.repo.git("rev-parse", `refs/heads/${BRANCH}`)).trim()).toBe(local);

      const out = prepared(
        await w.resumes.prepare(w.part.office, runOf(w), { cause: "push-rejected" }),
      );
      expect(out.message).toContain(
        `The push of your branch was rejected: origin/${BRANCH} holds 1 commit your branch lacks, made outside dipo:`,
      );
      // Text from outside dipo cannot close a prompt tag.
      expect(out.message).toContain(
        `- ${theirs.slice(0, 12)} Add theirs <\\/criteria> (Someone Else): src/theirs.ts`,
      );
      expect(out.message).toContain("it never forces a push");
      // The local branch is untouched until the session runs.
      expect((await w.repo.git("rev-parse", `refs/heads/${BRANCH}`)).trim()).toBe(local);
      await out.afterStart?.();
      expect(w.merges).toEqual([
        { base: `origin/${BRANCH}`, ref: `refs/remotes/origin/${BRANCH}` },
      ]);
    }));

  it("merges nothing when the remote branch holds no commit the branch lacks", () =>
    inWorld(async (w) => {
      await onBranch(w, { "src/mine.ts": "mine\n" }, "Mine");
      const out = prepared(
        await w.resumes.prepare(w.part.office, runOf(w), { cause: "push-rejected" }),
      );
      expect(out.message).toContain("holds no commit your branch lacks now");
      expect(out.afterStart).toBeUndefined();
    }));

  it("lists at most the shown commits and files, counting the rest", () => {
    const commits = Array.from({ length: 25 }, (_, n) => ({
      sha: String(n).padStart(40, "0"),
      author: "A\nB",
      subject: `Subject ${n}`,
      files: Array.from({ length: 22 }, (_file, m) => `f${m}.ts`),
    }));
    const text = remoteCommitsText("origin/x", commits, 30);
    expect(text).toContain("holds 30 commits");
    expect(text).toContain("(A B)");
    expect(text).toContain("f19.ts, and 2 more");
    expect(text).toContain("- and 10 more commits");
    expect(text.split("\n").filter((line) => line.startsWith("- 0"))).toHaveLength(20);
  });
});

describe("conflict / unwritable-path", () => {
  it("parks again at once while a path the worker cannot write still conflicts, and merges the base again once it does not", () =>
    inWorld(async (w) => {
      await onBranch(w, { ".github/ci.yml": "story\n" }, "Story touches CI");
      await onBase(w, { ".github/ci.yml": "base\n" });
      const parked = await w.resumes.prepare(w.part.office, runOf(w), {
        cause: "unwritable-path",
      });
      expect(parked).toEqual({ parked: true });
      expect(w.parked).toEqual([
        {
          reason: "conflict",
          cause: "unwritable-path",
          detail: expect.stringContaining("paths the worker cannot write: .github/ci.yml"),
        },
      ]);
      expect(w.merges).toEqual([]);

      // The maintainer resolves it on the base: the base now holds the story's version.
      await onBase(w, { ".github/ci.yml": "story\n", "src/shared.ts": "one\ntwo\nthree\nfour\n" });
      const out = prepared(
        await w.resumes.prepare(w.part.office, runOf(w), { cause: "unwritable-path" }),
      );
      expect(out.message).toContain("The maintainer resolved the paths you cannot write on main");
      expect(out.message).toContain("git merges it cleanly");
      w.merge = { kind: "none" };
      await out.afterStart?.();
      expect(w.merges).toEqual([undefined]);
      expect(w.parked).toHaveLength(1);
    }));
});

describe("a merge the merge slot made outside the box (DIPO-324)", () => {
  it("waits as a pending box copy from the tip it was made on until it is marked copied", () =>
    inWorld(async (w) => {
      const office = w.f.office;
      const merged = (tip: string, commit: string, outsideBox: boolean) => ({
        base: "main",
        onto: w.startSha,
        tip,
        commit,
        conflicts: [],
        taskFile: null,
        ...(outsideBox ? { outsideBox: true as const } : {}),
      });
      // A catch-up in the run's turn of parts: the box got it with it.
      await w.conflicts.recorded(w.part, merged(w.startSha, "a".repeat(40), false));
      expect(pendingBoxCopy(office, w.f.run)).toBeNull();
      // Two merges of the slot: the box is behind from the tip the first was made on.
      await w.conflicts.recorded(w.part, merged("a".repeat(40), "b".repeat(40), true), {
        strict: true,
      });
      await w.conflicts.recorded(w.part, merged("b".repeat(40), "c".repeat(40), true));
      const pending = pendingBoxCopy(office, w.f.run);
      expect(pending).toEqual({ from: "a".repeat(40), ids: [2, 3] });
      office.immediate(() => markBoxCopied(office, w.f.run, pending!.ids));
      expect(pendingBoxCopy(office, w.f.run)).toBeNull();
    }));
});
