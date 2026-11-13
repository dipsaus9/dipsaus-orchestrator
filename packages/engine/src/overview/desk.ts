// The desk (0020, DIPO-158): what waits on the maintainer, as `office.desk` returns it
// and `dipo desk` prints it. Code builds every item, its order and the command line it offers from
// stored facts; nothing asks a model, and clients never derive it (0005, 0009).
//
// The groups, in the order of 0020 with the setup first (DIPO-459), which is the order of
// `KNOWN_DESK_KINDS`, so a client that groups the items by kind keeps the engine's order:
// 0. setup: the run profile's rows (DIPO-310), each pending proposal of the scan fallback and each
//    stale confirmation, an office item with no story, offering its `dipo office confirm` lines;
// 1. the office's starts paused (DIPO-359, `starts-paused.ts`), with its reason and what lifts it,
//    offering `dipo daemon resume-starts`; an office item with no story;
// 2. an open question no park carries, with `dipo answer <question> --text "<answer>"`; a
//    worker's question parks at once (0020), so it is on its PARKED row instead;
// 3. merge gates that wait on the maintainer, with the PR from `story_prs`; a gate whose PR is
//    labelled `autorelease: pending` offers a hand merge and no `dipo approve`; a gate marked
//    hand-merge only because its PR changes the release path (DIPO-331, `gates.hand_merge`) names
//    the PR, says the maintainer merges it by hand on GitHub, and offers only `dipo reject`; a
//    gate that waits on the story's test (DIPO-309) offers `dipo test <ID>` first, or, while a
//    test is open, `dipo test pass <ID>` and `dipo test fail <ID> --note`;
// 4. open parks, by reason: `ambiguous-spec`, `review-blocked`, `budget-exceeded`,
//    `verify-failing`, `conflict`, `scope-violation`, `worker-failed`. A `review-blocked`
//    park whose merge gate is open is one row with both `dipo resume --note` and `dipo approve
//    --note` (or the hand merge when its PR is labelled `autorelease: pending` or its gate is
//    marked hand-merge only for the release path), and that gate gets
//    no MERGE row of its own;
// 5. hand actions, by kind in the order of `KNOWN_DESK_KINDS` (a kind it does not list last): a
//    backlog PR whose structural check failed or could not run, a planning lane whose operations
//    wait for a backlog PR longer than 30 minutes (DIPO-401), the items of
//    `DeskSources.handItems` (DONE ELSEWHERE and LEFTOVERS, parks that still hold a story's work,
//    and parks whose write to Backlog.md failed);
// 6. the ideas that passed the audit (0022, DIPO-454), spikes before follow-ups, each a PROPOSED
//    STORY whose `idea` holds the proposed user story in full for its card, offering `dipo idea accept` and `dipo idea dismiss`;
//    then the decision notes of worker reports (DIPO-404), each offering `dipo note dismiss`;
//    then one MERGED WHILE PARKED line per story whose PR merged while it was parked, with no
//    action, until the base says Done (DIPO-468);
// 7. next up (0010, `run/next-up.ts`): one Ready story per free run slot, in next-up order, with
//    one line of why and the files its references share with running stories, offering
//    `dipo next confirm <ID>` and `dipo next decline <ID>`;
// 8. one READY TO SET item while Refined stories pass the gate for their current content (DIPO-496),
//    an office item naming them and offering `dipo ready <ID>...`;
// 9. the stories parked `by-maintainer`, listed apart as "Parked by you".
// Within a group the items whose story blocks the most active stories come first, then the oldest.
//
// Every stored free text an item shows (questions, park details, gate summaries, PR titles, check
// failures, proposals) is cleaned of escape sequences, controls and bidi overrides: worker and host
// text is data, and a terminal must never run it. Its row form is one line capped at
// `DESK_DETAIL_MAX` (`deskText`, `deskLine`), for the list only; `fullDetail` and `fullHand` keep the
// whole text with its line breaks, never cut (`deskFull`, DIPO-483).
//
// An action is listed only when this engine registers its command as shipped, so the desk never
// offers a command the daemon would answer with `capability.missing`. Other modules supply
// `DeskSources`: the resume needs of a park (the 0020 table), the hand-merge-only label of a
// gate's PR and further hand items (`DESK_SOURCES`, `features.ts`).

import {
  type CommandName,
  DESK_LOADING_KIND,
  type DeskAction,
  type DeskIdea,
  type DeskItem,
  GateId,
  officeDesk,
  QuestionId,
  RunId,
  StoryId,
  StoryKey,
  KNOWN_DESK_KINDS,
  type StoryPr,
  ideaOriginWords,
  servesWords,
} from "@dipsaus-orchestrator/contract";

import { cleanDoorText } from "../box/door";
import type { FeatureRegistry, ReadContext, Registry } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import { openParkQuestions, openQuestions, type StoredQuestion } from "../run-state/questions";
import { heldParks, openPark, type ParkStore } from "../records/park-state";
import { openTestOf } from "../run/test-records";
import { parkResumeNeed, SUGGESTED_SHARE } from "../records/resume-policy";
import { LIFT_COMMAND, type StartsPausedState } from "../run/starts-paused";
import { profileDeskItems } from "../scan/profile-view";
import { findStoryPr, latestStoryPr } from "../records/story-prs";
import { doneElsewhereDeskItems } from "../worktree/done-elsewhere";
import { MERGED_WHILE_PARKED, mergedParkDeskItems } from "../worktree/merged-parked";
import { activeStoryViews, lifecycleOf } from "../views/story";
import { firstGateFailure } from "./chain";

import { PLANNER_ROLE, REVIEWER_ROLE } from "../records/caps";
import { openNotes } from "../records/decision-notes";
import { openPassedIdeas } from "../records/ideas";

/** An item another module puts on the desk's hand-action group, such as LEFTOVERS. */
export interface HandDeskItem {
  readonly kind: string;
  readonly key: StoryKey;
  readonly story: string;
  readonly detail: string;
  /** When it began to wait, in ms. */
  readonly since: number;
  readonly actions: readonly { readonly command: string; readonly cli: string }[];
}

/**
 * A hand-action item of a pull request no story owns, such as the office's backlog PR whose check
 * failed (0010): the planning lane puts it on the desk through `DeskSources.prItems`.
 */
export interface PrHandItem {
  readonly kind: string;
  readonly pr: NonNullable<DeskItem["pr"]>;
  readonly detail: string;
  /** When it began to wait, in ms. */
  readonly since: number;
  readonly hand: string;
}

/**
 * A hand-action item of the office with no story and no PR, such as a stuck planning lane
 * (DIPO-401): it puts it on the desk through `DeskSources.officeItems`.
 */
export interface OfficeHandItem {
  readonly kind: string;
  readonly detail: string;
  /** When it began to wait, in ms. */
  readonly since: number;
  readonly hand: string;
  /** The commands it offers, such as `dipo update` (DIPO-485); none when absent. */
  readonly actions?: readonly { readonly command: string; readonly cli: string }[];
}

/** A story offered for a free run slot (`run/next-up.ts`), as the desk shows it. */
export interface NextUpDeskItem {
  readonly story: StoryId;
  readonly key: StoryKey;
  readonly title: string;
  readonly why: string;
  /** The files its references share with each running story; empty when it shares none. */
  readonly shared: readonly { readonly story: string; readonly paths: readonly string[] }[];
  /** When it was first offered, in ms. */
  readonly since: number;
  /** Why its last start did not go on (DIPO-488). */
  readonly failed?: string;
}

/** An open merge gate, as `DeskSources.handMergeOnly` sees it. */
export interface DeskGate {
  readonly gate: string;
  readonly key: string;
  readonly run: string;
}

/** An open merge gate that waits on the maintainer, as the desk reads it. */
interface OpenMergeGate {
  gate_id: string;
  key: string;
  run_id: string;
  opened_at: number;
  summary: string;
  /** `release-path` for a gate only the maintainer's merge on the host decides (DIPO-331). */
  hand_merge: string | null;
  /** The kinds of the reasons it waits, as JSON (DIPO-309); null for an older gate. */
  waits: string | null;
}

/** The desk's seams for facts other stories add. */
export interface DeskSources {
  /** The story store: the park a pending planning change writes (`plannedPark`, 0010). */
  readonly stories: ParkStore;
  /** True when the gate's PR is labelled `autorelease: pending` (0016, DIPO-150). */
  readonly handMergeOnly: (office: OfficeHandle, gate: DeskGate) => boolean;
  /** Further hand-action items, in group 4. */
  readonly handItems: readonly ((
    office: OfficeHandle,
    stories: ParkStore,
  ) => readonly HandDeskItem[])[];
  /** Hand-action items of PRs no story owns, first in group 4; none without it. */
  readonly prItems?: (office: OfficeHandle) => readonly PrHandItem[];
  /**
   * Hand-action items of the office with no story, at the time of the read (a stuck planning lane,
   * DIPO-401); none without it or without a time.
   */
  readonly officeItems?: (office: OfficeHandle, now: number) => readonly OfficeHandItem[];
  /** The office's starts paused (`StartsPaused.state`, 0020); none without it. */
  readonly startsPaused?: (office: OfficeHandle) => StartsPausedState | null;
  /** The stories offered for the office's free run slots, in order (0010); none without it. */
  readonly nextUp?: (office: OfficeHandle) => readonly NextUpDeskItem[];
  /** The office's `nextUp.autoStart` (0010); `none` without it. */
  readonly nextUpAutoStart?: (office: OfficeHandle) => "none" | "no-overlap";
  /**
   * What a merge gate's PR shows beyond its record (DIPO-459): its head's required checks and
   * what its branch changes, from the story PR's CI watch and git; nothing without it.
   */
  readonly prFacts?: (office: OfficeHandle, run: RunId) => Pick<StoryPr, "checks" | "change">;
}

/**
 * The sources of this engine: no stored PR labels; the hand items are DONE ELSEWHERE
 * (a live worker of a story Done on the base), LEFTOVERS (what such a story left kept, with
 * `dipo discard <id> --note "<why>"`), the parks that still hold a story's work, and one line per
 * story whose PR merged while it was parked until the base says Done (DIPO-468), with no action.
 */
export const DESK_SOURCES: Omit<DeskSources, "stories"> = {
  handMergeOnly: () => false,
  handItems: [doneElsewhereDeskItems, heldParkDeskItems, mergedParkDeskItems],
};

/** True when a merge gate's stored reasons name the test-before-merge flag (DIPO-309). */
function waitsOnTest(waits: string | null): boolean {
  if (waits === null) return false;
  try {
    const kinds = JSON.parse(waits) as unknown;
    return Array.isArray(kinds) && kinds.includes("testBeforeMerge");
  } catch {
    return false;
  }
}

/** The kind of a park dipo could not write to Backlog.md (DIPO-360). */
export const PARK_NOT_WRITTEN = "PARK NOT WRITTEN";

/** The kind of an open park Backlog.md no longer holds, or a resume is lifting (DIPO-360). */
export const PARK_HELD = "PARK HELD";

const RESCAN = { command: "office.rescan", cli: "dipo office rescan" } as const;

/**
 * An open park of a story Backlog.md does not hold as parked (DIPO-360), which keeps holding the
 * story's work (`heldByPark`):
 * - its write to Backlog.md failed: `dipo park` writes it again, or a rescan's reconcile closes it;
 * - a maintainer resume is lifting it: it is held until the resume finishes, which a daemon restart
 *   retries (DIPO-362); `dipo drop` or `dipo discard` is the way out of one that never finishes;
 * - Backlog.md no longer holds it (lifted by hand): a rescan's reconcile closes it.
 */
export function heldParkDeskItems(office: OfficeHandle, stories: ParkStore): HandDeskItem[] {
  return heldParks(stories, office).map((park) => {
    const base = { key: StoryKey.parse(park.key), story: park.story, since: park.at };
    switch (park.why) {
      case "unwritten":
        return {
          ...base,
          kind: PARK_NOT_WRITTEN,
          detail: `${park.detail} · dipo could not write this park to Backlog.md; its work is held until the park is sent again or a rescan closes it`,
          actions: [
            { command: "story.park", cli: `dipo park ${park.story} --note "<why>"` },
            RESCAN,
          ],
        };
      case "resuming":
        return {
          ...base,
          kind: PARK_HELD,
          detail: `${park.detail} · a resume is lifting this park; its work is held until the resume finishes, and a daemon restart tries it again. If it never finishes, drop or discard the story`,
          actions: [
            { command: "story.drop", cli: `dipo drop ${park.story}` },
            { command: "work.discard", cli: `dipo discard ${park.story} --note "<why>"` },
          ],
        };
      case "lifted":
        return {
          ...base,
          kind: PARK_HELD,
          detail: `${park.detail} · Backlog.md no longer holds this park; its work is held until a rescan closes it`,
          actions: [RESCAN],
        };
    }
  });
}

/**
 * What each command a desk item offers does, in one line (`DeskAction.consequence`, DIPO-459): the
 * TUI shows it under the item's buttons. A command not listed has none.
 */
export const DESK_CONSEQUENCES: Readonly<Partial<Record<CommandName, string>>> = {
  "idea.accept": "Accepting files it as a Backlog draft. You refine it in a triage session.",
  "idea.dismiss": "Dismissing files nothing; dipo keeps it as dismissed, for retro.",
  "note.dismiss": "Dismissing closes the note; dipo never writes the decision records.",
  "gate.approve": "Approve merges once the checks pass on the close-out head.",
  "gate.reject": "Rejecting sends your note to the worker as a fix round.",
  "test.start": "Testing runs the story's pushed head in a test box with its manual steps.",
  "test.record":
    "The result is recorded on the story; a fail note goes to the builder as a fix round.",
  "work.answer": "The worker gets it on resume, and the run continues.",
  "work.resume": "A fresh session starts with a handoff. The box and branch are kept.",
  "work.discard": "Discarding ends the run, deletes the branch and returns the story to Refined.",
  "story.drop": "Dropping archives the story and releases its claim.",
  "story.park": "Parking stops its worker; the story waits on your desk until you resume it.",
  "nextUp.confirm":
    "Nothing starts until you confirm. Declined stories return once their task file changes.",
  "nextUp.decline": "Declined stories return once their task file changes.",
  "story.ready": "Each story is checked against the gate again and set Ready through a backlog PR.",
  "daemon.resumeStarts": "Lift it early, only if you raised your plan.",
  "daemon.update":
    "New starts pause, dipo builds the base, replaces its binary and restarts. A failed build keeps the old one.",
};

/** Whether a command is registered, so the desk may offer it. */
export type Implemented = (command: CommandName) => boolean;

export function implementedIn(registry: Registry): Implemented {
  return (command) => registry.command(command) !== undefined;
}

// The groups of 0020, in order, with the setup first and the maintainer's own parks last (DIPO-459).
const GROUP = {
  setup: 0,
  paused: 1,
  live: 2,
  merge: 3,
  park: 4,
  hand: 5,
  proposal: 6,
  nextUp: 7,
  readyToSet: 8,
  byYou: 9,
} as const;

/** A hand item's rank in group 5: its kind's place in `KNOWN_DESK_KINDS`, an unlisted kind last. */
function kindRank(kind: string): number {
  const at = (KNOWN_DESK_KINDS as readonly string[]).indexOf(kind);
  return at === -1 ? KNOWN_DESK_KINDS.length : at;
}

/** The kind of a story offered for a free run slot (0010). */
export const NEXT_UP_KIND = "NEXT UP";

/** The kind of the one item that says Refined stories pass the gate and wait for you (DIPO-496). */
export const READY_TO_SET_KIND = "READY TO SET";

/** What a NEXT UP item says about the files its references share with running stories. */
export function sharedText(shared: NextUpDeskItem["shared"]): string {
  if (shared.length === 0) return "its references share no files with running stories";
  const each = shared.map((other) => `${other.story} (${other.paths.join(", ")})`);
  return `its references share files with running stories: ${each.join("; ")}`;
}

/** Group 4's order: by reason, as 0020 lists them; a reason outside the eight comes last. */
const PARK_RANK: Readonly<Record<string, number>> = {
  "ambiguous-spec": 0,
  "review-blocked": 1,
  "budget-exceeded": 2,
  "verify-failing": 3,
  conflict: 4,
  "scope-violation": 5,
  "worker-failed": 6,
};
const OTHER_PARK_RANK = 7;

/**
 * Group 6's order (0020): the proposed stories, spikes before follow-ups, then the decision notes.
 * A proposed spike is one whose Story line is a spike's (0012: "We need to decide").
 */
const PROPOSAL_RANK = { spike: 0, idea: 1, note: 2, merged: 3 } as const;

/** True for a spike's Story line (0012 R05). */
const isSpikeLine = (line: string): boolean => line.trimStart().startsWith("We need to decide");

/** The kind of an idea that passed the audit, on the desk as a proposed user story (0022). */
export const PROPOSED_STORY_KIND = "PROPOSED STORY";
/** The kind of a worker's decision note (DIPO-404). */
export const DECISION_NOTE_KIND = "DECISION NOTE";

interface Ranked {
  readonly group: number;
  readonly rank: number;
  readonly sinceMs: number;
  readonly item: DeskItem;
}

/**
 * The longest `detail` or `hand` of an item, in characters; a longer one is cut and ends in `…`,
 * so one stored text cannot flood the maintainer's terminal.
 */
export const DESK_DETAIL_MAX = 300;

/** An item as a builder gives it: `fullDetail` is its whole text when `detail` is only the row form. */
type DeskItemInput = Omit<DeskItem, "fullDetail" | "fullHand"> & { readonly fullDetail?: string };

/** One line: runs of whitespace (newlines too) become one space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * A stored free text (a worker's question, a park detail, a gate summary, a PR title, a check
 * failure, a proposal) as the desk shows it: escape sequences, C0 and C1 controls and bidi
 * overrides removed as at the box door (`cleanDoorText`), then on one line. Worker and host text
 * can carry terminal sequences that `dipo desk` would otherwise print raw.
 */
export function deskText(text: string): string {
  return oneLine(cleanDoorText(text));
}

/** A detail or hand text: cleaned, on one line, and at most `DESK_DETAIL_MAX` characters. */
export function deskLine(text: string): string {
  return cut(deskText(text), DESK_DETAIL_MAX);
}

/**
 * A stored text whole, as the desk shows it in full: cleaned as `deskText` cleans it, but with its
 * line breaks kept and never cut (DIPO-483). The one-line form (`deskLine`) is the list row's only.
 */
export function deskFull(text: string): string {
  return cleanDoorText(text).trim();
}

/**
 * At most `max` characters: a longer text is cut and ends in `…`. The cut never lands inside a
 * backticked command (the text the maintainer types): it moves back to the command's opening
 * backtick, so the command is shown whole or not at all.
 */
function cut(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  let end = Math.max(0, max - 1);
  let open = -1;
  for (let i = 0; i < end; i++) {
    if (chars[i] === "`") open = open === -1 ? i : -1;
  }
  if (open !== -1) end = open;
  return `${chars.slice(0, end).join("")}…`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A shell word for a command line: kept bare when safe, else in double quotes. */
function word(text: string): string {
  return /^[A-Za-z0-9_./:%+-]+$/.test(text) ? text : JSON.stringify(text);
}

/** The current id of the story `key`, or null when the office does not know it. */
function storyIdOf(office: OfficeHandle, key: string): StoryId | null {
  const row = office.get<{ story_id: string }>(
    "select story_id from stories where office_id = $office_id and key = $key",
    { key },
  );
  return row === null ? null : StoryId.parse(row.story_id);
}

/**
 * The active stories (not Done, not removed) that list each story among their dependencies, by
 * upper-case story id. The dependencies are what the story index mirrored from the base.
 */
function dependentsByStory(office: OfficeHandle): Map<string, StoryId[]> {
  const rows = office.all<{
    story_id: string;
    kind: "task" | "draft";
    status: string;
    deps: string | null;
  }>(
    `select s.story_id as story_id, m.kind as kind, m.status as status,
            coalesce(m.gate_dependencies, m.waiting_on) as deps
       from stories s
       join backlog_mirror m on m.office_id = s.office_id and m.key = s.key
      where s.office_id = $office_id and s.removed_at is null
      order by s.story_id`,
  );
  const byStory = new Map<string, StoryId[]>();
  for (const row of rows) {
    if (row.deps === null || lifecycleOf(row.kind, row.status) === "Done") continue;
    const ids = JSON.parse(row.deps) as unknown;
    if (!Array.isArray(ids)) continue;
    const seen = new Set<string>();
    for (const id of ids) {
      if (typeof id !== "string") continue;
      const upper = id.toUpperCase();
      if (seen.has(upper)) continue;
      seen.add(upper);
      byStory.set(upper, [...(byStory.get(upper) ?? []), StoryId.parse(row.story_id)]);
    }
  }
  return byStory;
}

function prOf(record: { number: number; url: string; state: StoryPr["state"] } | null): {
  pr?: StoryPr;
} {
  return record === null
    ? {}
    : { pr: { number: record.number, url: record.url, state: record.state } };
}

/**
 * A proposed story's card as the desk shows it: every text cleaned of terminal sequences and on one
 * line (`deskText`), and never cut: the card shows it in full (0022). Each text was capped when the
 * audit's answer was validated.
 */
function cleanIdea(idea: DeskIdea): DeskIdea {
  const story = idea.story;
  return {
    ...idea,
    title: deskText(idea.title),
    story: {
      found: deskText(story.found),
      evidence: story.evidence.map((item) => ({
        file: deskText(item.file),
        line: item.line,
        ...(item.quote === undefined ? {} : { quote: deskText(item.quote) }),
      })),
      ...(story.sourceStory === undefined ? {} : { sourceStory: story.sourceStory }),
      storyLine: deskText(story.storyLine),
      proposed: deskText(story.proposed),
      why: deskText(story.why),
      serves: deskText(story.serves),
      ...(story.tier === undefined ? {} : { tier: deskText(story.tier) }),
    },
    ...(idea.raisedBy === undefined
      ? {}
      : {
          raisedBy: {
            role: deskText(idea.raisedBy.role),
            ...(idea.raisedBy.model === undefined ? {} : { model: deskText(idea.raisedBy.model) }),
          },
        }),
  };
}

/** The role of the agent that raises an idea of each origin (0022); a quick idea is the maintainer's. */
const RAISER_ROLES: Readonly<Record<string, string>> = {
  proposal: "developer",
  finding: REVIEWER_ROLE,
  aside: PLANNER_ROLE,
};

/**
 * Who raised an idea (DIPO-459): the maintainer for a quick idea; else the role of its origin with
 * the model of that role's latest agent on the idea's run, or the role alone when no such agent is
 * kept. Undefined for an origin with no known role, or an idea with no run.
 */
function raiserOf(
  office: OfficeHandle,
  idea: { readonly origin: string; readonly run?: string | undefined },
): DeskIdea["raisedBy"] {
  if (idea.origin === "quick") return { role: "maintainer" };
  const role = RAISER_ROLES[idea.origin];
  if (role === undefined || idea.run === undefined) return undefined;
  const agent = office.get<{ model: string }>(
    `select model from agents where office_id = $office_id and run_id = $run and role = $role
      order by started_at desc, agent_id desc limit 1`,
    { run: idea.run, role },
  );
  return agent === null ? { role } : { role, model: agent.model };
}

/** The desk's builder: one office, its sources and the commands this engine ships. */
class DeskBuilder {
  readonly #office: OfficeHandle;
  readonly #sources: DeskSources;
  readonly #implemented: Implemented;
  readonly #dependents: Map<string, StoryId[]>;
  /** The Refined stories by upper-case id, with their first failed Ready gate rule (DIPO-484). */
  readonly #refined: Map<string, string | undefined>;
  readonly #items: Ranked[] = [];
  /** The time of the read, for the time left on a waiting question; none without one. */
  readonly #now: number | undefined;

  constructor(
    office: OfficeHandle,
    sources: DeskSources,
    implemented: Implemented,
    now: number | undefined,
  ) {
    this.#office = office;
    this.#sources = sources;
    this.#implemented = implemented;
    this.#dependents = dependentsByStory(office);
    this.#refined = new Map(
      activeStoryViews(office)
        .filter((view) => view.column === "refined")
        .map((view) => [String(view.story).toUpperCase(), firstGateFailure(view)]),
    );
    this.#now = now;
  }

  /** The action with its consequence line, when this engine ships its command. */
  #action(command: CommandName, cli: string): DeskAction[] {
    if (!this.#implemented(command)) return [];
    const consequence = DESK_CONSEQUENCES[command];
    return [{ command, cli, ...(consequence === undefined ? {} : { consequence }) }];
  }

  #blocks(story: StoryId | null): StoryId[] {
    return story === null ? [] : (this.#dependents.get(story.toUpperCase()) ?? []);
  }

  /**
   * Adds an item; its detail and hand text are cleaned here, whoever built them. The row form is
   * capped; `fullDetail` (default: the detail as built) and the hand's full text are not (DIPO-483).
   */
  #add(group: number, rank: number, sinceMs: number, item: DeskItemInput): void {
    // A Refined story that depends on the item's story waits for the maintainer to set it Ready, so
    // it is listed apart from what the item blocks (DIPO-484).
    const refined = item.blocks.filter((id) => this.#refined.has(id.toUpperCase()));
    const clean: DeskItem = {
      ...item,
      ...(refined.length === 0
        ? {}
        : {
            blocks: item.blocks.filter((id) => !refined.includes(id)),
            refined: refined.map((id) => {
              const reason = this.#refined.get(id.toUpperCase());
              return { story: id, ...(reason === undefined ? {} : { reason: deskLine(reason) }) };
            }),
          }),
      detail: deskLine(item.detail),
      fullDetail: deskFull(item.fullDetail ?? item.detail),
      ...(item.hand === undefined
        ? {}
        : { hand: deskLine(item.hand), fullHand: deskFull(item.hand) }),
      ...(item.note === undefined
        ? {}
        : { note: { ...item.note, title: deskText(item.note.title) } }),
      ...(item.idea === undefined ? {} : { idea: cleanIdea(item.idea) }),
    };
    this.#items.push({ group, rank, sinceMs, item: clean });
  }

  /**
   * The hand text of a gate whose PR only the maintainer merges: one labelled `autorelease:
   * pending`, or one that changes the release path (DIPO-331).
   */
  #handMerge(
    record: { readonly number: number; readonly url: string } | null,
    why: "autorelease" | "release-path" = "autorelease",
  ): string {
    const where = record === null ? "its PR" : `PR #${record.number} (${record.url})`;
    if (why === "release-path") {
      return `the maintainer merges ${where} by hand on GitHub: it changes the release path, which needs the maintainer's code owner approval, so dipo never merges it`;
    }
    return `merge ${where} by hand on GitHub: it is labelled autorelease: pending, so dipo never approves it`;
  }

  /** The answer actions of a question: allow and deny for a permission, a text for a question. */
  #answerActions(question: StoredQuestion): DeskAction[] {
    const id = question.questionId;
    // An answer is always text, never read as a decision (0020).
    return this.#action("work.answer", `dipo answer ${id} --text "<answer>"`);
  }

  /** Group 1: the office's starts paused, with what lifts it; nothing else starts until then. */
  startsPaused(): void {
    const paused = this.#sources.startsPaused?.(this.#office) ?? null;
    if (paused === null) return;
    const why =
      paused.reason === "adapter" ? `adapter check failed: ${paused.detail}` : paused.detail;
    // The box token's pause lifts only with `dipo login box`: no command lifts it here (0020).
    const sticky = paused.reason === "adapter" && paused.pause?.liftedBy !== undefined;
    this.#add(GROUP.paused, 0, paused.since, {
      kind: "STARTS PAUSED",
      detail: `no new session starts · ${why}`,
      since: iso(paused.since),
      blocks: [],
      actions: sticky ? [] : this.#action("daemon.resumeStarts", LIFT_COMMAND),
      hand: paused.lifts,
    });
  }

  /** Group 2: open questions no park carries; a park's questions are on its PARKED row. */
  liveQuestions(): void {
    for (const question of openQuestions(this.#office)) {
      if (question.parkId !== null) continue;
      const run = this.#office.get<{ key: string | null }>(
        "select key from runs where office_id = $office_id and run_id = $run",
        { run: question.runId },
      );
      const key = run?.key ?? null;
      const story = key === null ? null : storyIdOf(this.#office, key);
      const text = cut(deskText(question.text), DESK_DETAIL_MAX - 2);
      this.#add(GROUP.live, 0, question.askedAt, {
        kind: "QUESTION",
        ...(story === null || key === null ? {} : { story, key: StoryKey.parse(key) }),
        question: QuestionId.parse(question.questionId),
        detail: JSON.stringify(text),
        fullDetail: deskFull(question.text),
        since: iso(question.askedAt),
        blocks: this.#blocks(story),
        actions: this.#answerActions(question),
      });
    }
  }

  /** The open merge gates that wait on the maintainer, oldest first. */
  #openMergeGates(): OpenMergeGate[] {
    return this.#office.all(
      `select g.gate_id, g.key, g.run_id, g.opened_at, g.summary, g.hand_merge, g.waits from gates g
        where g.office_id = $office_id and g.kind = 'merge' and g.waiting_on = 'maintainer'
          and g.key is not null and g.run_id is not null
          and not exists (select 1 from gate_decisions d
                           where d.office_id = g.office_id and d.gate_id = g.gate_id)
        order by g.opened_at, g.gate_id`,
    );
  }

  /**
   * The hand text of a gate only the maintainer merges, by hand: one whose PR changes the release
   * path (`gates.hand_merge`, DIPO-331) or is labelled `autorelease: pending`; null when `dipo
   * approve` decides it.
   */
  #handOnlyText(
    gate: OpenMergeGate,
    record: { readonly number: number; readonly url: string } | null,
  ): string | null {
    if (gate.hand_merge === "release-path") return this.#handMerge(record, "release-path");
    const labelled = this.#sources.handMergeOnly(this.#office, {
      gate: gate.gate_id,
      key: gate.key,
      run: gate.run_id,
    });
    return labelled ? this.#handMerge(record) : null;
  }

  /** Group 3: one merge gate that waits on the maintainer (see the file comment). */
  #mergeGate(gate: OpenMergeGate): void {
    const story = storyIdOf(this.#office, gate.key);
    if (story === null) return;
    const record =
      findStoryPr(this.#office, RunId.parse(gate.run_id)) ?? latestStoryPr(this.#office, gate.key);
    const reject = this.#action("gate.reject", `dipo reject ${story} --note "<why>"`);
    const hand = this.#handOnlyText(gate, record);
    // A release-path PR can still be sent back; an `autorelease: pending` one only merges by hand.
    let actions = [...this.#action("gate.approve", `dipo approve ${story}`), ...reject];
    if (hand !== null) actions = gate.hand_merge === "release-path" ? reject : [];
    // A story waiting on its test (DIPO-309): `dipo test`, or the record of its open test.
    if (waitsOnTest(gate.waits)) actions = [...this.#testActions(story, gate.key), ...actions];
    const facts =
      record === null ? {} : (this.#sources.prFacts?.(this.#office, record.runId) ?? {});
    const pr = prOf(record).pr;
    this.#add(GROUP.merge, 0, gate.opened_at, {
      kind: "MERGE",
      story,
      key: StoryKey.parse(gate.key),
      gate: GateId.parse(gate.gate_id),
      ...(pr === undefined ? {} : { pr: { ...pr, ...facts } }),
      detail: deskText(gate.summary),
      since: iso(gate.opened_at),
      blocks: this.#blocks(story),
      actions,
      ...(hand === null ? {} : { hand }),
    });
  }

  /** The test actions of a story waiting on its test: start one, or record its open one. */
  #testActions(story: StoryId, key: string): DeskAction[] {
    if (openTestOf(this.#office, key) === null)
      return this.#action("test.start", `dipo test ${story}`);
    return [
      ...this.#action("test.record", `dipo test pass ${story}`),
      ...this.#action("test.record", `dipo test fail ${story} --note "<what failed>"`),
    ];
  }

  /** Groups 3, 4 and 8: merge gates and every open park, the maintainer's own parks last. */
  gatesAndParks(): void {
    // Every parked story (DIPO-360): the reason from Backlog.md, the rest from the open park row.
    const keys = this.#office.all<{ key: string; story_id: string }>(
      `select key, story_id from parks where office_id = $office_id and resolved_at is null
        group by key order by min(at), min(park_id)`,
    );
    const parks = keys.flatMap(({ key, story_id }) => {
      const open = openPark(this.#sources.stories, this.#office, key);
      return open === null
        ? []
        : [
            {
              park_id: open.parkId,
              key,
              story_id,
              reason: open.reason as string,
              detail: open.detail,
              at: open.at,
            },
          ];
    });
    const gates = this.#openMergeGates();
    const reviewBlocked = new Set(
      parks.filter((park) => park.reason === "review-blocked").map((park) => park.key),
    );
    for (const gate of gates) {
      // A review-blocked park's gate is the PARKED row's `dipo approve --note` (0002).
      if (!reviewBlocked.has(gate.key)) this.#mergeGate(gate);
    }
    for (const park of parks) {
      const story = storyIdOf(this.#office, park.key) ?? StoryId.parse(park.story_id);
      const byYou = park.reason === "by-maintainer";
      const actions: DeskAction[] = [];
      for (const question of openParkQuestions(this.#office, park.park_id)) {
        actions.push(...this.#answerActions(question));
      }
      actions.push(...this.#resumeActions(story, park.reason));
      const record = latestStoryPr(this.#office, park.key);
      let gate: string | null = null;
      let hand: string | null = null;
      const open =
        park.reason === "review-blocked"
          ? (gates.find((candidate) => candidate.key === park.key) ?? null)
          : null;
      if (open !== null) {
        // The park's merge gate (0002): `dipo approve --note`, unless only the
        // maintainer merges its PR, by hand.
        gate = open.gate_id;
        hand = this.#handOnlyText(
          open,
          findStoryPr(this.#office, RunId.parse(open.run_id)) ?? record,
        );
        if (hand === null) {
          actions.push(...this.#action("gate.approve", `dipo approve ${story} --note "<why>"`));
        }
      }
      this.#add(
        byYou ? GROUP.byYou : GROUP.park,
        byYou ? 0 : (PARK_RANK[park.reason] ?? OTHER_PARK_RANK),
        park.at,
        {
          kind: byYou ? "PARKED BY YOU" : "PARKED",
          story,
          key: StoryKey.parse(park.key),
          ...(gate === null ? {} : { gate: GateId.parse(gate) }),
          ...prOf(record),
          reason: park.reason,
          detail: deskText(park.detail),
          fullDetail: deskFull(park.detail),
          since: iso(park.at),
          blocks: this.#blocks(story),
          actions,
          ...(hand === null ? {} : { hand }),
        },
      );
    }
  }

  /** The resume (or discard) a park offers, from the 0020 table of its reason. */
  #resumeActions(story: StoryId, reason: string): DeskAction[] {
    const need = parkResumeNeed(reason);
    if (need.kind === "refuse") {
      return this.#action("work.discard", `dipo discard ${story} --note "<why>"`);
    }
    const placeholder =
      need.note === "answer" ? "<answer>" : reason === "review-blocked" ? "<direction>" : "<why>";
    const budget = need.budget === true ? ` --budget +${SUGGESTED_SHARE}%` : "";
    const note = need.note === "optional" ? "" : ` --note "${placeholder}"`;
    return this.#action("work.resume", `dipo resume ${story}${budget}${note}`);
  }

  /** Group 5: PRs no story owns (backlog PRs whose check failed), then the sources' hand items. */
  handActions(): void {
    for (const item of this.#sources.prItems?.(this.#office) ?? []) {
      this.#add(GROUP.hand, kindRank(item.kind), item.since, {
        kind: item.kind,
        pr: item.pr,
        detail: item.detail,
        since: iso(item.since),
        blocks: [],
        actions: [],
        hand: item.hand,
      });
    }
    for (const source of this.#sources.handItems) {
      for (const hand of source(this.#office, this.#sources.stories)) {
        const story = StoryId.parse(hand.story);
        // A story whose PR merged while it was parked is a line to read, not a hand action: it
        // sorts after the decision notes, where `KNOWN_DESK_KINDS` lists it (DIPO-468).
        const informational = hand.kind === MERGED_WHILE_PARKED;
        this.#add(
          informational ? GROUP.proposal : GROUP.hand,
          informational ? PROPOSAL_RANK.merged : kindRank(hand.kind),
          hand.since,
          {
            kind: hand.kind,
            story,
            key: hand.key,
            detail: deskText(hand.detail),
            since: iso(hand.since),
            blocks: this.#blocks(story),
            actions: hand.actions.flatMap((action) => this.#action(action.command, action.cli)),
          },
        );
      }
    }
    // Office items with no story, such as a stuck planning lane (DIPO-401).
    if (this.#now !== undefined) {
      for (const item of this.#sources.officeItems?.(this.#office, this.#now) ?? []) {
        this.#add(GROUP.hand, kindRank(item.kind), item.since, {
          kind: item.kind,
          detail: deskText(item.detail),
          since: iso(item.since),
          blocks: [],
          actions: (item.actions ?? []).flatMap((action) =>
            this.#action(action.command, action.cli),
          ),
          hand: item.hand,
        });
      }
    }
  }

  /** The setup group: the run profile's rows (DIPO-310), what `dipo office confirm` confirms. */
  setup(): void {
    for (const item of profileDeskItems(this.#office)) {
      this.#add(GROUP.setup, 0, item.since, {
        kind: item.kind,
        detail: deskText(item.detail),
        since: iso(item.since),
        blocks: [],
        actions: item.actions.flatMap((action) => this.#action(action.command, action.cli)),
      });
    }
  }

  /**
   * Group 6: the ideas that passed the audit, each one PROPOSED STORY item whose card holds its
   * proposed user story in full (0022, DIPO-454), and the open decision notes of worker reports
   * (DIPO-404), each with its own dismiss.
   */
  proposals(): void {
    for (const idea of openPassedIdeas(this.#office)) {
      const story = idea.proposal;
      if (story === undefined) continue;
      const source = story.sourceStory ?? idea.story;
      const id = word(idea.id);
      const since = Date.parse(idea.decidedAt ?? idea.createdAt);
      const rank = isSpikeLine(story.storyLine) ? PROPOSAL_RANK.spike : PROPOSAL_RANK.idea;
      const raisedBy = raiserOf(this.#office, idea);
      this.#add(GROUP.proposal, rank, since, {
        kind: PROPOSED_STORY_KIND,
        ...(source === undefined ? {} : { story: source }),
        idea: {
          id: idea.id,
          origin: idea.origin,
          title: idea.title,
          ...(idea.run === undefined ? {} : { run: idea.run }),
          story,
          ...(raisedBy === undefined ? {} : { raisedBy }),
        },
        detail: `${JSON.stringify(deskText(idea.title))} · ${servesWords(story.serves)} · from ${ideaOriginWords(idea.origin)}`,
        since: iso(since),
        blocks: [],
        actions: [
          ...this.#action("idea.accept", `dipo idea accept ${id}`),
          ...this.#action("idea.dismiss", `dipo idea dismiss ${id}`),
        ],
      });
    }
    for (const note of openNotes(this.#office)) {
      const story =
        note.story === null ? storyIdOf(this.#office, note.key) : StoryId.parse(note.story);
      this.#add(GROUP.proposal, PROPOSAL_RANK.note, note.createdAt, {
        kind: DECISION_NOTE_KIND,
        ...(story === null ? {} : { story, key: note.key }),
        note: {
          id: note.hash,
          title: `Decision note for ${note.file}`,
          run: RunId.parse(note.run),
        },
        detail: `decision note · ${deskText(`${note.file}, section "${note.section}": ${note.text}`)}`,
        since: iso(note.createdAt),
        blocks: this.#blocks(story),
        actions: this.#action("note.dismiss", `dipo note dismiss ${word(note.hash)}`),
        hand: "dipo never writes decision records: add the note by hand if you agree",
      });
    }
  }

  /** Group 7: the stories offered for free run slots, in their order (0010). */
  nextUp(): void {
    const offers = this.#sources.nextUp?.(this.#office) ?? [];
    const auto = this.#sources.nextUpAutoStart?.(this.#office) === "no-overlap";
    offers.forEach((offer, rank) => {
      this.#add(GROUP.nextUp, rank, offer.since, {
        kind: NEXT_UP_KIND,
        ...(auto ? { autoStart: "no-overlap" as const } : {}),
        story: offer.story,
        key: offer.key,
        detail: `${JSON.stringify(deskText(offer.title))} · ${offer.why} · ${sharedText(offer.shared)}${
          offer.failed === undefined
            ? ""
            : ` · its last start failed: ${cut(deskText(offer.failed), 200)}`
        }`,
        since: iso(offer.since),
        blocks: this.#blocks(offer.story),
        actions: [
          ...this.#action("nextUp.confirm", `dipo next confirm ${offer.story}`),
          ...this.#action("nextUp.decline", `dipo next decline ${offer.story}`),
        ],
      });
    });
  }

  /**
   * Group 8: one item while Refined stories pass the gate for their current content, naming them
   * and the command that sets them Ready (DIPO-496); an office item, gone when none passes.
   */
  readyToSet(): void {
    const ids = activeStoryViews(this.#office)
      .filter((view) => view.column === "refined" && view.gatePasses === true)
      .map((view) => String(view.story));
    if (ids.length === 0) return;
    const noun = ids.length === 1 ? "story" : "stories";
    const since = this.#now ?? 0;
    this.#add(GROUP.readyToSet, 0, since, {
      kind: READY_TO_SET_KIND,
      detail: `${ids.length} ${noun} Refined but passing the gate: space and Y in the Queue (3) · ${ids.join(", ")}`,
      since: iso(since),
      blocks: [],
      actions: this.#action("story.ready", `dipo ready ${ids.join(" ")}`),
    });
  }

  /** The items in desk order: group, rank in it, most blocked stories, oldest, then by story. */
  sorted(): DeskItem[] {
    return this.#items
      .toSorted(
        (a, b) =>
          a.group - b.group ||
          a.rank - b.rank ||
          b.item.blocks.length - a.item.blocks.length ||
          a.sinceMs - b.sinceMs ||
          (a.item.story ?? "").localeCompare(b.item.story ?? "") ||
          a.item.detail.localeCompare(b.item.detail),
      )
      .map((ranked) => ranked.item);
  }
}

/**
 * What waits on the maintainer in `office`, in desk order (see the file comment). `now` is the time
 * of the read, for the office items with no story; without it none is shown.
 */
export function desk(
  office: OfficeHandle,
  implemented: Implemented,
  sources: DeskSources,
  now?: number,
): DeskItem[] {
  const builder = new DeskBuilder(office, sources, implemented, now);
  builder.setup();
  builder.startsPaused();
  builder.liveQuestions();
  builder.gatesAndParks();
  builder.handActions();
  builder.proposals();
  builder.nextUp();
  builder.readyToSet();
  return builder.sorted();
}

/** Registers `office.desk`; `overview/feature.ts` calls it with this engine's sources. */
export function registerDesk(registry: FeatureRegistry, sources: DeskSources): void {
  registry.addRead({
    definition: officeDesk,
    handle: (ctx: ReadContext) => {
      if (ctx.office === undefined) throw new Error("office.desk runs with its office");
      return desk(ctx.office, implementedIn(ctx.registry), sources, ctx.clock.now());
    },
    // While the office loads there is no database to read yet: the desk says so (DIPO-380).
    whileLoading: (_office, nowMs) => [
      {
        kind: DESK_LOADING_KIND,
        detail: "the office is loading; its desk follows when the load ends",
        fullDetail: "the office is loading; its desk follows when the load ends",
        since: iso(nowMs),
        blocks: [],
        actions: [],
      },
    ],
  });
}
