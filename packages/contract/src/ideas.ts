// Ideas (0022, DIPO-452): every incoming idea is held, audited first by code and then by a short
// audit session, and only one that passes reaches the maintainer as a proposed user story. An
// idea comes from a worker's proposal, a reviewer's advisory finding, a planning session's aside
// or the maintainer's quick idea; it is held with its origin and source story. Every text of an
// idea is data: nothing in it changes what the audit session may do.

import { z } from "zod";

import { RunId, StoryId } from "./ids";
import { openEnum } from "./work";

const Count = z.int().nonnegative();
const Timestamp = z.iso.datetime();

// Where an idea came from: a worker's follow-up, spike or tool proposal, a reviewer's advisory
// finding, a planning session's aside, or the maintainer's quick idea.
export const IDEA_ORIGINS = ["proposal", "finding", "aside", "quick"] as const;
export const IdeaOrigin = openEnum(IDEA_ORIGINS);
export type IdeaOrigin = z.infer<typeof IdeaOrigin>;

// `held` until its audit decides; `passed` with a proposed user story, or `rejected` with its
// reason. A rejected idea is kept.
export const IDEA_STATES = ["held", "passed", "rejected"] as const;
export const IdeaState = z.enum(IDEA_STATES);
export type IdeaState = z.infer<typeof IdeaState>;

// Who decided an idea: code (a duplicate, or the title of a story) or the audit session.
export const IdeaDecidedBy = z.enum(["code", "audit"]);
export type IdeaDecidedBy = z.infer<typeof IdeaDecidedBy>;

/** The length caps of an idea's texts and of an audit answer, in characters. */
export const IDEA_CAPS = {
  title: 120,
  text: 2_000,
  paths: 20,
  path: 300,
  ideas: 20,
  ideaRef: 64,
  reason: 1_000,
  found: 2_000,
  evidence: 10,
  quote: 300,
  storyLine: 500,
  proposed: 2_000,
  why: 1_000,
  serves: 40,
} as const;

const caps = IDEA_CAPS;
const Text = (max: number) => z.string().trim().min(1).max(max);

// A planning session's aside (0022): an idea the session noticed outside the goal it plans. The
// session writes it as a fenced `dipo-aside` block holding this object as JSON, and the engine
// validates it here before it holds the idea. No other key is accepted.
export const AsideBlock = z.strictObject({
  title: Text(caps.title).describe("a short title"),
  text: Text(caps.text).describe("what the idea is and why it matters"),
  paths: z
    .array(Text(caps.path))
    .max(caps.paths)
    .optional()
    .describe("files it concerns, relative to the repository root"),
});
export type AsideBlock = z.infer<typeof AsideBlock>;

// One place in the code an audit cites: a file of the base copy and a line in it.
export const IdeaEvidence = z.strictObject({
  file: Text(caps.path).describe("the file, relative to the repository root"),
  line: z.int().positive().describe("the line number in that file"),
  quote: Text(caps.quote).optional().describe("the line as it reads"),
});
export type IdeaEvidence = z.infer<typeof IdeaEvidence>;

// What the idea serves: a milestone of the backlog by its id (`m-3`), or `tech-debt`.
export const TECH_DEBT = "tech-debt";
export const IdeaServes = z
  .string()
  .regex(/^(?:m-\d+|tech-debt)$/)
  .describe('the milestone id it serves, such as "m-3", or "tech-debt"');

// The audit session's verdict on one idea (0022). A pass names what it found with its evidence, a
// Story line in the 0012 shape, what it proposes, why, and the milestone it serves or tech debt;
// a reject names its reason. Size is never a reason to reject.
export const AuditPass = z.strictObject({
  idea: Text(caps.ideaRef).describe("the id of the idea, as its idea tag names it"),
  verdict: z.literal("pass"),
  found: Text(caps.found).describe("what you found in the code"),
  evidence: z.array(IdeaEvidence).min(1).max(caps.evidence),
  storyLine: Text(caps.storyLine).describe(
    "one line: As <maintainer|worker|reviewer> I want <capability> so that <value>. Plain words: no backticks, file paths or code",
  ),
  proposed: Text(caps.proposed).describe("what the story proposes"),
  why: Text(caps.why).describe("why it is needed"),
  serves: IdeaServes,
});
export const AuditReject = z.strictObject({
  idea: Text(caps.ideaRef).describe("the id of the idea, as its idea tag names it"),
  verdict: z.literal("reject"),
  reason: Text(caps.reason).describe("which pass rule it fails, and what you saw"),
});
export const AuditVerdict = z.discriminatedUnion("verdict", [AuditPass, AuditReject]);
export type AuditVerdict = z.infer<typeof AuditVerdict>;

// The audit session's one answer: a verdict for each idea it was given.
export const AuditAnswer = z.strictObject({
  ideas: z.array(AuditVerdict).min(1).max(caps.ideas),
});
export type AuditAnswer = z.infer<typeof AuditAnswer>;

// The proposed user story of an idea that passed, as dipo keeps it: the audit's words, and the
// source story code knows from the idea.
export const ProposedStory = z.object({
  found: z.string(),
  evidence: z.array(IdeaEvidence),
  sourceStory: StoryId.optional(),
  storyLine: z.string(),
  proposed: z.string(),
  why: z.string(),
  serves: z.string(),
});
export type ProposedStory = z.infer<typeof ProposedStory>;

<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
// An idea's id: a hash of 64 lower-case hex characters. A command may name it by a unique prefix
// of at least 8 of them.
=======
// The maintainer's answer to a passed idea on the desk (0020, DIPO-454): `accepted` filed it as a
// Backlog draft, `dismissed` closed it. A dismissed idea is kept, for retro.
export const IDEA_ANSWERS = ["accepted", "dismissed"] as const;
export const IdeaAnswer = z.enum(IDEA_ANSWERS);
export type IdeaAnswer = z.infer<typeof IdeaAnswer>;

// An idea's stored id: a hash of 64 lower-case hex characters. A command may name it by a unique
// prefix of at least 8 of them.
>>>>>>> de146a854c2be9713e40505688960f87444be951
export const IdeaId = z.string().regex(/^[0-9a-f]{64}$/, "expected an idea id");
export type IdeaId = z.infer<typeof IdeaId>;
export const IdeaRef = z
  .string()
  .regex(/^[0-9a-f]{8,64}$/, "expected an idea id, or at least its first 8 characters");

<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
// The maintainer's decision on an idea that passed (DIPO-454): `accepted`, filed as a Backlog
// draft, or `dismissed`, closed and kept. A passed idea without one waits on the desk.
export const IDEA_DECISIONS = ["accepted", "dismissed"] as const;
export const IdeaDecision = z.enum(IDEA_DECISIONS);
export type IdeaDecision = z.infer<typeof IdeaDecision>;

// A passed idea as its desk card shows it (DIPO-454): the proposed user story in full, with the
// idea's id, origin, title and run. Every text is cleaned of terminal controls, never cut.
export const IdeaCard = ProposedStory.extend({
  id: IdeaId,
  origin: IdeaOrigin,
  title: z.string(),
  run: RunId.optional(),
});
export type IdeaCard = z.infer<typeof IdeaCard>;

// One idea as `office.ideas` lists it. `attempts` counts the audits that failed, were cut off or
// were refused by schema; such an idea stays held and is audited again at the next trigger.
// `decision` is the maintainer's on a passed idea, and `draft` the Backlog draft an accept filed.
=======
/** The longest quick idea the maintainer hands to the audit, in characters. */
export const QUICK_IDEA_MAX = IDEA_CAPS.text;

// One idea as `office.ideas` lists it. `attempts` counts the audits that failed, were cut off or
// were refused by schema; such an idea stays held and is audited again at the next trigger. A
// passed idea waits on the desk until the maintainer answers it (`answer`).
>>>>>>> de146a854c2be9713e40505688960f87444be951
export const IdeaView = z.object({
  id: z.string(),
  origin: IdeaOrigin,
  story: StoryId.optional(),
  run: RunId.optional(),
  title: z.string(),
  text: z.string(),
  state: IdeaState,
  decidedBy: IdeaDecidedBy.optional(),
  reason: z.string().optional(),
  proposal: ProposedStory.optional(),
  attempts: Count,
  lastProblem: z.string().optional(),
  decision: IdeaDecision.optional(),
  draft: z.string().optional(),
  createdAt: Timestamp,
  decidedAt: Timestamp.optional(),
<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
  decisionAt: Timestamp.optional(),
=======
  // The maintainer's answer to a passed idea, when it was given, and the draft an accept filed.
  answer: IdeaAnswer.optional(),
  answeredAt: Timestamp.optional(),
  draft: z.string().optional(),
>>>>>>> de146a854c2be9713e40505688960f87444be951
});
export type IdeaView = z.infer<typeof IdeaView>;

/** What an idea's origin says on its card and its draft (0022). */
export const IDEA_ORIGIN_WORDS: Readonly<Record<IdeaOrigin, string>> = {
  proposal: "a worker's proposal",
  finding: "a reviewer's advisory finding",
  aside: "a planning session's aside",
  quick: "the maintainer's quick idea",
};

/** Pure: what an idea's origin says, for an origin this contract may not know yet. */
export function ideaOriginWords(origin: string): string {
  return (IDEA_ORIGIN_WORDS as Readonly<Record<string, string>>)[origin] ?? `an idea (${origin})`;
}

/** Pure: what a proposed user story serves, in words: the milestone, or tech debt. */
export function servesWords(serves: string): string {
  return serves === TECH_DEBT ? "tech debt" : `milestone ${serves}`;
}

/**
 * Pure: the card of a proposed user story (0020, DIPO-454), one labelled line per part, in full:
 * what was found, each piece of evidence, the source story, the Story line, what is proposed, why
 * and what it serves. The desk's clients lay it out; nothing in it is cut.
 */
export function proposedStoryLines(story: ProposedStory): string[] {
  const lines = [`Found: ${story.found}`];
  for (const evidence of story.evidence) {
    lines.push(
      `Evidence: ${evidence.file}:${evidence.line}${evidence.quote === undefined ? "" : ` ${JSON.stringify(evidence.quote)}`}`,
    );
  }
  lines.push(`Source story: ${story.sourceStory ?? "none"}`);
  lines.push(`Story: ${story.storyLine}`);
  lines.push(`Proposed: ${story.proposed}`);
  lines.push(`Why: ${story.why}`);
  lines.push(`Serves: ${servesWords(story.serves)}`);
  return lines;
}
