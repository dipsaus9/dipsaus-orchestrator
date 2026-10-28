// CI only (0017 section 1, DIPO-225): real git repositories and processes, too slow for the local
// run.
// A box run's Mac worktree that only lags its branch (DIPO-332, after DIPO-302), on real git with
// a bare remote and the scripted Backlog CLI of the reconcile helpers. The branch moves as a box
// run moves it: parts and dipo's own commits made outside the claim's worktree and put on the
// branch with `update-ref`, while dipo's task-file commits also write the task file in the worktree.
// So the worktree holds the claim's code files and a later task file. The Done teardown and the
// done-elsewhere release remove such a worktree, and keep one with a change only it holds.

import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { git as gitIn } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config";
import type { OfficeGit } from "../../src/git/office";
import { reconcileOffice } from "../../src/reconcile";
import { insertStoryPr } from "../../src/story-pr/records";
import { StoryTeardown } from "../../src/worktree/done";
import {
  DONE_ELSEWHERE_DESK,
  DONE_ELSEWHERE_NOTICES,
  doneElsewhereDeskItems,
  findDoneElsewhere,
  releaseDoneElsewhere,
  settleDoneElsewhere,
} from "../../src/worktree/done-elsewhere";
import { unlaggedPaths } from "../../src/worktree/lagging";
import { type ClaimRecord, findClaim, liveClaimOf } from "../../src/worktree/records";
import { dirtyFilesOf } from "../../src/worktree/release";
import { removeWorktree, TEARDOWN_NOTICES } from "../../src/worktree/teardown";
import { otherClone, squashMergeOnRemote } from "../backlog/lane/helpers";
import {
  claim,
  editWorktree,
  type FakeTask,
  fakeBacklog,
  keyOf,
  noticesAfter,
  type ReconcileOffice,
  withReconcileOffice,
} from "../reconcile/helpers";
import { lastSeq } from "../stories/helpers";

const DONE: readonly FakeTask[] = [{ id: "TASK-1", status: "Done" }];

function gitOf(o: ReconcileOffice): OfficeGit {
  const git = o.engineGit.forOffice(o.officeId);
  if (git === undefined) throw new Error("the office git is not attached");
  return git;
}

/** Code files (and `extra` ones) on the base before the claim, pushed and fetched. */
async function seedBase(
  o: ReconcileOffice,
  extra: Readonly<Record<string, string>> = {},
): Promise<void> {
  const files: Record<string, string> = {
    "src/shared.ts": "export const shared = 1;\n",
    "src/old.ts": "export const old = 1;\n",
    ...extra,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(o.repo.dir, path)), { recursive: true });
    writeFileSync(join(o.repo.dir, path), text);
  }
  await o.repo.git("add", "--all");
  await o.repo.git("commit", "--quiet", "--no-verify", "-m", "Seed the code");
  await o.repo.git("push", "--quiet", "origin", "main");
  await o.repo.git("fetch", "--quiet", "origin");
}

async function tipOf(o: ReconcileOffice, ref: string): Promise<string | null> {
  const result = await o.repo.run(["git", "rev-parse", "--verify", "--quiet", ref], o.repo.dir);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/**
 * Commits on the story branch as dipo commits a box part or its own commit: in a scratch checkout
 * of the tip, never in the claim's worktree, then `update-ref` from the tip. A null content
 * deletes the file; `task` also writes the story's task file there. Returns the new tip.
 */
async function onBranch(
  o: ReconcileOffice,
  record: ClaimRecord,
  message: string,
  files: Readonly<Record<string, string | null>>,
  task?: FakeTask,
): Promise<string> {
  const ref = `refs/heads/${record.branch}`;
  const tip = (await tipOf(o, ref)) ?? "";
  const scratch = join(o.repo.root, "scratch");
  await o.repo.git("worktree", "add", "--quiet", "--detach", scratch, tip);
  try {
    for (const [path, text] of Object.entries(files)) {
      const full = join(scratch, path);
      if (text === null) rmSync(full);
      else {
        await o.repo.run(["mkdir", "-p", join(full, "..")]);
        writeFileSync(full, text);
      }
    }
    if (task !== undefined) editWorktree({ worktree: scratch }, task);
    for (const args of [
      ["git", "add", "--all"],
      ["git", "commit", "--quiet", "--no-verify", "-m", message],
    ] as const) {
      const done = await o.repo.run(args, scratch);
      if (done.exitCode !== 0) throw new Error(`${args.join(" ")}: ${done.stderr}`);
    }
    const commit = (await o.repo.run(["git", "rev-parse", "HEAD"], scratch)).stdout.trim();
    await o.repo.git("update-ref", ref, commit, tip);
    return commit;
  } finally {
    await o.repo.git("worktree", "remove", "--force", scratch);
  }
}

/** The story's task file path in the worktree. */
async function taskPath(o: ReconcileOffice, record: ClaimRecord): Promise<string> {
  const out = await o.repo.run(["git", "ls-files", "--", "backlog/tasks"], record.worktree);
  const path = out.stdout.split("\n").find((line) => line.toLowerCase().includes("task-1 - "));
  if (path === undefined) throw new Error("no task file");
  return path;
}

/**
 * dipo's task-file commit: on the branch from its own copy, and the worktree's index entry and
 * file of the task file brought up to it (`commitFromCopy`), nothing else in the worktree.
 */
async function statusCommit(
  o: ReconcileOffice,
  record: ClaimRecord,
  status: string,
): Promise<string> {
  const commit = await onBranch(
    o,
    record,
    `TASK-1: status ${status}`,
    {},
    { id: "TASK-1", status },
  );
  const path = await taskPath(o, record);
  const done = await o.repo.run(["git", "checkout", commit, "--", path], record.worktree);
  if (done.exitCode !== 0) throw new Error(done.stderr);
  return commit;
}

/**
 * A box run as the live gap had it: two parts (a new file, a change, a deletion), the In Review
 * commit that also writes the worktree's task file, and the close-out commit that does not.
 */
async function boxRun(o: ReconcileOffice, record: ClaimRecord): Promise<string> {
  await onBranch(o, record, "TASK-1: part 1", {
    "src/feature.ts": "export const feature = 1;\n",
    "src/shared.ts": "export const shared = 2;\n",
  });
  await onBranch(o, record, "TASK-1: part 2", {
    "src/feature.ts": "export const feature = 2;\n",
    "src/old.ts": null,
  });
  await statusCommit(o, record, "In Review");
  return onBranch(o, record, "TASK-1: close out", {}, { id: "TASK-1", status: "Done" });
}

async function statusOf(o: ReconcileOffice, record: ClaimRecord): Promise<string[]> {
  const out = await o.repo.run(
    ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    record.worktree,
  );
  return [
    ...new Set(
      out.stdout
        .split("\0")
        .filter((line) => line !== "")
        .map((line) => line.slice(3)),
    ),
  ].toSorted();
}

function pollOf(o: ReconcileOffice): StoryTeardown {
  const teardown = new StoryTeardown({
    git: () => gitOf(o),
    host: null,
    cli: { spawn: fakeBacklog(o.tables).spawn },
    offices: { get: () => o.office, config: () => OFFICE_DEFAULTS },
    statusOf: async () => "Done",
  });
  teardown.track(o.officeId as OfficeId, o.office, o.s.clock);
  return teardown;
}

/** The story PR of the run, recorded merged at `head` as the PR poll records it. */
function mergedPr(o: ReconcileOffice, record: ClaimRecord, head: string): void {
  o.office.immediate(() =>
    insertStoryPr(o.office, {
      runId: record.runId,
      key: record.key,
      number: 377,
      url: "https://github.com/o/r/pull/377",
      branch: record.branch,
      base: "main",
      headSha: head,
      state: "merged",
      title: "feat(TASK-1): x",
      bodyHash: "h",
      openedAt: 1,
      closedAt: 2,
    }),
  );
}

async function reconcile(o: ReconcileOffice): Promise<void> {
  const pass = await o.index.indexStories(o.officeId);
  await reconcileOffice(
    {
      officeId: o.officeId,
      office: o.office,
      git: gitOf(o),
      clock: o.s.clock,
      host: { closePr: async () => {} },
    },
    { trigger: "rescan", pass, reindex: () => o.index.indexStories(o.officeId) },
  );
}

/** A claim of TASK-1 with its run ended, on a base with code files. */
async function claimed(
  o: ReconcileOffice,
  extra: Readonly<Record<string, string>> = {},
): Promise<ClaimRecord> {
  await seedBase(o, extra);
  return claim(o, o.office, "TASK-1", keyOf(o.office, "TASK-1"), { active: false });
}

/** `removeWorktree` of the claim, as the Done teardown and the releases call it. */
function remove(o: ReconcileOffice, record: ClaimRecord) {
  const git = gitOf(o);
  return git.run((session) =>
    removeWorktree({ office: o.office, git, clock: o.s.clock }, session, record),
  );
}

/** The unlagged paths of the claim's worktree, through the office git. */
function unlagged(o: ReconcileOffice, record: ClaimRecord): Promise<string[] | null> {
  const git = gitOf(o);
  return git.run((session) => unlaggedPaths(git, session, record));
}

async function movedPast(o: ReconcileOffice): Promise<ClaimRecord> {
  const record = await claimed(o);
  const head = await boxRun(o, record);
  mergedPr(o, record, head);
  await onBranch(o, record, "TASK-1: after the merge", { "src/extra.ts": "export {};\n" });
  return record;
}

function expectLeftovers(o: ReconcileOffice, record: ClaimRecord, seq: number): void {
  expect(findClaim(o.office, record.runId)?.releaseReason).toBe("done");
  expect(liveClaimOf(o.office, record.key)).toBeNull();
  expect(existsSync(record.worktree)).toBe(false);
  const row = findDoneElsewhere(o.office, record.runId);
  expect(row).toMatchObject({ worktreeKept: false, branchKept: true });
  expect(row?.commits.map((c) => c.subject)).toContain("TASK-1: after the merge");
  expect(doneElsewhereDeskItems(o.office)).toMatchObject([
    {
      kind: DONE_ELSEWHERE_DESK.leftovers,
      key: record.key,
      actions: [{ command: "work.discard", cli: 'dipo discard TASK-1 --note "<why>"' }],
    },
  ]);
  const notices = noticesAfter(o.office, seq);
  expect(notices.find((n) => n.code === DONE_ELSEWHERE_NOTICES.released)?.text).toContain(
    "moved past the merged head",
  );
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("a box run's worktree that only lags its branch (DIPO-332)", () => {
    it("is removed by the Done teardown after its PR squash-merged, with its branch", () =>
      withReconcileOffice({}, async (o) => {
        const record = await claimed(o);
        await boxRun(o, record);
        // The live gap: git lists every delivered file, and the task file differs from the claim's.
        expect(await statusOf(o, record)).toEqual([
          await taskPath(o, record),
          "src/feature.ts",
          "src/old.ts",
          "src/shared.ts",
        ]);
        expect(await unlagged(o, record)).toEqual([]);
        expect(await dirtyFilesOf({ git: gitOf(o) }, record)).toEqual([]);
        await o.repo.git("push", "--quiet", "origin", record.branch);
        await squashMergeOnRemote(o.repo, record.branch);
        await o.repo.git("fetch", "--quiet", "origin");
        const seq = lastSeq(o.office);

        const teardown = pollOf(o);
        const report = await teardown.poll(o.officeId as OfficeId);
        teardown.stop();

        expect(report.tornDown.map((c) => c.runId)).toEqual([record.runId]);
        expect(existsSync(record.worktree)).toBe(false);
        expect(await tipOf(o, `refs/heads/${record.branch}`)).toBeNull();
        expect(findClaim(o.office, record.runId)?.releaseReason).toBe("done");
        const codes = noticesAfter(o.office, seq).map((n) => n.code);
        expect(codes).toContain(TEARDOWN_NOTICES.done);
        expect(codes).not.toContain(TEARDOWN_NOTICES.kept);
      }));

    it("keeps a change only the worktree holds: a staged-only blob, a mode, an untracked file, a folder", () =>
      withReconcileOffice({}, async (o) => {
        const record = await claimed(o);
        await boxRun(o, record);
        const wt = record.worktree;
        const run = (...args: string[]) => gitIn(wt, o.repo.home, ...args);
        expect(await unlagged(o, record)).toEqual([]);

        // A staged blob no commit has, its working file back at the claim's content.
        writeFileSync(join(wt, "src/shared.ts"), "export const shared = 7;\n");
        await run("add", "--", "src/shared.ts");
        writeFileSync(join(wt, "src/shared.ts"), "export const shared = 1;\n");
        expect(await unlagged(o, record)).toEqual(["src/shared.ts"]);
        await run("reset", "--quiet", "--", "src/shared.ts");
        expect(await unlagged(o, record)).toEqual([]);

        // The same content with another mode.
        chmodSync(join(wt, "src/shared.ts"), 0o755);
        expect(await unlagged(o, record)).toEqual(["src/shared.ts"]);
        chmodSync(join(wt, "src/shared.ts"), 0o644);

        // An untracked file no commit has.
        writeFileSync(join(wt, "notes.txt"), "mine\n");
        expect(await unlagged(o, record)).toEqual(["notes.txt"]);
        rmSync(join(wt, "notes.txt"));

        // A deleted file the branch still has.
        rmSync(join(wt, "src/shared.ts"));
        expect(await unlagged(o, record)).toEqual(["src/shared.ts"]);
        await run("checkout", "--", "src/shared.ts");

        // A nested repository dipo cannot judge: everything git lists stays.
        await gitIn(o.repo.root, o.repo.home, "init", "--quiet", join(wt, "nested"));
        await gitIn(
          join(wt, "nested"),
          o.repo.home,
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          "x",
        );
        expect(await unlagged(o, record)).toBeNull();
        expect((await dirtyFilesOf({ git: gitOf(o) }, record)).toSorted()).toEqual(
          (await statusOf(o, record)).toSorted(),
        );
        rmSync(join(wt, "nested"), { recursive: true, force: true });
        expect(await unlagged(o, record)).toEqual([]);
      }));
  });

  describe("a story merged through its own PR is Done through its own branch (DIPO-332, the DIPO-311 path)", () => {
    it("is not released as done elsewhere by reconcile, and the Done poll tears it down as done after the base moved on", () =>
      withReconcileOffice({ base: DONE }, async (o) => {
        const record = await claimed(o);
        const tip = await boxRun(o, record);
        await o.repo.git("push", "--quiet", "origin", record.branch);
        await squashMergeOnRemote(o.repo, record.branch);
        // The base moves on over the same lines, so merge-tree alone no longer sees the branch Done.
        const other = await otherClone(o.repo);
        writeFileSync(join(other, "src/feature.ts"), "export const feature = 3;\n");
        await gitIn(other, o.repo.home, "commit", "--quiet", "-am", "Change the feature again");
        await gitIn(other, o.repo.home, "push", "--quiet", "origin", "HEAD:main");
        await o.repo.git("fetch", "--quiet", "origin");
        mergedPr(o, record, tip);
        const seq = lastSeq(o.office);

        await reconcile(o);

        expect(liveClaimOf(o.office, record.key)).not.toBeNull();
        expect(findDoneElsewhere(o.office, record.runId)).toBeNull();
        expect(await tipOf(o, `refs/heads/${record.branch}`)).toBe(tip);

        const teardown = pollOf(o);
        const report = await teardown.poll(o.officeId as OfficeId);
        teardown.stop();

        expect(report.tornDown.map((c) => c.runId)).toEqual([record.runId]);
        expect(report.released ?? []).toEqual([]);
        expect(findClaim(o.office, record.runId)?.releaseReason).toBe("done");
        expect(existsSync(record.worktree)).toBe(false);
        expect(await tipOf(o, `refs/heads/${record.branch}`)).toBeNull();
        const notices = noticesAfter(o.office, seq);
        expect(notices.map((n) => n.code)).not.toContain(DONE_ELSEWHERE_NOTICES.released);
        expect(notices.find((n) => n.code === TEARDOWN_NOTICES.done)?.text).toContain("PR #377");
      }));

    it("removes a lagging worktree whose branch is already gone, by the PR's recorded head", () =>
      withReconcileOffice({}, async (o) => {
        const record = await claimed(o);
        const tip = await boxRun(o, record);
        mergedPr(o, record, tip);
        // The DIPO-311 state: the local branch deleted while the worktree stayed (HEAD unborn).
        await o.repo.git("update-ref", "-d", `refs/heads/${record.branch}`, tip);
        // Without the recorded head the close-out commit's task file is not found: kept.
        expect(await unlagged(o, record)).toContain(await taskPath(o, record));

        const teardown = pollOf(o);
        const report = await teardown.poll(o.officeId as OfficeId);
        teardown.stop();

        expect(report.tornDown.map((c) => c.runId)).toEqual([record.runId]);
        expect(existsSync(record.worktree)).toBe(false);
      }));

    it("keeps the branch of a worktree kept by a done-elsewhere release, so the worktree keeps its HEAD", () =>
      withReconcileOffice({ base: DONE }, async (o) => {
        const record = await claimed(o);
        const tip = await boxRun(o, record);
        writeFileSync(join(record.worktree, "src/feature.ts"), "export const feature = 9;\n");
        await o.repo.git("push", "--quiet", "origin", record.branch);
        await squashMergeOnRemote(o.repo, record.branch);
        await o.repo.git("fetch", "--quiet", "origin");
        // The release as it ran before this fix, for a story whose branch adds nothing.
        const deps = {
          officeId: o.officeId,
          office: o.office,
          git: gitOf(o),
          clock: o.s.clock,
        };
        releaseDoneElsewhere(deps, record, null);
        const row = findDoneElsewhere(o.office, record.runId);
        if (row === null) throw new Error("no row");

        const outcome = await settleDoneElsewhere(deps, row);

        expect(outcome).toMatchObject({ worktreeKept: true, branchKept: false });
        expect(outcome.files).toEqual(["src/feature.ts"]);
        expect(await tipOf(o, `refs/heads/${record.branch}`)).toBe(tip);
        const head = await o.repo.run(["git", "rev-parse", "--verify", "HEAD"], record.worktree);
        expect(head.stdout.trim()).toBe(tip);
      }));
  });

  describe("a done-elsewhere release of a box run (DIPO-332)", () => {
    it("removes the lagging worktree and keeps the branch with its commits", () =>
      withReconcileOffice({ base: DONE }, async (o) => {
        const record = await claimed(o);
        const tip = await boxRun(o, record);
        const seq = lastSeq(o.office);

        await reconcile(o);

        expect(findClaim(o.office, record.runId)?.releaseReason).toBe("done-elsewhere");
        expect(existsSync(record.worktree)).toBe(false);
        expect(await tipOf(o, `refs/heads/${record.branch}`)).toBe(tip);
        expect(findDoneElsewhere(o.office, record.runId)).toMatchObject({
          worktreeKept: false,
          branchKept: true,
          files: [],
        });
        const leftovers = noticesAfter(o.office, seq).find(
          (n) => n.code === DONE_ELSEWHERE_NOTICES.leftovers,
        );
        expect(leftovers?.text).not.toContain("uncommitted");
        expect(leftovers?.text).toContain(`the branch ${record.branch}`);
      }));
  });

  describe("what git status does not list keeps the worktree (DIPO-332 review)", () => {
    it("keeps a populated submodule with a local commit that ignore=all hides, next to a lagging file", () =>
      withReconcileOffice({}, async (o) => {
        const home = o.repo.home;
        const source = join(o.repo.root, "sub-source");
        await gitIn(o.repo.root, home, "init", "--quiet", "-b", "main", source);
        writeFileSync(join(source, "lib.ts"), "export const lib = 1;\n");
        await gitIn(source, home, "add", "--all");
        await gitIn(source, home, "commit", "--quiet", "-m", "lib");
        await o.repo.git(
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          "--quiet",
          source,
          "vendor/sub",
        );
        await o.repo.git("config", "-f", ".gitmodules", "submodule.vendor/sub.ignore", "all");
        const record = await claimed(o);
        await gitIn(
          record.worktree,
          home,
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "update",
          "--init",
          "--quiet",
        );
        const sub = join(record.worktree, "vendor/sub");
        writeFileSync(join(sub, "lib.ts"), "export const lib = 2;\n");
        await gitIn(sub, home, "commit", "--quiet", "-am", "unpushed");
        const unpushed = (await gitIn(sub, home, "rev-parse", "HEAD")).trim();
        await boxRun(o, record);
        // git status hides the submodule; only the lagging files show.
        expect((await statusOf(o, record)).some((path) => path.startsWith("vendor"))).toBe(false);
        expect(await unlagged(o, record)).toBeNull();

        const outcome = await remove(o, record);

        expect(outcome.ok).toBe(false);
        expect((await gitIn(sub, home, "rev-parse", "HEAD")).trim()).toBe(unpushed);
      }));

    it("keeps a worktree with an ignored .env, and removes one whose only ignored entry is node_modules/", () =>
      withReconcileOffice({}, async (o) => {
        const record = await claimed(o, { ".gitignore": ".env\nnode_modules/\n" });
        await boxRun(o, record);
        writeFileSync(join(record.worktree, ".env"), "TOKEN=local\n");
        await o.repo.git("push", "--quiet", "origin", record.branch);
        await squashMergeOnRemote(o.repo, record.branch);
        await o.repo.git("fetch", "--quiet", "origin");
        const seq = lastSeq(o.office);
        const teardown = pollOf(o);

        const kept = await teardown.poll(o.officeId as OfficeId);

        expect(kept.kept.map((c) => c.runId)).toEqual([record.runId]);
        expect(existsSync(join(record.worktree, ".env"))).toBe(true);
        const told = noticesAfter(o.office, seq).filter((n) => n.code === TEARDOWN_NOTICES.kept);
        expect(told[0]?.text).toContain("ignored files that git would delete with it");
        expect(told[0]?.text).toContain("Files git lists there: .env.");

        rmSync(join(record.worktree, ".env"));
        mkdirSync(join(record.worktree, "node_modules/pkg"), { recursive: true });
        writeFileSync(join(record.worktree, "node_modules/pkg/index.js"), "module.exports = 1;\n");
        const done = await teardown.poll(o.officeId as OfficeId);
        teardown.stop();

        expect(done.tornDown.map((c) => c.runId)).toEqual([record.runId]);
        expect(existsSync(record.worktree)).toBe(false);
      }));

    it("keeps a node_modules/ that holds a repository at any depth, next to a lagging file", () =>
      withReconcileOffice({}, async (o) => {
        const record = await claimed(o, { ".gitignore": "node_modules/\n" });
        await boxRun(o, record);
        const pkg = join(record.worktree, "node_modules/@scope/pkg");
        mkdirSync(pkg, { recursive: true });
        await gitIn(o.repo.root, o.repo.home, "init", "--quiet", pkg);
        writeFileSync(join(pkg, "index.js"), "module.exports = 1;\n");
        await gitIn(pkg, o.repo.home, "add", "--all");
        await gitIn(pkg, o.repo.home, "commit", "--quiet", "-m", "local work");
        expect(await unlagged(o, record)).toEqual([]);

        const outcome = await remove(o, record);

        expect(outcome).toMatchObject({ ok: false, files: ["node_modules/"] });
        expect(existsSync(join(pkg, ".git"))).toBe(true);
      }));

    it("keeps a node_modules/ holding a .GIT folder or a bare repository", () =>
      withReconcileOffice({}, async (o) => {
        const record = await claimed(o, { ".gitignore": "node_modules/\n" });
        await boxRun(o, record);
        const upper = join(record.worktree, "node_modules/pkg/.GIT");
        mkdirSync(upper, { recursive: true });
        writeFileSync(join(upper, "HEAD"), "ref: refs/heads/main\n");
        expect(await remove(o, record)).toMatchObject({ ok: false, files: ["node_modules/"] });

        rmSync(join(record.worktree, "node_modules/pkg"), { recursive: true });
        const bare = join(record.worktree, "node_modules/cache/mirror");
        await gitIn(o.repo.root, o.repo.home, "init", "--quiet", "--bare", bare);
        expect(await remove(o, record)).toMatchObject({ ok: false, files: ["node_modules/"] });
        expect(existsSync(join(bare, "HEAD"))).toBe(true);

        rmSync(join(record.worktree, "node_modules/cache"), { recursive: true });
        expect(await remove(o, record)).toEqual({ ok: true });
      }));

    it("keeps an ignored .env inside a tracked build/ folder: only a whole node_modules/ may go", () =>
      withReconcileOffice({}, async (o) => {
        const record = await claimed(o, { ".gitignore": ".env\n", "build/keep.txt": "kept\n" });
        await boxRun(o, record);
        writeFileSync(join(record.worktree, "build/.env"), "TOKEN=local\n");

        const outcome = await remove(o, record);

        expect(outcome).toMatchObject({ ok: false, files: ["build/.env"] });
        expect(existsSync(join(record.worktree, "build/.env"))).toBe(true);
      }));

    it("keeps a lagging worktree that changes between the check and the forced removal", () =>
      withReconcileOffice({}, async (o) => {
        const record = await claimed(o);
        await boxRun(o, record);
        expect(await unlagged(o, record)).toEqual([]);
        const git = gitOf(o);
        // An edit lands after the first lagging check hashed the files, before the second.
        let edited = false;
        const outcome = await git.run((session) => {
          const racing: typeof session = {
            repository: session.repository,
            base: () => session.base(),
            step: (location, args, options) => {
              if (args[0] === "rev-list" && !edited) {
                edited = true;
                writeFileSync(
                  join(record.worktree, "src/shared.ts"),
                  "export const shared = 42;\n",
                );
              }
              return session.step(location, args, options);
            },
            ok: (location, args, options) => session.ok(location, args, options),
          };
          return removeWorktree({ office: o.office, git, clock: o.s.clock }, racing, record);
        });

        expect(outcome).toMatchObject({ ok: false, files: ["src/shared.ts"] });
        expect(existsSync(join(record.worktree, "src/shared.ts"))).toBe(true);
        expect(await o.repo.git("worktree", "list", "--porcelain")).toContain(
          `locked dipo ${record.runId}`,
        );
      }));
  });

  describe("a claim whose branch moved past its merged PR's head (DIPO-332 review)", () => {
    it("is released by the Done poll with its branch as leftovers, not left open", () =>
      withReconcileOffice({}, async (o) => {
        const record = await movedPast(o);
        const seq = lastSeq(o.office);
        const teardown = pollOf(o);
        const report = await teardown.poll(o.officeId as OfficeId);
        teardown.stop();
        expect(report.released?.map((c) => c.runId)).toEqual([record.runId]);
        expectLeftovers(o, record, seq);
      }));

    it("is released by reconcile the same way when the base reads it Done", () =>
      withReconcileOffice({ base: DONE }, async (o) => {
        const record = await movedPast(o);
        const seq = lastSeq(o.office);
        await reconcile(o);
        expectLeftovers(o, record, seq);
      }));

    it("is kept with a notice while its story has an open park, by the Done poll and by reconcile", () =>
      withReconcileOffice({ base: DONE }, async (o) => {
        const record = await movedPast(o);
        // Parked in Backlog.md on its branch (DIPO-360), with the park's run detail row.
        await onBranch(
          o,
          record,
          "TASK-1: status Parked",
          {},
          {
            id: "TASK-1",
            status: "Parked",
            fields: ['park: {reason: "budget-exceeded", from: "In Review", note: "turn cap"}'],
          },
        );
        o.office.run(
          `insert into parks (office_id, park_id, key, story_id, run_id, reason, detail, last_good_commit, at)
         values ($office_id, 1, $key, 'TASK-1', $run, 'budget-exceeded', 'turn cap', null, 1)`,
          { key: record.key, run: record.runId },
        );
        await o.index.indexStories(o.officeId);
        const seq = lastSeq(o.office);
        const teardown = pollOf(o);
        const report = await teardown.poll(o.officeId as OfficeId);
        teardown.stop();
        await reconcile(o);

        expect(report.kept.map((c) => c.runId)).toEqual([record.runId]);
        expect(liveClaimOf(o.office, record.key)).not.toBeNull();
        expect(existsSync(record.worktree)).toBe(true);
        expect(findDoneElsewhere(o.office, record.runId)).toBeNull();
        const notices = noticesAfter(o.office, seq);
        const parked = notices.find((n) => n.code === TEARDOWN_NOTICES.parked);
        expect(parked?.text).toContain("is Parked, but its PR #377 merged");
        expect(parked?.text).toContain("dipo discard TASK-1");
        expect(notices.some((n) => n.code === "reconcile.doneOnBaseKept")).toBe(true);
      }));
  });
}
