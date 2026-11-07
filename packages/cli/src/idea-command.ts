<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
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
=======
// `dipo idea "<text>" [--story <id>] [--office <id>]`, `dipo idea accept|dismiss <idea>` and
// `dipo note dismiss <note>` (0020, 0022, DIPO-454), in the office of `--office` or of the current
// directory:
//
// - `dipo idea "<text>"` sends `idea.add`: the maintainer's quick idea goes to the audit, which
//   decides it at once; its first line is its title. `--story` names the story it is about.
// - `dipo idea accept <idea>` and `dipo idea dismiss <idea>` send `idea.accept` and `idea.dismiss`
//   for a proposed story that `dipo desk` lists. Accept prints what the planning lane did with the
//   draft: the backlog PR it opened or updated, or why it waits (DIPO-401); dismiss files nothing.
// - `dipo note dismiss <note>` sends `note.dismiss` for a worker's decision note.
//
// None asks for confirmation. An idea or note is named by the id the desk prints, or by its first
// 8 or more characters. A quick idea whose text starts with "accept" or "dismiss" is given in
// quotes, as one word.

import {
  IdeaRef,
  type LaneFlush,
  ideaAccept,
  ideaAdd,
  ideaDismiss,
  noteDismiss,
  ProposalRef,
  QUICK_IDEA_MAX,
>>>>>>> de146a854c2be9713e40505688960f87444be951
} from "@dipsaus-orchestrator/contract";

import { engineFailure, usage } from "./daemon-commands";
import { type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";

/** How long `accept` waits: the planning lane's flush creates the draft and pushes it. */
<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
export const IDEA_TIMEOUT_MS = 180_000;
=======
export const ACCEPT_TIMEOUT_MS = 180_000;
>>>>>>> de146a854c2be9713e40505688960f87444be951

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

<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
/** The words of `args`, and its options (`--office`, `--story` and anything else) apart. */
function split(args: readonly string[]): {
  readonly words: string[];
  readonly rest: string[];
  readonly story: string | null | undefined;
} {
  const words: string[] = [];
  const rest: string[] = [];
  let story: string | null | undefined;
=======
/** The words and the options of a command line: `--office` and `--story` take a value. */
function splitArgs(args: readonly string[]): {
  readonly words: string[];
  readonly rest: string[];
  readonly story: string | undefined;
} {
  const words: string[] = [];
  const rest: string[] = [];
  let story: string | undefined;
>>>>>>> de146a854c2be9713e40505688960f87444be951
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--office") {
      rest.push(arg, ...(i + 1 < args.length ? [args[i + 1] ?? ""] : []));
      i += 1;
    } else if (arg === "--story") {
<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
      story = args[i + 1] ?? null;
      i += 1;
=======
      story = args[i + 1] ?? "";
      i += 1;
    } else if (arg === "--") {
      words.push(...args.slice(i + 1));
      break;
>>>>>>> de146a854c2be9713e40505688960f87444be951
    } else if (arg.startsWith("-")) {
      rest.push(arg);
    } else {
      words.push(arg);
    }
  }
  return { words, rest, story };
}

<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
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
=======
/**
 * True when the first word is `accept` or `dismiss` on its own: an answer to a proposed story. A
 * quick idea that starts with one of those words is given in quotes, as one word.
 */
function isAnswer(words: readonly string[]): boolean {
  return words[0] === "accept" || words[0] === "dismiss";
}

/** `dipo idea accept|dismiss <idea>`. */
async function answerIdea(
  deps: OfficeCommandDeps,
  action: "accept" | "dismiss",
  ref: string,
  rest: readonly string[],
): Promise<number> {
  const options = parseOptions(rest, false);
  if (typeof options === "string") return usage(deps, `idea: ${options}`);
  const idea = ref.toLowerCase();
  return withOffice(
    deps,
    options.office,
    async (session, office) => {
      if (action === "dismiss") {
        const outcome = await session.command(ideaDismiss, { idea }, { office });
>>>>>>> de146a854c2be9713e40505688960f87444be951
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
<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
      const outcome = await session.command(ideaAccept, { idea }, { office: target });
=======
      const outcome = await session.command(ideaAccept, { idea }, { office });
>>>>>>> de146a854c2be9713e40505688960f87444be951
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
<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
    IDEA_TIMEOUT_MS,
  );
}

/** `dipo note dismiss <note>`: closes a worker's decision note from the desk. */
=======
    ACCEPT_TIMEOUT_MS,
  );
}

export async function ideaCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
  const { words, rest, story } = splitArgs(args);
  if (isAnswer(words)) {
    const [action, id, ...extra] = words;
    if (id === undefined) return usage(deps, `idea ${action} needs an idea id`);
    if (extra.length > 0) return usage(deps, `idea ${action} takes one idea id`);
    if (story !== undefined) return usage(deps, `idea ${action} takes no --story`);
    if (!IdeaRef.safeParse(id.toLowerCase()).success) {
      return usage(
        deps,
        `idea: ${JSON.stringify(id)} is not an idea id (dipo desk prints it; 8 or more of its characters will do)`,
      );
    }
    return answerIdea(deps, action as "accept" | "dismiss", id, rest);
  }
  if (words.length === 0) {
    return usage(deps, "idea needs the idea's text in quotes, or accept|dismiss and an idea id");
  }
  if (story === "") return usage(deps, "idea: --story needs a story id");
  const text = words.join(" ").trim();
  if (text === "") return usage(deps, "idea needs the idea's text");
  if (Array.from(text).length > QUICK_IDEA_MAX) {
    return usage(deps, `idea: the text is longer than ${QUICK_IDEA_MAX} characters`);
  }
  const options = parseOptions(rest, false);
  if (typeof options === "string") return usage(deps, `idea: ${options}`);
  return withOffice(deps, options.office, async (session, office) => {
    const outcome = await session.command(
      ideaAdd,
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
        ? `handed idea ${name} to the audit; if it passes, it reaches your desk as a proposed story (dipo ideas shows it meanwhile)`
        : `idea ${name} is held already; dipo ideas shows where it stands`,
    );
    return 0;
  });
}

/** `dipo note dismiss <note>`: closes a worker's decision note. */
>>>>>>> de146a854c2be9713e40505688960f87444be951
export async function noteCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
  const { words, rest, story } = split(args);
  const [action, id, ...extra] = words;
  if (action !== "dismiss") return usage(deps, "note needs dismiss and a decision note id");
  if (id === undefined) return usage(deps, "note dismiss needs a decision note id");
  if (extra.length > 0 || story !== undefined) {
    return usage(deps, "note dismiss takes one decision note id");
  }
  const note = NoteRef.safeParse(id.toLowerCase());
=======
  const { words, rest } = splitArgs(args);
  const [action, id, ...extra] = words;
  if (action !== "dismiss") return usage(deps, "note needs dismiss and a decision note id");
  if (id === undefined) return usage(deps, "note dismiss needs a decision note id");
  if (extra.length > 0) return usage(deps, "note dismiss takes one decision note id");
  const note = ProposalRef.safeParse(id.toLowerCase());
>>>>>>> de146a854c2be9713e40505688960f87444be951
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
<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
        ? `dismissed decision note ${name}; add it to the decision record by hand if you agree`
=======
        ? `dismissed decision note ${name}; dipo never writes decision records, so add it by hand if you agree`
>>>>>>> de146a854c2be9713e40505688960f87444be951
        : `decision note ${name} was dismissed already`,
    );
    return 0;
  });
}
