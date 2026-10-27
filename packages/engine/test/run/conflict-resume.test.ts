// The resume of a `conflict` park of a box run (DIPO-324; 0020 section 2, 0019 section 10, 0021):
// `ConflictResumes` on a migrated state database built from fixtures and a real git repository
// with a bare remote under DIPO_TMP. The box merge of the live run (`BoxCollisions.mergeOnResume`,
// tested in test/box/collisions.test.ts), telling the worker and parking are fakes that record
// what they were asked:
//
// What git and the run's hand-offs say decides which case a resume is, never the park's detail:
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
//
// Three cases stay local: a resume with nothing to merge, the shown-commit cap, and the
// pending box copy of a slot merge. The rest is in conflict-resume.ci.test.ts (CI only, DIPO-225).

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
  ConflictResumes,
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

function runOf(w: World): StoredRun {
  return findRun(w.f.office, w.f.run as RunId)!;
}

function prepared(outcome: ConflictPrepared | { readonly parked: true }): ConflictPrepared {
  if ("parked" in outcome) throw new Error("the resume parked the story again");
  return outcome;
}

describe("a conflict resume, from git's facts", () => {
  it("merges nothing when neither the remote branch nor the base holds anything the branch lacks", () =>
    inWorld(async (w) => {
      await onBranch(w, { "src/mine.ts": "mine\n" }, "Mine");
      const out = prepared(await w.resumes.prepare(w.part.office, runOf(w)));
      expect(out.message).toContain("nothing needs merging now");
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
