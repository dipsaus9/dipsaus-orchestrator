// `dipo idea` and `dipo note dismiss` (DIPO-454; 0020, 0022), in the office of `--office` or of the
// current directory, without asking:
//
// - `dipo idea "<text>" [--story <id>]` hands the maintainer's quick idea to the audit
//   (`idea.quick`): held with origin `quick`, its first line its title, and audited at once; only
//   if it passes does it reach the desk.
// - `dipo idea accept|dismiss <idea>` decides an idea that passed its audit, from `dipo desk`:
//   accept files it as a Backlog draft through the backlog PR and prints what the planning lane did
//   with the draft (DIPO-401); dismiss closes it, kept as dismissed by the maintainer.
// - `dipo note dismiss <note>` closes a worker's decision note from `dipo desk`.
//
// An idea or a note is named by the id the desk prints, or by its first 8 or more characters. A
// quick idea whose text is `accept` or `dismiss` and one id is read as the decision: quote the
// whole idea as one argument to hand it to the audit.

import {
  IdeaRef,
  ideaAccept,
  ideaDismiss,
  ideaQuick,
  type LaneFlush,
  NoteRef,
  noteDismiss,
  StoryRefValue,
} from "@dipsaus-orchestrator/contract";

import { engineFailure, usage } from "./daemon-commands";
import { type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";

/** How long `accept` waits: the planning lane's flush creates the draft and pushes it. */
export const IDEA_TIMEOUT_MS = 180_000;

const short = (id: string) => id.slice(0, 12);

/**
 * Where an accepted idea stands, from what the planning lane's flush did with its draft
 * (DIPO-401): a backlog PR only when the flush opened or updated one.
 */
export function acceptedText(result: {
  readonly draft?: string | undefined;
  readonly flush?: LaneFlush | undefined;
}): string {
  const draft = result.draft === undefined ? "its draft" : `Backlog draft ${result.draft}`;
  const flush = result.flush;
  if (flush === undefined) {
    return result.draft === undefined
      ? "dipo files it as a Backlog draft through the backlog PR"
      : `filed as Backlog draft ${result.draft} through the backlog PR`;
  }
  switch (flush.state) {
    case "opened":
      return `${draft} is on the new backlog PR ${flush.pr}`;
    case "updated":
      return `${draft} was added to the backlog PR ${flush.pr}`;
    case "pushed":
      return `${draft} is pushed on ${flush.branch}; its backlog PR is not open yet, and dipo opens or updates it at the next backlog change`;
    case "merged":
      return `${draft} is on the base already`;
    case "held":
      return `${draft} waits for the next backlog PR: ${flush.reason}`;
    case "waiting":
      return flush.branch === undefined
        ? `${draft} waits: ${flush.reason}`
        : `${draft} is on ${flush.branch} and waits: ${flush.reason}`;
    case "failed":
      return `the planning lane could not file ${draft}, it stays journaled: ${flush.reason}`;
    case "closed":
      return `${draft} was not filed: ${flush.reason}`;
  }
}

/** The words of `args`, and its options (`--office`, `--story` and anything else) apart. */
function split(args: readonly string[]): {
  readonly words: string[];
  readonly rest: string[];
  readonly story: string | null | undefined;
} {
  const words: string[] = [];
  const rest: string[] = [];
  let story: string | null | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--office") {
      rest.push(arg, ...(i + 1 < args.length ? [args[i + 1] ?? ""] : []));
      i += 1;
    } else if (arg === "--story") {
      story = args[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith("-")) {
      rest.push(arg);
    } else {
      words.push(arg);
    }
  }
  return { words, rest, story };
}

/** The decision of `words`, when they are `accept` or `dismiss` and one id; else null. */
function decisionOf(words: readonly string[]): "accept" | "dismiss" | null {
  const [action, id, ...extra] = words;
  if (action !== "accept" && action !== "dismiss") return null;
  return id !== undefined && extra.length === 0 && IdeaRef.safeParse(id.toLowerCase()).success
    ? action
    : null;
}

export async function ideaCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
  const { words, rest, story } = split(args);
  const options = parseOptions(rest, false);
  if (typeof options === "string") return usage(deps, `idea: ${options}`);
  const decision = decisionOf(words);
  if (decision !== null) {
    if (story !== undefined) return usage(deps, `idea ${decision} takes no --story`);
    return decide(deps, decision, (words[1] ?? "").toLowerCase(), options.office);
  }
  if (words.length === 0)
    return usage(deps, "idea needs the idea's text, or accept or dismiss and an idea id");
  if (words.length > 1) {
    return usage(
      deps,
      'idea takes the idea as one argument: put it in quotes, as dipo idea "<text>"',
    );
  }
  const text = (words[0] ?? "").trim();
  if (text === "") return usage(deps, "idea needs the idea's text");
  if (story === null) return usage(deps, "idea: --story needs a story id");
  if (story !== undefined && !StoryRefValue.safeParse(story).success) {
    return usage(deps, `idea: ${JSON.stringify(story)} is not a story id`);
  }
  return withOffice(deps, options.office, async (session, office) => {
    const outcome = await session.command(
      ideaQuick,
      { text, ...(story === undefined ? {} : { story }) },
      { office },
    );
    if (!outcome.ok) {
      return outcome.error.code === "office.unknown"
        ? "unknown"
        : engineFailure(deps, outcome.error);
    }
    const name = short(outcome.result.idea);
    deps.writeLine(
      outcome.result.held
        ? `held idea ${name}: dipo audits it now, and it reaches dipo desk only if it passes`
        : `idea ${name} was held already; dipo ideas shows how its audit went`,
    );
    return 0;
  });
}

async function decide(
  deps: OfficeCommandDeps,
  action: "accept" | "dismiss",
  idea: string,
  office: Parameters<typeof withOffice>[1],
): Promise<number> {
  return withOffice(
    deps,
    office,
    async (session, target) => {
      if (action === "dismiss") {
        const outcome = await session.command(ideaDismiss, { idea }, { office: target });
        if (!outcome.ok) {
          return outcome.error.code === "office.unknown"
            ? "unknown"
            : engineFailure(deps, outcome.error);
        }
        const name = short(outcome.result.idea);
        deps.writeLine(
          outcome.changed
            ? `dismissed idea ${name}; nothing is filed, and dipo keeps it as dismissed by you`
            : `idea ${name} was dismissed already`,
        );
        return 0;
      }
      const outcome = await session.command(ideaAccept, { idea }, { office: target });
      if (!outcome.ok) {
        return outcome.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, outcome.error);
      }
      const name = short(outcome.result.idea);
      const where = acceptedText(outcome.result);
      deps.writeLine(
        outcome.changed
          ? `accepted idea ${name}: ${where}`
          : `idea ${name} was accepted already: ${where}`,
      );
      return 0;
    },
    undefined,
    IDEA_TIMEOUT_MS,
  );
}

/** `dipo note dismiss <note>`: closes a worker's decision note from the desk. */
export async function noteCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
  const { words, rest, story } = split(args);
  const [action, id, ...extra] = words;
  if (action !== "dismiss") return usage(deps, "note needs dismiss and a decision note id");
  if (id === undefined) return usage(deps, "note dismiss needs a decision note id");
  if (extra.length > 0 || story !== undefined) {
    return usage(deps, "note dismiss takes one decision note id");
  }
  const note = NoteRef.safeParse(id.toLowerCase());
  if (!note.success) {
    return usage(
      deps,
      `note: ${JSON.stringify(id)} is not a decision note id (dipo desk prints it; 8 or more of its characters will do)`,
    );
  }
  const options = parseOptions(rest, false);
  if (typeof options === "string") return usage(deps, `note: ${options}`);
  return withOffice(deps, options.office, async (session, office) => {
    const outcome = await session.command(noteDismiss, { note: note.data }, { office });
    if (!outcome.ok) {
      return outcome.error.code === "office.unknown"
        ? "unknown"
        : engineFailure(deps, outcome.error);
    }
    const name = short(outcome.result.note);
    deps.writeLine(
      outcome.changed
        ? `dismissed decision note ${name}; add it to the decision record by hand if you agree`
        : `decision note ${name} was dismissed already`,
    );
    return 0;
  });
}
