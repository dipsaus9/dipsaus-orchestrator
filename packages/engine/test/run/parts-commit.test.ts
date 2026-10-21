// Delivery in parts on real git (DIPO-273, 0021 sections 8, 13 and 14): a fake box whose `tar`
// streams a real folder, dipo's stream, extraction, comparison, scans, plumbing commit and push
// to a bare remote in the temp folder. The box ignores dipo's exclude list here, so the Mac's own
// check is what keeps `node_modules` out.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
  BoxParts,
  PART_RECORD_FILE,
  PART_WAITING,
  type PartPark,
  type PartRun,
} from "../../src/box/parts";
import { BoxError, type BoxPort } from "../../src/box/port";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";

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
  live: boolean;
}

/** A box whose exec runs the system `tar` over `work`, whatever exclude list dipo passes. */
function tarBox(work: string, calls: string[]): Pick<BoxPort, "execLive" | "stop"> {
  return {
    execLive: (box, command) => {
      calls.push(`exec ${box} ${command.slice(4).join(" ")}`);
      const packed = spawnSync("tar", ["-C", work, "-cf", "-", "."], {
        env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" },
        maxBuffer: 64 * 1024 * 1024,
      });
      let finish!: (exit: { code: number | null; signal: Signal | null }) => void;
      const exited = new Promise<{ code: number | null; signal: Signal | null }>((resolve) => {
        finish = resolve;
      });
      const stdout = new ReadableStream<Uint8Array>({
        start(controller) {
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

async function world(repo: TempRepoWithRemote): Promise<World> {
  write(repo.dir, START);
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
  write(work, START);
  writeFileSync(join(work, "listed.json"), "{}\n");
  const runDir = join(repo.root, "run");
  mkdirSync(runDir);
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
  const w = { repo, git, work, runDir, startSha, claimTip, calls, parks, live: true } as World;
  const parts = new BoxParts({
    boxes: tarBox(work, calls),
    clock: new ManualClock(),
    tmpRoot: realpathSync(tmp),
    run: (runId) => (runId === "run_1" ? run : null),
    git: (office) => (office === OFFICE ? git : undefined),
    listedFiles: async () => ["listed.json"],
    live: () => w.live,
    park: (_runId, park) => {
      parks.push(park);
      return true;
    },
    readDoor: (runId) => {
      calls.push(`read door ${runId}`);
      return Promise.resolve(null);
    },
  });
  (w as { parts: BoxParts }).parts = parts;
  return w;
}

function part(message: string) {
  return {
    runId: "run_1",
    box: "dipo-run_1",
    runDir: "",
    n: 1,
    name: "1700000000-1.part",
    message,
    at: 0,
  };
}

function inParts(fn: (w: World) => Promise<void>): Promise<void> {
  return withBareRemote(async (repo) => fn(await world(repo)));
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
        "exec dipo-run_1 tar --hard-dereference -C /work -cf - --exclude=node_modules .",
        "stdin end",
      ]);
      // The main checkout was not written.
      expect((await w.repo.git("status", "--porcelain")).trim()).toBe("");
      expect((await w.repo.git("rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe("main");
    }));

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
        expect(w.parks.map((p) => [p.reason, p.cause])).toEqual([
          ["scope-violation", "protected-file"],
        ]);
        expect(await tip(w)).toBe(w.claimTip);
        expect(await tip(w, "remote")).toBe(w.claimTip);
      }));
  }

  it("parks on a symlink, never following it, whatever it points at", () =>
    inParts(async (w) => {
      const outside = join(w.repo.root, "mac-secret");
      writeFileSync(outside, "the maintainer's file\n");
      symlinkSync(outside, join(w.work, "src", "home"));
      await w.parts.onPart(part("Plant a link"));
      expect(w.parks).toEqual([
        {
          reason: "scope-violation",
          cause: "protected-file",
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
      expect(w.parks.map((p) => [p.reason, p.cause])).toEqual([["scope-violation", "secret"]]);
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

  it("refuses a part over the size cap and parks it", () =>
    withBareRemote(async (repo) => {
      const w = await world(repo);
      const small = new BoxParts({
        boxes: tarBox(w.work, w.calls),
        clock: new ManualClock(),
        tmpRoot: realpathSync(join(repo.root, "tmp")),
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
      expect(w.parks.map((p) => p.cause)).toEqual(["part-refused"]);
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
      expect(outcome).toMatchObject({ kind: "hit", cause: "protected-file" });
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
