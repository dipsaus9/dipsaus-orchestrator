// dipo updates itself from the base commit of an office (DIPO-485, 0005, 0016). When an
// office's base has engine commits after the running build and nothing runs, the desk offers the
// update; its command pauses new starts, checks the base commit out in a dipo-owned worktree under
// `<state>/update`, runs `bun install --frozen-lockfile` and the repository's build script there,
// checks that the built binary runs and reports that commit, copies it beside the running binary
// and moves the copy over it (a new inode: writing over a running binary kills it), then restarts
// the daemon with `dipo daemon restart` from the new binary, the same command the maintainer runs.
// Any failure before the move keeps the old binary and lifts the pause. The commit built is the
// one read when the update began, so a base that moves during the build changes nothing.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";

import type { Clock, OfficeId, Spawn } from "@dipsaus-orchestrator/contract";

import { CommandError } from "../commands/errors";
import type { Logger } from "../log/logger";
import type { SpawnDetached } from "../platform/process";

/** How long each step may run before it is killed. */
export const UPDATE_TIMEOUTS_MS = {
  install: 10 * 60_000,
  build: 15 * 60_000,
  check: 30_000,
} as const;

/** The built binary, relative to the worktree: where `scripts/build.ts` writes it. */
export const BUILT_BINARY = join("dist", "dipo");

/** What the desk shows of an update: the engine commits after the build, newest first. */
export interface UpdateOffer {
  readonly commits: number;
  readonly titles: readonly string[];
}

/** What the update found when it began: the base commit it will build. */
export interface BehindFact {
  readonly commits: number;
  readonly tip: string;
  readonly titles: readonly string[];
}

/** The git steps of the update, on the office's own queue. */
export interface UpdateWorktrees {
  add(office: OfficeId, path: string, commit: string): Promise<void>;
  remove(office: OfficeId, path: string): Promise<void>;
}

export interface UpdateDeps {
  readonly clock: Clock;
  readonly logger: Pick<Logger, "info" | "warn">;
  readonly lifecycle: {
    readonly state: string;
    readonly updating: boolean;
    beginUpdate(): boolean;
    endUpdate(): void;
  };
  readonly spawn: Spawn;
  readonly spawnDetached: SpawnDetached;
  /** The daemon's environment; the build runs with it. */
  readonly env: Readonly<Record<string, string>>;
  /** Where dipo keeps its state; the update's worktrees live in `<home>/update`. */
  readonly home: string;
  /** The running executable, absent when dipo runs from source: then there is nothing to replace. */
  readonly binary: string | undefined;
  /** Where the restart's output goes. */
  readonly restartLog: string;
  /** The last read of the office's engine commits after the build; undefined when none. */
  readonly behind: (office: OfficeId) => BehindFact | undefined;
  /** The stories holding a run slot and the sessions open, over every loaded office. */
  readonly running: () => { readonly stories: number; readonly sessions: number };
  readonly worktrees: UpdateWorktrees;
  /** `bun`, when known; else found on `PATH` and in `~/.bun/bin`. */
  readonly bun?: string;
  readonly timeoutsMs?: typeof UPDATE_TIMEOUTS_MS;
}

export interface UpdateResult {
  /** The commit now installed, 12 characters. */
  readonly commit: string;
  readonly commits: number;
}

interface Finished {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly output: string;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

function tail(text: string, lines = 12): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

/** True when `target` lies inside `root`; both are already real paths. */
function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

/** Finds `bun` for the build: the daemon's `PATH`, then `~/.bun/bin`. */
export function findBun(env: Readonly<Record<string, string>>): string | null {
  const dirs = (env["PATH"] ?? "").split(delimiter).filter((dir) => dir !== "");
  if (env["HOME"] !== undefined) dirs.push(join(env["HOME"], ".bun", "bin"));
  for (const dir of dirs) {
    const candidate = join(dir, "bun");
    if (isAbsolute(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

export class SelfUpdate {
  readonly #deps: UpdateDeps;

  constructor(deps: UpdateDeps) {
    this.#deps = deps;
  }

  /** What is running: stories and sessions over every loaded office, as text; null when idle. */
  busy(): string | null {
    const { stories, sessions } = this.#deps.running();
    const parts = [
      stories === 0 ? "" : `${stories} ${stories === 1 ? "story run" : "story runs"}`,
      sessions === 0 ? "" : `${sessions} ${sessions === 1 ? "session" : "sessions"}`,
    ].filter((part) => part !== "");
    return parts.length === 0 ? null : parts.join(" and ");
  }

  /** The update the desk offers for `office`: behind the build, idle and replaceable; else null. */
  offer(office: OfficeId): UpdateOffer | null {
    const { binary, lifecycle } = this.#deps;
    if (binary === undefined || lifecycle.state !== "running" || lifecycle.updating) return null;
    const behind = this.#deps.behind(office);
    if (behind === undefined || behind.commits === 0 || this.busy() !== null) return null;
    return { commits: behind.commits, titles: behind.titles };
  }

  /** Runs the update of `office`; throws `CommandError` with `update.refused` or `update.failed`. */
  async run(office: OfficeId): Promise<UpdateResult> {
    const { lifecycle, binary } = this.#deps;
    if (binary === undefined) {
      throw this.#refused(
        "unavailable",
        "dipo runs from source; only a built binary updates itself",
      );
    }
    if (lifecycle.state !== "running") {
      throw this.#refused("unavailable", `the daemon is ${lifecycle.state}; update when it runs`);
    }
    // Pause first, then look: a start that slips in between would otherwise run during the swap.
    if (!lifecycle.beginUpdate()) throw this.#refused("updating", "dipo is already updating");
    let replaced = false;
    try {
      const busy = this.busy();
      if (busy !== null) throw this.#refused("busy", `not while anything runs: ${busy}`);
      const behind = this.#deps.behind(office);
      if (behind === undefined || behind.commits === 0) {
        throw this.#refused("current", "the base has no engine commits after this build");
      }
      // The commit built is this one, whatever the base does meanwhile.
      const result = await this.#build(office, behind, binary);
      replaced = true;
      return result;
    } finally {
      // A replaced binary keeps the pause: the daemon restarts at once and ends with it.
      if (!replaced) lifecycle.endUpdate();
    }
  }

  async #build(office: OfficeId, behind: BehindFact, binary: string): Promise<UpdateResult> {
    const { logger } = this.#deps;
    const commit = behind.tip.slice(0, 12);
    const worktree = this.#freshWorktreePath(commit);
    let added = false;
    try {
      try {
        await this.#deps.worktrees.add(office, worktree, behind.tip);
        added = true;
      } catch (error) {
        throw this.#failed(`checking out ${commit} failed: ${messageOf(error)}`);
      }
      this.#insideHome(worktree);
      const bun = this.#deps.bun ?? findBun(this.#deps.env);
      if (bun === null) throw this.#failed("bun was not found on PATH or in ~/.bun/bin");
      const timeouts = this.#deps.timeoutsMs ?? UPDATE_TIMEOUTS_MS;
      await this.#step(
        "install",
        [bun, "install", "--frozen-lockfile"],
        worktree,
        timeouts.install,
      );
      await this.#step("build", [bun, "run", "build"], worktree, timeouts.build);
      const built = this.#builtBinary(worktree);
      await this.#check(built, behind.tip, worktree, timeouts.check);
      const target = this.#replace(built, binary);
      logger.info("dipo binary replaced", { commit, binary: target });
      this.#restart(target);
      return { commit, commits: behind.commits };
    } finally {
      await this.#removeWorktree(office, worktree, added);
    }
  }

  /** `<home>/update/<commit>`, real and inside the home; a leftover of an earlier try is removed. */
  #freshWorktreePath(commit: string): string {
    const { home } = this.#deps;
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const dir = join(home, "update");
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
      throw this.#failed(`${dir} is a link; dipo keeps its update worktrees in its own folder`);
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const real = realpathSync(dir);
    if (!within(realpathSync(home), real)) {
      throw this.#failed(`${dir} resolves outside dipo's home`);
    }
    const path = join(real, commit);
    // A link is never followed or used; a folder of an earlier try is removed whole.
    if (isLink(path)) throw this.#failed(`${path} is a link; dipo leaves it alone`);
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    return path;
  }

  #insideHome(path: string): void {
    const real = realpathSync(path);
    if (!within(realpathSync(this.#deps.home), real)) {
      throw this.#failed(`${path} resolves outside dipo's home`);
    }
  }

  async #step(
    name: string,
    cmd: readonly [string, ...string[]],
    cwd: string,
    timeoutMs: number,
  ): Promise<string> {
    const done = await this.#run(cmd, cwd, timeoutMs);
    if (done.timedOut)
      throw this.#failed(`${name} timed out after ${Math.round(timeoutMs / 1000)} s`);
    if (done.code !== 0) {
      throw this.#failed(`${name} failed (exit ${done.code ?? "signal"}): ${tail(done.output)}`);
    }
    return done.output;
  }

  async #run(
    cmd: readonly [string, ...string[]],
    cwd: string,
    timeoutMs: number,
  ): Promise<Finished> {
    const { clock } = this.#deps;
    let child;
    try {
      child = this.#deps.spawn({ cmd, cwd, env: this.#deps.env, detached: true });
    } catch (error) {
      return { code: null, timedOut: false, output: messageOf(error) };
    }
    let timedOut = false;
    const timer = clock.setTimeout(() => {
      timedOut = true;
      if (child.killGroup !== undefined) child.killGroup("SIGKILL");
      else child.kill("SIGKILL");
    }, timeoutMs);
    try {
      const [out, err, exit] = await Promise.all([
        drain(child.stdout),
        drain(child.stderr),
        child.exited,
      ]);
      return { code: exit.code, timedOut, output: `${out}\n${err}` };
    } finally {
      clock.clearTimeout(timer);
    }
  }

  /** The built binary: a regular executable file inside the worktree, not a link out of it. */
  #builtBinary(worktree: string): string {
    const path = join(worktree, BUILT_BINARY);
    if (!existsSync(path)) throw this.#failed(`the build wrote no ${BUILT_BINARY}`);
    const real = realpathSync(path);
    if (!within(realpathSync(worktree), real)) {
      throw this.#failed(`${BUILT_BINARY} is a link out of the build worktree`);
    }
    const stat = lstatSync(real);
    if (!stat.isFile() || (stat.mode & 0o111) === 0) {
      throw this.#failed(`${BUILT_BINARY} is not an executable file`);
    }
    return real;
  }

  /** Runs the built binary: it must start and report the commit that was checked out. */
  async #check(built: string, tip: string, cwd: string, timeoutMs: number): Promise<void> {
    const done = await this.#run([built, "--version", "--json"], cwd, timeoutMs);
    if (done.timedOut || done.code !== 0) {
      throw this.#failed(`the built binary does not run: ${tail(done.output, 4)}`);
    }
    let reported: unknown;
    try {
      reported = (JSON.parse(done.output.trim().split("\n")[0] ?? "") as { commit?: unknown })
        .commit;
    } catch {
      throw this.#failed("the built binary printed no version");
    }
    if (typeof reported !== "string" || reported === "" || !tip.startsWith(reported)) {
      throw this.#failed(
        `the built binary reports commit ${JSON.stringify(reported)}, not ${tip.slice(0, 12)}`,
      );
    }
  }

  /** Copies `built` beside `binary` and moves the copy over it: a new inode, never a write over it. */
  #replace(built: string, binary: string): string {
    let target: string;
    try {
      target = realpathSync(binary);
    } catch (error) {
      throw this.#failed(`the running binary is gone: ${messageOf(error)}`);
    }
    const staged = join(dirname(target), `.dipo-update-${process.pid}-${this.#deps.clock.now()}`);
    try {
      copyFileSync(built, staged);
      chmodSync(staged, 0o755);
      renameSync(staged, target);
    } catch (error) {
      rmSync(staged, { force: true });
      throw this.#failed(`replacing ${target} failed: ${messageOf(error)}`);
    }
    return target;
  }

  /** `dipo daemon restart` from the new binary, detached: it drains this daemon and starts it. */
  #restart(binary: string): void {
    try {
      this.#deps.spawnDetached({
        cmd: [binary, "daemon", "restart"],
        cwd: dirname(binary),
        env: this.#deps.env,
        outputFile: this.#deps.restartLog,
      });
    } catch (error) {
      // The binary is replaced but nothing restarts: say so, the maintainer runs the command.
      this.#deps.lifecycle.endUpdate();
      throw this.#failed(
        `the binary was replaced but \`dipo daemon restart\` did not start (${messageOf(error)}); run it`,
      );
    }
  }

  async #removeWorktree(office: OfficeId, path: string, added: boolean): Promise<void> {
    try {
      if (added) await this.#deps.worktrees.remove(office, path);
    } catch (error) {
      this.#deps.logger.warn("the update worktree was not removed by git", {
        path,
        error: messageOf(error),
      });
    }
    try {
      if (existsSync(path) || isLink(path)) rmSync(path, { recursive: true, force: true });
    } catch (error) {
      this.#deps.logger.warn("the update worktree was not removed", {
        path,
        error: messageOf(error),
      });
    }
  }

  #refused(reason: string, message: string): CommandError {
    return new CommandError("update.refused", `dipo does not update: ${message}.`, { reason });
  }

  #failed(message: string): CommandError {
    this.#deps.logger.warn("dipo update failed", { message });
    return new CommandError(
      "update.failed",
      `dipo did not update; the old binary stays: ${message}`,
    );
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
