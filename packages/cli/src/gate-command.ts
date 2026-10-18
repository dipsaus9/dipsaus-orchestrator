// `dipo gate <id> [--office <id>]` (DIPO-71, M0 breakdown decision D3): the read-only Ready gate
// check. It sends the read `story.gate` and prints `ready <ID> passed`, or each failure message on
// its own line and exits 1. The office comes from `--office`, else from the repository around the
// current directory, as for `dipo office`.

import { StoryId, StoryKey, type StoryRefValue, storyGate } from "@dipsaus-orchestrator/contract";

import { engineFailure, usage } from "./daemon-commands";
import { type Act, type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";

/**
 * How long `dipo gate` waits for the daemon's reply (DIPO-180). The read answers from the mirror in
 * under a second. When the mirror was read at an older `_base` commit, the daemon first reads every
 * task through the Backlog CLI to bring it up to date: 11 to 13 s on a backlog of 169 tasks
 * (about 0.17 s per task view, 4 at a time), so the wait covers that read twice over.
 */
export const GATE_TIMEOUT_MS = 30_000;

/** A story id as typed (Backlog.md prints ids upper-cased), or a story key as is. */
function storyRef(text: string): StoryRefValue | null {
  const key = StoryKey.safeParse(text);
  if (key.success) return key.data;
  const id = StoryId.safeParse(text.toUpperCase());
  return id.success ? id.data : null;
}

export async function gateCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
  let story: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--office") {
      rest.push(arg, ...(i + 1 < args.length ? [args[i + 1] ?? ""] : []));
      i += 1;
    } else if (story === undefined && !arg.startsWith("-")) {
      story = arg;
    } else {
      rest.push(arg);
    }
  }
  if (story === undefined) return usage(deps, "gate needs a story id, for example DIPO-7");
  const ref = storyRef(story);
  if (ref === null) return usage(deps, `gate: ${JSON.stringify(story)} is not a story id`);
  const options = parseOptions(rest, false);
  if (typeof options === "string") return usage(deps, `gate: ${options}`);
  const act: Act = async (session, office) => {
    const outcome = await session.read(storyGate, { office, story: ref });
    if (!outcome.ok) {
      return outcome.error.code === "office.unknown"
        ? "unknown"
        : engineFailure(deps, outcome.error);
    }
    const { passed, failures, waitingOn = [] } = outcome.result;
    if (passed) {
      deps.writeLine(`ready ${outcome.result.story} passed`);
    } else {
      for (const failure of failures) deps.writeLine(failure.message);
    }
    // The verdict does not depend on open dependencies, but pickup skips the story until they are Done.
    if (waitingOn.length > 0) {
      const list = waitingOn.map((dep) => `${dep.id} (${dep.status ?? "missing"})`);
      deps.writeLine(`waits on ${list.join(", ")}`);
    }
    return passed ? 0 : 1;
  };
  return withOffice(deps, options.office, act, undefined, GATE_TIMEOUT_MS);
}
