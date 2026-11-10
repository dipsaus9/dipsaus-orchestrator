// The update of dipo from the base commit of an office (DIPO-485), wired to the engine: the office
// git for the worktree, the engine commits counted in the background, and the runs that must be
// absent. The steps are in `update/self-update.ts`.

import { join } from "node:path";

import { detachedEnv, type OfficeId } from "@dipsaus-orchestrator/contract";

import { BASE_CHECKOUT_CONFIG, BASE_CHECKOUT_ENV, WORKTREE_ADD_CONFIG } from "../git/hardened";
import { systemSpawnDetached } from "../platform/process";
import { runningStoryCount, sessionRunCount } from "../overview/summary";
import type { OfficeHandItem } from "../overview/desk";
import { SelfUpdate, type UpdateWorktrees } from "../update/self-update";
import type { Core } from "./core";
import type { OfficeServices } from "./office-services";

function worktreesOf(core: Core): UpdateWorktrees {
  const git = (office: OfficeId) => {
    const found = core.gitOf(office);
    if (found === undefined) throw new Error(`office ${office} has no git loaded`);
    return found;
  };
  return {
    add: (office, path, commit) =>
      git(office).run((session) =>
        session
          .ok(session.repository, ["worktree", "add", "--detach", path, commit], {
            config: [...WORKTREE_ADD_CONFIG, ...BASE_CHECKOUT_CONFIG],
            env: BASE_CHECKOUT_ENV,
          })
          .then(() => undefined),
      ),
    remove: (office, path) =>
      git(office).run((session) =>
        session
          .ok(session.repository, ["worktree", "remove", "--force", path])
          .then(() => undefined),
      ),
  };
}

/** The update service, or null when this daemon has no build commit to compare with. */
export function selfUpdateOf(core: Core, office: OfficeServices): SelfUpdate | null {
  const { daemon } = core.deps;
  const behind = office.engineBehind;
  if (daemon.buildCommit === undefined || behind === null) return null;
  return new SelfUpdate({
    clock: core.deps.clock,
    logger: core.logger.child({ component: "self-update" }),
    lifecycle: core.lifecycle,
    spawn: core.deps.spawn,
    spawnDetached: core.deps.spawnDetached ?? systemSpawnDetached,
    env: detachedEnv(core.deps.env),
    home: core.deps.paths.stateDir,
    binary: daemon.executable,
    restartLog: join(core.deps.paths.stateDir, "update.log"),
    behind: (id) => {
      const known = behind.known(id);
      if (known === undefined || known.commits === null || known.tip === undefined) {
        return undefined;
      }
      return { commits: known.commits, tip: known.tip, titles: known.titles ?? [] };
    },
    running: () => {
      let stories = 0;
      let sessions = 0;
      for (const id of core.offices.loadedOffices()) {
        const handle = core.offices.get(id);
        if (handle === undefined) continue;
        stories += runningStoryCount(handle);
        sessions += sessionRunCount(handle);
      }
      return { stories, sessions };
    },
    worktrees: worktreesOf(core),
  });
}

/** The kind of the desk item that offers the update (DIPO-485). */
export const UPDATE_DESK_KIND = "UPDATE DIPO";

/**
 * The one desk item that offers `office` the update when its base has engine commits after the
 * running build and nothing runs; none otherwise.
 */
export function updateDeskItems(
  update: SelfUpdate | null,
  office: OfficeId,
  now: number,
): OfficeHandItem[] {
  const offer = update?.offer(office) ?? null;
  if (offer === null) return [];
  const plural = offer.commits === 1 ? "commit" : "commits";
  const shown = offer.titles.join("; ");
  const more = offer.commits > offer.titles.length ? "; …" : "";
  return [
    {
      kind: UPDATE_DESK_KIND,
      detail: `update dipo (${offer.commits} engine ${plural}: ${shown}${more})`,
      since: now,
      hand: "nothing runs now; dipo builds the base, replaces its binary and restarts itself",
      actions: [{ command: "daemon.update", cli: "dipo update" }],
    },
  ];
}
