// `dipo update [--office <id>] [--yes]` (DIPO-485, 0005): sends `daemon.update` for the office of
// `--office` or of the current directory. The daemon pauses new starts, builds the office's base in
// a dipo-owned worktree, replaces its binary and restarts itself; the command prints the commit it
// built. It is `confirm: true`, so the CLI asks yes or no first (`--yes` answers for a script, and
// without a terminal it refuses).

import { daemonUpdate } from "@dipsaus-orchestrator/contract";

import { engineFailure, usage } from "./daemon-commands";
import { type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";

const YES = /^\s*y(es)?\s*$/i;

/** How long the update may take: an install and a build, then the restart begins. */
export const UPDATE_TIMEOUT_MS = 35 * 60_000;

export async function updateCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
  const options = parseOptions(args, true);
  if (typeof options === "string") return usage(deps, `update: ${options}`);
  const confirm = async (): Promise<boolean> => {
    if (!daemonUpdate.confirm || options.yes) return true;
    if (!deps.workspace.interactive) {
      deps.writeError("dipo: update needs confirmation; run it at a terminal or pass --yes.");
      return false;
    }
    const answer = await deps.workspace.ask(
      "Update dipo from the base? New starts pause, dipo builds, replaces its binary and restarts. [y/N] ",
    );
    if (YES.test(answer)) return true;
    deps.writeLine("nothing updated");
    return false;
  };
  return withOffice(
    deps,
    options.office,
    async (session, office) => {
      const outcome = await session.command(daemonUpdate, { office });
      if (!outcome.ok) {
        return outcome.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, outcome.error);
      }
      const { commit, commits } = outcome.result;
      deps.writeLine(
        `dipo built ${commit} (${commits} engine ${commits === 1 ? "commit" : "commits"}) and is restarting on it; \`dipo daemon status\` names the new commit`,
      );
      return 0;
    },
    confirm,
    UPDATE_TIMEOUT_MS,
  );
}
