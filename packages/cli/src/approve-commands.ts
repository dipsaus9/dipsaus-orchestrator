// `dipo approve <id> [--note <text>]` and `dipo reject <id> --note <text> [--yes]` (DIPO-150 with
// DIPO-151; 0019 section 11): the maintainer's decision on the story's merge that waits for them.
// Both read the story's open gate that waits for the maintainer from `story.detail` (its newest
// one) and send its id with `gate.approve` or `gate.reject`; with none they print that nothing
// waits and exit 1. `dipo gate` stays the Ready gate check.
//
// Approve asks nothing; a note is optional, and required when the gate overrides a blocked review
// (the engine answers `gate.noteRequired`). Reject is `confirm: true` in the contract, so the CLI
// asks yes or no first (`--yes` answers for a script, and without a terminal it refuses); its note
// goes to the worker in a fix round.

import { storyRef } from "@dipsaus-orchestrator/client";
import {
  gateApprove,
  type GateId,
  gateReject,
  type StoryRefValue,
  storyDetail,
} from "@dipsaus-orchestrator/contract";

import { engineFailure, usage } from "./daemon-commands";
import { type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";

const YES = /^\s*y(es)?\s*$/i;

/**
 * How long these commands wait: an override lifts the park on the story branch (a Backlog CLI
 * call and a push) before it answers.
 */
export const APPROVE_TIMEOUT_MS = 120_000;

interface Parsed {
  readonly story: StoryRefValue;
  readonly note: string | undefined;
  readonly rest: string[];
}

/** One story id, `--note` and the office options; else usage. */
function parseArgs(
  name: string,
  args: readonly string[],
  deps: OfficeCommandDeps,
): Parsed | number {
  let story: StoryRefValue | null = null;
  let note: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--note") {
      const value = args[i + 1];
      if (value === undefined || value.trim() === "") {
        return usage(deps, `${name}: --note needs a text`);
      }
      note = value;
      i += 1;
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
  return { story, note, rest };
}

/** The story's newest open gate that waits for the maintainer, read from `story.detail`. */
async function waitingGate(
  deps: OfficeCommandDeps,
  office: Parameters<typeof withOffice>[1],
  story: StoryRefValue,
): Promise<{ code: number; gate?: GateId; summary?: string }> {
  const found: { gate?: GateId; summary?: string } = {};
  const code = await withOffice(
    deps,
    office,
    async (session, id) => {
      const outcome = await session.read(storyDetail, { office: id, story });
      if (!outcome.ok) {
        return outcome.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, outcome.error);
      }
      const gates = (outcome.result.gates ?? []).filter((gate) => gate.waitingOn === "maintainer");
      const newest = gates.at(-1);
      if (newest === undefined) {
        deps.writeLine(`nothing waits for you on ${story}`);
        return 1;
      }
      found.gate = newest.gate;
      found.summary = newest.summary;
      return 0;
    },
    undefined,
    APPROVE_TIMEOUT_MS,
  );
  return { code, ...found };
}

export async function approveCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
  const parsed = parseArgs("approve", args, deps);
  if (typeof parsed === "number") return parsed;
  const options = parseOptions(parsed.rest, false);
  if (typeof options === "string") return usage(deps, `approve: ${options}`);
  const { story, note } = parsed;
  const waiting = await waitingGate(deps, options.office, story);
  if (waiting.code !== 0 || waiting.gate === undefined) return waiting.code || 1;
  const gate = waiting.gate;
  return withOffice(
    deps,
    options.office,
    async (session, office) => {
      const outcome = await session.command(
        gateApprove,
        { gate, ...(note === undefined ? {} : { note }) },
        { office },
      );
      if (!outcome.ok) {
        return outcome.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, outcome.error);
      }
      deps.writeLine(`approved the merge of ${story}; dipo turns GitHub's auto-merge on for it`);
      return 0;
    },
    undefined,
    APPROVE_TIMEOUT_MS,
  );
}

export async function rejectCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
  const parsed = parseArgs("reject", args, deps);
  if (typeof parsed === "number") return parsed;
  if (parsed.note === undefined) return usage(deps, "reject needs --note <text>");
  const options = parseOptions(parsed.rest, true);
  if (typeof options === "string") return usage(deps, `reject: ${options}`);
  const { story } = parsed;
  const note = parsed.note;
  const waiting = await waitingGate(deps, options.office, story);
  if (waiting.code !== 0 || waiting.gate === undefined) return waiting.code || 1;
  const gate = waiting.gate;
  const confirm = async (): Promise<boolean> => {
    if (!gateReject.confirm || options.yes) return true;
    if (!deps.workspace.interactive) {
      deps.writeError(
        `dipo: rejecting ${story} needs confirmation; run it at a terminal or pass --yes.`,
      );
      return false;
    }
    const answer = await deps.workspace.ask(
      `Reject the merge of ${story}? Your note goes to its worker in a fix round. [y/N] `,
    );
    if (YES.test(answer)) return true;
    deps.writeLine("nothing rejected");
    return false;
  };
  return withOffice(
    deps,
    options.office,
    async (session, office) => {
      const outcome = await session.command(gateReject, { gate, note }, { office });
      if (!outcome.ok) {
        return outcome.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, outcome.error);
      }
      deps.writeLine(`rejected the merge of ${story}; your note goes to its worker`);
      return 0;
    },
    confirm,
    APPROVE_TIMEOUT_MS,
  );
}
