// `dipo propose accept|dismiss <proposal> [--office <id>]` (DIPO-166; 0020 sections 11c and 16):
// sends `proposal.accept` or `proposal.dismiss` for a worker's proposal that `dipo desk` lists, in
// the office of `--office` or of the current directory. Neither asks for confirmation. The proposal
// is named by the id the desk prints, or by its first 8 or more characters.

import { ProposalRef, proposalAccept, proposalDismiss } from "@dipsaus-orchestrator/contract";

import { engineFailure, usage } from "./daemon-commands";
import { type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";

/** How long `accept` waits: the planning lane's flush creates the draft and pushes it. */
export const PROPOSE_TIMEOUT_MS = 180_000;

const short = (id: string) => id.slice(0, 12);

export async function proposeCommand(
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
  if (action !== "accept" && action !== "dismiss") {
    return usage(deps, "propose needs accept or dismiss and a proposal id");
  }
  if (id === undefined) return usage(deps, `propose ${action} needs a proposal id`);
  if (extra.length > 0) return usage(deps, `propose ${action} takes one proposal id`);
  const proposal = ProposalRef.safeParse(id.toLowerCase());
  if (!proposal.success) {
    return usage(
      deps,
      `propose: ${JSON.stringify(id)} is not a proposal id (dipo desk prints it; 8 or more of its characters will do)`,
    );
  }
  const options = parseOptions(rest, false);
  if (typeof options === "string") return usage(deps, `propose: ${options}`);
  return withOffice(
    deps,
    options.office,
    async (session, office) => {
      if (action === "dismiss") {
        const outcome = await session.command(
          proposalDismiss,
          { proposal: proposal.data },
          { office },
        );
        if (!outcome.ok) {
          return outcome.error.code === "office.unknown"
            ? "unknown"
            : engineFailure(deps, outcome.error);
        }
        const name = short(outcome.result.proposal);
        deps.writeLine(
          outcome.changed
            ? `dismissed proposal ${name}; nothing is filed`
            : `proposal ${name} was dismissed already`,
        );
        return 0;
      }
      const outcome = await session.command(
        proposalAccept,
        { proposal: proposal.data },
        { office },
      );
      if (!outcome.ok) {
        return outcome.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, outcome.error);
      }
      const name = short(outcome.result.proposal);
      const where =
        outcome.result.draft === undefined
          ? "dipo files it as a Backlog draft through the backlog PR"
          : `filed as Backlog draft ${outcome.result.draft} through the backlog PR`;
      deps.writeLine(
        outcome.changed
          ? `accepted proposal ${name}: ${where}`
          : `proposal ${name} was accepted already: ${where}`,
      );
      return 0;
    },
    undefined,
    PROPOSE_TIMEOUT_MS,
  );
}
