// The life of a story's box from claim to merge (DIPO-278; 0021 section 6), on the in-memory box
// backend and a real git repository:
// - which runs' boxes stop, which are deleted and which are left (`boxRunState`): a run that waits
//   (ended at In Review, a park, a review period's end, with its claim live) stops; a released
//   claim (merge, drop, discard) deletes; a session that runs or may start is left alone;
// - a waiting run's box is checked for the token and stopped with its files, once, and started
//   again by its next session; a resting box is deleted at the claim's end without a second check;
// - a lost box is rebuilt from the start commit plus the delivered parts (`deliveredCode`), with
//   the packages installed again and `/work` checked against the delivered tree; only undelivered
//   work is lost, and the notice says so.

import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import {
  ManualClock,
  type TempRepo,
  withTempDir,
  withTempRepo,
} from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config";
import type { BaseBox, BoxImageDescription } from "../../src/box/image";
import { NODE_TARBALL_SHA256 } from "../../src/box/image";
import {
  BoxLifetime,
  boxEndedOf,
  boxRebuiltText,
  boxRunState,
  deliveredCode,
  type RunBoxes,
  type RunBoxRequest,
} from "../../src/box/lifetime";
import type { RunningModelProxy } from "../../src/box/model-proxy";
import { boxName } from "../../src/box/port";
import { SecretToken } from "../../src/box/token";
import { BOX_INDEX_DIR, BOX_WAITING, BoxWorkers, readBoxRun } from "../../src/box/workers";
import type { BoxWebRouteStart } from "../../src/box/web-proxy";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemClock } from "../../src/platform/clock";
import { systemSpawn } from "../../src/platform/process";
import type { RunProfile } from "../../src/scan/detect";
import { AdapterHolds } from "../../src/workers/hold";
import { FakeBoxes } from "./fake-boxes";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z00000278" as OfficeId;
const RUN = "run_01J9ZK5Q8W3V4X6Y7Z00000278";
const BOX = boxName(RUN);
const ADAPTER = "claude-cli";
const STORY = "TASK-1";
const BRANCH = "TASK-1/box-lifetime";
const TOKEN = "fake-box-login-for-tests-0123456789";
const CA =
  "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIBATAKBggqhkjOPQQDAjA=\n-----END CERTIFICATE-----\n";
const IMAGE: BoxImageDescription = {
  debian: "trixie",
  toolchain: { node: "24.22.1" },
  nodeSha256: NODE_TARBALL_SHA256["24.22.1"]!,
  packages: [],
  claudeCode: "2.1.303",
};
const TASK_FILE = "backlog/tasks/task-1 - Box-lifetime.md";
const PART_BODY = "Part 1 of TASK-1, delivered from its box by dipo.";

describe("what happens to a run's box (boxRunState)", () => {
  it("stops the box while the story waits, deletes it when the claim ends, and leaves a working one", () => {
    // Ended at In Review, a park or a review period's end, the claim live, no host running.
    expect(boxRunState({ endedAt: 5, claimLive: true, hostsExited: true })).toBe("waiting");
    // Merge (Done), drop and discard all release the claim.
    expect(boxRunState({ endedAt: 5, claimLive: false, hostsExited: true })).toBe("released");
    // A session runs: nothing happens until it exits, whatever the claim says.
    expect(boxRunState({ endedAt: 5, claimLive: false, hostsExited: false })).toBe("working");
    expect(boxRunState({ endedAt: null, claimLive: true, hostsExited: false })).toBe("working");
    // A run reopened for a review, a fix round or a resume may start a session at any moment.
    expect(boxRunState({ endedAt: null, claimLive: true, hostsExited: true })).toBe("working");
    // No claim row: the box ends with the run, as before.
    expect(boxRunState({ endedAt: 5, claimLive: null, hostsExited: true })).toBe("released");
    expect(boxRunState({ endedAt: null, claimLive: null, hostsExited: true })).toBe("working");
  });

  it("answers the box workers' pass: true deletes, waiting stops, false leaves", () => {
    expect(boxEndedOf("released")).toBe(true);
    expect(boxEndedOf("waiting")).toBe(BOX_WAITING);
    expect(boxEndedOf("working")).toBe(false);
    expect(boxEndedOf(null)).toBeNull();
  });
});

function officeGit(dir: string, env: Record<string, string>): OfficeGit {
  const real = realpathSync(dir);
  return new OfficeGit({
    officeId: OFFICE,
    mainWorktree: real,
    commonDir: join(real, ".git"),
    settings: { remote: "origin", base: "main" },
    runner: { exec: spawnGitExec(systemSpawn), env, sleep: async () => {} },
    clock: new ManualClock(),
  });
}

interface World {
  readonly boxes: FakeBoxes;
  readonly workers: BoxWorkers;
  readonly log: string[];
  readonly holds: AdapterHolds;
  readonly git: OfficeGit;
  readonly start: string;
  readonly runDir: string;
  readonly systemFile: string;
  readonly tmp: string;
}

/**
 * A repository whose start commit holds code and the story's task file, the box workers on the
 * fake backend, and the run's directory. The story branch is made at the start commit.
 */
async function world(
  repo: TempRepo,
  tmp: string,
  more: { readonly finishWaitMs?: number } = {},
): Promise<World> {
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(join(repo.dir, "src", "greet.ts"), "export const greet = () => 'hi';\n");
  mkdirSync(join(repo.dir, "backlog", "tasks"), { recursive: true });
  writeFileSync(join(repo.dir, TASK_FILE), "---\nstatus: Ready\n---\n");
  const start = await repo.commitAll("start");
  await repo.git("update-ref", "refs/remotes/origin/main", start);
  await repo.git("branch", BRANCH, start);
  const git = officeGit(repo.dir, repo.env);
  const log: string[] = [];
  const boxes = new FakeBoxes({ log });
  const holds = new AdapterHolds({ clock: new ManualClock(), notify: () => {} });
  const caFile = join(tmp, "route-ca.pem");
  writeFileSync(caFile, CA);
  const route = async (network: { hostAddress: string }): Promise<BoxWebRouteStart> => ({
    ok: true,
    route: {
      host: network.hostAddress,
      port: 3128,
      url: `http://${network.hostAddress}:3128`,
      caFile,
      stop: async () => {
        log.push("web route stopped");
      },
    },
  });
  const token = new SecretToken(TOKEN);
  const workers = new BoxWorkers({
    boxes,
    startWebRoute: route,
    startBuildRoute: route,
    startModelProxy: async (network): Promise<RunningModelProxy> => ({
      hostAddress: network.hostAddress,
      port: 4000,
      url: `http://${network.hostAddress}:4000`,
      scanner: () => token.scanner(),
      redact: (text) => token.redact(text),
      stop: async () => {
        log.push("model proxy stopped");
      },
    }),
    readBaseBox: async (): Promise<BaseBox> =>
      ({
        ok: true,
        description: { image: IMAGE, files: [] },
        detected: {},
        commit: start,
      }) as unknown as BaseBox,
    code: { spawn: systemSpawn, clock: systemClock },
    holds,
    adapter: ADAPTER,
    tmpRoot: tmp,
    indexDir: join(tmp, "state", BOX_INDEX_DIR),
    scratchRoot: tmp,
    ...more,
    // /work is compared with dipo's copy; here every box is found the same.
    treeCheck: async (run) => {
      log.push(`tree check against ${run.codeTip ?? run.startSha}`);
      return { kind: "same" };
    },
  });
  const runDir = join(tmp, "runs", RUN);
  mkdirSync(runDir, { recursive: true });
  const systemFile = join(runDir, "system.md");
  writeFileSync(systemFile, "# system\n");
  return { boxes, workers, log, holds, git, start, runDir, systemFile, tmp };
}

function inBoxes(fn: (repo: TempRepo, tmp: string) => Promise<void>): Promise<void> {
  return withTempRepo((repo) => withTempDir((tmp) => fn(repo, realpathSync(tmp))));
}

async function made(w: World): Promise<void> {
  await w.workers.create({
    office: OFFICE,
    runId: RUN,
    runDir: w.runDir,
    git: w.git,
    startCommit: w.start,
  });
}

/** One session of the run in its box, which then ends (its host exits). */
async function session(w: World): Promise<void> {
  await w.workers.session({ runId: RUN, runDir: w.runDir, systemFile: w.systemFile });
}

/** The pass the daemon runs, with the state the daemon would read for the run. */
function pass(w: World, state: Parameters<typeof boxRunState>[0]) {
  return w.workers.finishEnded((runId) => (runId === RUN ? boxEndedOf(boxRunState(state)) : null));
}

/** Holds the post-run check's export of the box until `release`; `started` once it is asked. */
function hold(w: World): { readonly started: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  let asked!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    asked = resolve;
  });
  const exportFiles = w.boxes.exportFiles.bind(w.boxes);
  w.boxes.exportFiles = async (name, to) => {
    asked();
    await held;
    w.boxes.exportFiles = exportFiles;
    return exportFiles(name, to);
  };
  return { started, release };
}

const WAITING = { endedAt: 5, claimLive: true, hostsExited: true } as const;
const RELEASED = { endedAt: 5, claimLive: false, hostsExited: true } as const;
const WORKING = { endedAt: null, claimLive: true, hostsExited: false } as const;

describe("the box while the story waits", () => {
  it("is checked for the token and stopped with its files, once, while the claim is live", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      await made(w);
      await session(w);
      w.log.length = 0;
      // A session runs: the pass leaves the box alone.
      expect(await pass(w, WORKING)).toEqual([]);
      expect(w.log).toEqual([]);
      // The run ended at In Review (or parked): the story waits for the review, CI or an answer.
      expect(await pass(w, WAITING)).toEqual([]);
      // Stopped and started first, so no earlier claude runs in it during the check.
      expect(w.log).toEqual([
        "list",
        `stop ${BOX}`,
        `start ${BOX}`,
        `exec ${BOX} sh`,
        `export ${BOX}`,
        `stop ${BOX}`,
        "web route stopped",
        "model proxy stopped",
      ]);
      expect(w.boxes.boxes.get(BOX)?.state).toBe("stopped");
      expect(readBoxRun(w.runDir)).toMatchObject({ waiting: true });
      expect(readBoxRun(w.runDir)?.finished).toBeUndefined();
      expect(w.workers.pending()).toEqual([RUN]);
      expect(w.holds.adapterHeld(ADAPTER)).toBeNull();
      // Later passes find it resting and call nothing.
      w.log.length = 0;
      expect(await pass(w, WAITING)).toEqual([]);
      expect(w.log).toEqual([]);
    }));

  it("starts again for the next session, which the next stop checks again", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      await made(w);
      await session(w);
      await pass(w, WAITING);
      w.log.length = 0;
      await session(w);
      expect(w.log.slice(0, 2)).toEqual(["list", `start ${BOX}`]);
      expect(w.boxes.boxes.get(BOX)?.state).toBe("running");
      expect(readBoxRun(w.runDir)?.waiting).toBeUndefined();
      w.log.length = 0;
      await pass(w, WAITING);
      expect(w.log).toContain(`export ${BOX}`);
      expect(w.log).toContain(`stop ${BOX}`);
    }));

  it("keeps the box and routes of a session started while the rest's export is held, and the next stop checks it again", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      await made(w);
      await session(w);
      const held = hold(w);
      const resting = w.workers.rest(RUN);
      await held.started;
      // The next session starts during the check: it waits for the rest, which then stops nothing.
      let ready = false;
      const next = session(w).then(() => {
        ready = true;
      });
      await Promise.resolve();
      expect(ready).toBe(false);
      w.log.length = 0;
      held.release();
      expect(await resting).toEqual({ kind: "skipped" });
      await next;
      expect(w.log).not.toContain("web route stopped");
      expect(w.log).not.toContain("model proxy stopped");
      expect(w.boxes.boxes.get(BOX)?.state).toBe("running");
      expect(w.workers.routeUsers).toEqual({ web: [BOX], model: [BOX] });
      expect(readBoxRun(w.runDir)?.waiting).toBeUndefined();
      expect(w.holds.adapterHeld(ADAPTER)).toBeNull();
      // That session ends: the next stop checks the box again before it stops it.
      w.log.length = 0;
      expect(await w.workers.rest(RUN)).toMatchObject({ kind: "stopped" });
      expect(w.log).toContain(`export ${BOX}`);
      expect(w.log.at(-3)).toBe(`stop ${BOX}`);
      expect(readBoxRun(w.runDir)).toMatchObject({ waiting: true });
    }));

  it("is skipped while a session makes the box ready", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      await made(w);
      await session(w);
      // A copy into the box is held, so the session is still making its box ready.
      let release!: () => void;
      const copied = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const inCopy = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const copyIn = w.boxes.copyIn.bind(w.boxes);
      w.boxes.copyIn = async (...args) => {
        entered();
        await copied;
        return copyIn(...args);
      };
      const next = session(w);
      await inCopy;
      expect(await w.workers.rest(RUN)).toEqual({ kind: "skipped" });
      release();
      await next;
      expect(w.boxes.boxes.get(BOX)?.state).toBe("running");
    }));

  it("lets the pass go on after the wait while a rest hangs, and the rest still ends", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp, { finishWaitMs: 20 });
      await made(w);
      await session(w);
      const held = hold(w);
      expect(await pass(w, WAITING)).toEqual([]);
      expect(readBoxRun(w.runDir)?.waiting).toBeUndefined();
      held.release();
      // The same rest goes on: a later call gets it and the box rests.
      expect(await w.workers.rest(RUN)).toMatchObject({ kind: "stopped" });
      expect(readBoxRun(w.runDir)).toMatchObject({ waiting: true });
    }));

  it("finds a listed box the index lost through the office that knows its run", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      await made(w);
      await session(w);
      const index = join(tmp, "state", BOX_INDEX_DIR);
      rmSync(join(index, BOX));
      expect(w.workers.pending()).toEqual([]);
      await w.workers.finishEnded((runId) => (runId === RUN ? BOX_WAITING : null), {
        listBoxes: true,
        runDirOf: (runId) => (runId === RUN ? w.runDir : null),
      });
      expect(w.workers.pending()).toEqual([RUN]);
      // With its entry back the rest finds the run's record and marks it waiting.
      expect(readBoxRun(w.runDir)).toMatchObject({ waiting: true });
    }));

  it("writes no index entry for a listed box no office knows", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      await made(w);
      await session(w);
      rmSync(join(tmp, "state", BOX_INDEX_DIR, BOX));
      await w.workers.finishEnded(() => null, {
        listBoxes: true,
        runDirOf: () => w.runDir,
      });
      expect(w.workers.pending()).toEqual([]);
    }));
});

describe("the box when the claim ends (merge, drop, discard)", () => {
  it("is deleted without a second check when it rests already", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      await made(w);
      await session(w);
      await pass(w, WAITING);
      w.log.length = 0;
      expect(await pass(w, RELEASED)).toEqual([RUN]);
      expect(w.log).toEqual(["list", `delete ${BOX}`]);
      expect(w.boxes.boxes.has(BOX)).toBe(false);
      expect(readBoxRun(w.runDir)?.finished).toBe(true);
      expect(w.workers.pending()).toEqual([]);
    }));

  it("is checked and deleted when the claim ends while the box still ran", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      await made(w);
      await session(w);
      w.log.length = 0;
      expect(await pass(w, RELEASED)).toEqual([RUN]);
      expect(w.log).toContain(`export ${BOX}`);
      expect(w.log).toContain(`delete ${BOX}`);
      expect(w.boxes.boxes.has(BOX)).toBe(false);
    }));
});

/** A part on the story branch, as dipo commits one, and dipo's own task-file commit after it. */
async function deliverPart(repo: TempRepo): Promise<string> {
  await repo.git("checkout", "--quiet", BRANCH);
  writeFileSync(join(repo.dir, "src", "part.ts"), "export const part = 1;\n");
  await repo.git("add", "--all");
  await repo.git("commit", "--quiet", "-m", "Add the part", "-m", PART_BODY);
  // dipo's own commit of the task file, which never reaches the box.
  writeFileSync(join(repo.dir, TASK_FILE), "---\nstatus: In Review\n---\n");
  const tip = await repo.commitAll("TASK-1: status In Review");
  await repo.git("checkout", "--quiet", "main");
  return tip;
}

describe("the delivered code a lost box is rebuilt from", () => {
  it("is the branch tip's tree with backlog/ as the start commit holds it, and counts the parts", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      const tip = await deliverPart(repo);
      const code = await deliveredCode(w.git, { branch: BRANCH, startSha: w.start, tmpRoot: tmp });
      expect(code.tip).toBe(tip);
      expect(code.parts).toBe(1);
      const listed = (await repo.git("ls-tree", "-r", "--name-only", code.tree)).trim().split("\n");
      expect(listed.toSorted()).toEqual([TASK_FILE, "src/greet.ts", "src/part.ts"]);
      const task = await repo.git("show", `${code.tree}:${TASK_FILE}`);
      expect(task).toBe("---\nstatus: Ready\n---\n");
      // No temporary index is left in dipo's temp root.
      expect(readFileSync(join(tmp, "route-ca.pem"), "utf8")).toBe(CA);
    }));
});

/** The box lifetime over scripted box workers, recording what it asked. */
function scripted(
  presence: "ready" | "gone" | "none",
  options: { readonly installFails?: boolean } = {},
): { readonly boxes: RunBoxes; readonly calls: string[] } {
  const calls: string[] = [];
  const boxes: RunBoxes = {
    has: async () => presence,
    create: async (input) => {
      calls.push(`create at ${input.code ?? input.startCommit}`);
      return { name: boxName(input.runId), cache: { kind: "off" } };
    },
    discard: async (runId) => {
      calls.push(`discard ${runId}`);
    },
    install: async () => {
      calls.push("install");
      return options.installFails === true
        ? { ok: false, reason: "the install exited 1 in the box", ended: null, output: "" }
        : { ok: true };
    },
    changedSinceStart: async (input) => {
      calls.push(`check against ${input.codeTip ?? input.startSha}`);
      return { kind: "same" };
    },
  } as RunBoxes;
  return { boxes, calls };
}

const PROFILE = {
  capabilities: {
    install: {
      status: "resolved",
      value: { commands: [["bun", "install", "--frozen-lockfile"]], cwd: "." },
    },
  },
  devPorts: [],
} as unknown as RunProfile;

function request(w: World): RunBoxRequest {
  return {
    office: OFFICE,
    runId: RUN,
    runDir: w.runDir,
    story: STORY,
    branch: BRANCH,
    startSha: w.start,
    slot: 2,
    git: w.git,
    config: OFFICE_DEFAULTS,
  };
}

describe("a lost box (BoxLifetime.ensure)", () => {
  it("does nothing while the run's box is there", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      const { boxes, calls } = scripted("ready");
      const lifetime = new BoxLifetime({ boxes, profile: () => PROFILE, tmpRoot: tmp });
      expect(await lifetime.ensure(request(w), () => {})).toEqual({ kind: "ready" });
      expect(calls).toEqual([]);
    }));

  it("is rebuilt from the start commit plus the delivered parts, installed and checked against them", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      const tip = await deliverPart(repo);
      const { boxes, calls } = scripted("gone");
      const lifetime = new BoxLifetime({ boxes, profile: () => PROFILE, tmpRoot: tmp });
      const ensured = await lifetime.ensure(request(w), () => {});
      expect(ensured).toEqual({ kind: "rebuilt", had: "gone", parts: 1 });
      const code = await deliveredCode(w.git, { branch: BRANCH, startSha: w.start, tmpRoot: tmp });
      expect(calls).toEqual([
        `discard ${RUN}`,
        `create at ${code.tree}`,
        "install",
        `check against ${tip}`,
      ]);
    }));

  it("makes a box for a run that never had one, with nothing to delete first", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      const { boxes, calls } = scripted("none");
      const lifetime = new BoxLifetime({ boxes, profile: () => PROFILE, tmpRoot: tmp });
      expect(await lifetime.ensure(request(w), () => {})).toEqual({
        kind: "rebuilt",
        had: "none",
        parts: 0,
      });
      expect(calls[0]).toMatch(/^create at [0-9a-f]{40}$/);
    }));

  it("says why and deletes the new box when its install fails", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      const { boxes, calls } = scripted("gone", { installFails: true });
      const lifetime = new BoxLifetime({ boxes, profile: () => PROFILE, tmpRoot: tmp });
      expect(await lifetime.ensure(request(w), () => {})).toEqual({
        kind: "failed",
        reason: "the install exited 1 in the box",
      });
      expect(calls.at(-1)).toBe(`discard ${RUN}`);
    }));

  it("fails, making nothing, when the story branch cannot be read", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      await repo.git("branch", "-D", BRANCH);
      const { boxes, calls } = scripted("gone");
      const lifetime = new BoxLifetime({ boxes, profile: () => PROFILE, tmpRoot: tmp });
      const ensured = await lifetime.ensure(request(w), () => {});
      expect(ensured.kind).toBe("failed");
      expect(calls).toEqual([]);
    }));

  it("is rebuilt in the real box workers when the backend lost it", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      await made(w);
      const tip = await deliverPart(repo);
      w.boxes.boxes.delete(BOX);
      expect(await w.workers.has(RUN, w.runDir)).toBe("gone");
      const lifetime = new BoxLifetime({
        boxes: w.workers,
        profile: () => ({ ...PROFILE, capabilities: { install: { status: "missing" } } }) as never,
        tmpRoot: tmp,
      });
      w.log.length = 0;
      expect(await lifetime.ensure(request(w), () => {})).toEqual({
        kind: "rebuilt",
        had: "gone",
        parts: 1,
      });
      // The new box holds the delivered part and the task file as the start commit held it.
      const work = w.boxes.boxes.get(BOX)?.copies.find((copy) => copy.to === "/work");
      expect(work?.listing).toContain("src/part.ts");
      expect(work?.listing).toContain(TASK_FILE);
      expect(w.log).toContain(`tree check against ${tip}`);
      expect(readBoxRun(w.runDir)?.finished).toBeUndefined();
      expect(await w.workers.has(RUN, w.runDir)).toBe("ready");
    }));

  it("tells the maintainer what the box was made from and that undelivered work is lost", () => {
    expect(boxRebuiltText("TASK-1", { had: "gone", parts: 2 })).toBe(
      "TASK-1's box was gone, so dipo made it again from the start commit and the 2 delivered parts on the story branch. Work the worker had not delivered as a part is lost.",
    );
    expect(boxRebuiltText("TASK-1", { had: "none", parts: 1 })).toContain(
      "TASK-1's run had no box (it started before every run ran in a box)",
    );
    expect(boxRebuiltText("TASK-1", { had: "none", parts: 1 })).toContain("the 1 delivered part ");
  });
});
