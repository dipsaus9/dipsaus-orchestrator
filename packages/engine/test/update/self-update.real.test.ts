// `daemon.update` run for real (DIPO-485): the registered command, a real git repository as the
// office, a real worktree, the real `bun install --frozen-lockfile` and a stand-in build script.
// Whatever fails, the old binary stays byte for byte and the daemon stays on it, starts allowed.

import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { withTempRepo, type TempRepo } from "@dipsaus-orchestrator/testkit";

import { buildRegistry } from "../../src/commands/registry";
import { controlFeature } from "../../src/create/control";
import { DaemonLifecycle } from "../../src/create/lifecycle";
import { lifecycleGate } from "../../src/create/surface";
import { createLogger } from "../../src/log/logger";
import { systemClock } from "../../src/platform/clock";
import { systemSpawn } from "../../src/platform/process";
import { SelfUpdate } from "../../src/update/self-update";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z00000001" as OfficeId;
const OLD = "#!/bin/sh\necho old\n";

/** A repository whose `build` script is `build`, with a lockfile that matches its package.json. */
async function office(repo: TempRepo, build: string, options: { stale?: boolean } = {}) {
  writeFileSync(
    join(repo.dir, "package.json"),
    JSON.stringify({ name: "fixture", version: "0.0.0", scripts: { build } }),
  );
  const env = { ...repo.env, PATH: process.env["PATH"] ?? "/usr/bin:/bin" };
  const installed = Bun.spawnSync([process.execPath, "install"], { cwd: repo.dir, env });
  expect(installed.exitCode).toBe(0);
  const first = await repo.commitAll("first");
  if (options.stale === true) {
    // package.json moved on without its lockfile: the frozen install must refuse it.
    writeFileSync(
      join(repo.dir, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "0.0.0",
        scripts: { build },
        dependencies: { "left-pad": "1.3.0" },
      }),
    );
  } else {
    writeFileSync(join(repo.dir, "engine.txt"), "changed");
  }
  const tip = await repo.commitAll("second");
  return { first, tip, env };
}

async function run(
  repo: TempRepo,
  options: { build: string; stale?: boolean },
  body: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>,
) {
  await body(await setup(repo, options));
}

async function setup(repo: TempRepo, options: { build: string; stale?: boolean }) {
  const { tip, env } = await office(repo, options.build, { stale: options.stale === true });
  const home = join(repo.root, "state");
  const binary = join(repo.root, "dipo");
  Bun.spawnSync(["mkdir", "-p", home]);
  writeFileSync(binary, OLD);
  chmodSync(binary, 0o755);
  const lifecycle = new DaemonLifecycle();
  lifecycle.transition("recovering", "test");
  lifecycle.transition("running", "test");
  const restarts: unknown[] = [];
  const update = new SelfUpdate({
    clock: systemClock,
    logger: createLogger({ clock: systemClock, sinks: [], component: "test" }),
    lifecycle,
    spawn: systemSpawn,
    spawnDetached: (spawn) => {
      restarts.push(spawn);
      return { pid: 1 };
    },
    env,
    home,
    binary,
    restartLog: join(repo.root, "update.log"),
    behind: () => ({ commits: 1, tip, titles: ["second"] }),
    running: () => ({ stories: 0, sessions: 0 }),
    worktrees: {
      add: async (_office, path, commit) => {
        await repo.git("worktree", "add", "--detach", path, commit);
      },
      remove: async (_office, path) => {
        await repo.git("worktree", "remove", "--force", path);
      },
    },
    bun: process.execPath,
  });
  const clock = systemClock;
  const registry = buildRegistry([
    controlFeature({
      lifecycle,
      logger: createLogger({ clock, sinks: [], component: "test" }),
      clock,
      startedAt: clock.now(),
      pid: 4242,
      version: "0.0.0-test",
      buildCommit: "oldoldoldold",
      socket: "/s",
      tools: {},
      upgradePending: () => false,
      loadedOffices: () => [OFFICE],
      update: (id) => update.run(id),
      requestStop: () => {},
    }),
  ]);
  const command = registry.command("daemon.update");
  if (command === undefined || command.level !== "software") throw new Error("not registered");
  const send = () =>
    (command.handle as unknown as (ctx: unknown, args: unknown) => Promise<unknown>)(
      {},
      { office: OFFICE },
    );
  const status = () => {
    const read = registry.read("daemon.status");
    if (read === undefined) throw new Error("no status");
    return (
      read.handle as (
        ctx: unknown,
        args: unknown,
      ) => { state: string; pid: number; buildCommit?: string }
    )({}, {});
  };
  return { send, status, binary, lifecycle, restarts, home, tip };
}

describe("daemon.update for real, fail closed (DIPO-485)", () => {
  it("leaves the old binary byte for byte and the daemon on it when the build fails", () =>
    withTempRepo((repo) =>
      run(repo, { build: "echo stand-in build failing >&2; exit 1" }, async (f) => {
        const before = statSync(f.binary);
        await expect(f.send()).rejects.toMatchObject({
          error: { code: "update.failed", message: expect.stringContaining("build failed") },
        });
        expect(readFileSync(f.binary, "utf8")).toBe(OLD);
        expect(statSync(f.binary).ino).toBe(before.ino);
        expect(f.restarts).toEqual([]);
        // The daemon is still on its own build, running, and starts are allowed again.
        expect(f.status()).toMatchObject({
          state: "running",
          pid: 4242,
          buildCommit: "oldoldoldold",
        });
        expect(f.lifecycle.updating).toBe(false);
        expect(lifecycleGate(f.lifecycle, "command", "work.run")).toBeNull();
        expect(existsSync(join(f.home, "update", f.tip.slice(0, 12)))).toBe(false);
      }),
    ));

  it("refuses a lockfile that does not match package.json: the frozen install fails", () =>
    withTempRepo((repo) =>
      run(repo, { build: "exit 0", stale: true }, async (f) => {
        await expect(f.send()).rejects.toMatchObject({
          error: { code: "update.failed", message: expect.stringContaining("install failed") },
        });
        expect(readFileSync(f.binary, "utf8")).toBe(OLD);
        expect(f.restarts).toEqual([]);
        expect(f.lifecycle.updating).toBe(false);
      }),
    ));
});
