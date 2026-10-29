// Changed files and collisions of box runs (DIPO-277, 0021 section 12): the prefix rule, the texts,
// git's output and the conflict item read as data, and on real git the guard that runs no merge
// driver. The rest of the flow on real git with a bare remote is in collisions.ci.test.ts (CI only,
// DIPO-225).

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
  catchUpMessage,
  catchUpNotice,
  changedLockfiles,
  COLLISION_NOTICES,
  CONFLICT_MARKER,
  conflictFeedbackItem,
  conflictSignature,
  type CollisionNotice,
  type ConflictFile,
  conflictSummary,
  fileHunks,
  findOverlaps,
  hunksWithin,
  markerLines,
  markersLeftText,
  overlapMessage,
  overlapNotice,
  overlappingPaths,
  overlapSignature,
  parseBoxChanges,
  parseMergeTree,
  pathsOverlap,
  SHOWN_PATHS_MAX,
  shownPaths,
  unwritableNotice,
} from "../../src/box/collisions";
import { taskFileStatus } from "../../src/backlog/task-file";
import { BoxParts, type PartPark, type PartRun } from "../../src/box/parts";
import type { BoxPort } from "../../src/box/port";
import { BOX_STAGE_ROOT } from "../../src/box/user";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import { backlogLayout } from "../story-store/backlog";

const TREE = "a".repeat(40);

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
    stories: backlogLayout,
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
    stories: backlogLayout,
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

/** Both stories change `src/shared.ts` in lines apart, then the first merges. */
async function overlapAndMerge(w: World): Promise<{ before: string; onto: string }> {
  write(w.a.work, { "src/shared.ts": lines({ 0: "ONE" }), "src/a.ts": "a\n" });
  await handPart(w, w.a, "A changes shared");
  write(w.b.work, { "src/shared.ts": lines({ 7: "EIGHT" }) });
  await handPart(w, w.b, "B changes shared");
  const before = await tipOf(w, w.b);
  return { before, onto: await mergeFirst(w) };
}

// ---- the sync before In Review and the check In Review (DIPO-149) ----------------------------------

describe("the prefix rule", () => {
  it("matches a path, and a folder above a path, never a shared name start", () => {
    expect(pathsOverlap("src/a.ts", "src/a.ts")).toBe(true);
    expect(pathsOverlap("src", "src/a.ts")).toBe(true);
    expect(pathsOverlap("src/a.ts", "src")).toBe(true);
    expect(pathsOverlap("src/a.ts", "src/a.tsx")).toBe(false);
    expect(pathsOverlap("src/a", "src/ab/c.ts")).toBe(false);
    expect(
      overlappingPaths(["src/a.ts", "docs/x.md", "lib"], ["src/a.ts", "lib/y.ts", "doc"]),
    ).toEqual(["lib", "src/a.ts"]);
  });

  it("finds each overlapping pair once, with the paths of both sides", () => {
    const overlaps = findOverlaps([
      { runId: "run_a", story: "DIPO-1", files: ["src/shared.ts", "src/a.ts"] },
      { runId: "run_b", story: "DIPO-2", files: ["src/shared.ts", "src/b.ts"] },
      { runId: "run_c", story: "DIPO-3", files: ["docs/c.md"] },
      { runId: "run_d", story: "DIPO-4", files: ["src"] },
    ]);
    expect(overlaps.map((o) => [o.a.story, o.b.story, o.paths])).toEqual([
      ["DIPO-1", "DIPO-2", ["src/shared.ts"]],
      ["DIPO-1", "DIPO-4", ["src", "src/a.ts", "src/shared.ts"]],
      ["DIPO-2", "DIPO-4", ["src", "src/b.ts", "src/shared.ts"]],
    ]);
    const [first] = overlaps;
    // The same overlap seen from the other side is the same overlap.
    expect(overlapSignature({ ...first!, a: first!.b, b: first!.a })).toBe(
      overlapSignature(first!),
    );
  });
});

describe("the texts", () => {
  it("names both stories and the files, cleaned and counted past the limit", () => {
    const overlap = {
      a: { runId: "run_a", story: "DIPO-1" },
      b: { runId: "run_b", story: "DIPO-2" },
      paths: ["src/shared.ts"],
    };
    expect(overlapNotice(overlap)).toBe(
      "DIPO-1 and DIPO-2 are both in progress and change the same 1 file: src/shared.ts. Both continue; when one merges, dipo merges the new base into the other's branch and box.",
    );
    expect(overlapMessage("DIPO-1", ["src/shared.ts"])).toContain(
      "another story in progress, DIPO-1, changes the same 1 file as you: src/shared.ts. Both stories continue.",
    );
    const many = Array.from({ length: SHOWN_PATHS_MAX + 3 }, (_, n) => `f${n}.ts`);
    expect(shownPaths(many)).toEndWith("f19.ts and 3 more");
    expect(shownPaths(["a\u001b[2J.ts"])).toBe("a.ts");
  });

  it("tells a clean catch-up and a fix round apart", () => {
    const facts = {
      story: "DIPO-2",
      base: "main",
      onto: "b".repeat(40),
      overlap: ["src/shared.ts"],
      conflicts: [] as ConflictFile[],
      written: 2,
      removed: 1,
    };
    expect(catchUpNotice(facts)).toBe(
      `dipo merged main at ${"b".repeat(12)} into DIPO-2's branch and box: the base changed 1 file the story changed too (src/shared.ts).`,
    );
    expect(catchUpMessage(facts)).toContain("2 files written, 1 file removed");
    const conflict = {
      ...facts,
      conflicts: [{ path: "src/shared.ts", kind: "content" as const }],
    };
    expect(catchUpNotice(conflict)).toBe(
      `1 file conflicted when git merged main at ${"b".repeat(12)} into DIPO-2's branch (content: src/shared.ts). dipo committed the merge as git left it, copied it into the box, and gave the worker a fix round.`,
    );
    expect(catchUpMessage(conflict)).toStartWith(
      "dipo: fix round. main changed files your story changes too, and 1 file conflicted when git merged main into your branch: content: src/shared.ts.",
    );
    expect(catchUpMessage(conflict)).toContain("conflict markers (<<<<<<<, =======, >>>>>>>)");
    expect(catchUpMessage(conflict)).toContain("hand a part with dipo-part");
    // Markers are named only for a content conflict.
    const binary = {
      ...facts,
      conflicts: [
        { path: "logo.png", kind: "binary" as const },
        { path: "src/gone.ts", kind: "deleted" as const },
        { path: "lib", kind: "folder" as const },
      ],
    };
    expect(conflictSummary(binary.conflicts)).toBe(
      "binary: logo.png; file vs folder: lib; modify/delete: src/gone.ts",
    );
    expect(catchUpMessage(binary)).not.toContain("markers");
    expect(catchUpMessage(binary)).toContain("kept your version");
    expect(catchUpMessage(binary)).toContain("decide whether the file stays");
    expect(catchUpMessage(binary)).toContain("a file and a folder share one name");
  });

  it("says that a conflict the worker cannot resolve merged nothing and parked the story", () => {
    expect(unwritableNotice("DIPO-2", "main", [".github/workflows/ci.yml"])).toBe(
      "git could not merge main into DIPO-2's branch cleanly, and the conflict is in 1 file the worker cannot write (.github/workflows/ci.yml). dipo merged nothing, into neither the branch nor the box, and parked DIPO-2: resolve the conflict on the base or the branch by hand, then resume the story.",
    );
  });
});

describe("git's output, as data", () => {
  it("reads the tree and the conflicted files of merge-tree", () => {
    expect(parseMergeTree(`${TREE}\0`)).toEqual({ tree: TREE, conflicts: [] });
    const messages = [
      TREE,
      "src/b.ts",
      "src/a.ts",
      "logo.png",
      "lib~s",
      "gone.ts",
      "",
      "1",
      "src/a.ts",
      "Auto-merging",
      "Auto-merging src/a.ts\n",
      "1",
      "src/a.ts",
      "CONFLICT (contents)",
      "CONFLICT (content): Merge conflict in src/a.ts\n",
      "1",
      "logo.png",
      "CONFLICT (binary)",
      "warning: Cannot merge binary files: logo.png\n",
      "1",
      "logo.png",
      "CONFLICT (contents)",
      "CONFLICT (content): Merge conflict in logo.png\n",
      "2",
      "lib~s",
      "lib",
      "CONFLICT (file/directory)",
      "CONFLICT (file/directory): directory in the way of lib from s; moving it to lib~s instead.\n",
      "1",
      "lib~s",
      "CONFLICT (modify/delete)",
      "CONFLICT (modify/delete): lib~s deleted in main and modified in s.\n",
      "1",
      "gone.ts",
      "CONFLICT (modify/delete)",
      "CONFLICT (modify/delete): gone.ts deleted in s and modified in main.\n",
      "",
    ].join("\0");
    expect(parseMergeTree(messages)).toEqual({
      tree: TREE,
      conflicts: [
        { path: "gone.ts", kind: "deleted" },
        { path: "lib~s", kind: "folder" },
        { path: "logo.png", kind: "binary" },
        { path: "src/a.ts", kind: "content" },
        { path: "src/b.ts", kind: "other" },
      ],
    });
    expect(() => parseMergeTree("no tree here\0")).toThrow("printed no tree");
  });

  it("writes and removes what the merge changed, never the backlog or a submodule", () => {
    const z = "0".repeat(40);
    const raw = [
      `:100644 100644 ${TREE} ${TREE} M`,
      "src/a.ts",
      `:000000 100644 ${z} ${TREE} A`,
      "src/new.ts",
      `:100644 000000 ${TREE} ${z} D`,
      "src/gone.ts",
      `:100644 100644 ${TREE} ${TREE} M`,
      "backlog/tasks/dipo-2 - Two.md",
      `:100644 160000 ${TREE} ${TREE} T`,
      "vendor/lib",
      "",
    ].join("\0");
    expect(parseBoxChanges(raw)).toEqual({
      written: ["src/a.ts", "src/new.ts"],
      removed: ["src/gone.ts", "vendor/lib"],
    });
  });
});

describe("a catch-up's guards on real git", () => {
  it("runs no merge driver from the config or any attributes file, and calls such a path conflicted", () =>
    inWorld(async (w) => {
      const { before, onto } = await overlapAndMerge(w);
      // Set after the base merged, so only dipo's merge meets them.
      const ran = join(w.repo.root, "driver-ran");
      const attributes = join(w.repo.root, "attributes");
      writeFileSync(attributes, "* merge=evil\n");
      // The maintainer's global config, which dipo's git reads (the test's own git does not).
      const global = join(w.repo.home, ".gitconfig");
      await w.repo.git("config", "--file", global, "merge.evil.driver", `touch ${ran}`);
      await w.repo.git("config", "--file", global, "core.attributesFile", attributes);
      const seen = await w.git.run((session) =>
        session.ok(session.repository, ["config", "--get", "merge.evil.driver"]),
      );
      expect(seen.trim()).toBe(`touch ${ran}`);
      writeFileSync(join(w.repo.dir, ".git/info/attributes"), "src/shared.ts merge=evil\n");

      await w.collisions.check();
      expect(existsSync(ran)).toBe(false);
      expect(w.parks).toEqual([]);
      const tip = await tipOf(w, w.b);
      expect((await w.repo.git("rev-list", "--parents", "-n", "1", tip)).trim()).toBe(
        `${tip} ${before} ${onto}`,
      );
      // The blanked driver leaves git the story's side and a conflict to resolve.
      expect(readFileSync(join(w.b.work, "src/shared.ts"), "utf8")).toBe(lines({ 7: "EIGHT" }));
      expect(w.notices.at(-1)).toMatchObject({ code: COLLISION_NOTICES.conflict });
      expect(w.told.at(-1)!.text).toContain("content: src/shared.ts");
    }));
});

describe("the conflict item and its markers, as data", () => {
  it("names git's own markers only, never a heading underline", () => {
    const text = [
      "a",
      "<<<<<<< ours",
      "b",
      "=======",
      "c",
      ">>>>>>> theirs",
      "Title",
      "========",
      "=======\r",
      "======= not quite",
    ].join("\n");
    expect(markerLines(text)).toEqual([2, 4, 6, 9, 10]);
    expect(CONFLICT_MARKER.test("<<<<<<<")).toBe(false);
  });

  it("cuts the hunks to the item budget and signs over the base commit and the sorted paths", () => {
    const text = ["x", "y", "<<<<<<< a", "1", "=======", "2", ">>>>>>> b", "z", "w", "v"].join(
      "\n",
    );
    const [hunk] = fileHunks("src/a.ts", text);
    expect(hunk).toBe("--- src/a.ts (lines 1-9)\nx\ny\n<<<<<<< a\n1\n=======\n2\n>>>>>>> b\nz\nw");
    expect(hunksWithin([hunk!, hunk!], hunk!.length + 10)).toBe(
      `${hunk!}\n\n[dipo: 1 more conflict hunk not shown; open the files in your box.]`,
    );
    const item = conflictFeedbackItem({
      base: "main",
      onto: "b".repeat(40),
      conflicts: [
        { path: "src/z.ts", kind: "content" },
        { path: "src/a.ts", kind: "content" },
      ],
      hunks: [hunk!],
    });
    expect(item.source).toBe("conflict");
    expect(item.signature).toBe(conflictSignature("b".repeat(40), ["src/a.ts", "src/z.ts"]));
    expect(item.signature).not.toBe(conflictSignature("c".repeat(40), ["src/a.ts", "src/z.ts"]));
    expect(item.text).toContain(`git could not merge main at ${"b".repeat(12)} into your branch`);
    expect(item.text).toContain("Conflicted files: content: src/a.ts, src/z.ts");
    expect(item.text).toContain(hunk!);
    expect(item.text.length).toBeLessThanOrEqual(3_000);
    const small = conflictFeedbackItem({
      base: "main",
      onto: "b".repeat(40),
      conflicts: [{ path: "src/a.ts", kind: "content" }],
      hunks: [hunk!],
      itemMax: 200,
    });
    expect(small.text).toContain("1 more conflict hunk not shown");
    expect(
      markersLeftText(
        new Map([
          ["src/b.ts", [4, 6, 8, 12, 14, 16, 20]],
          ["src/a.ts", [3]],
        ]),
      ),
    ).toContain("- src/a.ts: line 3\n- src/b.ts: lines 4, 6, 8, 12, 14 and 2 more");
  });

  it("reads a task file's status from its front matter", () => {
    expect(taskFileStatus("---\nid: DIPO-2\nstatus: In Progress\n---\nbody")).toBe("In Progress");
    expect(taskFileStatus("---\nid: DIPO-2\nstatus: 'In Review'\n---\n")).toBe("In Review");
    expect(taskFileStatus("---\nid: DIPO-2\n---\nstatus: Done\n")).toBeNull();
    expect(changedLockfiles(["bun.lock", "src/a.ts", "web/package-lock.json"])).toEqual([
      "bun.lock",
      "web/package-lock.json",
    ]);
  });
});
