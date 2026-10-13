// One engine git step: a hardened call (see `hardened.ts`) through an injected executor, with the
// lock rule of 0010 section 7: a held `index.lock` or ref lock is retried three times with backoff,
// then the step fails. Lock files are never deleted; another git process owns them.

import type { Clock, Spawn, TimerHandle } from "@dipsaus-orchestrator/contract";

import { type GitLocation, hardenedArgs, hardenedCwd, hardenedEnv } from "./hardened";

/** Per-step additions to the hardened call: command-line config and environment. */
export interface GitStepOptions {
  readonly config?: readonly (readonly [string, string])[];
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Kills the step after this long on the runner's clock and fails it with `git.timedOut`. For
   * steps that may wait on something outside the engine: a signing program, a credential prompt.
   */
  readonly timeoutMs?: number;
}

/** One git process to start: the arguments after `git`, its environment and working directory. */
export interface GitCall {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /** Aborted when the step timed out; the executor kills the process. */
  readonly signal?: AbortSignal;
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
    const child = spawn({ cmd: [git, ...call.args], cwd: call.cwd, env: call.env });
    if (call.signal?.aborted === true) child.kill("SIGKILL");
    else call.signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
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
  /** The clock step timeouts run on; a step with `timeoutMs` needs it. */
  readonly clock?: Clock;
}

/** Runs one call, killed and failed with `git.timedOut` after `timeoutMs` on `clock`. */
async function execWithTimeout(
  runner: GitStepRunner,
  call: GitCall,
  args: readonly string[],
  timeoutMs: number | undefined,
): Promise<GitResult> {
  if (timeoutMs === undefined) return runner.exec(call);
  const clock = runner.clock;
  if (clock === undefined) throw new Error("a git step with a timeout needs the runner's clock");
  const controller = new AbortController();
  let timer: TimerHandle | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = clock.setTimeout(() => {
      controller.abort();
      reject(
        new GitError(
          "git.timedOut",
          `git ${args.join(" ")} did not finish within ${Math.round(timeoutMs / 1000)} s and was killed.`,
          false,
          { args: [...args], timeoutMs },
        ),
      );
    }, timeoutMs);
  });
  try {
    // A killed git may leave a child (a signing program) holding its pipes, so the step does not
    // wait for the process's output once the timeout fired.
    return await Promise.race([runner.exec({ ...call, signal: controller.signal }), timedOut]);
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

/** True when `error` is a step killed by its timeout. */
export function isTimedOut(error: unknown): error is GitError {
  return error instanceof GitError && error.code === "git.timedOut";
}
