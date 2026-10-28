// CI only (0017 section 1, DIPO-225): the flow on real git; the rules as data and the merge driver
// guard stay in collisions.test.ts.
// Changed files and collisions of box runs (DIPO-277, 0021 section 12): the prefix rule, the texts
// and git's output read as data, then the flow on real git with a bare remote: two box runs whose
// boxes are folders here (a fake box: `tar` of the folder for the parts, `rm` and a folder copy for
// the catch-up), real `BoxParts` delivering their parts, and `BoxCollisions` telling the overlap
// and letting the second story catch up, cleanly and with a conflict.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import type { OfficeId, Signal } from "@dipsaus-orchestrator/contract";
import {
  ManualClock,
  type TempRepoWithRemote,
  withBareRemote,
} from "@dipsaus-orchestrator/testkit";

import {
  BoxCollisions,
  type CatchUpFound,
  type CatchUpMerged,
  CATCH_UP_PART_MESSAGE,
  COLLISION_NOTICES,
  conflictSignature,
  countedMarkers,
  type CollisionNotice,
  markersAt,
  storyChangedFiles,
  type SyncMode,
  type SyncOutcome,
} from "../../src/box/collisions";
import { BoxParts, type PartPark, type PartRun } from "../../src/box/parts";
import type { BoxPort } from "../../src/box/port";
import { BOX_STAGE_ROOT } from "../../src/box/user";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";

// ---- the flow on real git -------------------------------------------------------------------------

const OFFICE = "office-collisions" as OfficeId;
const SHARED = ["one", "two", "three", "four", "five", "six", "seven", "eight", ""].join("\n");

const START: Readonly<Record<string, string>> = {
  "README.md": "# Collisions\n",
  "src/shared.ts": SHARED,
  "src/old.ts": "export const old = 1;\n",
  ".github/workflows/ci.yml": "name: ci\n",
  "backlog/tasks/dipo-1 - One.md": "---\nid: DIPO-1\nstatus: Ready\n---\n",
  "backlog/tasks/dipo-2 - Two.md": "---\nid: DIPO-2\nstatus: Ready\n---\n",
};

interface Story {
  readonly run: PartRun;
  /** The box's `/work`. */
  readonly work: string;
}

interface World {
  readonly repo: TempRepoWithRemote;
  readonly git: OfficeGit;
  readonly parts: BoxParts;
  readonly collisions: BoxCollisions;
  readonly a: Story;
  readonly b: Story;
  readonly startSha: string;
  readonly told: { runId: string; text: string }[];
  readonly notices: CollisionNotice[];
  readonly parks: { runId: string; park: PartPark }[];
  readonly copies: string[];
  /** The merges dipo recorded and the conflicts it found In Review (DIPO-149). */
  readonly recorded: CatchUpMerged[];
  readonly found: { runId: string; found: CatchUpFound }[];
  /** The task-file statuses written back after a merge took the base's version (DIPO-149). */
  readonly statuses: { runId: string; status: string }[];
  /** The runs a check In Review cleared, and the installs after a catch-up changed a lockfile. */
  readonly cleared: string[];
  readonly reinstalls: { runId: string; lockfiles: readonly string[] }[];
  /** The runs whose story is In Review: no longer in progress. */
  inReview: PartRun[];
  readonly reviewing: Set<string>;
  failCopy: boolean;
  /** Runs before each stream out of a box, with how many streams that box gave so far. */
  onStream: ((box: string, n: number) => void) | null;
  /** Runs when the merge is copied into a box, before it is. */
  onCopy: (() => Promise<void>) | null;
  /** Why a run's box lacks a merge dipo made outside it (DIPO-324), by run. */
  readonly behind: Map<string, string>;
}

function write(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

function lines(replace: Readonly<Record<number, string>>): string {
  return SHARED.split("\n")
    .map((line, at) => replace[at] ?? line)
    .join("\n");
}

/** Boxes that are folders: `tar` of the folder for a part, `rm` and a folder copy for a catch-up. */
function folderBoxes(
  folders: ReadonlyMap<string, string>,
  w: () => World,
): Pick<BoxPort, "execLive" | "stop" | "exec" | "copyIn"> {
  const folder = (box: string) => {
    const dir = folders.get(box);
    if (dir === undefined) throw new Error(`no box ${box}`);
    return dir;
  };
  const streams = new Map<string, number>();
  // A copy for the box user (DIPO-334): the stage's source, copied on at the box user's `cp`.
  const staged = new Map<string, string>();
  return {
    execLive: (box) => {
      const n = (streams.get(box) ?? 0) + 1;
      streams.set(box, n);
      w().onStream?.(box, n);
      const packed = spawnSync("tar", ["-C", folder(box), "-cf", "-", "."], {
        env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" },
        maxBuffer: 64 * 1024 * 1024,
      });
      let finish!: (exit: { code: number | null; signal: Signal | null }) => void;
      const exited = new Promise<{ code: number | null; signal: Signal | null }>((resolve) => {
        finish = resolve;
      });
      return {
        stdin: { write: () => {}, end: () => {} },
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(packed.stdout));
            controller.close();
            finish({ code: packed.status, signal: null });
          },
        }),
        stderr: new ReadableStream({ start: (controller) => controller.close() }),
        exited,
        kill: () => {},
      };
    },
    stop: async () => {},
    exec: async (box, command) => {
      const stage = command.find((part) => part.startsWith(`${BOX_STAGE_ROOT}/`));
      if (stage !== undefined) {
        if (command[0] === "/bin/cp") {
          await w().onCopy?.();
          expect(command.at(-1)).toBe("/work");
          w().copies.push(box);
          cpSync(staged.get(stage)!, folder(box), { recursive: true, force: true });
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      const [program, flag, dashes, ...paths] = command;
      if (program !== "rm" || flag !== "-f" || dashes !== "--") {
        return { code: 127, stdout: "", stderr: "unexpected command" };
      }
      for (const path of paths) {
        if (!path.startsWith("/work/")) return { code: 1, stdout: "", stderr: "outside /work" };
        rmSync(join(folder(box), path.slice("/work/".length)), { force: true });
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    copyIn: async (_box, from, to) => {
      if (w().failCopy) throw new Error("the box is gone");
      expect(to.startsWith(`${BOX_STAGE_ROOT}/`)).toBe(true);
      expect(from).toEndWith("/.");
      staged.set(to, from.slice(0, -2));
    },
  };
}

async function world(repo: TempRepoWithRemote): Promise<World> {
  write(repo.dir, START);
  const startSha = await repo.commitAll("start");
  await repo.git("push", "--quiet", "origin", "main");
  await repo.git("fetch", "--quiet", "origin");
  const tmp = join(repo.root, "tmp");
  mkdirSync(tmp);
  const real = realpathSync(repo.dir);
  const git = new OfficeGit({
    officeId: OFFICE,
    mainWorktree: real,
    commonDir: join(real, ".git"),
    settings: { remote: "origin", base: "main" },
    runner: { exec: spawnGitExec(systemSpawn), env: repo.env, sleep: async () => {} },
    clock: new ManualClock(),
  });
  const story = async (id: string, n: number, task: string): Promise<Story> => {
    const branch = `${id}/story-${n}`;
    await repo.git("branch", branch, startSha);
    // dipo's claim commit of the task file: the box never gets it.
    await repo.git("checkout", "--quiet", branch);
    writeFileSync(join(repo.dir, task), `---\nid: ${id}\nstatus: In Progress\n---\n`);
    await repo.commitAll(`${id}: status In Progress`);
    await repo.git("push", "--quiet", "origin", branch);
    await repo.git("checkout", "--quiet", "main");
    const work = join(repo.root, `box-${n}`);
    write(work, START);
    return {
      run: {
        runId: `run_${n}`,
        office: OFFICE,
        story: id,
        branch,
        startSha,
        box: `dipo-run_${n}`,
      },
      work,
    };
  };
  const a = await story("DIPO-1", 1, "backlog/tasks/dipo-1 - One.md");
  const b = await story("DIPO-2", 2, "backlog/tasks/dipo-2 - Two.md");
  const runs = new Map([a, b].map((s) => [s.run.runId, s.run]));
  const folders = new Map([a, b].map((s) => [s.run.box, s.work]));
  const clock = new ManualClock();
  const told: { runId: string; text: string }[] = [];
  const notices: CollisionNotice[] = [];
  const parks: { runId: string; park: PartPark }[] = [];
  let self: World | null = null;
  const boxes = folderBoxes(folders, () => self!);
  const parts = new BoxParts({
    boxes,
    clock,
    stageRoot: join(realpathSync(tmp), "box-parts"),
    run: (runId) => runs.get(runId) ?? null,
    git: (office) => (office === OFFICE ? git : undefined),
    live: (runId) => !parks.some((p) => p.runId === runId) && !self!.reviewing.has(runId),
    behind: (run) => self!.behind.get(run.runId) ?? null,
    park: (runId, park) => {
      parks.push({ runId, park });
      return true;
    },
  });
  const collisions = new BoxCollisions({
    boxes,
    code: { spawn: systemSpawn, clock },
    tmpRoot: realpathSync(tmp),
    runs: () => [...runs.values()].filter((run) => !self!.reviewing.has(run.runId)),
    git: (office) => (office === OFFICE ? git : undefined),
    live: (runId) => !parks.some((p) => p.runId === runId) && !self!.reviewing.has(runId),
    parts,
    park: (runId, park) => {
      parks.push({ runId, park });
      return true;
    },
    tell: async (runId, text) => {
      told.push({ runId, text });
    },
    notice: (_office, _runId, notice) => notices.push(notice),
    inReview: () => self!.inReview,
    recorded: async (_run, merged) => {
      self!.recorded.push(merged);
    },
    found: (run, found) => self!.found.push({ runId: run.runId, found }),
    cleared: (run) => self!.cleared.push(run.runId),
    reinstall: async (run, lockfiles) => {
      self!.reinstalls.push({ runId: run.runId, lockfiles });
    },
    taskStatus: async (run, status) => {
      self!.statuses.push({ runId: run.runId, status });
    },
  });
  self = {
    repo,
    git,
    parts,
    collisions,
    a,
    b,
    startSha,
    told,
    notices,
    parks,
    copies: [],
    recorded: [],
    found: [],
    statuses: [],
    cleared: [],
    reinstalls: [],
    inReview: [],
    reviewing: new Set(),
    failCopy: false,
    onStream: null,
    onCopy: null,
    behind: new Map(),
  };
  return self;
}

function inWorld(fn: (w: World) => Promise<void>): Promise<void> {
  return withBareRemote(async (repo) => fn(await world(repo)));
}

/** The worker of `s` hands a part with what its box holds now. */
function handPart(w: World, s: Story, message: string): Promise<void> {
  return w.parts.onPart({
    runId: s.run.runId,
    box: s.run.box,
    n: 1,
    name: "1700000000-1.part",
    message,
    at: 0,
  });
}

/** The first story's branch merges into the base on the remote, as its PR would. */
async function mergeFirst(w: World): Promise<string> {
  await w.repo.git("merge", "--quiet", "--no-ff", "-m", "Merge DIPO-1", w.a.run.branch);
  await w.repo.git("push", "--quiet", "origin", "main");
  await w.repo.git("fetch", "--quiet", "origin");
  return (await w.repo.git("rev-parse", "refs/remotes/origin/main")).trim();
}

async function tipOf(w: World, s: Story, where: "local" | "remote" = "local"): Promise<string> {
  if (where === "remote") await w.repo.git("fetch", "--quiet", "origin");
  const ref =
    where === "local" ? `refs/heads/${s.run.branch}` : `refs/remotes/origin/${s.run.branch}`;
  return (await w.repo.git("rev-parse", ref)).trim();
}

async function changed(w: World, s: Story): Promise<string[]> {
  const found = await w.git.run((session) =>
    storyChangedFiles(session, {
      branch: s.run.branch,
      startSha: s.run.startSha,
      baseRef: "refs/remotes/origin/main",
    }),
  );
  return found?.files ?? [];
}

/** Both stories change `src/shared.ts` in lines apart, then the first merges. */
async function overlapAndMerge(w: World): Promise<{ before: string; onto: string }> {
  write(w.a.work, { "src/shared.ts": lines({ 0: "ONE" }), "src/a.ts": "a\n" });
  await handPart(w, w.a, "A changes shared");
  write(w.b.work, { "src/shared.ts": lines({ 7: "EIGHT" }) });
  await handPart(w, w.b, "B changes shared");
  const before = await tipOf(w, w.b);
  return { before, onto: await mergeFirst(w) };
}

/** Commits `files` on the base and pushes it, as a merge of something else would. */
async function onBase(w: World, files: Readonly<Record<string, string>>): Promise<string> {
  write(w.repo.dir, files);
  await w.repo.commitAll("Change the base");
  await w.repo.git("push", "--quiet", "origin", "main");
  await w.repo.git("fetch", "--quiet", "origin");
  return (await w.repo.git("rev-parse", "refs/remotes/origin/main")).trim();
}

// ---- the sync before In Review and the check In Review (DIPO-149) ----------------------------------

/** Both stories change line four of `src/shared.ts`, then the first merges. */
async function conflictAndMerge(w: World): Promise<{ before: string; onto: string }> {
  write(w.a.work, { "src/shared.ts": lines({ 3: "FOUR from one" }) });
  await handPart(w, w.a, "A changes line four");
  write(w.b.work, { "src/shared.ts": lines({ 3: "FOUR from two" }) });
  await handPart(w, w.b, "B changes line four");
  const before = await tipOf(w, w.b);
  return { before, onto: await mergeFirst(w) };
}

/** The sync of the second story in its held turn, as verify and commit runs it at done. */
function syncB(w: World, mode: SyncMode): Promise<SyncOutcome> {
  return w.parts.inTurn(w.b.run.runId, () => w.collisions.syncInTurn(w.b.run, mode));
}

/** A commit on the remote story branch the local branch lacks (pushed from elsewhere). */
async function pushedElsewhere(w: World, s: Story, files: Readonly<Record<string, string>>) {
  await w.repo.git("checkout", "--quiet", "-b", "elsewhere", s.run.branch);
  write(w.repo.dir, files);
  const sha = await w.repo.commitAll("Pushed from elsewhere");
  await w.repo.git("push", "--quiet", "origin", `elsewhere:refs/heads/${s.run.branch}`);
  await w.repo.git("checkout", "--quiet", "main");
  await w.repo.git("branch", "--quiet", "-D", "elsewhere");
  await w.repo.git("fetch", "--quiet", "origin");
  return sha;
}

/** The merge slot's sync: the base merged into the branch from git objects, the box untouched. */
async function slotMerge(w: World, s: Story): Promise<{ from: string; merge: string }> {
  const from = await tipOf(w, s);
  const onto = (await w.repo.git("rev-parse", "refs/remotes/origin/main")).trim();
  const tree = (await w.repo.git("merge-tree", "--write-tree", from, onto)).trim().split("\n")[0]!;
  const merge = (
    await w.repo.git("commit-tree", tree, "-p", from, "-p", onto, "-m", "Merge main")
  ).trim();
  await w.repo.git("update-ref", `refs/heads/${s.run.branch}`, merge, from);
  return { from, merge };
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("changed files and collisions on real git", () => {
    it("computes the changed files from the delivered parts, never the worker's list or the backlog", () =>
      inWorld(async (w) => {
        // Before any part only dipo's own task-file commit is on the branch.
        expect(await changed(w, w.a)).toEqual([]);
        write(w.a.work, { "src/a.ts": "export const a = 1;\n" });
        rmSync(join(w.a.work, "src/old.ts"));
        // An edit still in the box is not delivered, so it does not count yet.
        await handPart(w, w.a, "Add a");
        write(w.a.work, { "src/later.ts": "export const later = 1;\n" });
        expect(await changed(w, w.a)).toEqual(["src/a.ts", "src/old.ts"]);
      }));

    it("tells the maintainer and both workers once when two stories change the same file", () =>
      inWorld(async (w) => {
        write(w.a.work, { "src/shared.ts": lines({ 0: "ONE" }), "src/a.ts": "a\n" });
        await handPart(w, w.a, "A changes shared");
        write(w.b.work, { "src/b.ts": "b\n" });
        await handPart(w, w.b, "B adds its own file");
        await w.collisions.check();
        expect(w.notices).toEqual([]);
        expect(w.told).toEqual([]);

        write(w.b.work, { "src/shared.ts": lines({ 7: "EIGHT" }) });
        await handPart(w, w.b, "B changes shared too");
        await w.collisions.check();
        expect(w.notices).toEqual([
          {
            level: "warn",
            code: COLLISION_NOTICES.overlap,
            text: "DIPO-1 and DIPO-2 are both in progress and change the same 1 file: src/shared.ts. Both continue; when one merges, dipo merges the new base into the other's branch and box.",
          },
        ]);
        expect(w.told.map((t) => t.runId)).toEqual(["run_1", "run_2"]);
        expect(w.told[0]!.text).toContain("DIPO-2, changes the same 1 file as you: src/shared.ts");
        expect(w.told[1]!.text).toContain("DIPO-1, changes the same 1 file as you: src/shared.ts");
        // Nothing merged yet: both continue, and no branch moved for it.
        expect(w.parks).toEqual([]);
        const tips = [await tipOf(w, w.a), await tipOf(w, w.b)];

        // The same overlap is told once; a new overlapping file is told again.
        await w.collisions.check();
        expect(w.notices).toHaveLength(1);
        write(w.a.work, { "src/b.ts": "a's b\n" });
        await handPart(w, w.a, "A touches b too");
        await w.collisions.check();
        expect(w.notices).toHaveLength(2);
        expect(w.notices[1]!.text).toContain("the same 2 files: src/b.ts, src/shared.ts");
        expect(await tipOf(w, w.b)).toBe(tips[1]!);
      }));

    it("merges the new base into the second story's branch and box once the first merged", () =>
      inWorld(async (w) => {
        write(w.a.work, { "src/shared.ts": lines({ 0: "ONE" }), "src/a.ts": "a\n" });
        rmSync(join(w.a.work, "src/old.ts"));
        await handPart(w, w.a, "A changes shared");
        write(w.b.work, { "src/shared.ts": lines({ 7: "EIGHT" }) });
        await handPart(w, w.b, "B changes shared");
        const before = await tipOf(w, w.b);
        // An edit the second worker has not handed yet.
        write(w.b.work, { "src/b.ts": "b in progress\n" });
        const onto = await mergeFirst(w);

        await w.collisions.check();
        expect(w.parks).toEqual([]);
        const tip = await tipOf(w, w.b);
        // The box's own work went first, as a part, then the merge on top of it.
        const parents = (await w.repo.git("rev-list", "--parents", "-n", "1", tip))
          .trim()
          .split(" ");
        expect(parents.slice(1)[1]).toBe(onto);
        const first = parents[1]!;
        expect((await w.repo.git("log", "-1", "--format=%s", first)).trim()).toBe(
          CATCH_UP_PART_MESSAGE,
        );
        expect((await w.repo.git("rev-parse", `${first}^`)).trim()).toBe(before);
        expect((await w.repo.git("log", "-1", "--format=%s%n%n%b", tip)).trim()).toBe(
          `Merge main into ${w.b.run.branch}\n\nCatch-up of DIPO-2 with main at ${onto.slice(0, 12)}, merged by dipo.`,
        );
        expect(await tipOf(w, w.b, "remote")).toBe(tip);
        // The branch holds both changes, and the box holds what the branch holds.
        const merged = lines({ 0: "ONE", 7: "EIGHT" });
        expect(await w.repo.git("show", `${tip}:src/shared.ts`)).toBe(merged);
        expect(readFileSync(join(w.b.work, "src/shared.ts"), "utf8")).toBe(merged);
        expect(readFileSync(join(w.b.work, "src/a.ts"), "utf8")).toBe("a\n");
        expect(existsSync(join(w.b.work, "src/old.ts"))).toBe(false);
        expect(readFileSync(join(w.b.work, "src/b.ts"), "utf8")).toBe("b in progress\n");
        // dipo's task-file commits never reach the box: its backlog stays as it got it.
        expect(readFileSync(join(w.b.work, "backlog/tasks/dipo-1 - One.md"), "utf8")).toContain(
          "status: Ready",
        );
        expect(w.copies).toEqual(["dipo-run_2"]);
        // The first story merged: its changes are the base now, so only the catch-up is told.
        expect(w.notices.map((n) => [n.level, n.code])).toEqual([
          ["info", COLLISION_NOTICES.caughtUp],
        ]);
        const message = w.told.at(-1)!;
        expect(message.runId).toBe("run_2");
        expect(message.text).toContain("dipo merged main into your branch");
        expect(message.text).toContain("2 files written, 1 file removed");

        // The next part sees the merged box as delivered: nothing of the base comes back as a change.
        await handPart(w, w.b, "Nothing new");
        expect(await tipOf(w, w.b)).toBe(tip);
        expect(await changed(w, w.b)).toEqual(["src/b.ts", "src/shared.ts"]);
        // Caught up: the next pass leaves the story alone.
        const told = w.told.length;
        await w.collisions.check();
        expect(await tipOf(w, w.b)).toBe(tip);
        expect(w.told).toHaveLength(told);
        // The main checkout was not written by dipo.
        expect((await w.repo.git("status", "--porcelain")).trim()).toBe("");
      }));

    it("gives the second worker a fix round when git cannot merge cleanly", () =>
      inWorld(async (w) => {
        write(w.a.work, { "src/shared.ts": lines({ 3: "FOUR from one" }) });
        await handPart(w, w.a, "A changes line four");
        write(w.b.work, { "src/shared.ts": lines({ 3: "FOUR from two" }) });
        await handPart(w, w.b, "B changes line four");
        const before = await tipOf(w, w.b);
        const onto = await mergeFirst(w);

        await w.collisions.check();
        expect(w.parks).toEqual([]);
        const tip = await tipOf(w, w.b);
        expect((await w.repo.git("rev-list", "--parents", "-n", "1", tip)).trim()).toBe(
          `${tip} ${before} ${onto}`,
        );
        expect((await w.repo.git("log", "-1", "--format=%b", tip)).trim()).toContain(
          "1 file conflicted (content) and stay as git left them for the worker's fix round.",
        );
        const inBox = readFileSync(join(w.b.work, "src/shared.ts"), "utf8");
        expect(inBox).toContain("<<<<<<<");
        expect(inBox).toContain("FOUR from one");
        expect(inBox).toContain("FOUR from two");
        expect(await w.repo.git("show", `${tip}:src/shared.ts`)).toBe(inBox);
        expect(w.notices.at(-1)).toMatchObject({ level: "warn", code: COLLISION_NOTICES.conflict });
        const message = w.told.at(-1)!;
        expect(message.runId).toBe("run_2");
        expect(message.text).toStartWith("dipo: fix round.");
        expect(message.text).toContain("src/shared.ts");

        // The worker resolves it in its box and hands a part: an ordinary part on top of the merge.
        write(w.b.work, { "src/shared.ts": lines({ 3: "FOUR from one and two" }) });
        await handPart(w, w.b, "Resolve the conflict in shared");
        const fixed = await tipOf(w, w.b);
        expect((await w.repo.git("rev-parse", `${fixed}^`)).trim()).toBe(tip);
        expect(await w.repo.git("show", `${fixed}:src/shared.ts`)).toBe(
          lines({ 3: "FOUR from one and two" }),
        );
        const count = w.notices.length;
        await w.collisions.check();
        expect(w.notices).toHaveLength(count);
        expect(await tipOf(w, w.b)).toBe(fixed);
      }));

    it("leaves a story alone when the base changed none of its files", () =>
      inWorld(async (w) => {
        write(w.a.work, { "src/a.ts": "a\n" });
        await handPart(w, w.a, "A adds a");
        write(w.b.work, { "src/b.ts": "b\n" });
        await handPart(w, w.b, "B adds b");
        const before = await tipOf(w, w.b);
        await mergeFirst(w);
        await w.collisions.check();
        expect(await tipOf(w, w.b)).toBe(before);
        expect(w.notices).toEqual([]);
        expect(w.told).toEqual([]);
        expect(existsSync(join(w.b.work, "src/a.ts"))).toBe(false);
      }));

    it("parks the second story and keeps its branch when the merge cannot reach its box", () =>
      inWorld(async (w) => {
        write(w.a.work, { "src/shared.ts": lines({ 0: "ONE" }) });
        await handPart(w, w.a, "A changes shared");
        write(w.b.work, { "src/shared.ts": lines({ 7: "EIGHT" }) });
        await handPart(w, w.b, "B changes shared");
        const before = await tipOf(w, w.b);
        await mergeFirst(w);
        w.failCopy = true;
        await w.collisions.check();
        expect(await tipOf(w, w.b)).toBe(before);
        expect(w.parks).toEqual([
          {
            runId: "run_2",
            park: expect.objectContaining({ reason: "conflict" }),
          },
        ]);
        expect(w.notices.at(-1)).toMatchObject({ code: COLLISION_NOTICES.failed });
        // A parked run is no longer in progress: the next pass does not touch it.
        await w.collisions.check();
        expect(w.parks).toHaveLength(1);
      }));
  });

  describe("a catch-up's guards on real git", () => {
    it("fails the catch-up when an export attribute drops a merged file from the archive", () =>
      inWorld(async (w) => {
        await onBase(w, { ".gitattributes": "src/a.ts export-ignore\n" });
        const { before } = await overlapAndMerge(w);
        await w.collisions.check();
        expect(await tipOf(w, w.b)).toBe(before);
        expect(w.parks).toEqual([
          { runId: "run_2", park: expect.objectContaining({ reason: "conflict" }) },
        ]);
        // Checked on the Mac before the box was touched.
        expect(w.copies).toEqual([]);
        expect(existsSync(join(w.b.work, "src/a.ts"))).toBe(false);
        expect(readFileSync(join(w.b.work, "src/shared.ts"), "utf8")).toBe(lines({ 7: "EIGHT" }));
      }));

    it("takes the worker's edits made during the catch-up as a part and plans again once", () =>
      inWorld(async (w) => {
        const { before, onto } = await overlapAndMerge(w);
        let streams = 0;
        w.onStream = (box) => {
          if (box !== w.b.run.box) return;
          streams += 1;
          // The first stream is the part before the turn; the second is the one inside it.
          if (streams === 2) write(w.b.work, { "src/b.ts": "written during the catch-up\n" });
        };
        await w.collisions.check();
        expect(w.parks).toEqual([]);
        const tip = await tipOf(w, w.b);
        const [, first, second] = (await w.repo.git("rev-list", "--parents", "-n", "1", tip))
          .trim()
          .split(" ");
        expect(second).toBe(onto);
        expect((await w.repo.git("log", "-1", "--format=%s", first!)).trim()).toBe(
          CATCH_UP_PART_MESSAGE,
        );
        expect((await w.repo.git("rev-parse", `${first!}^`)).trim()).toBe(before);
        expect(await w.repo.git("show", `${tip}:src/b.ts`)).toBe("written during the catch-up\n");
        expect(readFileSync(join(w.b.work, "src/b.ts"), "utf8")).toBe(
          "written during the catch-up\n",
        );
        expect(readFileSync(join(w.b.work, "src/shared.ts"), "utf8")).toBe(
          lines({ 0: "ONE", 7: "EIGHT" }),
        );
      }));

    it("parks when the worker keeps changing files during the catch-up", () =>
      inWorld(async (w) => {
        await overlapAndMerge(w);
        let streams = 0;
        w.onStream = (box) => {
          if (box !== w.b.run.box) return;
          streams += 1;
          if (streams >= 2) write(w.b.work, { "src/b.ts": `edit ${streams}\n` });
        };
        await w.collisions.check();
        expect(w.parks).toEqual([
          { runId: "run_2", park: expect.objectContaining({ reason: "conflict" }) },
        ]);
        expect(w.notices.at(-1)!.text).toContain("the worker kept changing files");
        // Nothing of the base reached the box or the branch.
        expect(w.copies).toEqual([]);
        const tip = await tipOf(w, w.b);
        expect(
          (await w.repo.git("rev-list", "--parents", "-n", "1", tip)).trim().split(" "),
        ).toHaveLength(2);
        expect(readFileSync(join(w.b.work, "src/shared.ts"), "utf8")).toBe(lines({ 7: "EIGHT" }));
      }));

    it("resolves a conflict in the story's own task file to the base's version and writes the branch's status back", () =>
      inWorld(async (w) => {
        // The base refined the second story's task file on the line dipo's claim commit changed.
        const task = "backlog/tasks/dipo-2 - Two.md";
        const refined = "---\nid: DIPO-2\nstatus: Refined\n---\n\nRefined on the base.\n";
        await onBase(w, { [task]: refined });
        const { before, onto } = await overlapAndMerge(w);
        await w.collisions.check();
        expect(w.parks).toEqual([]);
        const tip = await tipOf(w, w.b);
        expect((await w.repo.git("rev-list", "--parents", "-n", "1", tip)).trim()).toBe(
          `${tip} ${before} ${onto}`,
        );
        // The merge holds the base's task file; the branch's status goes back through the field path.
        expect(await w.repo.git("show", `${tip}:${task}`)).toBe(refined);
        expect(w.statuses).toEqual([{ runId: "run_2", status: "In Progress" }]);
        // Only the task file conflicted, so the code merged cleanly and the worker got no fix round.
        expect(w.recorded).toEqual([
          { base: "main", onto, tip: before, commit: tip, conflicts: [], taskFile: task },
        ]);
        expect(readFileSync(join(w.b.work, "src/shared.ts"), "utf8")).toBe(
          lines({ 0: "ONE", 7: "EIGHT" }),
        );
        expect(readFileSync(join(w.b.work, task), "utf8")).toContain("status: Ready");
        expect(w.told.at(-1)!.text).toContain("dipo merged main into your branch");
        expect(w.notices.map((n) => n.code)).toEqual([COLLISION_NOTICES.caughtUp]);
      }));

    it("parks unwritable-path and merges nothing when the conflict is in a path the worker cannot write", () =>
      inWorld(async (w) => {
        const { before } = await overlapAndMerge(w);
        // A workflow change on the story branch made outside the box, then the base changes it too.
        await w.repo.git("checkout", "--quiet", w.b.run.branch);
        write(w.repo.dir, { ".github/workflows/ci.yml": "name: branch\n" });
        const byHand = await w.repo.commitAll("Change the workflow by hand");
        await w.repo.git("checkout", "--quiet", "main");
        await onBase(w, { ".github/workflows/ci.yml": "name: base\n" });
        expect(byHand).not.toBe(before);
        await w.collisions.check();
        expect(w.parks).toEqual([
          {
            runId: "run_2",
            park: expect.objectContaining({
              reason: "conflict",
            }),
          },
        ]);
        expect(w.parks[0]!.park.detail).toContain(".github/workflows/ci.yml");
        expect(w.notices.at(-1)).toMatchObject({ code: COLLISION_NOTICES.unwritable });
        expect(await tipOf(w, w.b)).toBe(byHand);
        expect(w.copies).toEqual([]);
        expect(w.recorded).toEqual([]);
        expect(w.told).toEqual([]);
      }));

    it("parks the story when the push after the merge is rejected", () =>
      inWorld(async (w) => {
        const { before, onto } = await overlapAndMerge(w);
        // The remote branch gets a commit the local branch lacks.
        const tree = (await w.repo.git("rev-parse", `${before}^{tree}`)).trim();
        const remoteOnly = (
          await w.repo.git("commit-tree", tree, "-p", before, "-m", "Pushed from elsewhere")
        ).trim();
        await w.repo.git("push", "--quiet", "origin", `${remoteOnly}:refs/heads/${w.b.run.branch}`);
        await w.collisions.check();
        const tip = await tipOf(w, w.b);
        expect((await w.repo.git("rev-list", "--parents", "-n", "1", tip)).trim()).toBe(
          `${tip} ${before} ${onto}`,
        );
        expect(await tipOf(w, w.b, "remote")).toBe(remoteOnly);
        expect(w.parks).toEqual([
          {
            runId: "run_2",
            park: expect.objectContaining({
              reason: "conflict",
            }),
          },
        ]);
        expect(w.told.some((t) => t.text.includes("merged main into your branch"))).toBe(false);
      }));

    it("parks the story when its branch moves between the plan and the move", () =>
      inWorld(async (w) => {
        const { before } = await overlapAndMerge(w);
        let elsewhere = "";
        w.onCopy = async () => {
          const tree = (await w.repo.git("rev-parse", `${before}^{tree}`)).trim();
          elsewhere = (await w.repo.git("commit-tree", tree, "-p", before, "-m", "Moved")).trim();
          await w.repo.git("update-ref", `refs/heads/${w.b.run.branch}`, elsewhere);
        };
        await w.collisions.check();
        expect(await tipOf(w, w.b)).toBe(elsewhere);
        expect(w.parks).toEqual([
          { runId: "run_2", park: expect.objectContaining({ reason: "conflict" }) },
        ]);
        expect(w.notices.at(-1)!.text).toContain(`the branch ${w.b.run.branch} moved`);
      }));
  });

  describe("the sync before In Review on real git (DIPO-149)", () => {
    it("merges a base that changed none of the story's files only for a riskier story, and records it", () =>
      inWorld(async (w) => {
        write(w.a.work, { "src/a.ts": "a\n" });
        await handPart(w, w.a, "A adds a");
        write(w.b.work, { "src/b.ts": "b\n" });
        await handPart(w, w.b, "B adds b");
        const before = await tipOf(w, w.b);
        const onto = await mergeFirst(w);
        expect(await syncB(w, "onConflict")).toEqual({ kind: "none" });
        expect(await tipOf(w, w.b)).toBe(before);

        const synced = await syncB(w, "always");
        expect(synced.kind).toBe("merged");
        if (synced.kind !== "merged") return;
        expect(synced.item).toBeNull();
        const tip = await tipOf(w, w.b);
        expect(synced.head).toBe(tip);
        expect((await w.repo.git("rev-list", "--parents", "-n", "1", tip)).trim()).toBe(
          `${tip} ${before} ${onto}`,
        );
        expect(await tipOf(w, w.b, "remote")).toBe(tip);
        expect(readFileSync(join(w.b.work, "src/a.ts"), "utf8")).toBe("a\n");
        expect(w.recorded).toEqual([
          { base: "main", onto, tip: before, commit: tip, conflicts: [], taskFile: null },
        ]);
        expect(w.notices.at(-1)).toEqual({
          level: "info",
          code: COLLISION_NOTICES.caughtUp,
          text: `dipo merged main at ${onto.slice(0, 12)} into DIPO-2's branch and box before review: a story of tier L or flagged test-before-merge always syncs with its base.`,
        });
        // The caller tells the worker, not the sync.
        expect(w.told).toEqual([]);
        expect(await syncB(w, "always")).toEqual({ kind: "none" });
      }));

    it("leaves a clean overlap for later unless the story is riskier", () =>
      inWorld(async (w) => {
        const { before } = await overlapAndMerge(w);
        expect(await syncB(w, "onConflict")).toEqual({ kind: "none" });
        expect(await tipOf(w, w.b)).toBe(before);
        expect(w.copies).toEqual([]);
      }));

    it("commits a conflict as git left it, copies it into the box and hands back one conflict item", () =>
      inWorld(async (w) => {
        const { before, onto } = await conflictAndMerge(w);
        const synced = await syncB(w, "onConflict");
        expect(synced.kind).toBe("merged");
        if (synced.kind !== "merged" || synced.item === null) throw new Error("no conflict item");
        const tip = await tipOf(w, w.b);
        expect((await w.repo.git("rev-list", "--parents", "-n", "1", tip)).trim()).toBe(
          `${tip} ${before} ${onto}`,
        );
        expect(synced.merged.conflicts).toEqual([{ path: "src/shared.ts", kind: "content" }]);
        expect(w.recorded).toEqual([synced.merged]);
        expect(synced.item.signature).toBe(conflictSignature(onto, ["src/shared.ts"]));
        expect(synced.item.text).toContain("Conflicted files: content: src/shared.ts");
        expect(synced.item.text).toContain("--- src/shared.ts (lines 2-10)");
        expect(synced.item.text).toContain("FOUR from one");
        expect(synced.item.text).toContain("FOUR from two");
        expect(readFileSync(join(w.b.work, "src/shared.ts"), "utf8")).toContain("<<<<<<< ");
        expect(w.told).toEqual([]);
        // The markers on the tip, read from git objects; a heading underline elsewhere is none.
        write(w.b.work, { "README.md": "# Collisions\n========\n" });
        await handPart(w, w.b, "A heading");
        const head = await tipOf(w, w.b);
        const read = (paths: string[]) => w.git.run((session) => markersAt(session, head, paths));
        expect([...(await read(["src/shared.ts", "README.md", "src/gone.ts"])).entries()]).toEqual([
          ["src/shared.ts", [4, 6, 8]],
        ]);
        // Resolved in the box and handed as a part: no marker is left.
        write(w.b.work, { "src/shared.ts": lines({ 3: "FOUR from one and two" }) });
        await handPart(w, w.b, "Resolve the conflict");
        const resolved = await tipOf(w, w.b);
        expect(
          (await w.git.run((session) => markersAt(session, resolved, ["src/shared.ts"]))).size,
        ).toBe(0);
      }));

    it("finds a conflict of a story In Review, merges nothing, and finds no clean overlap", () =>
      inWorld(async (w) => {
        const { before, onto } = await conflictAndMerge(w);
        w.reviewing.add(w.b.run.runId);
        w.inReview = [w.b.run];
        await w.collisions.check();
        expect(w.found).toEqual([
          {
            runId: "run_2",
            found: {
              base: "main",
              onto,
              tip: before,
              conflicts: [{ path: "src/shared.ts", kind: "content" }],
            },
          },
        ]);
        expect(await tipOf(w, w.b)).toBe(before);
        expect(w.copies).toEqual([]);
        expect(w.told).toEqual([]);
        expect(w.parks).toEqual([]);
      }));

    it("finds nothing for a story In Review whose overlap merges cleanly", () =>
      inWorld(async (w) => {
        await overlapAndMerge(w);
        w.reviewing.add(w.b.run.runId);
        w.inReview = [w.b.run];
        await w.collisions.check();
        expect(w.found).toEqual([]);
        expect(w.copies).toEqual([]);
      }));

    it("tells the worker of a conflict caught up while it works the hunks as git left them", () =>
      inWorld(async (w) => {
        await conflictAndMerge(w);
        await w.collisions.check();
        const message = w.told.at(-1)!.text;
        expect(message).toStartWith("dipo: fix round.");
        expect(message).toContain("The conflicts as git left them:\n<diff>\n--- src/shared.ts");
        expect(message).toContain("dipo does not move the story to review while a conflict marker");
        expect(w.recorded.map((merged) => merged.conflicts.length)).toEqual([1]);
      }));
  });

  describe("the review fixes of DIPO-149 on real git", () => {
    it("reads markers in a file with a NUL byte, and counts a lone ======= only beside a side marker", () =>
      inWorld(async (w) => {
        write(w.b.work, {
          "src/binary.ts": `one\n<<<<<<< ours\na\0b\n=======\nc\n>>>>>>> main\n`,
          "docs/title.md": "Title\n=======\n\ntext\n",
        });
        await handPart(w, w.b, "Files with and without markers");
        const head = await tipOf(w, w.b);
        const found = await w.git.run((session) =>
          markersAt(session, head, ["src/binary.ts", "docs/title.md"]),
        );
        expect([...found.entries()]).toEqual([["src/binary.ts", [2, 4, 6]]]);
        expect(countedMarkers([{ n: 2, text: "=======" }])).toEqual([]);
        expect(
          countedMarkers([
            { n: 2, text: "=======" },
            { n: 4, text: ">>>>>>> main" },
          ]),
        ).toEqual([2, 4]);
      }));

    it("checks a story In Review once per tip and base, and clears a conflict a later check does not find", () =>
      inWorld(async (w) => {
        const { onto } = await conflictAndMerge(w);
        w.reviewing.add(w.b.run.runId);
        w.inReview = [w.b.run];
        await w.collisions.check();
        await w.collisions.check();
        expect(w.found).toHaveLength(1);
        expect(w.cleared).toEqual([]);
        // The branch takes the base's line by hand: the next check finds no conflict.
        await w.repo.git("checkout", "--quiet", w.b.run.branch);
        write(w.repo.dir, { "src/shared.ts": lines({ 3: "FOUR from one" }) });
        await w.repo.commitAll("Take the base's line");
        await w.repo.git("checkout", "--quiet", "main");
        await w.collisions.check();
        expect(w.found).toHaveLength(1);
        expect(w.cleared).toEqual(["run_2"]);
        expect(onto).not.toBe("");
      }));

    it("installs the packages in the box again after a catch-up changed a lockfile", () =>
      inWorld(async (w) => {
        write(w.a.work, { "src/shared.ts": lines({ 0: "ONE" }), "bun.lock": "{ lock: 2 }\n" });
        await handPart(w, w.a, "A changes shared and the lockfile");
        write(w.b.work, { "src/shared.ts": lines({ 7: "EIGHT" }) });
        await handPart(w, w.b, "B changes shared");
        await mergeFirst(w);
        await w.collisions.check();
        expect(w.parks).toEqual([]);
        expect(readFileSync(join(w.b.work, "bun.lock"), "utf8")).toBe("{ lock: 2 }\n");
        expect(w.reinstalls).toEqual([{ runId: "run_2", lockfiles: ["bun.lock"] }]);
      }));

    it("finds a conflict at the sync in a file the story changed before its start commit", () =>
      inWorld(async (w) => {
        // A re-claimed branch: its earlier work lies below the run's start commit, so the files the
        // story changed since its start do not overlap the base, but git's merge still conflicts.
        write(w.a.work, { "src/shared.ts": lines({ 3: "FOUR from one" }) });
        await handPart(w, w.a, "A changes line four");
        await w.repo.git("checkout", "--quiet", w.b.run.branch);
        write(w.repo.dir, { "src/shared.ts": lines({ 3: "FOUR from the earlier run" }) });
        const earlier = await w.repo.commitAll("The earlier run's work");
        await w.repo.git("checkout", "--quiet", "main");
        await mergeFirst(w);
        const reclaimed = { ...w.b.run, startSha: earlier };
        write(w.b.work, { "src/shared.ts": lines({ 3: "FOUR from the earlier run" }) });
        const synced = await w.parts.inTurn(reclaimed.runId, () =>
          w.collisions.syncInTurn(reclaimed, "onConflict"),
        );
        expect(synced.kind).toBe("merged");
        if (synced.kind === "merged") {
          expect(synced.merged.conflicts).toEqual([{ path: "src/shared.ts", kind: "content" }]);
        }
      }));
  });

  describe("the merge of a resumed conflict park on real git (DIPO-324)", () => {
    it("lets no part meet a rejected push again: the resume merges the remote outside the box, the box gets it first, and a part pushes", () =>
      inWorld(async (w) => {
        write(w.b.work, { "src/b.ts": "b\n" });
        await handPart(w, w.b, "B adds b");
        const remoteOnly = await pushedElsewhere(w, w.b, { "src/remote.ts": "remote\n" });
        // A part on top of the old tip: its push is rejected, as the park recorded.
        write(w.b.work, { "src/b2.ts": "b2\n" });
        await handPart(w, w.b, "B adds b2");
        expect(w.parks.at(-1)?.park.detail).toContain(
          "the remote branch has commits the story branch lacks",
        );
        w.parks.length = 0;
        const local = await tipOf(w, w.b);
        // The resume (`ConflictResumes`): the remote merged into the branch in dipo's git and
        // pushed, never forced; the box copy waits for the session's start.
        const tree = (await w.repo.git("merge-tree", "--write-tree", local, remoteOnly))
          .trim()
          .split("\n")[0]!;
        const merge = (
          await w.repo.git("commit-tree", tree, "-p", local, "-p", remoteOnly, "-m", "Merge")
        ).trim();
        await w.repo.git("update-ref", `refs/heads/${w.b.run.branch}`, merge, local);
        await w.repo.git("push", "--quiet", "origin", w.b.run.branch);
        w.behind.set(w.b.run.runId, "the box lacks dipo's merge");
        // A part handed before the box got the merge is refused, never taken against the merge.
        write(w.b.work, { "src/early.ts": "early\n" });
        await handPart(w, w.b, "An early part");
        expect(w.parks.map((p) => p.park.reason)).toEqual(["conflict"]);
        expect(await tipOf(w, w.b)).toBe(merge);
        w.parks.length = 0;
        // The session's start copies the merge in; then the part commits on it and pushes.
        await w.collisions.copyPending(w.b.run, local);
        w.behind.delete(w.b.run.runId);
        expect(readFileSync(join(w.b.work, "src/remote.ts"), "utf8")).toBe("remote\n");
        await handPart(w, w.b, "The part after the copy");
        expect(w.parks).toEqual([]);
        const tip = await tipOf(w, w.b);
        expect((await w.repo.git("rev-parse", `${tip}^`)).trim()).toBe(merge);
        expect(await tipOf(w, w.b, "remote")).toBe(tip);
        expect((await w.repo.git("show", `${tip}:src/remote.ts`)).trim()).toBe("remote");
        expect((await w.repo.git("show", `${tip}:src/early.ts`)).trim()).toBe("early");
      }));

    it("merges the base again whenever it moved, without an overlap, and hands back a conflict", () =>
      inWorld(async (w) => {
        write(w.b.work, { "src/b.ts": "b\n" });
        await handPart(w, w.b, "B adds b");
        const before = await tipOf(w, w.b);
        const onto = await onBase(w, { "docs/elsewhere.md": "elsewhere\n" });
        const clean = await w.collisions.mergeOnResume(w.b.run);
        expect(clean.kind).toBe("merged");
        if (clean.kind !== "merged") return;
        expect((await w.repo.git("rev-list", "--parents", "-n", "1", clean.head)).trim()).toBe(
          `${clean.head} ${before} ${onto}`,
        );
        expect(readFileSync(join(w.b.work, "docs/elsewhere.md"), "utf8")).toBe("elsewhere\n");

        const { onto: conflicting } = await conflictAndMerge(w);
        const conflicted = await w.collisions.mergeOnResume(w.b.run);
        expect(conflicted.kind).toBe("merged");
        if (conflicted.kind !== "merged" || conflicted.item === null) throw new Error("no item");
        expect(conflicted.merged.onto).toBe(conflicting);
        expect(conflicted.item.text).toContain("Conflicted files: content: src/shared.ts");
        expect(readFileSync(join(w.b.work, "src/shared.ts"), "utf8")).toContain("<<<<<<< ");
        // The caller tells the worker.
        expect(w.told).toEqual([]);
      }));

    it("parks nothing itself and reports a stopped run", () =>
      inWorld(async (w) => {
        w.reviewing.add(w.b.run.runId);
        expect(await w.collisions.mergeOnResume(w.b.run)).toEqual({ kind: "stopped" });
        expect(w.parks).toEqual([]);
      }));
  });

  describe("a merge dipo committed on the branch outside the box (DIPO-324)", () => {
    it("copies what the branch got outside the box into it, and leaves the branch where it is", () =>
      inWorld(async (w) => {
        write(w.b.work, { "src/b.ts": "b\n" });
        await handPart(w, w.b, "B adds b");
        await onBase(w, { "docs/notes.md": "notes\n" });
        const { from, merge } = await slotMerge(w, w.b);
        expect(existsSync(join(w.b.work, "docs/notes.md"))).toBe(false);
        const copied = await w.collisions.copyPending(w.b.run, from);
        expect(copied.written).toEqual(["docs/notes.md"]);
        expect(readFileSync(join(w.b.work, "docs/notes.md"), "utf8")).toBe("notes\n");
        expect(await tipOf(w, w.b)).toBe(merge);
        expect(w.copies).toEqual([w.b.run.box]);
        // Nothing left to copy: no box call.
        expect((await w.collisions.copyPending(w.b.run, merge)).written).toEqual([]);
        expect(w.copies).toEqual([w.b.run.box]);
        // The worker's next part keeps what the base added.
        write(w.b.work, { "src/b.ts": "b2\n" });
        await handPart(w, w.b, "B changes b");
        const tip = await tipOf(w, w.b);
        expect((await w.repo.git("show", `${tip}:docs/notes.md`)).trim()).toBe("notes");
      }));

    it("removes deleted and renamed paths, writes added and binary files, and leaves backlog/ out", () =>
      inWorld(async (w) => {
        write(w.b.work, { "src/b.ts": "b\n" });
        await handPart(w, w.b, "B adds b");
        // The base deletes a file, renames another, adds a binary file and changes the backlog.
        const logo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0x00, 0x0a]);
        rmSync(join(w.repo.dir, "src/old.ts"));
        rmSync(join(w.repo.dir, "README.md"));
        mkdirSync(join(w.repo.dir, "assets"), { recursive: true });
        writeFileSync(join(w.repo.dir, "assets/logo.png"), logo);
        await onBase(w, {
          "docs/README.md": "# Collisions\n",
          "backlog/tasks/dipo-1 - One.md": "---\nid: DIPO-1\nstatus: Done\n---\n",
        });
        const { from } = await slotMerge(w, w.b);
        const copied = await w.collisions.copyPending(w.b.run, from);
        expect([...copied.written].toSorted()).toEqual(["assets/logo.png", "docs/README.md"]);
        expect([...copied.removed].toSorted()).toEqual(["README.md", "src/old.ts"]);
        expect(existsSync(join(w.b.work, "src/old.ts"))).toBe(false);
        expect(existsSync(join(w.b.work, "README.md"))).toBe(false);
        expect(readFileSync(join(w.b.work, "docs/README.md"), "utf8")).toBe("# Collisions\n");
        expect(readFileSync(join(w.b.work, "assets/logo.png")).equals(logo)).toBe(true);
        // dipo's own task-file commits never reach the box: backlog/ stays as the box got it.
        expect(readFileSync(join(w.b.work, "backlog/tasks/dipo-1 - One.md"), "utf8")).toContain(
          "status: Ready",
        );
        expect(readFileSync(join(w.b.work, "src/b.ts"), "utf8")).toBe("b\n");
      }));

    it("throws when the copy fails, and the box keeps its files", () =>
      inWorld(async (w) => {
        await onBase(w, { "docs/notes.md": "notes\n" });
        const { from } = await slotMerge(w, w.b);
        w.failCopy = true;
        await expect(w.collisions.copyPending(w.b.run, from)).rejects.toThrow("the box is gone");
        expect(existsSync(join(w.b.work, "docs/notes.md"))).toBe(false);
      }));

    it("takes no part while the box lacks the merge, and parks the story instead", () =>
      inWorld(async (w) => {
        await onBase(w, { "docs/notes.md": "notes\n" });
        const { merge } = await slotMerge(w, w.b);
        w.behind.set(w.b.run.runId, "the box lacks dipo's merge");
        write(w.b.work, { "src/b.ts": "b\n" });
        await handPart(w, w.b, "B adds b");
        expect(w.parks).toEqual([
          {
            runId: w.b.run.runId,
            park: {
              reason: "conflict",
              detail: "the box lacks dipo's merge",
            },
          },
        ]);
        // Nothing was committed against the merged tip: the base's file is still on the branch.
        expect(await tipOf(w, w.b)).toBe(merge);
      }));
  });
}
