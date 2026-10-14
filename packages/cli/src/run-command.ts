// `dipo run [ID...] [--office <id>]` (DIPO-48): sends `work.run` for the office of `--office` or of
// the current directory, with the main worktree it resolved as `from`, and prints each started
// story with its run and each skipped story with its reason. Exit 0 when a story started, else 1.

import { StoryId, StoryKey, type StoryRefValue, workRun } from "@dipsaus-orchestrator/contract";

import { engineFailure, usage } from "./daemon-commands";
import { type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";

/**
 * How long `dipo run` waits for its reply: a fetch, a story index pass, the run profile, the
 * Ready gate and the claim with its push; each step that waits on something outside dipo is
 * killed after a minute.
 */
export const RUN_TIMEOUT_MS = 300_000;

/** What each skip reason means, for people (0005 section 4). */
const REASONS: Readonly<Record<string, string>> = {
  notReady: "not Ready",
  parked: "parked",
  notRunnable:
    "not runnable (not on the base, already claimed or past Ready, or a backlog change for it is pending)",
  dependency: "a dependency is not Done",
  collision: "its branch or worktree path is taken",
  capacity: "the office already runs a story",
  pickupCheckFailed: "it failed its pickup check and goes back to Refined",
};

/** A story id as typed (Backlog.md prints ids upper-cased), or a story key as is. */
function storyRef(text: string): StoryRefValue | null {
  const key = StoryKey.safeParse(text);
  if (key.success) return key.data;
  const id = StoryId.safeParse(text.toUpperCase());
  return id.success ? id.data : null;
}

export async function runCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
  const stories: StoryRefValue[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--office") {
      rest.push(arg, ...(i + 1 < args.length ? [args[i + 1] ?? ""] : []));
      i += 1;
    } else if (!arg.startsWith("-")) {
      const ref = storyRef(arg);
      if (ref === null) return usage(deps, `run: ${JSON.stringify(arg)} is not a story id`);
      stories.push(ref);
    } else {
      rest.push(arg);
    }
  }
  const options = parseOptions(rest, false);
  if (typeof options === "string") return usage(deps, `run: ${options}`);
  return withOffice(
    deps,
    options.office,
    async (session, office, from) => {
      const outcome = await session.command(
        workRun,
        {
          ...(stories.length === 0 ? {} : { stories }),
          ...(from === undefined ? {} : { from }),
        },
        { office },
      );
      if (!outcome.ok) {
        return outcome.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, outcome.error);
      }
      const { started, skipped } = outcome.result;
      for (const story of started) deps.writeLine(`started ${story.story} (run ${story.run})`);
      for (const story of skipped) {
        deps.writeLine(`skipped ${story.story}: ${REASONS[story.reason] ?? story.reason}`);
      }
      if (started.length > 0) return 0;
      if (skipped.length === 0) deps.writeLine("no Ready story to start");
      return 1;
    },
    undefined,
    RUN_TIMEOUT_MS,
  );
}
