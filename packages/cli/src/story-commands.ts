// `dipo hold <id> --note <text>` and `dipo drop <id> [--delete-branch] [--yes]` (DIPO-160; 0020
// sections 8 and 16): `story.hold` and `story.drop` for the story in the office of `--office` or of
// the current directory.
//
// Hold has no confirmation; its note is required. Drop is `confirm: true` in the contract, so the
// CLI asks yes or no first (`--yes` answers for a script, and without a terminal it refuses).
// With `--delete-branch` the command is irreversible (`irreversibleWhen`, 0009 section 5): the CLI
// says what is lost and asks for the story id typed out, which `--yes` does not replace.

import {
  StoryId,
  StoryKey,
  type StoryRefValue,
  storyDrop,
  storyHold,
} from "@dipsaus-orchestrator/contract";

import { engineFailure, usage } from "./daemon-commands";
import { type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";

const YES = /^\s*y(es)?\s*$/i;

/** How long these commands wait: the lane's flush, the PR close and the worktree removal. */
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

export async function holdCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
  const parsed = parseStoryArgs("hold", args, { note: true, deleteBranch: false }, deps);
  if (typeof parsed === "number") return parsed;
  if (parsed.note === undefined) return usage(deps, "hold needs --note <text>");
  const options = parseOptions(parsed.rest, false);
  if (typeof options === "string") return usage(deps, `hold: ${options}`);
  const { story, note } = parsed;
  return withOffice(
    deps,
    options.office,
    async (session, office) => {
      const outcome = await session.command(storyHold, { story, note }, { office });
      if (!outcome.ok) {
        return outcome.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, outcome.error);
      }
      deps.writeLine(
        outcome.changed
          ? `held ${story}; it is parked on-hold until \`dipo resume ${story}\``
          : `${story} is already on hold`,
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
        `Dropping ${story} archives it, closes its open PR, and removes its worktree with --force and deletes its branch locally and on the remote: uncommitted and untracked files and commits not on the base are lost. This cannot be undone. Type ${story} to confirm: `,
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
      `Drop ${story}? It is archived, its open PR is closed and its worktree is removed; its branch is kept. [y/N] `,
    );
    if (YES.test(answer)) return true;
    deps.writeLine("nothing dropped");
    return false;
  };
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
          ? `dropped ${story}; it is archived${deleteBranch ? ", its worktree and branch are removed" : ", its branch is kept"}`
          : `${story} was already dropped`,
      );
      return 0;
    },
    confirm,
    STORY_COMMAND_TIMEOUT_MS,
  );
}
