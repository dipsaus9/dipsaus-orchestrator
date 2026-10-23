// `dipo resume <id> [--note <text>] [--budget +<n>%|+<tokens>] [--yes] [--office <id>]` (DIPO-155;
// 0020 sections 1, 4 and 16): sends `work.resume` for the story in the office of `--office` or of
// the current directory. A paused run continues, a held one is lifted, and a parked story resumes as
// its park's row of the 0020 matrix says. `--budget` tops up a `budget-exceeded` park: `work.resume`
// declares `confirmWhen: ["budget"]` in the contract, so the CLI first sends it unconfirmed, shows
// the caps before and after from the engine's `confirmation.required` and asks yes or no; `--yes`
// answers for a script, and without a terminal a top-up refuses instead of asking. The reply says
// where the story went, which grants were recorded and whether its session waits for its place.

import {
  type ResumeBudget,
  ResumeConfirmDetails,
  type ResumeGrant,
  StoryId,
  StoryKey,
  type StoryRefValue,
  workResume,
} from "@dipsaus-orchestrator/contract";

import { engineFailure, usage } from "./daemon-commands";
import { type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";

const YES = /^\s*y(es)?\s*$/i;

/**
 * How long `dipo resume` waits for its reply: the park lifted on the branch (a task-file commit and
 * its push, each git step killed after a minute), then the reply; the session starts after it.
 */
export const RESUME_TIMEOUT_MS = 180_000;

function storyRef(text: string): StoryRefValue | null {
  const key = StoryKey.safeParse(text);
  if (key.success) return key.data;
  const id = StoryId.safeParse(text.toUpperCase());
  return id.success ? id.data : null;
}

/** `+50%` as a share, `+200000` (or `+200,000`, `+200_000`) as tokens; null for anything else. */
export function parseBudget(text: string): ResumeBudget | null {
  const share = /^\+(\d+(?:\.\d+)?)%$/.exec(text);
  if (share !== null) {
    const value = Number(share[1]);
    return value > 0 ? { share: value } : null;
  }
  const tokens = /^\+(\d[\d,_]*)$/.exec(text);
  if (tokens !== null) {
    const value = Number((tokens[1] ?? "").replace(/[,_]/g, ""));
    return Number.isSafeInteger(value) && value > 0 ? { tokens: value } : null;
  }
  return null;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

/** One grant as the reply line names it. */
function grantText(grant: ResumeGrant): string {
  switch (grant.kind) {
    case "budget":
      return `+${count(grant.tokens ?? 0)} tokens, +${count(grant.turns ?? 0)} turns and +${count(grant.minutes ?? 0)} minutes`;
    case "reviewCap":
      return `the reviewer's cap +${count(grant.turns ?? 0)} turns and +${count(grant.minutes ?? 0)} minutes`;
    case "loop":
      return "one more verify loop";
    case "ciAttempt":
      return "one more CI attempt";
    case "conflictHandoff":
      return "one more conflict hand-off";
    case "reviewRound":
      return "one more review round";
    default:
      return grant.kind;
  }
}

/** The caps before and after a top-up, one line each, as the question shows them. */
export function capsLines(details: ResumeConfirmDetails): string[] {
  const rows: [string, number, number][] = [
    ["tokens", details.before.budgetTokens, details.after.budgetTokens],
    ["turns", details.before.maxTurns, details.after.maxTurns],
    ["minutes", details.before.maxMinutes, details.after.maxMinutes],
  ];
  const width = Math.max(...rows.map(([, before]) => count(before).length));
  return rows.map(
    ([name, before, after]) =>
      `  ${name.padEnd(8)}${count(before).padStart(width)} -> ${count(after)}`,
  );
}

interface Parsed {
  readonly story: StoryRefValue;
  readonly note: string | undefined;
  readonly budget: ResumeBudget | undefined;
  readonly rest: string[];
}

function parse(args: readonly string[], deps: OfficeCommandDeps): Parsed | number {
  let story: StoryRefValue | null = null;
  let note: string | undefined;
  let budget: ResumeBudget | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--note") {
      const value = args[i + 1];
      if (value === undefined || value.trim() === "") {
        return usage(deps, "resume: --note needs a text");
      }
      note = value;
      i += 1;
    } else if (arg === "--budget") {
      const parsed = parseBudget(args[i + 1] ?? "");
      if (parsed === null) {
        return usage(deps, "resume: --budget needs +<n>% or +<tokens>, such as +50% or +200000");
      }
      budget = parsed;
      i += 1;
    } else if (arg === "--office") {
      rest.push(arg, ...(i + 1 < args.length ? [args[i + 1] ?? ""] : []));
      i += 1;
    } else if (!arg.startsWith("-")) {
      if (story !== null) return usage(deps, "resume takes one story id");
      story = storyRef(arg);
      if (story === null) return usage(deps, `resume: ${JSON.stringify(arg)} is not a story id`);
    } else {
      rest.push(arg);
    }
  }
  if (story === null) return usage(deps, "resume needs a story id");
  return { story, note, budget, rest };
}

export async function resumeCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
  const parsed = parse(args, deps);
  if (typeof parsed === "number") return parsed;
  const options = parseOptions(parsed.rest, true);
  if (typeof options === "string") return usage(deps, `resume: ${options}`);
  const { story, note, budget } = parsed;
  // `confirmWhen: ["budget"]`: a top-up asks first, unless --yes answered.
  const asks = budget !== undefined && workResume.confirmWhen?.includes("budget") === true;
  if (asks && !options.yes && !deps.workspace.interactive) {
    deps.writeError(
      `dipo: topping up ${story} needs confirmation; run it at a terminal or pass --yes.`,
    );
    return 1;
  }
  const send = (confirmed: boolean, pending: { details: ResumeConfirmDetails | null }) =>
    withOffice(
      deps,
      options.office,
      async (session, office) => {
        const outcome = await session.command(
          workResume,
          {
            story,
            ...(note === undefined ? {} : { note }),
            ...(budget === undefined ? {} : { budget }),
          },
          { office, confirmed },
        );
        if (!outcome.ok) {
          if (outcome.error.code === "office.unknown") return "unknown";
          const details = ResumeConfirmDetails.safeParse(outcome.error.details);
          if (outcome.error.code === "confirmation.required" && !confirmed && details.success) {
            pending.details = details.data;
            return 0;
          }
          return engineFailure(deps, outcome.error);
        }
        const { result } = outcome;
        const where =
          result.queued === true
            ? `it is ${result.to}; its session starts when the office's place frees`
            : `it is ${result.to}`;
        deps.writeLine(
          `resumed ${story}${result.run === undefined ? "" : ` (run ${result.run})`}; ${where}`,
        );
        if (result.grants !== undefined && result.grants.length > 0) {
          deps.writeLine(`granted: ${result.grants.map(grantText).join("; ")}`);
        }
        return 0;
      },
      undefined,
      RESUME_TIMEOUT_MS,
    );
  const pending: { details: ResumeConfirmDetails | null } = { details: null };
  // Confirmed only with --yes or after the maintainer answered yes below, never by default.
  const code = await send(options.yes, pending);
  if (code !== 0 || pending.details === null) return code;
  // Asked while no connection is open, so the reply deadline never runs while a person decides.
  deps.writeLine(`Top up ${story}: its caps go from the left to the right.`);
  for (const line of capsLines(pending.details)) deps.writeLine(line);
  const answer = await deps.workspace.ask(`Raise ${story}'s caps and resume it? [y/N] `);
  if (!YES.test(answer)) {
    deps.writeLine("nothing resumed");
    return 1;
  }
  return await send(true, { details: null });
}
