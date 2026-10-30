// CI only (0017 section 1, DIPO-225): real git and a fake box, too slow for the local run; the hook
// and filter guard stays in parts-commit.test.ts.
// Delivery in parts on real git (DIPO-273, 0021 sections 8, 13 and 14): a fake box whose `tar`
// streams a real folder, dipo's stream, extraction, comparison, scans, plumbing commit and push
// to a bare remote in the temp folder. The box ignores dipo's exclude list here, so the Mac's own
// check is what keeps `node_modules` out; the DIPO-290 cases use a box that honours it, as GNU tar
// does.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
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
  PART_FAILED,
  PART_NOTICES,
  PART_RECORD_FILE,
  PART_STAGE_PREFIX,
  PART_STREAK_GAP_MS,
  PART_STUCK_READS,
  PART_WAITING,
  type PartNotice,
  type PartPark,
  type PartRun,
  partStageRoot,
  partStuckText,
  partUnstuckText,
} from "../../src/box/parts";
import { BOX_RUN_FILE } from "../../src/box/workers";
import { BoxError, type BoxPort } from "../../src/box/port";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import { backlogLayout } from "../story-store/backlog";

const OFFICE = "office-parts" as OfficeId;
const BRANCH = "DIPO-1/deliver-in-parts";
const TASK_FILE = "backlog/tasks/dipo-1 - Deliver-in-parts.md";
const AWS_KEY = `AK${"IA"}${"QRSTUVWXYZ234567"}`;

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

async function filesAt(w: World, commit: string): Promise<string[]> {
  return (await w.repo.git("ls-tree", "-r", "--name-only", commit))
    .split("\n")
    .filter((line) => line !== "");
}

/** `live` answers true `times` times, then false: the run ends during the part. */
function endsAfter(w: World, times: number): void {
  let asked = 0;
  Object.defineProperty(w, "live", { get: () => (asked += 1) <= times });
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("a part on real git", () => {
    it("commits a change outside the References from dipo's own copy and pushes it", () =>
      inParts(async (w) => {
        write(w.work, {
          "src/a.ts": "export const a = 2;\n",
          "docs/anything/new.md": "Outside every forecast path.\n",
          "node_modules/left-out/index.js": "ignored\n",
          "debug.log": "ignored\n",
        });
        rmSync(join(w.work, "src/gone.ts"));
        await w.parts.onPart(part(`Change a${"\u001b"}[2J and add notes\nsecond line`));
        expect(w.parks).toEqual([]);
        const commit = await tip(w);
        expect(await tip(w, "remote")).toBe(commit);
        expect((await w.repo.git("rev-parse", `${commit}^`)).trim()).toBe(w.claimTip);
        expect((await w.repo.git("log", "-1", "--format=%s%n%b", commit)).trim()).toBe(
          "Change a and add notes\nPart 1 of DIPO-1, delivered from its box by dipo.",
        );
        expect(await filesAt(w, commit)).toEqual([
          ".github/workflows/ci.yml",
          ".gitignore",
          "README.md",
          TASK_FILE,
          "docs/anything/new.md",
          "src/a.ts",
        ]);
        // dipo's own task-file commit stays: the box's older copy is not a change.
        expect(await w.repo.git("show", `${commit}:${TASK_FILE}`)).toContain("In Progress");
        // The stream: tar through the exec with its stdin closed, never a copy out of the box.
        expect(w.calls).toEqual([
          "exec dipo-run_1 tar --hard-dereference -C /work -cf - --exclude=./.git --exclude=node_modules/* .",
          "stdin end",
        ]);
        // The main checkout was not written.
        expect((await w.repo.git("status", "--porcelain")).trim()).toBe("");
        expect((await w.repo.git("rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe("main");
      }));

    it("records each part's push that reached the remote (DIPO-315)", () => {
      const pushes: { branch: string; pushed: boolean; error: string | null }[] = [];
      return inParts(
        async (w) => {
          write(w.work, { "src/a.ts": "export const a = 3;\n" });
          await w.parts.onPart(part("Change a"));
          expect(w.parks).toEqual([]);
          expect(pushes).toEqual([{ branch: BRANCH, pushed: true, error: null }]);
        },
        {
          deps: {
            pushed: (run, push) =>
              pushes.push({ branch: run.branch, pushed: push.pushed, error: push.error }),
          },
        },
      );
    });

    it("numbers the parts, commits nothing for an unchanged box and keeps a record", () =>
      inParts(async (w) => {
        write(w.work, { "src/a.ts": "export const a = 2;\n" });
        await w.parts.onPart(part("First part"));
        const first = await tip(w);
        await w.parts.onPart(part("Nothing new"));
        expect(await tip(w)).toBe(first);
        write(w.work, { "src/b.ts": "export const b = 1;\n" });
        await w.parts.onPart(part("Second part"));
        expect((await w.repo.git("log", "-1", "--format=%b", BRANCH)).trim()).toBe(
          "Part 2 of DIPO-1, delivered from its box by dipo.",
        );
        const lines = (await Bun.file(join(w.runDir, PART_RECORD_FILE)).text())
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { kind: string; n?: number });
        expect(lines.map((line) => [line.kind, line.n])).toEqual([
          ["part", 1],
          ["empty", undefined],
          ["part", 2],
        ]);
      }));

    it("commits a file that became a folder and a folder that became a file", () =>
      inParts(async (w) => {
        rmSync(join(w.work, "README.md"));
        write(w.work, { "README.md/index.md": "# Parts\n" });
        rmSync(join(w.work, "src"), { recursive: true });
        writeFileSync(join(w.work, "src"), "now a file\n");
        await w.parts.onPart(part("Swap a file and a folder"));
        expect(w.parks).toEqual([]);
        expect(await filesAt(w, await tip(w))).toEqual([
          ".github/workflows/ci.yml",
          ".gitignore",
          "README.md/index.md",
          TASK_FILE,
          "src",
        ]);
      }));
  });

  describe("the scans park and commit nothing", () => {
    for (const [what, change] of [
      ["the story's task file", { [TASK_FILE]: "---\nid: DIPO-1\nstatus: Done\n---\n" }],
      ["a CI workflow", { ".github/workflows/ci.yml": "name: ci\non: push\n" }],
      ["dipo's configuration", { ".dipo/office.yaml": "base: main\n" }],
      ["git attributes", { ".gitattributes": "* filter=lfs\n" }],
    ] as const) {
      it(`parks scope-violation on ${what}`, () =>
        inParts(async (w) => {
          write(w.work, { ...change, "src/a.ts": "export const a = 2;\n" });
          await w.parts.onPart(part("Touch a protected file"));
          expect(w.parks.map((p) => [p.reason, caught(p)])).toEqual([
            ["scope-violation", "protected-file"],
          ]);
          expect(await tip(w)).toBe(w.claimTip);
          expect(await tip(w, "remote")).toBe(w.claimTip);
        }));
    }

    // The configuration of the tools dipo runs on checkouts (DIPO-312): added, changed or deleted.
    const TOOL_CONFIG = {
      "bunfig.toml": "[install]\nexact = true\n",
      ".mcp.json": '{ "mcpServers": {} }\n',
      "backlog.config.yml": 'backlog_directory: "backlog"\n',
    };
    for (const [what, change] of [
      ["an added Bun configuration", { "packages/x/bunfig.toml": "[test]\n" }],
      ["an added MCP server configuration", { ".mcp.json": '{ "mcpServers": { "x": {} } }\n' }],
      ["an added Backlog configuration", { ".backlog/config.yml": "project_name: x\n" }],
      ["a changed Bun configuration", { "bunfig.toml": "[test]\npreload = []\n" }],
      ["a changed Backlog configuration", { "backlog.config.yml": "project_name: x\n" }],
    ] as const) {
      it(`parks protected-file on ${what}`, () =>
        inParts(
          async (w) => {
            write(w.work, { ...change, "src/a.ts": "export const a = 2;\n" });
            await w.parts.onPart(part("Touch a tool's configuration"));
            expect(w.parks.map((p) => [p.reason, caught(p)])).toEqual([
              ["scope-violation", "protected-file"],
            ]);
            expect(await tip(w)).toBe(w.claimTip);
            expect(await tip(w, "remote")).toBe(w.claimTip);
          },
          { start: TOOL_CONFIG },
        ));
    }

    it("parks protected-file on the configuration of the folder backlog.config.yml names", () =>
      inParts(
        async (w) => {
          write(w.work, { "planning/config.yml": "project_name: x\n" });
          await w.parts.onPart(part("Change the named folder's configuration"));
          expect(w.parks.map((p) => [p.reason, caught(p)])).toEqual([
            ["scope-violation", "protected-file"],
          ]);
          expect(await tip(w)).toBe(w.claimTip);
        },
        {
          start: {
            "backlog.config.yml": 'project_name: x\nbacklog_directory: "planning"\n',
            "planning/config.yml": "project_name: x\nauto_commit: false\n",
          },
        },
      ));

    // The folder the root configuration names is one of the store's story folders (DIPO-379).
    it("parks protected-file on any change in the named folder", () =>
      inParts(
        async (w) => {
          write(w.work, { "planning/notes.txt": "Notes.\n" });
          await w.parts.onPart(part("Add notes"));
          expect(w.parks.map((p) => [p.reason, caught(p)])).toEqual([
            ["scope-violation", "protected-file"],
          ]);
          expect(await tip(w)).toBe(w.claimTip);
        },
        {
          start: {
            "backlog.config.yml": 'project_name: x\nbacklog_directory: "planning"\n',
            "planning/config.yml": "project_name: x\n",
          },
        },
      ));

    it("parks protected-file on a deleted MCP server configuration", () =>
      inParts(
        async (w) => {
          rmSync(join(w.work, ".mcp.json"));
          await w.parts.onPart(part("Drop the MCP servers"));
          expect(w.parks.map((p) => [p.reason, caught(p), p.detail])).toEqual([
            [
              "scope-violation",
              "protected-file",
              "The part the worker delivered changes protected files: Claude Code's MCP server configuration (.mcp.json). dipo committed and pushed nothing, and the change stays in the box. Only dipo or the maintainer writes these files.",
            ],
          ]);
          expect(await tip(w)).toBe(w.claimTip);
        },
        { start: TOOL_CONFIG },
      ));

    it("parks on a symlink, never following it, whatever it points at", () =>
      inParts(async (w) => {
        const outside = join(w.repo.root, "mac-secret");
        writeFileSync(outside, "the maintainer's file\n");
        symlinkSync(outside, join(w.work, "src", "home"));
        await w.parts.onPart(part("Plant a link"));
        expect(w.parks).toEqual([
          {
            reason: "scope-violation",
            detail:
              "The part the worker delivered changes protected files: a symlink or hard link. dipo committed and pushed nothing, and the change stays in the box. Only dipo or the maintainer writes these files.",
          },
        ]);
        expect(await tip(w)).toBe(w.claimTip);
        // Nothing of the link's target reached git's objects.
        const objects = spawnSync("git", ["cat-file", "--batch-all-objects", "--batch"], {
          cwd: w.repo.dir,
          env: w.repo.env,
          encoding: "latin1",
        });
        expect(objects.status).toBe(0);
        expect(objects.stdout).toContain("export const a = 1;");
        expect(objects.stdout).not.toContain("the maintainer's file");
      }));

    it("parks on a secret with a fixed text that quotes neither the secret nor its path", () =>
      inParts(async (w) => {
        write(w.work, { "src/config-loader.ts": `export const key = "${AWS_KEY}";\n` });
        await w.parts.onPart(part("Add a config"));
        expect(w.parks.map((p) => [p.reason, caught(p)])).toEqual([["scope-violation", "secret"]]);
        const detail = w.parks[0]?.detail ?? "";
        expect(detail).toContain("an AWS access key");
        expect(detail).not.toContain(AWS_KEY);
        expect(detail).not.toContain("config-loader");
        expect(await tip(w)).toBe(w.claimTip);
        expect(await tip(w, "remote")).toBe(w.claimTip);
      }));

    it("parks on a secret file name", () =>
      inParts(async (w) => {
        write(w.work, { ".env.production": "A=1\n" });
        await w.parts.onPart(part("Add env"));
        expect(w.parks[0]?.detail).toContain("a secret file name");
        expect(await tip(w)).toBe(w.claimTip);
      }));

    it("parks on a value of a listed box file brought into a tracked file", () =>
      inParts(async (w) => {
        // The listed file sits in the main checkout, where dipo reads it, and in the box.
        const value = `pg-${"pass".repeat(3)}-local`;
        writeFileSync(join(w.repo.dir, "listed.json"), `ANTHROPIC_API_KEY=${value}\n`);
        writeFileSync(join(w.work, "listed.json"), `ANTHROPIC_API_KEY=${value}\n`);
        write(w.work, { "src/a.ts": `export const password = "${value}";\n` });
        await w.parts.onPart(part("Hard-code the password"));
        expect(w.parks.map((p) => [p.reason, caught(p)])).toEqual([["scope-violation", "secret"]]);
        expect(w.parks[0]?.detail).toContain("a value from a listed box file");
        expect(w.parks[0]?.detail).not.toContain(value);
        expect(await tip(w)).toBe(w.claimTip);
      }));

    it("commits a file that names a listed key, such as process.env.ANTHROPIC_API_KEY", () =>
      inParts(async (w) => {
        const value = `pg-${"pass".repeat(3)}-local`;
        writeFileSync(join(w.repo.dir, "listed.json"), `ANTHROPIC_API_KEY=${value}\n`);
        writeFileSync(join(w.work, "listed.json"), `ANTHROPIC_API_KEY=${value}\n`);
        write(w.work, { "src/a.ts": "export const key = process.env.ANTHROPIC_API_KEY;\n" });
        await w.parts.onPart(part("Read the key from the environment"));
        expect(w.parks).toEqual([]);
        expect(await w.repo.git("show", `${await tip(w)}:src/a.ts`)).toContain(
          "process.env.ANTHROPIC_API_KEY",
        );
      }));

    it("parks on a secret in the worker's message, which would be the commit subject", () =>
      inParts(async (w) => {
        write(w.work, { "src/a.ts": "export const a = 2;\n" });
        await w.parts.onPart(part(`Use ${AWS_KEY} for the client`));
        expect(w.parks.map((p) => [p.reason, caught(p)])).toEqual([["scope-violation", "secret"]]);
        expect(w.parks[0]?.detail).not.toContain(AWS_KEY);
        expect(await tip(w)).toBe(w.claimTip);
      }));
  });

  describe("parts dipo does not take", () => {
    it("parks part-refused on a path git does not take into a commit", () =>
      inParts(async (w) => {
        // `git~1` is the 8.3 short name of `.git` on NTFS: git refuses it in a tree.
        write(w.work, { "git~1/config": "[core]\n", "src/a.ts": "export const a = 2;\n" });
        await w.parts.onPart(part("A path git refuses"));
        expect(w.parks).toEqual([
          {
            reason: "scope-violation",
            detail:
              "The part the worker delivered holds a path git does not take into a commit. dipo committed and pushed nothing.",
          },
        ]);
        expect(await tip(w)).toBe(w.claimTip);
      }));

    it("parks part-refused on a path with a control or bidirectional character", () =>
      inParts(async (w) => {
        write(w.work, { [`src/a${String.fromCodePoint(0x202e)}st.ts`]: "x\n" });
        await w.parts.onPart(part("A hidden name"));
        expect(w.parks.map(caught)).toEqual(["part-refused"]);
        expect(w.parks[0]?.detail).toContain("control, bidirectional or invisible");
        expect(await tip(w)).toBe(w.claimTip);
      }));

    it("parks part-refused on a .gitignore over 64 KiB, unread", () =>
      inParts(async (w) => {
        write(w.work, { "pkg/.gitignore": `${"x".repeat(70 * 1024)}\n` });
        await w.parts.onPart(part("A huge ignore file"));
        expect(w.parks.map(caught)).toEqual(["part-refused"]);
        expect(w.parks[0]?.detail).toContain(".gitignore larger than 65536 bytes");
      }));

    it("refuses a part over the size cap and parks it", () =>
      withBareRemote(async (repo) => {
        const w = await world(repo);
        const small = new BoxParts({
          stories: backlogLayout,
          boxes: tarBox(w.work, w.calls),
          clock: new ManualClock(),
          stageRoot: w.stageRoot,
          run: () => ({
            runId: "run_1",
            office: OFFICE,
            story: "DIPO-1",
            branch: BRANCH,
            startSha: w.startSha,
            box: "dipo-run_1",
          }),
          git: () => w.git,
          live: () => true,
          park: (_runId, park) => {
            w.parks.push(park);
            return true;
          },
          limits: { maxArchiveBytes: 4096, maxEntries: 1000, maxTotalBytes: 4096 },
        });
        write(w.work, { "big.txt": "x".repeat(8192) });
        await small.onPart(part("Too big"));
        expect(w.parks.map(caught)).toEqual(["part-refused"]);
        // The worker's box is kept: only the exec client was killed.
        expect(w.calls).toContain("kill SIGKILL");
        expect(w.calls.some((call) => call.startsWith("stop "))).toBe(false);
        expect(await tip(w)).toBe(w.claimTip);
      }));
  });

  describe("the last part (story done)", () => {
    it("reads the door first, then delivers what changed since with the done message", () =>
      inParts(async (w) => {
        write(w.work, { "src/a.ts": "export const a = 2;\n" });
        await w.parts.onPart(part("Delivered part"));
        write(w.work, { "src/late.ts": "export const late = 1;\n" });
        const outcome = await w.parts.deliverLast("run_1", "Finish the story");
        expect(outcome.kind).toBe("committed");
        expect(
          w.calls.filter((call) => !call.startsWith("stdin")).map((c) => c.split(" ")[0]),
        ).toEqual(["exec", "read", "exec"]);
        const commit = await tip(w);
        expect(await tip(w, "remote")).toBe(commit);
        expect((await w.repo.git("log", "-1", "--format=%s%n%b", commit)).trim()).toBe(
          "Finish the story\nPart 2 of DIPO-1, delivered from its box by dipo.",
        );
        expect(await filesAt(w, commit)).toContain("src/late.ts");
        expect(await w.parts.deliverLast("run_1", "Again")).toEqual({ kind: "empty" });
      }));

    it("returns a hit to its caller instead of parking it", () =>
      inParts(async (w) => {
        write(w.work, { ".github/workflows/release.yml": "name: release\n" });
        const outcome = await w.parts.deliverLast("run_1", "Done");
        expect(outcome).toMatchObject({ kind: "hit", hit: "protected-file" });
        expect(w.parks).toEqual([]);
      }));

    it("takes nothing while the run is not live; a door part stays queued", () =>
      inParts(async (w) => {
        w.live = false;
        write(w.work, { "src/a.ts": "export const a = 9;\n" });
        expect(await w.parts.deliverLast("run_1", "Done")).toEqual({ kind: "stopped" });
        const waiting = await w.parts.onPart(part("Queued")).then(
          () => null,
          (error: unknown) => error as BoxError,
        );
        expect(waiting).toBeInstanceOf(BoxError);
        expect(waiting?.code).toBe(PART_WAITING);
        expect(w.calls.filter((call) => call.startsWith("exec"))).toEqual([]);
        expect(await tip(w)).toBe(w.claimTip);
        expect(readdirSync(join(w.repo.root, "tmp"))).toEqual([]);
      }));
  });

  describe("a run that ends while its part is taken", () => {
    it("commits nothing and leaves the part queued when the run ends during the scan", () =>
      inParts(async (w) => {
        write(w.work, { "src/a.ts": "export const a = 2;\n" });
        // Asked before the part, in turn, then before the commit.
        endsAfter(w, 2);
        const error = await w.parts.onPart(part("Ends meanwhile")).then(
          () => null,
          (thrown: unknown) => thrown as BoxError,
        );
        expect(error?.code).toBe(PART_WAITING);
        expect(await tip(w)).toBe(w.claimTip);
        expect(w.parks).toEqual([]);
      }));

    it("pushes nothing when the run ends after the commit, and the last part reads stopped", () =>
      inParts(async (w) => {
        write(w.work, { "src/a.ts": "export const a = 2;\n" });
        endsAfter(w, 3);
        const error = await w.parts.onPart(part("Ends before the push")).then(
          () => null,
          (thrown: unknown) => thrown as BoxError,
        );
        expect(error?.code).toBe(PART_WAITING);
        expect(await tip(w, "remote")).toBe(w.claimTip);
        write(w.work, { "src/b.ts": "export const b = 1;\n" });
        endsAfter(w, 2);
        expect(await w.parts.deliverLast("run_1", "Done")).toEqual({ kind: "stopped" });
      }));
  });

  describe("the edges of a part (DIPO-290)", () => {
    it("leaves out the listed files the box was made with, whatever the base config says later", () =>
      inParts(
        async (w) => {
          // The base config now lists nothing, and then another file: the record decides.
          w.listed = [];
          write(w.work, {
            "listed.json": '{"changed": true}\n',
            "src/a.ts": "export const a = 2;\n",
          });
          await w.parts.onPart(part("Change a with the listed file beside it"));
          expect(w.parks).toEqual([]);
          expect(await filesAt(w, await tip(w))).not.toContain("listed.json");
          w.listed = ["listed.json", "src/b.ts"];
          write(w.work, { "src/b.ts": "export const b = 1;\n" });
          await w.parts.onPart(part("Add b"));
          expect(await filesAt(w, await tip(w))).toContain("src/b.ts");
        },
        { recorded: ["listed.json"] },
      ));

    it("reads the base config's list only for a run whose record does not hold one", () =>
      inParts(async (w) => {
        w.listed = [];
        write(w.work, { "listed.json": '{"changed": true}\n' });
        await w.parts.onPart(part("No record of the listed files"));
        expect(await filesAt(w, await tip(w))).toContain("listed.json");
      }));

    it("delivers a .env.example and a .env.sample, and still parks on a .env", () =>
      inParts(async (w) => {
        write(w.work, {
          ".env.example": "API_URL=https://example.invalid\n",
          "config/.env.sample": "PORT=\n",
        });
        await w.parts.onPart(part("Add the env templates"));
        expect(w.parks).toEqual([]);
        const files = await filesAt(w, await tip(w));
        expect(files).toContain(".env.example");
        expect(files).toContain("config/.env.sample");
        write(w.work, { ".env": "API_URL=https://example.invalid\n" });
        await w.parts.onPart(part("Add the env"));
        expect(w.parks.map((p) => [caught(p), p.detail.includes("a secret file name")])).toEqual([
          ["secret", true],
        ]);
      }));

    it("delivers a path the part's own .gitignore un-ignores in that same part", () =>
      inParts(async (w) => {
        write(w.work, { ".gitignore": "node_modules/\n", "keep.log": "kept\n" });
        await w.parts.onPart(part("Track the log"));
        expect(w.parks).toEqual([]);
        expect(await filesAt(w, await tip(w))).toContain("keep.log");
      }));

    it("delivers an un-ignored path in the last part too", () =>
      inParts(async (w) => {
        write(w.work, { ".gitignore": "node_modules/\n*.log\n!keep.log\n" });
        write(w.work, { "keep.log": "kept\n", "other.log": "ignored\n" });
        const outcome = await w.parts.deliverLast("run_1", "Finish with the log");
        expect(outcome.kind).toBe("committed");
        const files = await filesAt(w, await tip(w));
        expect(files).toContain("keep.log");
        expect(files).not.toContain("other.log");
      }));

    it("takes the part again without an in-box exclude the part's .gitignore dropped", () =>
      inParts(
        async (w) => {
          write(w.work, {
            ".gitignore": "*.log\n",
            "node_modules/pkg/index.js": "module.exports = 1;\n",
          });
          await w.parts.onPart(part("Vendor the package"));
          expect(w.parks).toEqual([]);
          expect(await filesAt(w, await tip(w))).toContain("node_modules/pkg/index.js");
          // The first stream left node_modules in the box; the second, by the part's rules, did not.
          expect(w.calls.filter((call) => call.startsWith("exec"))).toEqual([
            "exec dipo-run_1 tar --hard-dereference -C /work -cf - --exclude=./.git --exclude=node_modules/* .",
            "exec dipo-run_1 tar --hard-dereference -C /work -cf - --exclude=./.git .",
          ]);
          // The next part streams once, with the delivered rules.
          write(w.work, { "src/a.ts": "export const a = 2;\n" });
          await w.parts.onPart(part("Change a"));
          expect(w.calls.filter((call) => call.startsWith("exec"))).toHaveLength(3);
        },
        { tar: "excludes" },
      ));

    it("delivers the last part with an exclude the part's .gitignore dropped", () =>
      inParts(
        async (w) => {
          write(w.work, {
            ".gitignore": "/node_modules\n*.log\n",
            "node_modules/pkg/index.js": "module.exports = 1;\n",
          });
          await w.parts.onPart(part("Anchor node_modules"));
          // Unchanged: still ignored at the root, by the anchored rule now.
          expect(await filesAt(w, await tip(w))).not.toContain("node_modules/pkg/index.js");
          write(w.work, { ".gitignore": "*.log\n" });
          const outcome = await w.parts.deliverLast("run_1", "Vendor at the end");
          expect(outcome.kind).toBe("committed");
          expect(await filesAt(w, await tip(w))).toContain("node_modules/pkg/index.js");
        },
        { tar: "excludes" },
      ));

    it("excludes an anchored root name in the box, and delivers the same name deeper", () =>
      inParts(
        async (w) => {
          write(w.work, {
            "node_modules/left-out/index.js": "ignored\n",
            "pkg/node_modules/kept/index.js": "not ignored by /node_modules\n",
            "src/a.ts": "export const a = 2;\n",
            dist: "a regular file, which /dist/ does not ignore\n",
          });
          await w.parts.onPart(part("Anchored ignore"));
          expect(w.parks).toEqual([]);
          expect(w.calls.filter((call) => call.startsWith("exec"))).toEqual([
            "exec dipo-run_1 tar --hard-dereference -C /work -cf - --exclude=./.git --exclude=./dist/* --exclude=./node_modules .",
          ]);
          const files = await filesAt(w, await tip(w));
          expect(files).toContain("pkg/node_modules/kept/index.js");
          expect(files).not.toContain("node_modules/left-out/index.js");
          // `/dist/` ignores the folder only: a regular file named dist at the root leaves the box.
          expect(files).toContain("dist");
        },
        { start: { ".gitignore": "/node_modules\n/dist/\n*.log\n" }, tar: "excludes" },
      ));

    it("delivers a regular file named like a folder-only ignore, from inside the box", () =>
      inParts(
        async (w) => {
          write(w.work, {
            "node_modules/pkg/index.js": "ignored\n",
            "tools/node_modules": "a regular file, which node_modules/ does not ignore\n",
          });
          await w.parts.onPart(part("A file named node_modules"));
          expect(w.parks).toEqual([]);
          const files = await filesAt(w, await tip(w));
          expect(files).toContain("tools/node_modules");
          expect(files).not.toContain("node_modules/pkg/index.js");
        },
        { tar: "excludes" },
      ));

    it("never parks on a part that cannot come out, and tells the maintainer once per streak", () => {
      let failing = true;
      // The stream out of the box fails: `tar` ends with exit 2 and prints nothing.
      return inParts(
        async (w) => {
          /** One door read now that hands `queued` parts, each rejected and left queued. */
          const doorRead = async (queued = 1) => {
            const at = w.clock.now();
            const codes: (string | null)[] = [];
            for (let n = 0; n < queued; n += 1) {
              codes.push(
                await w.parts.onPart(part("Cannot come out", at)).then(
                  () => null,
                  (error: unknown) => (error as BoxError).code,
                ),
              );
            }
            return codes;
          };
          write(w.work, { "src/a.ts": "export const a = 2;\n" });
          // A run that is not live counts nothing, however long.
          w.live = false;
          for (let n = 0; n < PART_STUCK_READS + 1; n += 1) {
            expect(await doorRead()).toEqual([PART_WAITING]);
            w.clock.advance(60_000);
          }
          expect(w.notices).toEqual([]);
          w.live = true;
          // Three parts queued in one read count as one failed read.
          expect(await doorRead(3)).toEqual([PART_FAILED, PART_FAILED, PART_FAILED]);
          for (let n = 1; n < PART_STUCK_READS; n += 1) {
            w.clock.advance(5_000);
            await doorRead(3);
          }
          // Enough reads, but not for long enough: a hiccup under the minimum time is not told.
          expect(w.notices).toEqual([]);
          // Reads 30 s apart: told on the first read past the minimum time, 140 s in.
          for (let n = 0; n < 3; n += 1) {
            w.clock.advance(30_000);
            await doorRead();
          }
          expect(w.notices).toEqual([]);
          w.clock.advance(30_000);
          expect(await doorRead()).toEqual([PART_FAILED]);
          const stuck: PartNotice = {
            level: "warn",
            code: PART_NOTICES.stuck,
            text: partStuckText(PART_STUCK_READS + 4, 2),
          };
          expect(w.notices).toEqual([stuck]);
          expect(stuck.text).not.toContain("src/a.ts");
          // Once per streak, and never a park: the part stays queued and the worker goes on.
          w.clock.advance(60_000);
          await doorRead();
          expect(w.notices).toEqual([stuck]);
          expect(w.parks).toEqual([]);
          expect(await tip(w)).toBe(w.claimTip);
          // The part comes out: the streak ends with an info notice.
          failing = false;
          await w.parts.onPart(part("Comes out", w.clock.now()));
          expect(await w.repo.git("show", `${await tip(w)}:src/a.ts`)).toBe(
            "export const a = 2;\n",
          );
          expect(w.notices).toEqual([
            stuck,
            {
              level: "info",
              code: PART_NOTICES.unstuck,
              text: partUnstuckText(PART_STUCK_READS + 5),
            },
          ]);
          // A new streak of many reads within a minute is not told, nor its end.
          failing = true;
          write(w.work, { "src/b.ts": "export const b = 1;\n" });
          for (let n = 0; n < PART_STUCK_READS * 2; n += 1) {
            w.clock.advance(5_000);
            await doorRead();
          }
          failing = false;
          await w.parts.onPart(part("Comes out again", w.clock.now()));
          expect(w.notices).toHaveLength(2);
          expect(w.parks).toEqual([]);
        },
        { onExec: () => (failing ? { exit: 2 } : undefined) },
      );
    });

    it("starts a fresh streak after the run parked or the door stopped, never telling at once", () => {
      let failing = true;
      return inParts(
        async (w) => {
          // One door read now; the clock moves a little, as a read takes time.
          const doorRead = () => {
            w.clock.advance(1);
            return w.parts.onPart(part("Cannot come out", w.clock.now())).then(
              () => null,
              (error: unknown) => (error as BoxError).code,
            );
          };
          write(w.work, { "src/a.ts": "export const a = 2;\n" });
          // A streak one read short of the notice, over more than the minimum time.
          for (let n = 1; n < PART_STUCK_READS; n += 1) {
            expect(await doorRead()).toBe(PART_FAILED);
            w.clock.advance(PART_STREAK_GAP_MS - 10_000);
          }
          // The run parks: a door read finds it not live, which ends the streak.
          w.live = false;
          expect(await doorRead()).toBe(PART_WAITING);
          // Resumed: the next failure is the first of a fresh streak.
          w.live = true;
          expect(await doorRead()).toBe(PART_FAILED);
          expect(w.notices).toEqual([]);
          for (let n = 1; n < PART_STUCK_READS; n += 1) {
            w.clock.advance(PART_STREAK_GAP_MS - 10_000);
            await doorRead();
          }
          expect(w.notices.map((notice) => notice.code)).toEqual([PART_NOTICES.stuck]);
          // Delivered: the streak ends. A new one, short of the notice, then a door that stopped
          // reading for longer than the gap (a session ended, a resume): fresh again.
          failing = false;
          await w.parts.onPart(part("Comes out", w.clock.now()));
          failing = true;
          write(w.work, { "src/b.ts": "export const b = 1;\n" });
          for (let n = 1; n < PART_STUCK_READS; n += 1) {
            await doorRead();
            w.clock.advance(PART_STREAK_GAP_MS - 10_000);
          }
          w.clock.advance(PART_STREAK_GAP_MS + 1);
          await doorRead();
          expect(w.notices).toHaveLength(2);
          // The last part taken out ends a streak too.
          failing = false;
          expect((await w.parts.deliverLast("run_1", "Done")).kind).toBe("committed");
          failing = true;
          write(w.work, { "src/c.ts": "export const c = 1;\n" });
          for (let n = 1; n < PART_STUCK_READS; n += 1) {
            w.clock.advance(PART_STREAK_GAP_MS - 10_000);
            await doorRead();
          }
          expect(w.notices).toHaveLength(2);
          expect(w.parks).toEqual([]);
        },
        { onExec: () => (failing ? { exit: 2 } : undefined) },
      );
    });

    it("makes its folder of stages 0700, and fails a part while it is a link or another user's", () =>
      inParts(async (w) => {
        write(w.work, { "src/a.ts": "export const a = 2;\n" });
        const tryPart = () =>
          w.parts.onPart(part("Through the stage folder")).then(
            () => null,
            (error: unknown) => (error as BoxError).code,
          );
        // A link in its place, even to a folder of this user's: the part fails, nothing parks.
        const elsewhere = join(w.repo.root, "elsewhere");
        mkdirSync(elsewhere);
        mkdirSync(join(w.stageRoot, ".."), { recursive: true });
        symlinkSync(elsewhere, w.stageRoot);
        expect(await tryPart()).toBe(PART_FAILED);
        expect(readdirSync(elsewhere)).toEqual([]);
        expect(w.parks).toEqual([]);
        expect(await tip(w)).toBe(w.claimTip);
        // A folder of another user (as `uid` sees it): the same.
        rmSync(w.stageRoot);
        mkdirSync(w.stageRoot, { mode: 0o755 });
        const mine = w.uid;
        w.uid = mine + 1;
        expect(await tryPart()).toBe(PART_FAILED);
        expect(w.parks).toEqual([]);
        // Fixed: the part is delivered, and the folder is the user's own, 0700.
        w.uid = mine;
        expect(await tryPart()).toBeNull();
        expect(await w.repo.git("show", `${await tip(w)}:src/a.ts`)).toBe("export const a = 2;\n");
        expect(statSync(w.stageRoot).mode & 0o777).toBe(0o700);
        expect(readdirSync(w.stageRoot)).toEqual([]);
      }));

    it("sweeps the stage folders its daemon left, never one a part uses or another daemon's", () => {
      let sweep: Promise<number> | null = null;
      return inParts(
        async (w) => {
          const own = w.stageRoot;
          // Another daemon's stages are in its own state folder.
          const other = partStageRoot(join(w.repo.root, "other-state"));
          mkdirSync(join(own, `${PART_STAGE_PREFIX}left1`, "files"), { recursive: true });
          writeFileSync(join(own, `${PART_STAGE_PREFIX}left1`, "files", "a.ts"), "box files\n");
          writeFileSync(join(own, `${PART_STAGE_PREFIX}not-a-folder`), "kept\n");
          mkdirSync(join(other, `${PART_STAGE_PREFIX}live`), { recursive: true });
          write(w.work, { "src/a.ts": "export const a = 2;\n" });
          await w.parts.onPart(part("Swept meanwhile"));
          // The sweep ran while the part streamed: the part's own stage stayed, and it committed.
          expect(await sweep).toBe(1);
          expect(w.parks).toEqual([]);
          expect(await w.repo.git("show", `${await tip(w)}:src/a.ts`)).toBe(
            "export const a = 2;\n",
          );
          expect(readdirSync(own)).toEqual([`${PART_STAGE_PREFIX}not-a-folder`]);
          expect(readdirSync(other)).toEqual([`${PART_STAGE_PREFIX}live`]);
        },
        {
          // The part's output waits for the sweep, so its stage folder is in use while it runs.
          onExec: (w) => {
            sweep ??= w.parts.sweepStages();
            return { hold: sweep };
          },
        },
      );
    });
  });
}
/**
 * Which barrier a part's park names in its detail: protected files, what looks like a secret, or a
 * part dipo did not take. The detail is text for the maintainer; the test reads it to tell them apart.
 */
function caught(park: { readonly detail: string }): string {
  if (park.detail.includes("protected files")) return "protected-file";
  if (park.detail.includes("looks like a secret")) return "secret";
  return "part-refused";
}
