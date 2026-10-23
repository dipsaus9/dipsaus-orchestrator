// Engine git without processes (DIPO-31): version parsing, the hardened call, the serial queue
// and the lock retry, each with a fake executor.

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import {
  BASE_CHECKOUT_CONFIG,
  BASE_CHECKOUT_ENV,
  checkGitVersion,
  FETCH_CONFIG,
  DROPPED_GIT_ENV,
  EXTERNAL_STEP_TIMEOUT_MS,
  GitError,
  type GitCall,
  type GitExec,
  type GitLocation,
  GitQueue,
  type GitResult,
  hardenedArgs,
  hardenedEnv,
  heldLock,
  isInside,
  isTimedOut,
  LOCK_RETRY_DELAYS_MS,
  OfficeGit,
  parseGitVersion,
  runGitStep,
} from "../../src/git";
import { KILL_GRACE_MS } from "../../src/platform/deadline";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z00000001" as OfficeId;
const REPO: GitLocation = { kind: "repository", commonDir: "/repo/.git" };

/** Yields to queued promise callbacks a few times, so concurrent items get a chance to run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("git version", () => {
  it("refuses 2.37.1 and accepts 2.38.0 and an Apple Git suffix", () => {
    expect(checkGitVersion("git version 2.37.1\n")).toContain("git 2.37.1 is older than 2.38");
    expect(checkGitVersion("git version 2.38.0\n")).toBeNull();
    expect(checkGitVersion("git version 2.50.1 (Apple Git-155)\n")).toBeNull();
    expect(parseGitVersion("git version 2.50.1 (Apple Git-155)")).toMatchObject({
      major: 2,
      minor: 50,
      patch: 1,
      text: "2.50.1 (Apple Git-155)",
    });
  });

  it("accepts later majors and Windows suffixes, and refuses text that is not a version", () => {
    expect(checkGitVersion("git version 3.0.0")).toBeNull();
    expect(checkGitVersion("git version 2.45.2.windows.1")).toBeNull();
    expect(checkGitVersion("git version 1.9.5")).toContain("older than 2.38");
    expect(checkGitVersion("hub version 2.14.2")).toContain("not a git version");
  });
});

describe("hardened calls", () => {
  it("disable hooks and fsmonitor, and run repository calls bare", () => {
    expect(hardenedArgs(REPO, ["fetch", "origin"])).toEqual([
      "--no-pager",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.quotePath=off",
      "--bare",
      "fetch",
      "origin",
    ]);
    const worktree: GitLocation = {
      kind: "worktree",
      commonDir: "/repo/.git",
      gitDir: "/repo/.git/worktrees/_base",
      workTree: "/wt/_base",
    };
    expect(hardenedArgs(worktree, ["status"])).not.toContain("--bare");
    expect(hardenedArgs(REPO, ["fetch", "origin"], FETCH_CONFIG)).toContain(
      "protocol.ext.allow=never",
    );
    expect(hardenedArgs(REPO, ["worktree", "add"], BASE_CHECKOUT_CONFIG)).toEqual(
      expect.arrayContaining(["filter.lfs.process=", "filter.lfs.smudge="]),
    );
    expect(hardenedEnv({}, REPO, BASE_CHECKOUT_ENV)["GIT_LFS_SKIP_SMUDGE"]).toBe("1");
  });

  it("set GIT_DIR and GIT_COMMON_DIR from the recorded paths and drop inherited locations", () => {
    const inherited: Record<string, string> = {
      HOME: "/home/me",
      GIT_CONFIG_KEY_0: "core.sshCommand",
      GIT_CONFIG_VALUE_0: "planted",
      GIT_CONFIG_KEY_12: "credential.helper",
      GIT_CONFIG_VALUE_12: "planted",
      GIT_SSH: "/usr/bin/ssh",
      GIT_SSH_COMMAND: "ssh -i key",
      GIT_ASKPASS: "/usr/bin/askpass",
      SSH_ASKPASS: "/usr/bin/ssh-askpass",
    };
    for (const name of DROPPED_GIT_ENV) inherited[name] = "/planted";
    const env = hardenedEnv(inherited, {
      kind: "worktree",
      commonDir: "/repo/.git",
      gitDir: "/repo/.git/worktrees/_base",
      workTree: "/wt/_base",
    });
    expect(env).toMatchObject({
      HOME: "/home/me",
      GIT_SSH: "/usr/bin/ssh",
      GIT_SSH_COMMAND: "ssh -i key",
      GIT_ASKPASS: "/usr/bin/askpass",
      SSH_ASKPASS: "/usr/bin/ssh-askpass",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      GIT_PAGER: "cat",
      GIT_DIR: "/repo/.git/worktrees/_base",
      GIT_COMMON_DIR: "/repo/.git",
      GIT_WORK_TREE: "/wt/_base",
    });
    expect(env["GIT_INDEX_FILE"]).toBeUndefined();
    expect(env["GIT_CONFIG_PARAMETERS"]).toBeUndefined();
    for (const name of [
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GIT_CONFIG_KEY_12",
      "GIT_CONFIG_VALUE_12",
      "GIT_CONFIG_GLOBAL",
      "GIT_EXEC_PATH",
      "GIT_TEMPLATE_DIR",
      "GIT_REPLACE_REF_BASE",
      "GIT_SHALLOW_FILE",
      "GIT_ATTR_SOURCE",
    ]) {
      expect(env[name]).toBeUndefined();
    }
    const repo = hardenedEnv(inherited, REPO);
    expect(repo["GIT_DIR"]).toBe("/repo/.git");
    expect(repo["GIT_COMMON_DIR"]).toBe("/repo/.git");
    expect(repo["GIT_WORK_TREE"]).toBeUndefined();
  });
});

describe("worktree root containment", () => {
  it("treats the checkout itself and paths under it as inside", () => {
    expect(isInside("/a/repo", "/a/repo")).toBe(true);
    expect(isInside("/a/repo/wt", "/a/repo")).toBe(true);
    expect(isInside("/a/repo.worktrees", "/a/repo")).toBe(false);
    expect(isInside("/a/..repo", "/a")).toBe(true);
    expect(isInside("/b", "/a/repo")).toBe(false);
  });
});

describe("the office git queue", () => {
  it("never interleaves the steps of two submitted items", async () => {
    const log: string[] = [];
    const gates: (() => void)[] = [];
    const exec: GitExec = (call) =>
      new Promise<GitResult>((resolve) => {
        log.push(`start ${call.args.at(-1)}`);
        gates.push(() => {
          log.push(`end ${call.args.at(-1)}`);
          resolve({ code: 0, stdout: "", stderr: "" });
        });
      });
    const git = new OfficeGit({
      officeId: OFFICE,
      mainWorktree: "/repo",
      commonDir: "/repo/.git",
      settings: { remote: "origin" },
      runner: { exec, env: {}, sleep: async () => {} },
      clock: new ManualClock(),
    });
    const item = (name: string) =>
      git.run(async (session) => {
        await session.step(session.repository, ["step", `${name}1`]);
        await session.step(session.repository, ["step", `${name}2`]);
        return name;
      });
    const a = item("a");
    const b = item("b");
    expect(git.queue.pending).toBe(2);
    for (let i = 0; i < 4; i += 1) {
      await settle();
      expect(gates).toHaveLength(1);
      gates.shift()?.();
    }
    expect(await Promise.all([a, b])).toEqual(["a", "b"]);
    expect(log).toEqual([
      "start a1",
      "end a1",
      "start a2",
      "end a2",
      "start b1",
      "end b1",
      "start b2",
      "end b2",
    ]);
    expect(git.queue.pending).toBe(0);
  });

  it("runs items in submission order and keeps going after a failed one", async () => {
    const queue = new GitQueue();
    const order: string[] = [];
    const first = queue.run(async () => {
      await settle();
      order.push("first");
      throw new Error("boom");
    });
    const second = queue.run(async () => {
      order.push("second");
      return 2;
    });
    const failed = first.catch((thrown: unknown) => thrown);
    expect(await second).toBe(2);
    expect(((await failed) as Error).message).toBe("boom");
    expect(order).toEqual(["first", "second"]);
  });
});

describe("lock retry", () => {
  const lockMessage =
    "fatal: Unable to create '/repo/.git/worktrees/_base/index.lock': File exists.\n\nAnother git process seems to be running in this repository";

  function failingExec(
    failures: number,
    stderr = lockMessage,
  ): { exec: GitExec; calls: GitCall[] } {
    const calls: GitCall[] = [];
    return {
      calls,
      exec: async (call) => {
        calls.push(call);
        return calls.length <= failures
          ? { code: 128, stdout: "", stderr }
          : { code: 0, stdout: "ok\n", stderr: "" };
      },
    };
  }

  it("names the held lock from git's message, including a ref lock", () => {
    expect(heldLock(lockMessage)).toBe("/repo/.git/worktrees/_base/index.lock");
    expect(
      heldLock(
        "error: cannot lock ref 'refs/heads/x': Unable to create '/repo/.git/refs/heads/x.lock': File exists.",
      ),
    ).toBe("/repo/.git/refs/heads/x.lock");
    expect(heldLock("fatal: a branch named 'x' already exists")).toBeNull();
  });

  it("retries a held lock three times with growing backoff, then succeeds", async () => {
    const { exec, calls } = failingExec(3);
    const delays: number[] = [];
    const result = await runGitStep(
      { exec, env: {}, sleep: async (ms) => void delays.push(ms) },
      REPO,
      ["checkout", "x"],
    );
    expect(result.stdout).toBe("ok\n");
    expect(calls).toHaveLength(4);
    expect(delays).toEqual([...LOCK_RETRY_DELAYS_MS]);
    expect(delays).toEqual(delays.toSorted((x, y) => x - y));
  });

  it("fails the step after the third retry", async () => {
    const { exec, calls } = failingExec(10);
    const error = await runGitStep({ exec, env: {}, sleep: async () => {} }, REPO, [
      "checkout",
      "x",
    ]).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).code).toBe("git.lockHeld");
    expect((error as GitError).message).toContain("never deletes lock files");
    expect(calls).toHaveLength(1 + LOCK_RETRY_DELAYS_MS.length);
  });

  it("waits on the injected clock between retries", async () => {
    const clock = new ManualClock();
    const { exec, calls } = failingExec(1);
    const git = new OfficeGit({
      officeId: OFFICE,
      mainWorktree: "/repo",
      commonDir: "/repo/.git",
      settings: { remote: "origin", base: "main" },
      runner: {
        exec,
        env: {},
        sleep: (ms) => new Promise((resolve) => void clock.setTimeout(resolve, ms)),
      },
      clock,
    });
    const step = git.run((session) => session.ok(session.repository, ["fetch"]));
    await settle();
    expect(calls).toHaveLength(1);
    clock.advance((LOCK_RETRY_DELAYS_MS[0] ?? 0) - 1);
    await settle();
    expect(calls).toHaveLength(1);
    clock.advance(1);
    expect(await step).toBe("ok\n");
    expect(calls).toHaveLength(2);
  });

  it("does not retry other failures", async () => {
    const { exec, calls } = failingExec(1, "fatal: a branch named 'x' already exists");
    const result = await runGitStep({ exec, env: {}, sleep: async () => {} }, REPO, [
      "branch",
      "x",
    ]);
    expect(result.code).toBe(128);
    expect(calls).toHaveLength(1);
  });
});

function baseGit(base: string | undefined, symbolicRef: GitResult): OfficeGit {
  return new OfficeGit({
    officeId: OFFICE,
    mainWorktree: "/repo",
    commonDir: "/repo/.git",
    settings: { remote: "origin", ...(base === undefined ? {} : { base }) },
    runner: { exec: async () => symbolicRef, env: {}, sleep: async () => {} },
    clock: new ManualClock(),
  });
}

describe("the base", () => {
  it("is `base` from configuration first", async () => {
    const git = baseGit("trunk", { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" });
    expect(await git.resolveBase()).toBe("trunk");
  });

  it("is origin/HEAD's target without configuration", async () => {
    const git = baseGit(undefined, { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" });
    expect(await git.resolveBase()).toBe("main");
  });

  it("fails with a clear error with neither", async () => {
    const git = baseGit(undefined, { code: 1, stdout: "", stderr: "" });
    const error = (await git.resolveBase().catch((thrown: unknown) => thrown)) as GitError;
    expect(error.code).toBe("git.baseUnknown");
    expect(error.message).toContain("Set `base`");
  });

  it("resolves inside a running queue item with the same rule (DIPO-112)", async () => {
    const git = baseGit(undefined, { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" });
    expect(await git.run((session) => git.resolveBaseIn(session))).toBe("main");
    const configured = baseGit("trunk", { code: 1, stdout: "", stderr: "" });
    expect(await configured.run((session) => configured.resolveBaseIn(session))).toBe("trunk");
  });

  it("refuses an origin/HEAD that names no branch", async () => {
    const git = baseGit(undefined, { code: 0, stdout: "refs/remotes/origin/\n", stderr: "" });
    const error = (await git
      .run((session) => git.resolveBaseIn(session))
      .catch((thrown: unknown) => thrown)) as GitError;
    expect(error.code).toBe("git.baseUnknown");
  });
});

/** An executor whose process never ends unless the step's signal kills it. */
function hangingExec(): { exec: GitExec; killed: string[] } {
  const killed: string[] = [];
  return {
    killed,
    exec: (call) =>
      new Promise<GitResult>(() => {
        call.signal?.addEventListener("abort", () => killed.push(call.args.join(" ")));
      }),
  };
}

describe("step timeout", () => {
  it("kills a step after its timeout on the injected clock and fails it with git.timedOut", async () => {
    const clock = new ManualClock();
    const { exec, killed } = hangingExec();
    const step = runGitStep({ exec, env: {}, sleep: async () => {}, clock }, REPO, ["push"], {
      timeoutMs: EXTERNAL_STEP_TIMEOUT_MS,
    }).catch((error: unknown) => error);
    clock.advance(EXTERNAL_STEP_TIMEOUT_MS - 1);
    expect(killed).toEqual([]);
    clock.advance(1);
    // SIGTERM first; the step fails once the grace for git to remove its locks passed.
    expect(killed).toHaveLength(1);
    clock.advance(KILL_GRACE_MS);
    const error = (await step) as GitError;
    expect(isTimedOut(error)).toBe(true);
    expect(error.message).toContain("did not finish within its deadline of 60 s");
    expect(killed).toHaveLength(1);
  });

  it("records a fetch that timed out as a failed fetch", async () => {
    const clock = new ManualClock();
    const { exec } = hangingExec();
    const git = new OfficeGit({
      officeId: "off_x" as OfficeId,
      mainWorktree: "/repo",
      commonDir: "/repo/.git",
      settings: { remote: "origin", base: "main" },
      runner: {
        exec: (call) => {
          if (!call.args.includes("fetch"))
            return Promise.resolve({ code: 1, stdout: "", stderr: "" });
          // The fetch waits; time passes on the injected clock.
          queueMicrotask(() => clock.advance(EXTERNAL_STEP_TIMEOUT_MS + KILL_GRACE_MS));
          return exec(call);
        },
        env: {},
        sleep: async () => {},
      },
      clock,
    });
    const outcome = await git.fetch();
    expect(outcome.ok).toBe(false);
    expect(git.lastFetch).toMatchObject({ ok: false });
  });
});
