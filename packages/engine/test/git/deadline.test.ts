// Every git step's deadline (DIPO-314): a step without its own deadline is killed after
// `GIT_STEP_DEADLINE_MS` on the runner's clock and fails with `git.timedOut`; commit, push and
// fetch keep `EXTERNAL_STEP_TIMEOUT_MS`. The spawning executor starts git in its own process group
// and kills the group, and a timed-out step frees its office git queue item.

import { describe, expect, it } from "bun:test";

import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { GitLocation } from "../../src/git/hardened";
import { GitQueue } from "../../src/git/queue";
import {
  EXTERNAL_STEP_TIMEOUT_MS,
  GIT_STEP_DEADLINE_MS,
  type GitError,
  isTimedOut,
  runGitStep,
  spawnGitExec,
} from "../../src/git/runner";
import { resolveRepository } from "../../src/office/repository";
import { KILL_GRACE_MS } from "../../src/platform/deadline";
import { hangingSpawn, settle } from "../platform/hanging";

const REPO: GitLocation = { kind: "repository", commonDir: "/repo/.git" };

describe("the default deadline of a git step", () => {
  it("kills a step that never ends after 120 s and fails it with git.timedOut", async () => {
    const clock = new ManualClock();
    const hang = hangingSpawn();
    const exec = spawnGitExec(hang.spawn, "git");
    let settled = false;
    const step = runGitStep({ exec, env: {}, sleep: async () => {}, clock }, REPO, [
      "rev-parse",
      "HEAD",
    ])
      .catch((error: unknown) => error)
      .finally(() => (settled = true));
    await settle();
    expect(GIT_STEP_DEADLINE_MS).toBe(120_000);
    expect(hang.calls[0]?.detached).toBe(true);
    clock.advance(GIT_STEP_DEADLINE_MS - 1);
    await settle();
    expect(settled).toBe(false);

    clock.advance(1);
    await settle();
    // SIGTERM first, so git removes its lock files; the step waits for the grace.
    expect(hang.children[0]?.groupSignals).toEqual(["SIGTERM"]);
    expect(settled).toBe(false);
    clock.advance(KILL_GRACE_MS);
    const error = (await step) as GitError;
    expect(isTimedOut(error)).toBe(true);
    expect(error.message).toBe(
      "`git rev-parse HEAD` did not finish within its deadline of 120 s; dipo stopped it and its process group. A lock file it held (`index.lock` or a ref's `.lock`) may be left behind; dipo never deletes lock files, so remove it by hand when no git process runs.",
    );
    expect(error.details).toEqual({ args: ["rev-parse", "HEAD"], timeoutMs: GIT_STEP_DEADLINE_MS });
    // The executor killed git's whole group.
    // It ignored SIGTERM, so it got SIGKILL after the grace.
    expect(hang.children[0]?.groupSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(hang.children[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("keeps the 60 s deadline a step passes for itself", async () => {
    const clock = new ManualClock();
    const hang = hangingSpawn();
    const step = runGitStep(
      { exec: spawnGitExec(hang.spawn), env: {}, sleep: async () => {}, clock },
      REPO,
      ["push", "origin", "x"],
      { timeoutMs: EXTERNAL_STEP_TIMEOUT_MS },
    ).catch((error: unknown) => error);
    await settle();
    clock.advance(EXTERNAL_STEP_TIMEOUT_MS + KILL_GRACE_MS);
    expect(isTimedOut(await step)).toBe(true);
  });

  it("frees the office git queue item, so the next item runs", async () => {
    const clock = new ManualClock();
    const hang = hangingSpawn();
    const runner = { exec: spawnGitExec(hang.spawn), env: {}, sleep: async () => {}, clock };
    const queue = new GitQueue();
    const first = queue
      .run(() => runGitStep(runner, REPO, ["status"]))
      .catch((error: unknown) => error);
    const second = queue.run(async () => "next");
    await settle();
    expect(queue.pending).toBe(2);
    clock.advance(GIT_STEP_DEADLINE_MS + KILL_GRACE_MS);
    expect(isTimedOut(await first)).toBe(true);
    expect(await second).toBe("next");
    expect(queue.pending).toBe(0);
  });

  it("fails the step as soon as git exits on its SIGTERM, with no SIGKILL", async () => {
    const clock = new ManualClock();
    const hang = hangingSpawn(undefined, "SIGTERM");
    const step = runGitStep(
      { exec: spawnGitExec(hang.spawn), env: {}, sleep: async () => {}, clock },
      REPO,
      ["status"],
    ).catch((error: unknown) => error);
    await settle();
    clock.advance(GIT_STEP_DEADLINE_MS);
    // A git that ends on SIGTERM still timed out, before the grace is over.
    expect(isTimedOut(await step)).toBe(true);
    expect(hang.children[0]?.signals).toEqual(["SIGTERM"]);
    clock.advance(KILL_GRACE_MS);
    expect(hang.children[0]?.signals).toEqual(["SIGTERM"]);
  });
});

describe("the deadline of repository discovery", () => {
  it("fails a discovery git call that never ends with git.timedOut", async () => {
    const clock = new ManualClock();
    const hang = hangingSpawn();
    const resolved = resolveRepository(
      { spawn: hang.spawn, env: {}, clock },
      process.env["DIPO_TMP"] || "/tmp",
    ).catch((error: unknown) => error);
    await settle();
    expect(hang.calls[0]?.detached).toBe(true);
    clock.advance(GIT_STEP_DEADLINE_MS + KILL_GRACE_MS);
    expect(isTimedOut(await resolved)).toBe(true);
    expect(hang.children[0]?.groupSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
