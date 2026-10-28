// One engine git step: a hardened call (see `hardened.ts`) through an injected executor, with the
// lock rule of 0010 section 7: a held `index.lock` or ref lock is retried three times with backoff,
// then the step fails. Lock files are never deleted; another git process owns them.
//
// Every step has a deadline on the runner's clock (DIPO-314): `GIT_STEP_DEADLINE_MS` (120 s) by
// default, `EXTERNAL_STEP_TIMEOUT_MS` (60 s) for the steps that may wait on something outside the
// engine (a commit that signs, a fetch or push that authenticates). git starts in its own process
// group; past the deadline the group gets SIGTERM, so git removes the lock files it holds, and
// SIGKILL after `KILL_GRACE_MS` when it has not exited. The step fails with `git.timedOut` once
// git exited or the grace passed, naming the command, the deadline and the lock file it may have
// left, so no git step holds the office git queue for longer.

import type { Clock, Spawn, TimerHandle } from "@dipsaus-orchestrator/contract";

import { systemClock } from "../platform/clock";
import { KILL_GRACE_MS, terminateChild, timedOutText, trackEngineCall } from "../platform/deadline";

import { type GitLocation, hardenedArgs, hardenedCwd, hardenedEnv } from "./hardened";

/** Per-step additions to the hardened call: command-line config and environment. */
export interface GitStepOptions {
  readonly config?: readonly (readonly [string, string])[];
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Kills the step after this long on the runner's clock and fails it with `git.timedOut`;
   * `GIT_STEP_DEADLINE_MS` when absent. Steps that may wait on something outside the engine (a
   * signing program, a credential prompt) pass `EXTERNAL_STEP_TIMEOUT_MS`.
   */
  readonly timeoutMs?: number;
  /** Text written to git's stdin, for `--stdin` reads; git gets no stdin when absent. */
  readonly stdin?: string;
}

/** One git process to start: the arguments after `git`, its environment and working directory. */
export interface GitCall {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /** Text written to git's stdin, which is then closed; no stdin when absent. */
  readonly stdin?: string;
  /** Aborted when the step timed out; the executor ends the process and its group. */
  readonly signal?: AbortSignal;
  /** The clock the executor's grace between SIGTERM and SIGKILL runs on; the system clock by default. */
  readonly clock?: Clock;
}

export interface GitResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one git process. The real one spawns git; unit tests pass a fake. */
export type GitExec = (call: GitCall) => Promise<GitResult>;

/** The executor that spawns `git` (or the absolute path the daemon resolved) through `spawn`. */
export function spawnGitExec(spawn: Spawn, git = "git"): GitExec {
  return async (call) => {
    // Its own process group, so a step killed at its deadline takes what it started along.
    const child = spawn({
      cmd: [git, ...call.args],
      cwd: call.cwd,
      env: call.env,
      detached: true,
      ...(call.stdin === undefined ? {} : { stdin: "pipe" as const }),
    });
    trackEngineCall(child);
    if (call.stdin !== undefined) {
      child.stdin?.write(call.stdin);
      child.stdin?.end();
    }
    const end = () => void terminateChild(child, call.clock ?? systemClock);
    if (call.signal?.aborted === true) end();
    else call.signal?.addEventListener("abort", end, { once: true });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code: exit.code, stdout, stderr };
  };
}

/** A git failure the engine reports; `retryable` is true only when the same step may succeed later. */
export class GitError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "GitError";
  }
}

/** Backoff before each lock retry: three retries, then the step fails (0010 section 7). */
export const LOCK_RETRY_DELAYS_MS: readonly number[] = [100, 400, 1600];

const LOCK_HELD = /Unable to create '([^']+\.lock)': File exists/;

/** The lock file a failed git call names as held, or null when it failed for another reason. */
export function heldLock(stderr: string): string | null {
  return LOCK_HELD.exec(stderr)?.[1] ?? null;
}

/** Waits `ms`; built on the injected clock so tests control it. */
export type Sleep = (ms: number) => Promise<void>;

export function clockSleep(clock: Clock): Sleep {
  return (ms) =>
    new Promise((resolve) => {
      clock.setTimeout(resolve, ms);
    });
}

export interface GitStepRunner {
  readonly exec: GitExec;
  /** The daemon's environment, which every hardened call starts from. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly sleep: Sleep;
  /** The clock step deadlines run on; the system clock when absent. */
  readonly clock?: Clock;
}

/** The `git.timedOut` error of a step: the command, the deadline and the lock it may have left. */
export function gitTimedOut(args: readonly string[], timeoutMs: number): GitError {
  return new GitError(
    "git.timedOut",
    `${timedOutText(["git", ...args], timeoutMs)}. A lock file it held (\`index.lock\` or a ref's \`.lock\`) may be left behind; dipo never deletes lock files, so remove it by hand when no git process runs.`,
    false,
    { args: [...args], timeoutMs },
  );
}

/**
 * Runs one call, ended and failed with `git.timedOut` after `timeoutMs` on the runner's clock:
 * the executor sends SIGTERM, then SIGKILL; the step fails once git exited or the grace passed.
 */
async function execWithTimeout(
  runner: GitStepRunner,
  call: GitCall,
  args: readonly string[],
  timeoutMs: number = GIT_STEP_DEADLINE_MS,
): Promise<GitResult> {
  const clock = runner.clock ?? systemClock;
  const controller = new AbortController();
  const running = runner.exec({ ...call, signal: controller.signal, clock });
  let timer: TimerHandle | undefined;
  let fired = false;
  const timedOut = new Promise<never>((_, reject) => {
    timer = clock.setTimeout(() => {
      timer = undefined;
      fired = true;
      controller.abort();
      const grace = new Promise<void>((resolve) => clock.setTimeout(resolve, KILL_GRACE_MS));
      const ended = running.then(
        () => undefined,
        () => undefined,
      );
      void Promise.race([ended, grace]).then(() => reject(gitTimedOut(args, timeoutMs)));
    }, timeoutMs);
  });
  try {
    // A killed git may leave a child (a signing program) holding its pipes, so the step does not
    // wait for the process's output past the grace.
    // A git that exits on its SIGTERM still timed out.
    const settled = running.then(
      (result) => (fired ? timedOut : result),
      (error: unknown) => (fired ? timedOut : Promise.reject(error)),
    );
    return await Promise.race([settled, timedOut]);
  } finally {
    if (timer !== undefined) clock.clearTimeout(timer);
  }
}

/**
 * Runs one hardened git step and returns its result, whatever the exit code, except that a held
 * lock is retried after each delay in `LOCK_RETRY_DELAYS_MS`; still held after the last retry, the
 * step fails with `git.lockHeld`.
 */
export async function runGitStep(
  runner: GitStepRunner,
  location: GitLocation,
  args: readonly string[],
  options: GitStepOptions = {},
): Promise<GitResult> {
  const call: GitCall = {
    args: hardenedArgs(location, args, options.config),
    env: hardenedEnv(runner.env, location, options.env),
    cwd: hardenedCwd(location),
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
  };
  for (let attempt = 0; ; attempt += 1) {
    const result = await execWithTimeout(runner, call, args, options.timeoutMs);
    const lock = result.code === 0 ? null : heldLock(result.stderr);
    if (lock === null) return result;
    const delay = LOCK_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      throw new GitError(
        "git.lockHeld",
        `git ${args.join(" ")} failed: ${lock} is held by another git process after ${LOCK_RETRY_DELAYS_MS.length} retries; dipo never deletes lock files.`,
        false,
        { lock, args: [...args] },
      );
    }
    await runner.sleep(delay);
  }
}

/** Like `runGitStep`, but a non-zero exit throws `git.failed` with git's message. */
export async function runGitStepOk(
  runner: GitStepRunner,
  location: GitLocation,
  args: readonly string[],
  options: GitStepOptions = {},
): Promise<string> {
  const result = await runGitStep(runner, location, args, options);
  if (result.code !== 0) {
    throw new GitError(
      "git.failed",
      `git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
      false,
      { args: [...args], code: result.code, stderr: result.stderr },
    );
  }
  return result.stdout;
}

/**
 * The timeout of engine git steps that may wait on something outside the engine: a commit that
 * signs, a fetch or push that authenticates. Such a step never holds the office queue forever.
 */
export const EXTERNAL_STEP_TIMEOUT_MS = 60_000;

/**
 * The deadline of every other engine git step (DIPO-314): 120 s, so a step that hangs (a held
 * file, a stuck filesystem) never holds the office queue forever, while a large local checkout
 * still fits.
 */
export const GIT_STEP_DEADLINE_MS = 120_000;

/** True when `error` is a step killed by its timeout. */
export function isTimedOut(error: unknown): error is GitError {
  return error instanceof GitError && error.code === "git.timedOut";
}
