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
  backlogConflictNotice,
  BoxCollisions,
  CATCH_UP_CAUSES,
  CATCH_UP_PART_MESSAGE,
  catchUpMessage,
  catchUpNotice,
  COLLISION_NOTICES,
  type CollisionNotice,
  type ConflictFile,
  conflictSummary,
  findOverlaps,
  overlapMessage,
  overlapNotice,
  overlappingPaths,
  overlapSignature,
  parseBoxChanges,
  parseMergeTree,
  pathsOverlap,
  SHOWN_PATHS_MAX,
  shownPaths,
  storyChangedFiles,
} from "../../src/box/collisions";
import { BoxParts, type PartPark, type PartRun } from "../../src/box/parts";
import type { BoxPort } from "../../src/box/port";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";

const TREE = "a".repeat(40);

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

  it("says that a backlog conflict merged no code either", () => {
    expect(backlogConflictNotice("DIPO-2", "main", ["backlog/tasks/dipo-2 - Two.md"])).toContain(
      "dipo merged nothing: the base's code changes were not merged into the branch or the box either",
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
  failCopy: boolean;
  /** Runs before each stream out of a box, with how many streams that box gave so far. */
  onStream: ((box: string, n: number) => void) | null;
  /** Runs when the merge is copied into a box, before it is. */
  onCopy: (() => Promise<void>) | null;
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
    copyIn: async (box, from, to) => {
      if (w().failCopy) throw new Error("the box is gone");
      await w().onCopy?.();
      expect(to).toBe("/work");
      expect(from).toEndWith("/.");
      w().copies.push(box);
      cpSync(from.slice(0, -2), folder(box), { recursive: true, force: true });
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
    tmpRoot: realpathSync(tmp),
    run: (runId) => runs.get(runId) ?? null,
    git: (office) => (office === OFFICE ? git : undefined),
    live: (runId) => !parks.some((p) => p.runId === runId),
    park: (runId, park) => {
      parks.push({ runId, park });
      return true;
    },
  });
  const collisions = new BoxCollisions({
    boxes,
    code: { spawn: systemSpawn, clock },
    tmpRoot: realpathSync(tmp),
    runs: () => [...runs.values()],
    git: (office) => (office === OFFICE ? git : undefined),
    live: (runId) => !parks.some((p) => p.runId === runId),
    parts,
    park: (runId, park) => {
      parks.push({ runId, park });
      return true;
    },
    tell: async (runId, text) => {
      told.push({ runId, text });
    },
    notice: (_office, _runId, notice) => notices.push(notice),
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
    failCopy: false,
    onStream: null,
    onCopy: null,
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
      const parents = (await w.repo.git("rev-list", "--parents", "-n", "1", tip)).trim().split(" ");
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
          park: expect.objectContaining({ reason: "conflict", cause: CATCH_UP_CAUSES.failed }),
        },
      ]);
      expect(w.notices.at(-1)).toMatchObject({ code: COLLISION_NOTICES.failed });
      // A parked run is no longer in progress: the next pass does not touch it.
      await w.collisions.check();
      expect(w.parks).toHaveLength(1);
    }));
});

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

  it("fails the catch-up when an export attribute drops a merged file from the archive", () =>
    inWorld(async (w) => {
      await onBase(w, { ".gitattributes": "src/a.ts export-ignore\n" });
      const { before } = await overlapAndMerge(w);
      await w.collisions.check();
      expect(await tipOf(w, w.b)).toBe(before);
      expect(w.parks).toEqual([
        { runId: "run_2", park: expect.objectContaining({ cause: CATCH_UP_CAUSES.failed }) },
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
        { runId: "run_2", park: expect.objectContaining({ cause: CATCH_UP_CAUSES.failed }) },
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

  it("tells a backlog conflict to the maintainer only, once per base commit", () =>
    inWorld(async (w) => {
      // The base and the branch both changed the second story's task file.
      await onBase(w, { "backlog/tasks/dipo-2 - Two.md": "---\nid: DIPO-2\nstatus: Done\n---\n" });
      const { before } = await overlapAndMerge(w);
      await w.collisions.check();
      expect(w.notices).toEqual([
        expect.objectContaining({ code: COLLISION_NOTICES.backlogConflict }),
      ]);
      expect(w.notices[0]!.text).toContain("dipo merged nothing");
      expect(w.notices[0]!.text).toContain("backlog/tasks/dipo-2 - Two.md");
      expect(w.told).toEqual([]);
      expect(w.parks).toEqual([]);
      expect(await tipOf(w, w.b)).toBe(before);
      expect(w.copies).toEqual([]);
      await w.collisions.check();
      expect(w.notices).toHaveLength(1);
      // A new base commit is a new try, and told again.
      await onBase(w, { "README.md": "# Collisions, again\n" });
      await w.collisions.check();
      expect(w.notices).toHaveLength(2);
      expect(w.notices[1]!.code).toBe(COLLISION_NOTICES.backlogConflict);
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
            cause: CATCH_UP_CAUSES.pushRejected,
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
        { runId: "run_2", park: expect.objectContaining({ cause: CATCH_UP_CAUSES.failed }) },
      ]);
      expect(w.notices.at(-1)!.text).toContain(`the branch ${w.b.run.branch} moved`);
    }));
});
