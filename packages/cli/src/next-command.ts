// `dipo next confirm|decline <ID> [--office <id>]` (DIPO-440; 0010): decides a NEXT UP item that
// `dipo desk` lists, in the office of `--office` or of the current directory. Neither asks for
// confirmation. `confirm` sends `nextUp.confirm`, which starts the story as `dipo run <ID>` does,
// and prints the started story with its run, or why it was skipped; exit 0 when it started.
// `decline` sends `nextUp.decline` and prints the stories offered now in its place.

import { storyRef } from "@dipsaus-orchestrator/client";
import { nextUpConfirm, nextUpDecline } from "@dipsaus-orchestrator/contract";

import { engineFailure, usage } from "./daemon-commands";
import { type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";
import { REASONS, RUN_TIMEOUT_MS } from "./run-command";

export async function nextCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
  const words: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--office") {
      rest.push(arg, ...(i + 1 < args.length ? [args[i + 1] ?? ""] : []));
      i += 1;
    } else if (arg.startsWith("-")) {
      rest.push(arg);
    } else {
      words.push(arg);
    }
  }
  const [action, id, ...extra] = words;
  if (action !== "confirm" && action !== "decline") {
    return usage(deps, "next needs confirm or decline and a story id");
  }
  if (id === undefined) return usage(deps, `next ${action} needs a story id`);
  if (extra.length > 0) return usage(deps, `next ${action} takes one story id`);
  const story = storyRef(id);
  if (story === null) return usage(deps, `next: ${JSON.stringify(id)} is not a story id`);
  const options = parseOptions(rest, false);
  if (typeof options === "string") return usage(deps, `next: ${options}`);
  return withOffice(
    deps,
    options.office,
    async (session, office) => {
      if (action === "decline") {
        const outcome = await session.command(nextUpDecline, { story }, { office });
        if (!outcome.ok) {
          return outcome.error.code === "office.unknown"
            ? "unknown"
            : engineFailure(deps, outcome.error);
        }
        const { offered } = outcome.result;
        deps.writeLine(
          offered.length === 0
            ? `declined ${outcome.result.story}; no other story is next up now`
            : `declined ${outcome.result.story}; next up now: ${offered.join(", ")}`,
        );
        return 0;
      }
      const outcome = await session.command(nextUpConfirm, { story }, { office });
      if (!outcome.ok) {
        return outcome.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, outcome.error);
      }
      const { started, skipped } = outcome.result;
      for (const one of started) deps.writeLine(`started ${one.story} (run ${one.run})`);
      for (const one of skipped) {
        const [why, ...more] = one.detail ?? [];
        deps.writeLine(`skipped ${one.story}: ${why ?? REASONS[one.reason] ?? one.reason}`);
        for (const line of more) deps.writeLine(`  ${line}`);
      }
      return started.length > 0 ? 0 : 1;
    },
    undefined,
    RUN_TIMEOUT_MS,
  );
}
