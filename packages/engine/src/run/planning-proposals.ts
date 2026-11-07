// The proposals of a planning session (DIPO-450, 0022), pure. The session writes each proposal in its
// answer as a fenced block with the info string `dipo-proposal` holding one JSON object
// (`PLANNING_PROPOSAL_FENCE`). At each turn end the engine reads every block of the answer: the
// JSON is held to `PROPOSAL_BLOCK_MAX_CHARS`, every string is cleaned at the door (0008) and a key
// cleaning would change is refused, then the contract's `PlanningProposal` schema and the Ready
// gate's Story line check (0012 R05) decide. A block that fails is refused with its problems, which
// go back to the session as one message (`refusalMessage`).
//
// A confirmed proposal becomes planning-lane targets (0010): a new story a `file` target, an edit a
<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
// `revise` target, a split one of each, and a draft refined in triage a `refine` target (DIPO-454);
// a draft dropped in triage is the lane's drop.
=======
// `revise` target, a split one of each, a refined draft a `refine` target and a dropped draft a
// `drop` of the draft (DIPO-454).
>>>>>>> de146a854c2be9713e40505688960f87444be951

import {
  cleanText,
  PLANNING_PROPOSAL_FENCE,
  PlanningProposal,
  type PlanningEditFields,
  type PlanningStoryFields,
} from "@dipsaus-orchestrator/contract";

import { cleanDoorStrings, doorKeysClean } from "../box/door";
import { checkStoryLine } from "../gate/rules";
import {
  type FileTarget,
  type RefineTarget,
  type ReviseTarget,
  storyDescription,
} from "../story-store/planning";

/** The largest proposal block, in characters of JSON, before it is parsed. */
export const PROPOSAL_BLOCK_MAX_CHARS = 32_000;
/** How many refused blocks the planning view shows: the latest. */
export const PLANNING_REFUSALS_SHOWN = 3;
/**
 * How many answers in a row dipo refuses by itself, sending the problems to the session at once; after
 * that the problems wait for the maintainer's next message, so a session never loops on its own.
 */
export const AUTO_REFUSALS_MAX = 2;
/** The statuses a confirmed edit applies from (0012: never In Progress, In Review or Done). */
export const REVISABLE_STATUSES = ["Refined", "Ready", "Parked", "To Do"];

/** One block read from an answer: a valid proposal, or why it was refused. */
export type ProposalRead =
  | { readonly ok: true; readonly proposal: PlanningProposal }
  | { readonly ok: false; readonly problems: readonly string[] };

const OPEN_LINE = new RegExp(`^\\s*\`\`\`${PLANNING_PROPOSAL_FENCE}\\s*$`);
const CLOSE_LINE = /^\s*```\s*$/;

/** Pure: the content of every proposal block in `text`, in order; an unclosed block is null. */
export function proposalBlocks(text: string): (string | null)[] {
  const blocks: (string | null)[] = [];
  let open: string[] | null = null;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (open === null) {
      if (OPEN_LINE.test(line)) open = [];
    } else if (CLOSE_LINE.test(line)) {
      blocks.push(open.join("\n"));
      open = null;
    } else {
      open.push(line);
    }
  }
  if (open !== null) blocks.push(null);
  return blocks;
}

/** The Story line problems of `text`, each named by `where`; none when there is no text. */
function lineProblems(text: string | undefined, spike: boolean, where: string): string[] {
  return text === undefined
    ? []
    : checkStoryLine(text, spike).map((problem) => `${where}: ${problem}`);
}

/** The engine's checks beyond the schema: the Story lines (0012 R05). */
export function proposalProblems(proposal: PlanningProposal): string[] {
  switch (proposal.kind) {
    case "story":
      return lineProblems(proposal.storyLine, proposal.type === "spike", "storyLine");
    case "edit":
      return lineProblems(proposal.storyLine, isSpikeLine(proposal.storyLine), "storyLine");
    case "split":
      return [
        ...lineProblems(
          proposal.edit.storyLine,
          isSpikeLine(proposal.edit.storyLine),
          "edit.storyLine",
        ),
        ...lineProblems(
          proposal.story.storyLine,
          proposal.story.type === "spike",
          "story.storyLine",
        ),
      ];
    case "refine":
      return lineProblems(proposal.storyLine, proposal.type === "spike", "storyLine");
    case "drop":
      return [];
  }
}

/** An edit does not say its story's type; a spike's Story line reads `We need to decide`. */
function isSpikeLine(text: string | undefined): boolean {
  return text?.trimStart().startsWith("We need to decide") ?? false;
}

/** Pure: a proposal as the maintainer or the session wrote it, checked: valid, or its problems. */
export function checkProposal(value: unknown): ProposalRead {
  if (!doorKeysClean(value)) {
    return { ok: false, problems: ["a key holds characters dipo does not accept"] };
  }
  const parsed = PlanningProposal.safeParse(cleanDoorStrings(value));
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "proposal"}: ${issue.message}`,
      ),
    };
  }
  const problems = proposalProblems(parsed.data);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, proposal: parsed.data };
}

/** Pure: every proposal block of an answer, read and checked. */
export function readProposals(text: string): ProposalRead[] {
  return proposalBlocks(text).map((block): ProposalRead => {
    if (block === null) return { ok: false, problems: ["the block is not closed with ```"] };
    if (block.length > PROPOSAL_BLOCK_MAX_CHARS) {
      return {
        ok: false,
        problems: [`the block has ${block.length} characters; at most ${PROPOSAL_BLOCK_MAX_CHARS}`],
      };
    }
    let value: unknown;
    try {
      value = JSON.parse(block);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return { ok: false, problems: [`the block is not one JSON object: ${cleanText(why)}`] };
    }
    return checkProposal(value);
  });
}

/** Pure: the message that tells the session which blocks of its answer were refused, and why. */
export function refusalMessage(refused: readonly (readonly string[])[]): string {
  const lines = refused.map(
    (problems, index) => `- block ${index + 1} of the refused ones: ${problems.join("; ")}`,
  );
  return [
    `[dipo] dipo refused ${refused.length === 1 ? "a proposal block" : `${refused.length} proposal blocks`} of your last answer, so the maintainer cannot confirm ${refused.length === 1 ? "it" : "them"}. Write each again as one \`\`\`${PLANNING_PROPOSAL_FENCE} block holding one JSON object that passes the proposal schema of your first message:`,
    ...lines,
  ].join("\n");
}

/** Pure: the `file` target of a confirmed new story (0012: Refined, tier label, field block). */
export function fileTargetOf(
  run: string,
  proposal: number,
  story: PlanningStoryFields,
): FileTarget {
  const testPlan =
    story.testPlan === undefined
      ? undefined
      : "entries" in story.testPlan
        ? {
            entries: story.testPlan.entries.map((entry) => ({
              kind: entry.kind,
              check: entry.check.trim(),
              ...(entry.expect === undefined ? {} : { expect: entry.expect.trim() }),
            })),
          }
        : { not_applicable: story.testPlan.notApplicable.trim() };
  return {
    run,
    proposal,
    title: story.title.trim(),
    type: story.type,
    milestone: story.milestone.trim(),
    tier: story.tier,
    description: storyDescription(story.storyLine, story.context),
    criteria: story.criteria.map((text) => text.trim()),
    references: [...new Set(story.references)],
    dependencies: [...new Set((story.dependencies ?? []).map((id) => id.toUpperCase()))],
    ...(testPlan === undefined ? {} : { testPlan }),
  };
}

/** Pure: the `revise` target of a confirmed edit. */
export function reviseTargetOf(
  run: string,
  proposal: number,
  edit: PlanningEditFields,
): ReviseTarget {
  return {
    run,
    proposal,
    from: REVISABLE_STATUSES,
    ...(edit.title === undefined ? {} : { title: edit.title.trim() }),
    ...(edit.storyLine === undefined ? {} : { storyLine: edit.storyLine.trim() }),
    ...(edit.context === undefined ? {} : { context: edit.context.trim() }),
    ...(edit.criteria === undefined ? {} : { criteria: edit.criteria.map((text) => text.trim()) }),
    ...(edit.references === undefined ? {} : { references: [...new Set(edit.references)] }),
  };
}

/** The fields of an edit proposal, without its kind, id and why. */
export function editFieldsOf(
  proposal: Extract<PlanningProposal, { kind: "edit" }>,
): PlanningEditFields {
  const { kind: _kind, id: _id, why: _why, ...fields } = proposal;
  return fields;
}

/** The fields of a new story proposal, without its kind and why. */
export function storyFieldsOf(
  proposal: Extract<PlanningProposal, { kind: "story" }>,
): PlanningStoryFields {
  const { kind: _kind, why: _why, ...fields } = proposal;
  return fields;
}

<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
/** Pure: the `refine` target of a confirmed draft refinement (DIPO-454). */
export function refineTargetOf(
  run: string,
  proposal: number,
  refine: Extract<PlanningProposal, { kind: "refine" }>,
  draftTitle: string,
): RefineTarget {
  const { kind: _kind, draft: _draft, why: _why, ...story } = refine;
=======
/** The fields of a refine proposal, without its kind, draft and why (DIPO-454). */
export function refineFieldsOf(
  proposal: Extract<PlanningProposal, { kind: "refine" }>,
): PlanningStoryFields {
  const { kind: _kind, draft: _draft, why: _why, ...fields } = proposal;
  return fields;
}

/** Pure: the `refine` target of a confirmed refinement of the draft titled `draftTitle`. */
export function refineTargetOf(
  run: string,
  proposal: number,
  story: PlanningStoryFields,
  draftTitle: string,
): RefineTarget {
>>>>>>> de146a854c2be9713e40505688960f87444be951
  return { ...fileTargetOf(run, proposal, story), draftTitle };
}
