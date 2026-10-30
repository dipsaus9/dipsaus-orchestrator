// `dipo steer <id> <text>` (DIPO-163; 0020): `work.steer` for the story in the office of
// `--office` or of the current directory. It asks for no confirmation. The text of a steer is the words after the story id, joined with spaces.

import { storyRef } from "@dipsaus-orchestrator/client";
import { type StoryRefValue, workSteer } from "@dipsaus-orchestrator/contract";

import { engineFailure, usage } from "./daemon-commands";
import { type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";

/** How long these commands wait: the message goes through the worker host's socket. */
export const INTERVENE_TIMEOUT_MS = 60_000;

interface Parsed {
  readonly story: StoryRefValue;
  readonly words: string[];
  readonly rest: string[];
}

/** The story id first, then the words, and the office options anywhere; else usage. */
function parse(name: string, args: readonly string[], deps: OfficeCommandDeps): Parsed | number {
  let story: StoryRefValue | null = null;
  const words: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--office") {
      rest.push(arg, ...(i + 1 < args.length ? [args[i + 1] ?? ""] : []));
      i += 1;
    } else if (story === null && !arg.startsWith("-")) {
      story = storyRef(arg);
      if (story === null) return usage(deps, `${name}: ${JSON.stringify(arg)} is not a story id`);
    } else if (story !== null && name === "steer") {
      words.push(arg);
    } else if (arg.startsWith("-")) {
      rest.push(arg);
    } else {
      return usage(deps, `${name} takes one story id`);
    }
  }
  if (story === null) return usage(deps, `${name} needs a story id`);
  return { story, words, rest };
}

export async function steerCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
  const parsed = parse("steer", args, deps);
  if (typeof parsed === "number") return parsed;
  const text = parsed.words.join(" ").trim();
  if (text === "") return usage(deps, "steer needs a text after the story id");
  const options = parseOptions(parsed.rest, false);
  if (typeof options === "string") return usage(deps, `steer: ${options}`);
  const { story } = parsed;
  return withOffice(
    deps,
    options.office,
    async (session, office) => {
      const outcome = await session.command(workSteer, { story, text }, { office });
      if (!outcome.ok) {
        return outcome.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, outcome.error);
      }
      deps.writeLine(
        outcome.result.delivered === "next-turn"
          ? `steered ${story} (run ${outcome.result.run}); the worker reads it with its next turn`
          : `steered ${story} (run ${outcome.result.run}); the worker gets it with the first message on resume`,
      );
      return 0;
    },
    undefined,
    INTERVENE_TIMEOUT_MS,
  );
}
