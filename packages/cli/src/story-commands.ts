// `dipo park <id> --note <text>` and `dipo drop <id> [--delete-branch] [--yes]` (DIPO-160,
// DIPO-344; 0020): `story.park` and `story.drop` for the story in the office of `--office` or of
// the current directory.
//
// Park has no confirmation; its note is required. Drop is `confirm: true` in the contract, so the
// CLI asks yes or no first (`--yes` answers for a script, and without a terminal it refuses).
// With `--delete-branch` the command is irreversible (`irreversibleWhen`, 0009 section 5): the CLI
// reads what is lost (`story.losses`, DIPO-228), lists it, and asks for the story id typed out,
// which `--yes` does not replace.
//
// `dipo discard <id> --note <text>` (DIPO-161) is irreversible: it lists the same losses and asks
// for the typed story id.

import {
  type LostCommit,
  StoryId,
  StoryKey,
  type StoryRefValue,
  storyDrop,
  storyPark,
  storyLosses,
  workDiscard,
} from "@dipsaus-orchestrator/contract";

import { engineFailure, usage } from "./daemon-commands";
import { type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";

const YES = /^\s*y(es)?\s*$/i;

/** How many commits `drop --delete-branch` lists before the typed id (DIPO-228). */
const LISTED_COMMITS = 20;

/** What `story.losses` answers: the commits not on the base. */
interface StoryLosses {
  readonly commits: readonly LostCommit[];
}

/** Lists what the command loses, cut to its cap with a count of the rest. */
function printLosses(deps: OfficeCommandDeps, losses: StoryLosses): void {
  if (losses.commits.length === 0) {
    deps.writeLine("no commits are lost");
    return;
  }
  deps.writeLine(`commits not on the base (${losses.commits.length}):`);
  for (const commit of losses.commits.slice(0, LISTED_COMMITS)) {
    deps.writeLine(`  ${commit.sha} ${commit.subject}`);
  }
  const rest = losses.commits.length - LISTED_COMMITS;
  if (rest > 0) deps.writeLine(`  and ${rest} more`);
}

/** How long these commands wait: the lane's flush, the PR close and the branch deletion. */
export const STORY_COMMAND_TIMEOUT_MS = 180_000;

function storyRef(text: string): StoryRefValue | null {
  const key = StoryKey.safeParse(text);
  if (key.success) return key.data;
  const id = StoryId.safeParse(text.toUpperCase());
  return id.success ? id.data : null;
}

interface Parsed {
  readonly story: StoryRefValue;
  readonly rest: string[];
  readonly note: string | undefined;
  readonly deleteBranch: boolean;
}

/** One story id, `--note`, `--delete-branch` (when allowed) and the office options; else usage. */
function parseStoryArgs(
  name: string,
  args: readonly string[],
  allow: { readonly note: boolean; readonly deleteBranch: boolean },
  deps: OfficeCommandDeps,
): Parsed | number {
  let story: StoryRefValue | null = null;
  let note: string | undefined;
  let deleteBranch = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--note" && allow.note) {
      const value = args[i + 1];
      if (value === undefined || value.trim() === "") {
        return usage(deps, `${name}: --note needs a text`);
      }
      note = value;
      i += 1;
    } else if (arg === "--delete-branch" && allow.deleteBranch) {
      deleteBranch = true;
    } else if (arg === "--office") {
      rest.push(arg, ...(i + 1 < args.length ? [args[i + 1] ?? ""] : []));
      i += 1;
    } else if (!arg.startsWith("-")) {
      if (story !== null) return usage(deps, `${name} takes one story id`);
      story = storyRef(arg);
      if (story === null) return usage(deps, `${name}: ${JSON.stringify(arg)} is not a story id`);
    } else {
      rest.push(arg);
    }
  }
  if (story === null) return usage(deps, `${name} needs a story id`);
  return { story, rest, note, deleteBranch };
}

export async function parkCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
  const parsed = parseStoryArgs("park", args, { note: true, deleteBranch: false }, deps);
  if (typeof parsed === "number") return parsed;
  if (parsed.note === undefined) return usage(deps, "park needs --note <text>");
  const options = parseOptions(parsed.rest, false);
  if (typeof options === "string") return usage(deps, `park: ${options}`);
  const { story, note } = parsed;
  return withOffice(
    deps,
    options.office,
    async (session, office) => {
      const outcome = await session.command(storyPark, { story, note }, { office });
      if (!outcome.ok) {
        return outcome.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, outcome.error);
      }
      const run = outcome.result.run === undefined ? "" : ` (run ${outcome.result.run})`;
      deps.writeLine(
        outcome.changed === false
          ? `${story} is parked already`
          : `parked ${story}${run} as by-maintainer; it waits until \`dipo resume ${story}\``,
      );
      return 0;
    },
    undefined,
    STORY_COMMAND_TIMEOUT_MS,
  );
}

export async function dropCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
  const parsed = parseStoryArgs("drop", args, { note: false, deleteBranch: true }, deps);
  if (typeof parsed === "number") return parsed;
  const options = parseOptions(parsed.rest, true);
  if (typeof options === "string") return usage(deps, `drop: ${options}`);
  const { story, deleteBranch } = parsed;
  const confirm = async (): Promise<boolean> => {
    if (deleteBranch) {
      // Irreversible: the story id typed out, after what is lost (0009 section 5, 0020 section 8).
      if (!deps.workspace.interactive) {
        deps.writeError(
          `dipo: dropping ${story} with --delete-branch cannot be undone, so it needs the story id typed at a terminal.`,
        );
        return false;
      }
      const typed = await deps.workspace.ask(
        `Dropping ${story} archives it, closes its open PR, and deletes its branch locally and on the remote: commits not on the base are lost. This cannot be undone. Type ${story} to confirm: `,
      );
      if (typed.trim().toUpperCase() === String(story).toUpperCase()) return true;
      deps.writeLine("nothing dropped");
      return false;
    }
    if (!storyDrop.confirm || options.yes) return true;
    if (!deps.workspace.interactive) {
      deps.writeError(
        `dipo: dropping ${story} needs confirmation; run it at a terminal or pass --yes.`,
      );
      return false;
    }
    const answer = await deps.workspace.ask(
      `Drop ${story}? It is archived and its open PR is closed; its branch is kept. [y/N] `,
    );
    if (YES.test(answer)) return true;
    deps.writeLine("nothing dropped");
    return false;
  };
  if (deleteBranch) {
    // What is lost is read and listed before the typed id is asked (DIPO-228); a failed read drops
    // nothing, since this step never reaches the command.
    const read: { losses?: StoryLosses } = {};
    const code = await withOffice(
      deps,
      options.office,
      async (session, office) => {
        const outcome = await session.read(storyLosses, { office, story });
        if (!outcome.ok) {
          return outcome.error.code === "office.unknown"
            ? "unknown"
            : engineFailure(deps, outcome.error);
        }
        read.losses = outcome.result;
        return 0;
      },
      undefined,
      STORY_COMMAND_TIMEOUT_MS,
    );
    if (code !== 0 || read.losses === undefined) return code || 1;
    printLosses(deps, read.losses);
  }
  return withOffice(
    deps,
    options.office,
    async (session, office) => {
      const outcome = await session.command(storyDrop, { story, deleteBranch }, { office });
      if (!outcome.ok) {
        return outcome.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, outcome.error);
      }
      deps.writeLine(
        outcome.changed
          ? `dropped ${story}; it is archived${deleteBranch ? ", its branch is deleted" : ", its branch is kept"}`
          : `${story} was already dropped`,
      );
      return 0;
    },
    confirm,
    STORY_COMMAND_TIMEOUT_MS,
  );
}

/**
 * `dipo discard <id> --note <text>` (DIPO-161; 0020 sections 8 and 16): `work.discard` is
 * irreversible, so the CLI reads what is lost (`story.losses`), lists it, and asks for the story id
 * typed out at a terminal before it sends the command; `--yes` does not replace it.
 */
export async function discardCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
  const parsed = parseStoryArgs("discard", args, { note: true, deleteBranch: false }, deps);
  if (typeof parsed === "number") return parsed;
  if (parsed.note === undefined) return usage(deps, "discard needs --note <text>");
  const options = parseOptions(parsed.rest, true);
  if (typeof options === "string") return usage(deps, `discard: ${options}`);
  const { story, note } = parsed;
  if (!deps.workspace.interactive) {
    deps.writeError(
      `dipo: discarding ${story} cannot be undone, so it needs the story id typed at a terminal.`,
    );
    return 1;
  }
  const read: { losses?: StoryLosses } = {};
  const code = await withOffice(
    deps,
    options.office,
    async (session, office) => {
      const outcome = await session.read(storyLosses, {
        office,
        story,
        command: "work.discard",
      });
      if (!outcome.ok) {
        return outcome.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, outcome.error);
      }
      read.losses = outcome.result;
      return 0;
    },
    undefined,
    STORY_COMMAND_TIMEOUT_MS,
  );
  if (code !== 0 || read.losses === undefined) return code || 1;
  printLosses(deps, read.losses);
  const confirm = async (): Promise<boolean> => {
    const typed = await deps.workspace.ask(
      `Discarding ${story} stops its worker, closes its open PR, deletes its box and its branch locally and on the remote, and returns it to Refined: commits not on the base and work left in the box are lost. A running worker is stopped only after this list was read, so anything it delivers in between is lost too. This cannot be undone. Type ${story} to confirm: `,
    );
    if (typed.trim().toUpperCase() === String(story).toUpperCase()) return true;
    deps.writeLine("nothing discarded");
    return false;
  };
  return withOffice(
    deps,
    options.office,
    async (session, office) => {
      const outcome = await session.command(workDiscard, { story, note }, { office });
      if (!outcome.ok) {
        return outcome.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, outcome.error);
      }
      deps.writeLine(
        outcome.changed
          ? `discarded ${story}; its box and branch are deleted`
          : `${story} was already discarded`,
      );
      return 0;
    },
    confirm,
    STORY_COMMAND_TIMEOUT_MS,
  );
}
