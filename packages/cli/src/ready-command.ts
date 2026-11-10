// `dipo ready <id>...` (DIPO-482; 0012): `story.ready` for the Refined stories named, in the office
// of `--office` or of the current directory. Each story that passes the Ready gate is set Ready in
// a backlog PR and printed with the PR it waits on; each one refused is printed with the gate's
// messages, and the exit code is 1 when any was refused. An id that names no story, an archived
// story or a draft refuses the whole command and changes nothing.

import { readyLines, storyRef } from "@dipsaus-orchestrator/client";
import { storyReady } from "@dipsaus-orchestrator/contract";

import { engineFailure, usage } from "./daemon-commands";
import { type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";
import { STORY_COMMAND_TIMEOUT_MS } from "./story-commands";

export async function readyCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
  const stories: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--office") {
      rest.push(arg, ...(i + 1 < args.length ? [args[i + 1] ?? ""] : []));
      i += 1;
    } else if (!arg.startsWith("-")) {
      const ref = storyRef(arg);
      if (ref === null) return usage(deps, `ready: ${JSON.stringify(arg)} is not a story id`);
      stories.push(ref);
    } else {
      rest.push(arg);
    }
  }
  if (stories.length === 0) return usage(deps, "ready needs at least one story id");
  const options = parseOptions(rest, false);
  if (typeof options === "string") return usage(deps, `ready: ${options}`);
  return withOffice(
    deps,
    options.office,
    async (session, office) => {
      const outcome = await session.command(storyReady, { stories }, { office });
      if (!outcome.ok) {
        return outcome.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, outcome.error);
      }
      const lines = readyLines(outcome.result);
      for (const line of lines) {
        deps.writeLine(
          line.state === "queued"
            ? `${line.story}: ${line.text}`
            : `${line.story}: refused: ${line.text}`,
        );
      }
      return lines.some((line) => line.state === "refused") ? 1 : 0;
    },
    undefined,
    STORY_COMMAND_TIMEOUT_MS,
  );
}
