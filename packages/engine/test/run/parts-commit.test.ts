// Delivery in parts on real git (DIPO-273, 0021 sections 8, 13 and 14): a fake box whose `tar`
// streams a real folder, dipo's stream, extraction, comparison, scans, plumbing commit and push
// to a bare remote in the temp folder. The box ignores dipo's exclude list here, so the Mac's own
// check is what keeps `node_modules` out; the DIPO-290 cases use a box that honours it, as GNU tar
// does.
//
// Only the guard that runs no hook and no filter stays local; the other cases are in
// parts-commit.ci.test.ts (CI only, DIPO-225), and the rules as data are in box/parts.test.ts.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
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
} from "../../src/box/parts";
import { BOX_RUN_FILE } from "../../src/box/workers";
import { type BoxPort } from "../../src/box/port";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";

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
    runner: { exec: spawnGitExec(systemSpawn), env: repo.env, sleep: async () => {} },
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
