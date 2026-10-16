// One office's git (0010 sections 2 and 7): its serial queue, the base and remote, the worktree
// root, the detached `_base` read worktree at `origin/<base>`, and the fetch state that gates
// pickup and planning pushes. Every call is hardened (`hardened.ts`) and runs either on the
// repository without a work tree (`git --bare`, with the recorded common dir) or in a worktree
// the engine owns (with its recorded administrative directory). The maintainer's main checkout is
// never a work tree of any engine call, so the engine never writes it.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Clock, OfficeId } from "@dipsaus-orchestrator/contract";

import {
  BASE_CHECKOUT_CONFIG,
  BASE_CHECKOUT_ENV,
  FETCH_CONFIG,
  type GitLocation,
  WORKTREE_ADD_CONFIG,
} from "./hardened";
import { BASE_WORKTREE, canonicalFuturePath, resolveWorktreeRoot } from "./paths";
import { GitQueue } from "./queue";
import {
  EXTERNAL_STEP_TIMEOUT_MS,
  GitError,
  type GitResult,
  isTimedOut,
  type GitStepOptions,
  runGitStep,
  runGitStepOk,
  type GitStepRunner,
} from "./runner";
import { changedLinks, type WorktreeSnapshot, worktreeTampered } from "./snapshot";

const BASE_CHECKOUT: GitStepOptions = { config: BASE_CHECKOUT_CONFIG, env: BASE_CHECKOUT_ENV };

/** The office configuration git reads (0010 section 7). */
export interface GitSettings {
  /** `base` from `.dipo/office.yaml`; absent means `refs/remotes/<remote>/HEAD` decides. */
  readonly base?: string;
  /** The remote, `origin` unless configured. */
  readonly remote: string;
  /** `worktree.root`, default `../{repo}.worktrees`. */
  readonly worktreeRoot?: string;
}

/** What one queue item uses to run its git steps. */
export interface GitSession {
  /** The repository without a work tree: fetch, refs, `worktree add`. */
  readonly repository: GitLocation;
  /** Runs one hardened step; any exit code is returned, a lock still held after retries throws. */
  step(
    location: GitLocation,
    args: readonly string[],
    options?: GitStepOptions,
  ): Promise<GitResult>;
  /** Runs one hardened step; a non-zero exit throws `git.failed`. Returns stdout. */
  ok(location: GitLocation, args: readonly string[], options?: GitStepOptions): Promise<string>;
}

export type FetchState =
  | { readonly ok: true; readonly at: number }
  | { readonly ok: false; readonly at: number; readonly detail: string };

export type FetchOutcome =
  | {
      readonly ok: true;
      /** The base, or null when neither configuration nor `<remote>/HEAD` names one. */
      readonly base: string | null;
      /** True when the fetch moved `<remote>/<base>`. */
      readonly moved: boolean;
      /** The `_base` worktree after the fetch, when the base is known. */
      readonly baseWorktree: BaseWorktree | null;
    }
  | { readonly ok: false; readonly error: GitError };

export interface BaseWorktree {
  readonly path: string;
  readonly base: string;
  readonly sha: string;
}

export interface OfficeGitOptions {
  readonly officeId: OfficeId;
  /** The main checkout, canonical, as the office records it (0007 section 2). */
  readonly mainWorktree: string;
  /** `<git-common-dir>`, canonical, as the office records it. */
  readonly commonDir: string;
  readonly settings: GitSettings;
  readonly runner: GitStepRunner;
  readonly clock: Clock;
}

export class OfficeGit {
  readonly officeId: OfficeId;
  readonly mainWorktree: string;
  readonly commonDir: string;
  readonly queue = new GitQueue();
  readonly #runner: GitStepRunner;
  readonly #clock: Clock;
  #settings: GitSettings;
  #fetch: FetchState | null = null;
  /** Story worktrees with a run-start snapshot, by canonical path (0008 section 2). */
  readonly #pins = new Map<string, WorktreeSnapshot>();

  constructor(options: OfficeGitOptions) {
    this.officeId = options.officeId;
    this.mainWorktree = options.mainWorktree;
    this.commonDir = options.commonDir;
    this.#settings = options.settings;
    // Step timeouts run on the office clock.
    this.#runner = { ...options.runner, clock: options.runner.clock ?? options.clock };
    this.#clock = options.clock;
  }

  /** The repository location of every repository-level call. */
  get repository(): GitLocation {
    return { kind: "repository", commonDir: this.commonDir };
  }

  get settings(): GitSettings {
    return this.#settings;
  }

  /** Takes a new configuration, for example after `office.reloadConfig`. */
  configure(settings: GitSettings): void {
    this.#settings = settings;
  }

  /** The absolute worktree root; throws `git.rootInsideCheckout` when it lies in the main checkout. */
  worktreeRoot(): string {
    return resolveWorktreeRoot(this.mainWorktree, this.#settings.worktreeRoot);
  }

  /** `<root>/_base`. */
  baseWorktreePath(): string {
    return join(this.worktreeRoot(), BASE_WORKTREE);
  }

  /** Runs `item` as one queue item: no other item's git steps run until it finishes. */
  run<T>(item: (git: GitSession) => Promise<T>): Promise<T> {
    const session: GitSession = {
      repository: this.repository,
      step: async (location, args, options) => {
        this.#assertUntampered(location);
        return runGitStep(this.#runner, location, args, options);
      },
      ok: async (location, args, options) => {
        this.#assertUntampered(location);
        return runGitStepOk(this.#runner, location, args, options);
      },
    };
    return this.queue.run(() => item(session));
  }

  // Run-start snapshots of story worktrees (0008 section 2, "Engine git calls")

  /**
   * Records the snapshot of a story worktree's git links. From now on every engine git call in
   * that worktree first compares the links with it and refuses with `git.worktreeTampered` when
   * one differs.
   */
  pinWorktree(snapshot: WorktreeSnapshot): void {
    this.#pins.set(canonicalFuturePath(snapshot.path), snapshot);
  }

  /** Forgets the snapshot of the worktree at `path`, when its claim ends. */
  unpinWorktree(path: string): void {
    this.#pins.delete(canonicalFuturePath(path));
  }

  /** The snapshot recorded for the worktree at `path`, or null. */
  pinnedWorktree(path: string): WorktreeSnapshot | null {
    return this.#pins.get(canonicalFuturePath(path)) ?? null;
  }

  /** Throws `git.worktreeTampered` when `location` is a pinned worktree whose links changed. */
  #assertUntampered(location: GitLocation): void {
    if (location.kind !== "worktree" || this.#pins.size === 0) return;
    const pin = this.pinnedWorktree(location.workTree);
    if (pin === null) return;
    const changed = changedLinks(pin);
    // A location whose GIT_DIR is not the recorded admin dir is refused like a changed link.
    if (
      !changed.includes("gitdir") &&
      canonicalFuturePath(location.gitDir) !== canonicalFuturePath(pin.adminDir)
    ) {
      changed.push("gitdir");
    }
    if (changed.length > 0) throw worktreeTampered(pin, changed);
  }

  // Base and remote

  /** The base branch: `base` from configuration, else `refs/remotes/<remote>/HEAD`; else throws. */
  resolveBase(): Promise<string> {
    return this.run((git) => this.resolveBaseIn(git));
  }

  /**
   * `resolveBase` inside a queue item that is already running: the queue is not re-entrant, so a
   * caller holding `git` uses this instead. The office's only base-branch rule (DIPO-112).
   */
  async resolveBaseIn(git: GitSession): Promise<string> {
    const configured = this.#settings.base;
    if (configured !== undefined) return configured;
    const { remote } = this.#settings;
    const prefix = `refs/remotes/${remote}/`;
    const head = await git.step(git.repository, ["symbolic-ref", "--quiet", `${prefix}HEAD`]);
    const target = head.stdout.trim();
    if (head.code === 0 && target.startsWith(prefix) && target.length > prefix.length) {
      return target.slice(prefix.length);
    }
    throw new GitError(
      "git.baseUnknown",
      `The office has no base branch: .dipo/office.yaml sets no \`base\` and ${prefix}HEAD does not exist. Set \`base\`, or run \`git remote set-head ${remote} --auto\`.`,
      false,
      { remote },
    );
  }

  /** The commit `<remote>/<base>` points at, or null when the ref does not exist. */
  async #remoteBaseSha(git: GitSession, base: string): Promise<string | null> {
    const ref = `refs/remotes/${this.#settings.remote}/${base}`;
    const result = await git.step(git.repository, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ]);
    return result.code === 0 ? result.stdout.trim() : null;
  }

  // Fetch (0010 section 7 failure cases, 0007 section 6 step 4)

  /** The outcome of the last fetch, or null before the first. */
  get lastFetch(): FetchState | null {
    return this.#fetch;
  }

  /**
   * Pickup and planning pushes call this first. After a failed fetch it throws the retryable
   * `git.fetchFailed`, so they wait; running work and other queue items continue.
   */
  assertFetched(): void {
    const state = this.#fetch;
    if (state === null || state.ok) return;
    throw fetchFailed(this.#settings.remote, state.detail);
  }

  /**
   * One queue item: fetch the remote, then move `_base` to `<remote>/<base>` when the fetch moved
   * it (or `_base` is missing or elsewhere). A failed fetch is recorded and returned, never thrown.
   */
  fetch(): Promise<FetchOutcome> {
    return this.run(async (git) => {
      const base = await this.resolveBaseIn(git).catch(() => null);
      const before = base === null ? null : await this.#remoteBaseSha(git, base);
      const { remote } = this.#settings;
      const result = await git
        .step(git.repository, ["fetch", "--quiet", "--no-recurse-submodules", remote], {
          config: FETCH_CONFIG,
          timeoutMs: EXTERNAL_STEP_TIMEOUT_MS,
        })
        .catch((error: unknown): GitResult => {
          // A fetch waiting on a credential prompt was killed: a failed fetch like any other.
          if (isTimedOut(error)) return { code: null, stdout: "", stderr: error.message };
          throw error;
        });
      if (result.code !== 0) {
        const detail = result.stderr.trim() || `exit ${result.code}`;
        this.#fetch = { ok: false, at: this.#clock.now(), detail };
        return { ok: false, error: fetchFailed(remote, detail) };
      }
      this.#fetch = { ok: true, at: this.#clock.now() };
      // A fetch may create `<remote>/HEAD`, so the base is resolved again.
      const after = base ?? (await this.resolveBaseIn(git).catch(() => null));
      if (after === null) return { ok: true, base: null, moved: false, baseWorktree: null };
      const sha = await this.#remoteBaseSha(git, after);
      const moved = sha !== null && sha !== before;
      const baseWorktree = sha === null ? null : await this.#ensureBaseWorktree(git, after);
      return { ok: true, base: after, moved, baseWorktree };
    });
  }

  // The `_base` read worktree (0010 section 2)

  /** One queue item: creates or moves `<root>/_base`, detached at `<remote>/<base>`. */
  ensureBaseWorktree(): Promise<BaseWorktree> {
    return this.run(async (git) => this.#ensureBaseWorktree(git, await this.resolveBaseIn(git)));
  }

  async #ensureBaseWorktree(git: GitSession, base: string): Promise<BaseWorktree> {
    const path = this.baseWorktreePath();
    const { remote } = this.#settings;
    const sha = await this.#remoteBaseSha(git, base);
    if (sha === null) {
      throw new GitError(
        "git.baseMissing",
        `${remote}/${base} does not exist; fetch ${remote} first, or check \`base\` in .dipo/office.yaml.`,
        false,
        { remote, base },
      );
    }
    const registered = this.adminDirOf(path);
    if (registered === null && existsSync(path)) {
      throw new GitError(
        "git.basePathTaken",
        `${path} exists but is not a worktree of this repository; dipo leaves it alone. Move it away so the engine can create its base read worktree there.`,
        false,
        { path },
      );
    }
    if (registered === null || !existsSync(path)) {
      // `--force` only re-adds a registered worktree whose directory is gone.
      await git.ok(
        git.repository,
        ["worktree", "add", ...(registered === null ? [] : ["--force"]), "--detach", path, sha],
        {
          ...BASE_CHECKOUT,
          config: [...WORKTREE_ADD_CONFIG, ...BASE_CHECKOUT_CONFIG],
        },
      );
      return { path, base, sha };
    }
    const location = this.worktreeLocation(path);
    const head = (await git.ok(location, ["rev-parse", "--verify", "HEAD"])).trim();
    if (head !== sha) {
      await git.ok(
        location,
        ["checkout", "--quiet", "--force", "--no-recurse-submodules", "--detach", sha],
        BASE_CHECKOUT,
      );
    }
    return { path, base, sha };
  }

  // Worktree locations

  /**
   * The administrative directory (`<common-dir>/worktrees/<name>`) whose `gitdir` names
   * `<path>/.git`, read from the common dir the office recorded; null when none does.
   */
  adminDirOf(path: string): string | null {
    const dir = join(this.commonDir, "worktrees");
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return null;
    }
    const want = canonicalFuturePath(join(path, ".git"));
    for (const name of names) {
      let gitdir: string;
      try {
        gitdir = readFileSync(join(dir, name, "gitdir"), "utf8").trim();
      } catch {
        continue;
      }
      // A relative link (`worktree.useRelativePaths`) is relative to the file that holds it.
      if (canonicalFuturePath(resolve(join(dir, name), gitdir)) === want) return join(dir, name);
    }
    return null;
  }

  /**
   * The location of an engine worktree at `path`, with `GIT_DIR` from its administrative
   * directory. Its `.git` pointer must still name that directory (0008); a worktree whose pointer
   * changed runs no git and throws `git.worktreeChanged`.
   */
  worktreeLocation(path: string): GitLocation {
    const pin = this.pinnedWorktree(path);
    if (pin !== null) {
      // A pinned worktree's GIT_DIR comes from its snapshot, never from its current links.
      const changed = changedLinks(pin);
      if (changed.length > 0) throw worktreeTampered(pin, changed);
      return { kind: "worktree", commonDir: this.commonDir, gitDir: pin.adminDir, workTree: path };
    }
    const gitDir = this.adminDirOf(path);
    if (gitDir === null) {
      throw new GitError(
        "git.worktreeChanged",
        `${path} is not a registered worktree of ${this.commonDir}; dipo runs no git there.`,
        false,
        { path },
      );
    }
    let pointer: string;
    try {
      pointer = readFileSync(join(path, ".git"), "utf8").trim();
    } catch {
      pointer = "";
    }
    const named = pointer.startsWith("gitdir: ") ? pointer.slice("gitdir: ".length) : "";
    if (named === "" || canonicalFuturePath(resolve(path, named)) !== canonicalFuturePath(gitDir)) {
      throw new GitError(
        "git.worktreeChanged",
        `${path}/.git no longer points at ${gitDir}; dipo runs no git in that worktree.`,
        false,
        { path, gitDir },
      );
    }
    return { kind: "worktree", commonDir: this.commonDir, gitDir, workTree: path };
  }
}

function fetchFailed(remote: string, detail: string): GitError {
  return new GitError(
    "git.fetchFailed",
    `Fetching ${remote} failed (${detail}); pickup and planning pushes wait until a fetch succeeds, running work continues.`,
    true,
    { remote, detail },
  );
}
