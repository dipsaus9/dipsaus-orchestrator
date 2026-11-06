// `dipo ideas [--state held|passed|rejected] [--office <id>] [--json]` (0022, DIPO-452): reads
// `office.ideas` for the office from `--office` or the current directory and prints its ideas in
// plain text: a count line, then each idea with its state, id, origin, source story and title, and
// under it what decided it: a passed idea's proposed user story (what was found with its evidence,
// the Story line, the proposal, why, and the milestone or tech debt), a rejected idea's reason and
// who gave it, or what a held idea waits for. `--json` prints the read's result. Read only: it
// never starts the daemon, and never offers to open a folder that is not an office.

import { basename } from "node:path";

import {
  IDEA_STATES,
  type IdeaState,
  type IdeaView,
  officeIdeas,
  TECH_DEBT,
} from "@dipsaus-orchestrator/contract";

import { engineFailure, usage } from "./daemon-commands";
import { type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";

export const NO_IDEAS = "No ideas are held.";

const INDENT = "    ";
const short = (id: string) => id.slice(0, 12);

/** What a held idea waits for: its run's end, or its next audit after one missed it. */
function heldLines(idea: IdeaView): string[] {
  if (idea.attempts === 0) {
    return [
      idea.run === undefined || idea.story === undefined
        ? "Waits for its audit."
        : `Waits for its audit once the run of ${idea.story} is merged or parked.`,
    ];
  }
  const times = idea.attempts === 1 ? "once" : `${idea.attempts} times`;
  return [
    `Audited ${times} without a decision; audited again at the next trigger.`,
    ...(idea.lastProblem === undefined ? [] : [`Last problem: ${idea.lastProblem}`]),
  ];
}

/** A passed idea's proposed user story, one part per line. */
function passedLines(idea: IdeaView): string[] {
  const proposal = idea.proposal;
  if (proposal === undefined) return [];
  const evidence = proposal.evidence.map((place) => `${place.file}:${place.line}`).join(", ");
  return [
    `Found: ${proposal.found}${evidence === "" ? "" : ` (${evidence})`}`,
    ...(proposal.sourceStory === undefined ? [] : [`Source story: ${proposal.sourceStory}`]),
    `Story: ${proposal.storyLine}`,
    `Proposed: ${proposal.proposed}`,
    `Why: ${proposal.why}`,
    `Serves: ${proposal.serves === TECH_DEBT ? "tech debt" : `milestone ${proposal.serves}`}`,
  ];
}

/** The lines under an idea's head line. */
function detailLines(idea: IdeaView): string[] {
  switch (idea.state) {
    case "passed":
      return passedLines(idea);
    case "rejected":
      return [
        `Rejected by ${idea.decidedBy === "code" ? "code" : "the audit"}: ${idea.reason ?? ""}`,
      ];
    default:
      return heldLines(idea);
  }
}

/** The ideas as plain-text lines; `label` names the office on the count line. */
export function formatIdeas(label: string, ideas: readonly IdeaView[]): string[] {
  if (ideas.length === 0) return [NO_IDEAS];
  const count = (state: IdeaState) => ideas.filter((idea) => idea.state === state).length;
  const lines = [
    `${label} · ideas ${ideas.length} · held ${count("held")} · passed ${count("passed")} · rejected ${count("rejected")}`,
  ];
  const stateWidth = Math.max(...ideas.map((idea) => idea.state.length));
  for (const idea of ideas) {
    const source = idea.story ?? "-";
    lines.push(
      `${idea.state.toUpperCase().padEnd(stateWidth)} ${short(idea.id)} ${idea.origin} ${source}  ${idea.title}`,
    );
    for (const line of detailLines(idea)) lines.push(`${INDENT}${line}`);
  }
  return lines;
}

interface IdeasOptions {
  readonly json: boolean;
  readonly state: IdeaState | undefined;
  readonly rest: readonly string[];
}

function splitOptions(args: readonly string[]): IdeasOptions | string {
  let state: IdeaState | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--state") {
      const value = args[i + 1] ?? "";
      if (!(IDEA_STATES as readonly string[]).includes(value)) {
        return `--state needs one of ${IDEA_STATES.join(", ")}`;
      }
      state = value as IdeaState;
      i += 1;
    } else if (arg !== "--json") {
      rest.push(arg);
    }
  }
  return { json: args.includes("--json"), state, rest };
}

export async function ideasCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
  const split = splitOptions(args);
  if (typeof split === "string") return usage(deps, `ideas: ${split}`);
  const options = parseOptions(split.rest, false);
  if (typeof options === "string") return usage(deps, `ideas: ${options}`);
  return withOffice(
    deps,
    options.office,
    async (session, office, main) => {
      const outcome = await session.read(officeIdeas, {
        office,
        ...(split.state === undefined ? {} : { state: split.state }),
      });
      if (!outcome.ok) {
        return outcome.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, outcome.error);
      }
      if (split.json) {
        deps.writeLine(JSON.stringify(outcome.result));
        return 0;
      }
      const label = main === undefined ? office : basename(main);
      for (const line of formatIdeas(label, outcome.result)) deps.writeLine(line);
      return 0;
    },
    undefined,
    undefined,
    "running",
    // Read only: a folder that is not an office is named, never offered to open.
    false,
  );
}
