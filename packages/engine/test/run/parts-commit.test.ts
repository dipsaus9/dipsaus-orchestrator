// Delivery in parts on real git (DIPO-273, 0021 sections 8, 13 and 14): a fake box whose `tar`
// streams a real folder, dipo's stream, extraction, comparison, scans, plumbing commit and push
// to a bare remote in the temp folder. The box ignores dipo's exclude list here, so the Mac's own
// check is what keeps `node_modules` out; the DIPO-290 cases use a box that honours it, as GNU tar
// does.
//
// Only the guard that runs no hook and no filter, and the barriers around the box's own git
// repository (DIPO-346, 0008), stay local; the other cases are in parts-commit.ci.test.ts (CI only,
// DIPO-225), and the rules as data are in box/parts.test.ts. The box's repository here is made by
// dipo's own init script (`boxGitInitCommand`), run on the fake box's folder.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { describe, expect, it } from "bun:test";

import type { OfficeId, Signal } from "@dipsaus-orchestrator/contract";
import {
  ManualClock,
  type TempRepoWithRemote,
  withBareRemote,
} from "@dipsaus-orchestrator/testkit";

import {
  BoxParts,
  type BoxPartsDeps,
  type PartNotice,
  type PartPark,
  type PartRun,
  partStageRoot,
  refusedDetail,
} from "../../src/box/parts";
import { BOX_GIT_ENV, boxGitInitCommand } from "../../src/box/box-git";
import { BOX_WORKDIR } from "../../src/box/code";
import { BOX_RUN_FILE } from "../../src/box/workers";
import { type BoxPort } from "../../src/box/port";
import { OfficeGit, spawnGitExec } from "../../src/git";
import type { GitCall } from "../../src/git/runner";
import { systemSpawn } from "../../src/platform/process";
import { backlogLayout } from "../story-store/backlog";

const OFFICE = "office-parts" as OfficeId;
const BRANCH = "DIPO-1/deliver-in-parts";
const TASK_FILE = "backlog/tasks/dipo-1 - Deliver-in-parts.md";

const START = {
  "README.md": "# Parts\n",
  "src/a.ts": "export const a = 1;\n",
  "src/gone.ts": "export const gone = 1;\n",
  ".gitignore": "node_modules/\n*.log\n",
  ".github/workflows/ci.yml": "name: ci\n",
  [TASK_FILE]: "---\nid: DIPO-1\nstatus: Ready\n---\n",
};

interface World {
  readonly repo: TempRepoWithRemote;
  readonly git: OfficeGit;
  readonly parts: BoxParts;
  /** The box's `/work`: the folder its fake `tar` packs. */
  readonly work: string;
  readonly runDir: string;
  readonly startSha: string;
  /** The tip after dipo's own task-file commit, which never reaches the box. */
  readonly claimTip: string;
  readonly calls: string[];
  readonly parks: PartPark[];
  readonly notices: PartNotice[];
  /** The delivery's clock. */
  readonly clock: ManualClock;
  /** This daemon's folder of part stages, in its state folder. */
  readonly stageRoot: string;
  /** The user the stage folders must belong to (`BoxPartsDeps.uid`). */
  uid: number;
  /** What the base config's `box.files` says now (`BoxPartsDeps.listedFiles`). */
  listed: string[];
  live: boolean;
}

/** How the fake box's `tar` treats dipo's exclude list. */
type TarMode = "all" | "excludes";

/**
 * What one exec in the fake box does besides packing `/work`: `exit` ends it at once with that
 * code and no output; `hold` delays its output until it settles.
 */
type ExecHook = () => { readonly exit?: number; readonly hold?: Promise<unknown> } | void;

/** True for an exclude of what a folder holds (`node_modules/*`). */
function inside(pattern: string): boolean {
  return pattern.endsWith("/*");
}

/** The exclude without its `/*`. */
function bare(pattern: string): string {
  return inside(pattern) ? pattern.slice(0, -2) : pattern;
}

/**
 * The paths below `work` a GNU `tar -C work -cf - --exclude=... .` leaves out: a plain exclude
 * drops every entry of that name at any depth, `./<name>` only the entry at the root, and either
 * ending in `/*` only what a folder of that name holds.
 */
function excluded(work: string, excludes: readonly string[]): (path: string) => boolean {
  const roots = excludes.filter((name) => name.startsWith("./"));
  const names = excludes.filter((name) => !name.startsWith("./"));
  return (path) => {
    const rel = relative(work, path);
    if (rel === "") return false;
    const parent = dirname(rel);
    return (
      names.some((name) =>
        inside(name) ? parent !== "." && basename(parent) === bare(name) : basename(rel) === name,
      ) || roots.some((root) => (inside(root) ? parent : rel) === bare(root).slice(2))
    );
  };
}

/** The `--exclude=` values of a part's archive command. */
function excludesOf(command: readonly string[]): string[] {
  return command.flatMap((arg) =>
    arg.startsWith("--exclude=") ? [arg.slice("--exclude=".length)] : [],
  );
}

/**
 * A box whose exec runs the system `tar` over `work`: whatever exclude list dipo passes (`all`),
 * or honouring it as GNU tar does (`excludes`, from a copy without the excluded entries).
 */
function tarBox(
  work: string,
  calls: string[],
  mode: TarMode = "all",
  onExec: ExecHook = () => {},
): Pick<BoxPort, "execLive" | "stop"> {
  return {
    execLive: (box, command) => {
      calls.push(`exec ${box} ${command.slice(4).join(" ")}`);
      const hook = onExec() ?? {};
      if (hook.exit !== undefined) {
        return {
          stdin: { write: () => {}, end: () => calls.push("stdin end") },
          stdout: new ReadableStream({ start: (controller) => controller.close() }),
          stderr: new ReadableStream({ start: (controller) => controller.close() }),
          exited: Promise.resolve({ code: hook.exit, signal: null }),
          kill: (signal: Signal = "SIGTERM") => calls.push(`kill ${signal}`),
        };
      }
      let from = work;
      if (mode === "excludes") {
        from = mkdtempSync(join(work, "..", "box-tar-"));
        const out = excluded(work, excludesOf(command));
        cpSync(work, from, { recursive: true, verbatimSymlinks: true, filter: (at) => !out(at) });
      }
      const packed = spawnSync("tar", ["-C", from, "-cf", "-", "."], {
        env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" },
        maxBuffer: 64 * 1024 * 1024,
      });
      if (from !== work) rmSync(from, { recursive: true, force: true });
      let finish!: (exit: { code: number | null; signal: Signal | null }) => void;
      const exited = new Promise<{ code: number | null; signal: Signal | null }>((resolve) => {
        finish = resolve;
      });
      const stdout = new ReadableStream<Uint8Array>({
        async start(controller) {
          await hook.hold;
          controller.enqueue(new Uint8Array(packed.stdout));
          controller.close();
          finish({ code: packed.status, signal: null });
        },
      });
      return {
        stdin: { write: () => {}, end: () => calls.push("stdin end") },
        stdout,
        stderr: new ReadableStream({ start: (controller) => controller.close() }),
        exited,
        kill: (signal: Signal = "SIGTERM") => calls.push(`kill ${signal}`),
      };
    },
    stop: async (box) => {
      calls.push(`stop ${box}`);
    },
  };
}

function write(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

interface WorldOptions {
  /** Files of the start commit beside or instead of `START`. */
  readonly start?: Readonly<Record<string, string>>;
  readonly tar?: TarMode;
  /** Writes the box's record of the listed files (`BoxRunRecord.files`) in the run directory. */
  readonly recorded?: readonly string[];
  /** Called on every exec in the box, before it packs `/work` (`ExecHook`). */
  readonly onExec?: (w: World) => ReturnType<ExecHook>;
  readonly deps?: Partial<BoxPartsDeps>;
  /** Every git call dipo makes on the Mac, recorded (DIPO-346). */
  readonly gitCalls?: GitCall[];
}

async function world(repo: TempRepoWithRemote, options: WorldOptions = {}): Promise<World> {
  const start = { ...START, ...options.start };
  write(repo.dir, start);
  const startSha = await repo.commitAll("start");
  await repo.git("branch", BRANCH, startSha);
  // dipo's claim commit of the task file on the story branch: the box never gets it.
  await repo.git("checkout", "--quiet", BRANCH);
  writeFileSync(join(repo.dir, TASK_FILE), "---\nid: DIPO-1\nstatus: In Progress\n---\n");
  const claimTip = await repo.commitAll("DIPO-1: status In Progress");
  await repo.git("push", "--quiet", "origin", BRANCH);
  await repo.git("checkout", "--quiet", "main");
  // The box's code: the start commit as `tar` would find it, plus a file outside git.
  const work = join(repo.root, "box-work");
  write(work, start);
  writeFileSync(join(work, "listed.json"), "{}\n");
  const runDir = join(repo.root, "run");
  mkdirSync(runDir);
  if (options.recorded !== undefined) {
    writeFileSync(
      join(runDir, BOX_RUN_FILE),
      JSON.stringify({
        runId: "run_1",
        office: OFFICE,
        box: "dipo-run_1",
        files: options.recorded,
      }),
    );
  }
  const tmp = join(repo.root, "tmp");
  mkdirSync(tmp);
  const real = realpathSync(repo.dir);
  const git = new OfficeGit({
    officeId: OFFICE,
    mainWorktree: real,
    commonDir: join(real, ".git"),
    settings: { remote: "origin", base: "main" },
    runner: {
      exec: (call) => {
        options.gitCalls?.push(call);
        return spawnGitExec(systemSpawn)(call);
      },
      env: repo.env,
      sleep: async () => {},
    },
    clock: new ManualClock(),
  });
  const calls: string[] = [];
  const parks: PartPark[] = [];
  const run: PartRun = {
    runId: "run_1",
    office: OFFICE,
    story: "DIPO-1",
    branch: BRANCH,
    startSha,
    box: "dipo-run_1",
    runDir,
  };
  const w = {
    repo,
    git,
    work,
    runDir,
    startSha,
    claimTip,
    calls,
    parks,
    notices: [] as PartNotice[],
    clock: new ManualClock(),
    stageRoot: partStageRoot(join(realpathSync(repo.root), "state")),
    uid: process.getuid?.() ?? 0,
    listed: ["listed.json"],
    live: true,
  } as World;
  const parts = new BoxParts({
    stories: backlogLayout,
    boxes: tarBox(work, calls, options.tar, () => options.onExec?.(w)),
    clock: w.clock,
    notice: (_run, notice) => w.notices.push(notice),
    stageRoot: w.stageRoot,
    get uid() {
      return w.uid;
    },
    run: (runId) => (runId === "run_1" ? run : null),
    git: (office) => (office === OFFICE ? git : undefined),
    listedFiles: async () => w.listed,
    live: () => w.live,
    park: (_runId, park) => {
      parks.push(park);
      return true;
    },
    readDoor: (runId) => {
      calls.push(`read door ${runId}`);
      return Promise.resolve(null);
    },
    ...options.deps,
  });
  (w as { parts: BoxParts }).parts = parts;
  return w;
}

/** A door part; `at` is the door read that took it. */
function part(message: string, at = 0) {
  return {
    runId: "run_1",
    box: "dipo-run_1",
    n: 1,
    name: "1700000000-1.part",
    message,
    at,
  };
}

function inParts(fn: (w: World) => Promise<void>, options: WorldOptions = {}): Promise<void> {
  return withBareRemote(async (repo) => fn(await world(repo, options)));
}

async function tip(w: World, where: "local" | "remote" = "local"): Promise<string> {
  const ref = where === "local" ? `refs/heads/${BRANCH}` : `refs/remotes/origin/${BRANCH}`;
  if (where === "remote") await w.repo.git("fetch", "--quiet", "origin");
  return (await w.repo.git("rev-parse", ref)).trim();
}

describe("a part on real git", () => {
  it("runs no hook and no filter of the repository while it commits", () =>
    inParts(async (w) => {
      const marker = join(w.repo.root, "MARKER");
      // A filter every file is said to need, and hooks on every ref update and commit.
      await w.repo.git("config", "filter.evil.clean", `touch ${marker}`);
      await w.repo.git("config", "filter.evil.smudge", `touch ${marker}`);
      const hooks = join(w.repo.dir, ".git", "hooks");
      for (const hook of ["reference-transaction", "post-commit", "pre-commit"]) {
        writeFileSync(join(hooks, hook), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
      }
      writeFileSync(join(w.repo.dir, ".git", "info", "attributes"), "* filter=evil\n");
      write(w.work, { "src/a.ts": "export const a = 3;\n" });
      await w.parts.onPart(part("Under a hostile config"));
      expect(await w.repo.git("show", `${await tip(w)}:src/a.ts`)).toBe("export const a = 3;\n");
      expect(existsSync(marker)).toBe(false);
    }));
});

// ---- the box's own git repository (DIPO-346) -----------------------------------------------------

/** Runs dipo's init script of the box's repository on the fake box's folder, as the box does. */
function initBoxRepo(w: World): void {
  const [shell, flag, script] = boxGitInitCommand();
  const made = spawnSync(shell, [flag, script.replaceAll(`'${BOX_WORKDIR}'`, `'${w.work}'`)], {
    env: { ...w.repo.env, ...BOX_GIT_ENV },
    encoding: "utf8",
  });
  expect(made.stderr).toBe("");
  expect(made.status).toBe(0);
}

/**
 * The box's `.git` folder replaced by a `.git` file with a `gitdir` pointer. The folder is moved
 * out of the box's folder in one rename rather than removed: a recursive removal that leaves part
 * of it behind (seen on CI's macOS runner) would leave a folder where the file must go.
 */
function gitdirFile(w: World): void {
  renameSync(join(w.work, ".git"), mkdtempSync(join(w.repo.root, "box-git-")) + "/git");
  writeFileSync(join(w.work, ".git"), "gitdir: /home/dipo/elsewhere\n");
  expect(lstatSync(join(w.work, ".git")).isFile()).toBe(true);
}

/** git in the box's repository, as the worker would run it there. */
function inBox(w: World, ...args: string[]): string {
  const ran = spawnSync("git", args, { cwd: w.work, env: w.repo.env, encoding: "utf8" });
  expect(ran.status).toBe(0);
  return ran.stdout;
}

/** What the Mac repository holds that the box must never reach: its config, refs and hooks. */
async function macState(w: World): Promise<string> {
  const config = await w.repo.git("config", "--local", "--list");
  const refs = (await w.repo.git("for-each-ref", "--format=%(refname) %(objectname)"))
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith(`refs/heads/${BRANCH} `) &&
        !line.startsWith(`refs/remotes/origin/${BRANCH} `),
    )
    .join("\n");
  const hooks = readdirSync(join(w.repo.dir, ".git", "hooks"))
    .toSorted()
    .join(",");
  return [config, refs, hooks].join("\n--\n");
}

/** Every path a commit holds. */
async function pathsAt(w: World, commit: string): Promise<string[]> {
  return (await w.repo.git("ls-tree", "-r", "--name-only", commit))
    .split("\n")
    .filter((line) => line !== "");
}

/** The kind a park names. */
function parkedFor(w: World): string[] {
  return w.parks.map((park) => `${park.reason}: ${park.detail}`);
}

const GIT_FOLDER_PARK =
  "scope-violation: The part the worker delivered changes protected files: git's own folder (.git). dipo committed and pushed nothing, and the change stays in the box. Only dipo or the maintainer writes these files.";
const LINK_PARK =
  "scope-violation: The part the worker delivered changes protected files: a symlink or hard link. dipo committed and pushed nothing, and the change stays in the box. Only dipo or the maintainer writes these files.";

describe("the box's own git repository and the parts (DIPO-346)", () => {
  it("delivers a part without the box's .git: the box's commits, config and hooks stay in the box", () =>
    inParts(
      async (w) => {
        const before = await macState(w);
        initBoxRepo(w);
        // The worker uses its repository as it likes: commits, a hook, a hooks path, a remote.
        write(w.work, { "src/a.ts": "export const a = 2;\n" });
        inBox(w, "commit", "-qam", "Work in the box");
        writeFileSync(join(w.work, ".git", "hooks-marker"), "box\n");
        inBox(w, "config", "core.hooksPath", "/tmp/box-hooks");
        inBox(w, "remote", "add", "evil", "https://example.com/evil.git");
        await w.parts.onPart(part("Change a"));
        expect(w.parks).toEqual([]);
        const commit = await tip(w);
        expect(await pathsAt(w, commit)).not.toContain(".git");
        expect((await pathsAt(w, commit)).some((path) => path.split("/").includes(".git"))).toBe(
          false,
        );
        expect(await w.repo.git("show", `${commit}:src/a.ts`)).toBe("export const a = 2;\n");
        // One commit on the claim tip, dipo's: the box's own commit and history never come along.
        expect((await w.repo.git("rev-parse", `${commit}^`)).trim()).toBe(w.claimTip);
        expect(await w.repo.git("log", "--format=%s", `${w.claimTip}..${commit}`)).toBe(
          "Change a\n",
        );
        // The Mac repository's config, refs (but the story branch) and hooks are as they were.
        expect(await macState(w)).toBe(before);
        // The stream asked the box to keep its .git, on every take.
        expect(
          w.calls
            .filter((call) => call.startsWith("exec "))
            .every((call) => call.includes("--exclude=./.git ")),
        ).toBe(true);
      },
      { tar: "excludes" },
    ));

  // The fail-closed case on the real part path: a box whose tar does not keep its .git in (as if
  // the in-box filter were undone) hands the Mac a changed .git/config.
  it("refuses a part that carries a changed .git/config, and commits and pushes nothing", () =>
    inParts(async (w) => {
      initBoxRepo(w);
      inBox(w, "config", "core.hooksPath", "hooks");
      write(w.work, { "src/a.ts": "export const a = 2;\n" });
      const before = await macState(w);
      await w.parts.onPart(part("Carry the box's git config"));
      expect(parkedFor(w)).toEqual([GIT_FOLDER_PARK]);
      expect(await tip(w)).toBe(w.claimTip);
      expect(await tip(w, "remote")).toBe(w.claimTip);
      expect(await macState(w)).toBe(before);
      expect(await w.repo.git("config", "--get-all", "core.hooksPath").catch(() => "")).toBe("");
    }));

  for (const [what, plant, tar, refusal] of [
    [
      "a symlink in a part that points at .git",
      (w: World) => symlinkSync("../.git", join(w.work, "src", "repo")),
      "excludes",
      LINK_PARK,
    ],
    [
      "a symlink in a part that points at a file in .git",
      (w: World) => symlinkSync("../.git/config", join(w.work, "src", "config")),
      "excludes",
      LINK_PARK,
    ],
    [
      "a .git file instead of a folder, below the root",
      (w: World) => write(w.work, { "vendor/lib/.git": "gitdir: ../../.git\n" }),
      "excludes",
      GIT_FOLDER_PARK,
    ],
    [
      "a nested repository",
      (w: World) => {
        write(w.work, { "vendor/nested/README.md": "# nested\n" });
        const made = spawnSync("git", ["init", "-q", join(w.work, "vendor", "nested")], {
          env: w.repo.env,
        });
        expect(made.status).toBe(0);
      },
      "excludes",
      GIT_FOLDER_PARK,
    ],
    [
      "a .git file with a gitdir pointer at the root, when the box's tar keeps it",
      (w: World) => {
        gitdirFile(w);
      },
      "all",
      GIT_FOLDER_PARK,
    ],
  ] as const) {
    it(`refuses ${what}, and commits nothing`, () =>
      inParts(
        async (w) => {
          initBoxRepo(w);
          write(w.work, { "src/a.ts": "export const a = 2;\n" });
          plant(w);
          await w.parts.onPart(part("Plant something of git"));
          expect(parkedFor(w)).toEqual([refusal]);
          expect(await tip(w)).toBe(w.claimTip);
          expect(await tip(w, "remote")).toBe(w.claimTip);
        },
        { tar },
      ));
  }

  it("keeps a root .git file with a gitdir pointer in the box: nothing of it reaches the Mac", () =>
    inParts(
      async (w) => {
        initBoxRepo(w);
        gitdirFile(w);
        write(w.work, { "src/a.ts": "export const a = 2;\n" });
        await w.parts.onPart(part("Change a"));
        expect(w.parks).toEqual([]);
        expect(await pathsAt(w, await tip(w))).not.toContain(".git");
      },
      { tar: "excludes" },
    ));

  it("runs no hook of the box's repository on the Mac, whatever core.hooksPath the box sets", () =>
    inParts(
      async (w) => {
        const marker = join(w.repo.root, "HOOK-RAN");
        initBoxRepo(w);
        // Hooks in the tree, named by the box's own config: delivered as plain files, never run.
        for (const hook of ["pre-commit", "post-commit", "reference-transaction", "pre-push"]) {
          write(w.work, { [`box-hooks/${hook}`]: `#!/bin/sh\ntouch ${marker}\n` });
        }
        inBox(w, "config", "core.hooksPath", join(w.work, "box-hooks"));
        await w.parts.onPart(part("Add hook scripts"));
        expect(w.parks).toEqual([]);
        expect(await pathsAt(w, await tip(w))).toContain("box-hooks/pre-commit");
        expect(existsSync(marker)).toBe(false);
        expect(await w.repo.git("config", "--get-all", "core.hooksPath").catch(() => "")).toBe("");
      },
      { tar: "excludes" },
    ));

  it("runs no git command on the Mac in a box folder: never there as its folder, git dir or work tree", () => {
    const gitCalls: GitCall[] = [];
    return inParts(
      async (w) => {
        initBoxRepo(w);
        write(w.work, { "src/a.ts": "export const a = 2;\n" });
        await w.parts.onPart(part("Change a"));
        expect(w.parks).toEqual([]);
        expect(gitCalls.length).toBeGreaterThan(0);
        const boxFolders = [realpathSync(w.work), realpathSync(w.stageRoot)];
        const inBoxFolder = (path: string | undefined) =>
          path !== undefined &&
          boxFolders.some((folder) => path === folder || path.startsWith(`${folder}/`));
        for (const call of gitCalls) {
          expect(inBoxFolder(realpathSync(call.cwd))).toBe(false);
          for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) {
            expect(inBoxFolder(call.env[key])).toBe(false);
          }
          // No work tree at all, and no git dir or folder in a box folder, in either option form.
          expect(call.args.some((arg) => arg.startsWith("--work-tree"))).toBe(false);
          call.args.forEach((arg, at) => {
            if (arg === "-C" || arg === "--git-dir") {
              expect(inBoxFolder(call.args[at + 1])).toBe(false);
            }
            if (arg.startsWith("--git-dir=")) {
              expect(inBoxFolder(arg.slice("--git-dir=".length))).toBe(false);
            }
          });
        }
      },
      { tar: "excludes", gitCalls },
    );
  });
});

// The parts guard on the story folders (DIPO-379, R30): the folders come from the real Backlog.md
// store (`storyFolders`), read from the story branch's tip. The old barrier's paths and the bypass
// forms as data are in box/tracker-folder.test.ts; here whole parts on real git.
/** Each park of the part: its reason, and whether it names protected files. */
function parksOn(w: World): (string | boolean)[][] {
  return w.parks.map((p) => [p.reason, p.detail.includes("protected files")]);
}

describe("the story folders, on real git", () => {
  it("parks a write into the folder through a symlink the worker made, and a rename into it", () =>
    inParts(async (w) => {
      mkdirSync(join(w.work, "docs"), { recursive: true });
      symlinkSync("../backlog/tasks", join(w.work, "docs/tasks"));
      writeFileSync(join(w.work, "docs/tasks/dipo-9 - Nine.md"), "---\nid: DIPO-9\n---\n");
      await w.parts.onPart(part("Write through a link"));
      expect(parksOn(w)).toEqual([["scope-violation", true]]);
      expect(await tip(w)).toBe(w.claimTip);
    }));

  it("parks a rename into the folder, and a name in another case", () =>
    inParts(async (w) => {
      mkdirSync(join(w.work, "Backlog/Tasks"), { recursive: true });
      renameSync(join(w.work, "src/a.ts"), join(w.work, "Backlog/Tasks/a.md"));
      await w.parts.onPart(part("Move a into the folder"));
      expect(parksOn(w)).toEqual([["scope-violation", true]]);
      expect(await tip(w)).toBe(w.claimTip);
    }));

  it("commits a folder that only shares the prefix", () =>
    inParts(async (w) => {
      write(w.work, { "backlog-x/notes.md": "Notes.\n" });
      await w.parts.onPart(part("Add notes"));
      expect(w.parks).toEqual([]);
      expect(await tip(w)).not.toBe(w.claimTip);
    }));

  it("parks a change in the folder backlog.config.yml names, and in backlog/ beside it", async () => {
    const start = {
      "backlog.config.yml": 'project_name: x\nbacklog_directory: "planning"\n',
      "planning/config.yml": "project_name: x\n",
    };
    for (const change of [
      { "planning/tasks/task-9 - Nine.md": "---\nid: TASK-9\n---\n" },
      { "backlog/tasks/dipo-9 - Nine.md": "---\nid: DIPO-9\n---\n" },
    ]) {
      await inParts(
        async (w) => {
          write(w.work, change);
          await w.parts.onPart(part("Add a story"));
          expect([Object.keys(change)[0], parksOn(w)]).toEqual([
            Object.keys(change)[0],
            [["scope-violation", true]],
          ]);
          expect(await tip(w)).toBe(w.claimTip);
        },
        { start },
      );
    }
  });

  it("fails closed: with the real store whose folder lookup fails, it parks and commits nothing", () =>
    inParts(
      async (w) => {
        write(w.work, { "src/a.ts": "export const a = 2;\n" });
        await w.parts.onPart(part("Change a"));
        expect(w.parks).toEqual([
          { reason: "scope-violation", detail: refusedDetail("storyFolder", 0) },
        ]);
        expect(await tip(w)).toBe(w.claimTip);
        expect(await tip(w, "remote")).toBe(w.claimTip);
      },
      { start: { "backlog.config.yml": "backlog_directory: ../outside\n" } },
    ));
});
