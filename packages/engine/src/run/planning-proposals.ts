// The proposals of a planning session (DIPO-450, 0022), pure. The session writes each proposal in its
// answer as a fenced block with the info string `dipo-proposal` holding one JSON object
// (`PLANNING_PROPOSAL_FENCE`). At each turn end the engine reads every block of the answer: the
// JSON is held to `PROPOSAL_BLOCK_MAX_CHARS`, every string is cleaned at the door (0008) and a key
// cleaning would change is refused, then the contract's `PlanningProposal` schema and the Ready
// gate's Story line check (0012 R05) decide. A block that fails is refused with its problems, which
// go back to the session as one message (`refusalMessage`).
//
// A confirmed proposal becomes planning-lane targets (0010): a new story a `file` target, an edit a
// `revise` target, a split one of each, a refined draft a `refine` target and a dropped draft a
// `drop` of the draft (DIPO-454).

import {
  cleanText,
  PLANNING_PROPOSAL_FENCE,
  PlanningProposal,
  type PlanningEditFields,
  type PlanningStoryFields,
} from "@dipsaus-orchestrator/contract";

import { cleanDoorStrings, doorKeysClean } from "../box/door";
import { checkStoryLine } from "../gate/rules";
import { editRoleFile, renderRoleFile, roleFilePath } from "../roles/file";
import { loadRoleFiles } from "../roles/base";
import { parseRoleFile } from "../roles/parse";
import {
  type FileTarget,
  type RefineTarget,
  type ReviseTarget,
  type RoleAddTarget,
  type RoleEditTarget,
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

const CLOSE_LINE = /^\s*```\s*$/;

/** Pure: the content of every proposal block in `text`, in order; an unclosed block is null. */
export function proposalBlocks(text: string): (string | null)[] {
  return fencedBlocks(text, PLANNING_PROPOSAL_FENCE);
}

/** Pure: the content of every block with the info string `fence` in `text`; unclosed is null. */
export function fencedBlocks(text: string, fence: string): (string | null)[] {
  const OPEN_LINE = new RegExp(`^\\s*\`\`\`${fence}\\s*$`);
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

/** What the role proposals are checked against: the base's role files and the open stories. */
export interface RoleFacts {
  /** The text of every role file on the base, by path (`BaseRoles.files`); undefined: no file. */
  readonly files: ReadonlyMap<string, string | undefined>;
  /** The ids of the stories that are not Done and have the label `role:<name>`. */
  readonly openStories: (name: string) => readonly string[];
}

/** The engine's checks of a role proposal beyond the schema (DIPO-474). */
function roleProblems(
  proposal: Extract<PlanningProposal, { kind: "role" | "role-edit" | "role-remove" }>,
  facts: RoleFacts | undefined,
): string[] {
  if (facts === undefined) return ["this office's role files are not loaded yet; try again soon"];
  const path = roleFilePath(proposal.name);
  const exists = facts.files.has(path);
  if (proposal.kind === "role") {
    if (exists)
      return [`the role \`${proposal.name}\` already has a file, ${path}; propose a role-edit`];
    const { kind: _kind, why: _why, ...fields } = proposal;
    const loaded = parseRoleFile(path, renderRoleFile(fields));
    return loaded.ok ? [] : [loaded.message];
  }
  if (!exists) return [`the role \`${proposal.name}\` has no file ${path} on the base`];
  if (proposal.kind === "role-remove") {
    const stories = facts.openStories(proposal.name);
    return stories.length === 0
      ? []
      : [
          `the role \`${proposal.name}\` is still the label of ${stories.join(", ")}, which ${stories.length === 1 ? "is" : "are"} not Done`,
        ];
  }
  const current = facts.files.get(path);
  if (current === undefined) return [`${path}: not a regular file`];
  const { kind: _kind, why: _why, name: _name, ...changes } = proposal;
  const text = editRoleFile(current, changes);
  if (text === null) return [`${path}: no YAML frontmatter between --- lines at the top`];
  const loaded = parseRoleFile(path, text);
  return loaded.ok ? [] : [loaded.message];
}

/** The problem when `role` is not in the roster of the base's role files (DIPO-476). */
export function rosterProblems(
  role: string,
  facts: RoleFacts | undefined,
  where: string,
): string[] {
  if (facts === undefined) return ["this office's role files are not loaded yet; try again soon"];
  const names = loadRoleFiles(facts.files).roles.map((candidate) => candidate.name);
  return names.includes(role)
    ? []
    : [
        `${where}: the role \`${role}\` is not in the roster; the roster has ${names.join(", ") || "no roles"}`,
      ];
}

const ROLE_PROPOSAL_KINDS: readonly string[] = ["role", "role-edit", "role-remove"];

/**
 * The problem when a session of `sessionKind` may not take `proposal` (DIPO-475): a roles session
 * takes only role proposals, every other kind takes none. None while the session's kind is not known.
 */
function kindProblems(proposal: PlanningProposal, sessionKind: string | undefined): string[] {
  if (sessionKind === undefined) return [];
  const isRole = ROLE_PROPOSAL_KINDS.includes(proposal.kind);
  if (sessionKind === "roles" && !isRole) {
    return [
      `a roles session takes only role, role-edit and role-remove proposals, not a \`${proposal.kind}\` proposal`,
    ];
  }
  if (sessionKind !== "roles" && isRole) {
    return [
      `a ${sessionKind} session takes no \`${proposal.kind}\` proposal: role changes are made in a roles session, started from the Roles room`,
    ];
  }
  return [];
}

/** The engine's checks beyond the schema: the Story lines (0012 R05) and the roles (DIPO-474). */
export function proposalProblems(
  proposal: PlanningProposal,
  roles?: RoleFacts,
  sessionKind?: string,
): string[] {
  const refused = kindProblems(proposal, sessionKind);
  if (refused.length > 0) return refused;
  switch (proposal.kind) {
    case "role":
    case "role-edit":
    case "role-remove":
      return roleProblems(proposal, roles);
    case "story":
      return [
        ...lineProblems(proposal.storyLine, proposal.type === "spike", "storyLine"),
        ...rosterProblems(proposal.role, roles, "role"),
      ];
    case "edit":
      return [
        ...lineProblems(proposal.storyLine, isSpikeLine(proposal.storyLine), "storyLine"),
        ...(proposal.role === undefined ? [] : rosterProblems(proposal.role, roles, "role")),
      ];
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
        ...rosterProblems(proposal.story.role, roles, "story.role"),
        ...(proposal.edit.role === undefined
          ? []
          : rosterProblems(proposal.edit.role, roles, "edit.role")),
      ];
    case "refine":
      return [
        ...lineProblems(proposal.storyLine, proposal.type === "spike", "storyLine"),
        ...rosterProblems(proposal.role, roles, "role"),
      ];
    case "drop":
      return [];
  }
}

/** An edit does not say its story's type; a spike's Story line reads `We need to decide`. */
function isSpikeLine(text: string | undefined): boolean {
  return text?.trimStart().startsWith("We need to decide") ?? false;
}

/** Pure: a proposal as the maintainer or the session wrote it, checked: valid, or its problems. */
export function checkProposal(
  value: unknown,
  roles?: RoleFacts,
  sessionKind?: string,
): ProposalRead {
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
  const problems = proposalProblems(parsed.data, roles, sessionKind);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, proposal: parsed.data };
}

/** Pure: every proposal block of an answer, read and checked. */
export function readProposals(
  text: string,
  roles?: RoleFacts,
  sessionKind?: string,
): ProposalRead[] {
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
    return checkProposal(value, roles, sessionKind);
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
    role: story.role,
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
    ...(edit.dependencies === undefined
      ? {}
      : { dependencies: [...new Set(edit.dependencies.map((id) => id.toUpperCase()))] }),
    ...(edit.role === undefined ? {} : { role: edit.role }),
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
  return { ...fileTargetOf(run, proposal, story), draftTitle };
}

/** Pure: the `role-add` target of a confirmed role proposal. */
export function roleAddTargetOf(
  run: string,
  proposal: number,
  role: Extract<PlanningProposal, { kind: "role" }>,
): RoleAddTarget {
  return {
    run,
    proposal,
    name: role.name,
    purpose: role.purpose.trim(),
    ...(role.model === undefined ? {} : { model: role.model.trim() }),
    ...(role.effort === undefined ? {} : { effort: role.effort.trim() }),
    instructions: role.instructions.trim(),
  };
}

/** Pure: the `role-edit` target of a confirmed role-edit proposal: only the fields it names. */
export function roleEditTargetOf(
  run: string,
  proposal: number,
  edit: Extract<PlanningProposal, { kind: "role-edit" }>,
): RoleEditTarget {
  return {
    run,
    proposal,
    name: edit.name,
    ...(edit.purpose === undefined ? {} : { purpose: edit.purpose.trim() }),
    ...(edit.model === undefined ? {} : { model: edit.model.trim() }),
    ...(edit.effort === undefined ? {} : { effort: edit.effort.trim() }),
    ...(edit.instructions === undefined ? {} : { instructions: edit.instructions.trim() }),
  };
}
