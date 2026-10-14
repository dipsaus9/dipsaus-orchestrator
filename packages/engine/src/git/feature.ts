// The engine's git (0010, 0008 section 2): one `OfficeGit` per loaded office, and the office load
// step that checks `git --version` once per load (DIPO-27 seam) and records the office's paths.
// `office.reloadConfig` passes a new valid configuration on through `configure` (DIPO-48).
// Claims, the backlog lane and the story index reach an office's git through `forOffice`.

import type { Clock, OfficeId, Spawn } from "@dipsaus-orchestrator/contract";

import type { FeatureModule } from "../commands/registry";
import type { OfficeConfig } from "../config";
import type { OfficeLoadContext } from "../office/steps";

import { type GitSettings, OfficeGit } from "./office";
import { clockSleep, type GitExec, runGitStep, type Sleep, spawnGitExec } from "./runner";
import { checkGitVersion } from "./version";

export interface EngineGitDeps {
  /** How git processes start; ignored when `exec` is given. */
  readonly spawn?: Spawn;
  /** The git executable; the daemon may pass the absolute path it resolved. */
  readonly git?: string;
  /** Replaces the process executor, for unit tests. */
  readonly exec?: GitExec;
  /** The environment every hardened call starts from; the daemon's own by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Replaces the clock-based wait between lock retries, for tests. */
  readonly sleep?: (clock: Clock) => Sleep;
}

/** The git part of the office configuration. */
export function gitSettings(config: OfficeConfig | undefined): GitSettings {
  if (config === undefined) return { remote: "origin" };
  return {
    remote: config.remote,
    worktreeRoot: config.worktree.root,
    ...(config.base === undefined ? {} : { base: config.base }),
  };
}

export class EngineGit {
  readonly #exec: GitExec;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #sleep: (clock: Clock) => Sleep;
  readonly #offices = new Map<OfficeId, OfficeGit>();

  constructor(deps: EngineGitDeps) {
    if (deps.exec === undefined && deps.spawn === undefined) {
      throw new Error("EngineGit needs either spawn or exec");
    }
    this.#exec = deps.exec ?? spawnGitExec(deps.spawn as Spawn, deps.git);
    this.#env = deps.env ?? process.env;
    this.#sleep = deps.sleep ?? clockSleep;
  }

  /** The office's git once its office has loaded; undefined before. */
  forOffice(office: OfficeId): OfficeGit | undefined {
    return this.#offices.get(office);
  }

  /**
   * Checks `git --version` (at least 2.38) and records the office's paths. Returns the reason the
   * office is refused, or null. An office loaded again at the same paths keeps its queue.
   */
  async attach(ctx: OfficeLoadContext): Promise<string | null> {
    const runner = { exec: this.#exec, env: this.#env, sleep: this.#sleep(ctx.clock) };
    const version = await runGitStep(runner, { kind: "none", cwd: ctx.path }, ["--version"]);
    if (version.code !== 0) {
      return `\`git --version\` failed: ${version.stderr.trim() || `exit ${version.code}`}`;
    }
    const refused = checkGitVersion(version.stdout);
    if (refused !== null) return refused;
    const settings = gitSettings(ctx.config);
    const existing = this.#offices.get(ctx.officeId);
    if (existing?.mainWorktree === ctx.path && existing.commonDir === ctx.commonDir) {
      existing.configure(settings);
      return null;
    }
    this.#offices.set(
      ctx.officeId,
      new OfficeGit({
        officeId: ctx.officeId,
        mainWorktree: ctx.path,
        commonDir: ctx.commonDir,
        settings,
        runner,
        clock: ctx.clock,
      }),
    );
    return null;
  }

  /** The feature module that adds the `git.version` office load step. */
  get feature(): FeatureModule {
    return {
      name: "git",
      register: (registry) => {
        registry.registerLoadStep("git.version", async (ctx) => {
          const reason = await this.attach(ctx);
          return reason === null ? { ok: true } : { ok: false, reason };
        });
        // `office.reloadConfig` (DIPO-48): the office's git takes the new base, remote and
        // worktree root at once, not only at the next load.
        registry.registerConfigReload("git.settings", (ctx) => {
          this.#offices.get(ctx.officeId)?.configure(gitSettings(ctx.config));
        });
      },
    };
  }
}
