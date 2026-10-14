// `dipo stop <ID> [--note <text>] [--office <id>] [--yes]` (DIPO-50): sends `work.stop` for the
// story in the office of `--office` or of the current directory. `work.stop` is marked
// `confirm: true` in the contract (and so in `commands.describe`), so the CLI asks first; `--yes`
// answers for a script, and without a terminal the command refuses instead of asking. The worker
// gets the stop sequence, branch and worktree are kept, and the story parks `stopped`.

import { StoryId, StoryKey, type StoryRefValue, workStop } from "@dipsaus-orchestrator/contract";

import { engineFailure, usage } from "./daemon-commands";
import { type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";

const YES = /^\s*y(es)?\s*$/i;

/**
 * How long `dipo stop` waits for its reply: sending the stop sequence, then the park commit and
 * its push, each git step killed after a minute.
 */
export const STOP_TIMEOUT_MS = 180_000;

function storyRef(text: string): StoryRefValue | null {
  const key = StoryKey.safeParse(text);
  if (key.success) return key.data;
  const id = StoryId.safeParse(text.toUpperCase());
  return id.success ? id.data : null;
}

export async function stopCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
  let story: StoryRefValue | null = null;
  let note: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--note") {
      const value = args[i + 1];
      if (value === undefined || value.trim() === "")
        return usage(deps, "stop: --note needs a text");
      note = value;
      i += 1;
    } else if (arg === "--office") {
      rest.push(arg, ...(i + 1 < args.length ? [args[i + 1] ?? ""] : []));
      i += 1;
    } else if (!arg.startsWith("-")) {
      if (story !== null) return usage(deps, "stop takes one story id");
      story = storyRef(arg);
      if (story === null) return usage(deps, `stop: ${JSON.stringify(arg)} is not a story id`);
    } else {
      rest.push(arg);
    }
  }
  if (story === null) return usage(deps, "stop needs a story id");
  const options = parseOptions(rest, true);
  if (typeof options === "string") return usage(deps, `stop: ${options}`);
  const target = story;
  const confirm = async (): Promise<boolean> => {
    if (!workStop.confirm || options.yes) return true;
    if (!deps.workspace.interactive) {
      deps.writeError(
        `dipo: stopping ${target} needs confirmation; run it at a terminal or pass --yes.`,
      );
      return false;
    }
    const answer = await deps.workspace.ask(
      `Stop the worker of ${target}? The story parks as stopped; its branch and worktree are kept. [y/N] `,
    );
    if (YES.test(answer)) return true;
    deps.writeLine("nothing stopped");
    return false;
  };
  return withOffice(
    deps,
    options.office,
    async (session, office) => {
      const outcome = await session.command(
        workStop,
        { story: target, ...(note === undefined ? {} : { note }) },
        { office },
      );
      if (!outcome.ok) {
        return outcome.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, outcome.error);
      }
      deps.writeLine(
        `stopped ${target} (run ${outcome.result.run}); it is parked as stopped, branch and worktree kept`,
      );
      return 0;
    },
    confirm,
    STOP_TIMEOUT_MS,
  );
}
