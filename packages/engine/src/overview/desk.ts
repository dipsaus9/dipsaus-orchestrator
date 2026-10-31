// The desk (0020 section 12, DIPO-158): what waits on the maintainer, as `office.desk` returns it
// and `dipo desk` prints it. Code builds every item, its order and the command line it offers from
// stored facts; nothing asks a model, and clients never derive it (0005, 0009).
//
// The groups, in the order of 0020:
// 0. the office's starts paused (DIPO-359, `starts-paused.ts`), with its reason and what lifts it,
//    offering `dipo daemon resume-scheduling`; an office item with no story;
// 1. a question a live worker waits on (no park took it over); it shows the time left on its wait (DIPO-159) and offers `dipo answer <question>
//    --text "<answer>"`;
// 2. merge gates that wait on the maintainer, with the PR from `story_prs`; a gate whose PR is
//    labelled `autorelease: pending` offers a hand merge and no `dipo approve`; a gate marked
//    hand-merge only because its PR changes the release path (DIPO-331, `gates.hand_merge`) names
//    the PR, says the maintainer merges it by hand on GitHub, and offers only `dipo reject`; a
//    gate that waits on the story's test (DIPO-309) offers `dipo test <ID>` first, or, while a
//    test is open, `dipo test pass <ID>` and `dipo test fail <ID> --note`;
// 3. open parks, by reason: `ambiguous-spec`, `review-blocked`, `budget-exceeded`,
//    `verify-failing`, `conflict`, `scope-violation`, `worker-failed`. A `review-blocked`
//    park whose merge gate is open is one row with both `dipo resume --note` and `dipo approve
//    --note` (or the hand merge when its PR is labelled `autorelease: pending` or its gate is
//    marked hand-merge only for the release path), and that gate gets
//    no MERGE row of its own;
// 4. the stories parked `by-maintainer`, listed apart as "Parked by you";
// 5. hand actions: a backlog PR whose structural check failed or could not run, a planning lane
//    whose operations wait for a backlog PR longer than 30 minutes (DIPO-401), the items of
//    `DeskSources.handItems` (DIPO-161's DONE ELSEWHERE and LEFTOVERS), the story worktrees of an
//    earlier binary that hold changes (DIPO-349's LEFTOVER WORKTREE), and the run profile's rows
//    (DIPO-310): each pending proposal of the scan fallback and each stale confirmation, an office
//    item with no story, offering its `dipo office confirm` lines (no TUI keys yet);
// 6. proposals and decision notes of worker reports (`proposals.ts`), spike before follow-up.
// Within a group the items whose story blocks the most active stories come first, then the oldest.
//
// Every stored free text an item shows (questions, park details, gate summaries, PR titles, check
// failures, proposals) is cleaned of escape sequences, controls and bidi overrides, put on one line
// and capped at `DESK_DETAIL_MAX` (`deskText`, `deskLine`): worker and host text is data, and a
// terminal must never run it.
//
// An action is listed only when this engine registers its command as shipped, so the desk never
// offers a command the daemon would answer with `capability.missing`. Seams for stories not built
// yet are `DeskSources`: the resume needs of a park (the 0020 table), the hand-merge-only
// label of a gate's PR (DIPO-150) and further hand items (DIPO-161's are in `DESK_SOURCES`).

import {
  type CommandName,
  DESK_LOADING_KIND,
  type DeskAction,
  type DeskItem,
  GateId,
  officeDesk,
  QuestionId,
  RunId,
  StoryId,
  StoryKey,
  type StoryPr,
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
import { leftoverWorktreeDeskItems } from "../worktree/leftovers";
import { lifecycleOf } from "../views/story";

import { proposalItems, type ProposalItem } from "./proposals";

/** An item another module puts on the desk's hand-action group, such as DIPO-161's LEFTOVERS. */
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
  /** True when the gate's PR is labelled `autorelease: pending` (0016 rule 12, DIPO-150). */
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
}

/**
 * The sources of this engine: no stored PR labels yet; the hand items are DIPO-161's DONE ELSEWHERE
 * (a live worker of a story Done on the base) and LEFTOVERS (what such a story left kept, with
 * `dipo discard <id> --note "<why>"`).
 */
export const DESK_SOURCES: Omit<DeskSources, "stories"> = {
  handMergeOnly: () => false,
  handItems: [doneElsewhereDeskItems, heldParkDeskItems],
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

/** Whether a command is registered, so the desk may offer it. */
export type Implemented = (command: CommandName) => boolean;

export function implementedIn(registry: Registry): Implemented {
  return (command) => registry.command(command) !== undefined;
}

// The groups of 0020, in order.
const GROUP = { paused: 0, live: 1, merge: 2, park: 3, byYou: 4, hand: 5, proposal: 6 } as const;

/** Group 3's order: by reason, as 0020 lists them; a reason outside the eight comes last. */
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

/** Group 5's order: spike before follow-up (0020 section 12), then tools, then decision notes. */
const PROPOSAL_RANK: Readonly<Record<ProposalItem["kind"], number>> = {
  spike: 0,
  "follow-up": 1,
  tool: 2,
  "decision-note": 3,
};

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

/** At most `max` characters: a longer text is cut and ends in `…`. */
function cut(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
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

/** The desk's builder: one office, its sources and the commands this engine ships. */
class DeskBuilder {
  readonly #office: OfficeHandle;
  readonly #sources: DeskSources;
  readonly #implemented: Implemented;
  readonly #dependents: Map<string, StoryId[]>;
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
    this.#now = now;
  }

  /** The action, when this engine ships its command. */
  #action(command: CommandName, cli: string): DeskAction[] {
    return this.#implemented(command) ? [{ command, cli }] : [];
  }

  #blocks(story: StoryId | null): StoryId[] {
    return story === null ? [] : (this.#dependents.get(story.toUpperCase()) ?? []);
  }

  /** Adds an item; its detail and hand text are cleaned and capped here, whoever built them. */
  #add(group: number, rank: number, sinceMs: number, item: DeskItem): void {
    const clean: DeskItem = {
      ...item,
      detail: deskLine(item.detail),
      ...(item.hand === undefined ? {} : { hand: deskLine(item.hand) }),
      ...(item.proposal === undefined
        ? {}
        : { proposal: { ...item.proposal, title: deskText(item.proposal.title) } }),
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

  /**
   * `, <n> min left` while a worker question's live wait runs (rounded up, at least 1), `, its wait
   * is over` once it has ended; empty for a question with no wait or a desk read without a time.
   */
  #timeLeft(question: StoredQuestion): string {
    if (question.waitUntil === null || this.#now === undefined) return "";
    const left = question.waitUntil - this.#now;
    return left <= 0 ? ", its wait is over" : `, ${Math.max(1, Math.ceil(left / 60_000))} min left`;
  }

  /** Group 0: the office's starts paused, with what lifts it; nothing else starts until then. */
  startsPaused(): void {
    const paused = this.#sources.startsPaused?.(this.#office) ?? null;
    if (paused === null) return;
    const why =
      paused.reason === "adapter" ? `adapter check failed: ${paused.detail}` : paused.detail;
    // The box token's hold lifts only with `dipo login box` (DIPO-271): no command lifts it here.
    const sticky = paused.reason === "adapter" && paused.hold?.liftedBy !== undefined;
    this.#add(GROUP.paused, 0, paused.since, {
      kind: "STARTS PAUSED",
      detail: `no new session starts · ${why}`,
      since: iso(paused.since),
      blocks: [],
      actions: sticky ? [] : this.#action("daemon.resumeScheduling", LIFT_COMMAND),
      hand: paused.lifts,
    });
  }

  /** Group 1: questions a live worker waits on; a park's questions are on its PARKED row. */
  liveQuestions(): void {
    for (const question of openQuestions(this.#office)) {
      if (question.parkId !== null) continue;
      const run = this.#office.get<{ key: string | null }>(
        "select key from runs where office_id = $office_id and run_id = $run",
        { run: question.runId },
      );
      const key = run?.key ?? null;
      const story = key === null ? null : storyIdOf(this.#office, key);
      // The time left on a worker question's live wait (0020, DIPO-159), kept whole when a long
      // question is cut.
      const waiting = ` · worker waiting${this.#timeLeft(question)}`;
      const room = DESK_DETAIL_MAX - Array.from(waiting).length - 2;
      const text = cut(deskText(question.text), room);
      this.#add(GROUP.live, 0, question.askedAt, {
        kind: "QUESTION",
        ...(story === null || key === null ? {} : { story, key: StoryKey.parse(key) }),
        question: QuestionId.parse(question.questionId),
        detail: `${JSON.stringify(text)}${waiting}`,
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

  /** Group 2: one merge gate that waits on the maintainer (see the file comment). */
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
    this.#add(GROUP.merge, 0, gate.opened_at, {
      kind: "MERGE",
      story,
      key: StoryKey.parse(gate.key),
      gate: GateId.parse(gate.gate_id),
      ...prOf(record),
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

  /** Groups 2 and 3: merge gates and every open park, the maintainer's own parks apart. */
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
      // A review-blocked park's gate is the PARKED row's `dipo approve --note` (0019 section 11).
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
        // The park's merge gate (0019 section 11): `dipo approve --note`, unless only the
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
      this.#add(GROUP.hand, 0, item.since, {
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
        this.#add(GROUP.hand, 0, hand.since, {
          kind: hand.kind,
          story,
          key: hand.key,
          detail: deskText(hand.detail),
          since: iso(hand.since),
          blocks: this.#blocks(story),
          actions: hand.actions.flatMap((action) => this.#action(action.command, action.cli)),
        });
      }
    }
    // Office items with no story, such as a stuck planning lane (DIPO-401).
    if (this.#now !== undefined) {
      for (const item of this.#sources.officeItems?.(this.#office, this.#now) ?? []) {
        this.#add(GROUP.hand, 0, item.since, {
          kind: item.kind,
          detail: deskText(item.detail),
          since: iso(item.since),
          blocks: [],
          actions: [],
          hand: item.hand,
        });
      }
    }
    // The story worktrees of an earlier binary dipo kept because they hold changes (DIPO-349).
    for (const item of leftoverWorktreeDeskItems(this.#office)) {
      this.#add(GROUP.hand, 1, item.since, {
        kind: item.kind,
        detail: deskText(item.detail),
        since: iso(item.since),
        blocks: [],
        actions: [],
        hand: item.hand,
      });
    }
    // The run profile's rows (DIPO-310): what the maintainer confirms by `dipo office confirm`.
    for (const item of profileDeskItems(this.#office)) {
      this.#add(GROUP.hand, 1, item.since, {
        kind: item.kind,
        detail: deskText(item.detail),
        since: iso(item.since),
        blocks: [],
        actions: item.actions.flatMap((action) => this.#action(action.command, action.cli)),
      });
    }
  }

  /** Group 6: open proposals and decision notes of worker reports. */
  proposals(): void {
    for (const proposal of proposalItems(this.#office)) {
      const story =
        proposal.story === null
          ? storyIdOf(this.#office, proposal.storyKey)
          : StoryId.parse(proposal.story);
      const note = proposal.kind === "decision-note";
      const id = word(proposal.id);
      this.#add(GROUP.proposal, PROPOSAL_RANK[proposal.kind], proposal.createdAt, {
        kind: "PROPOSAL",
        ...(story === null ? {} : { story, key: StoryKey.parse(proposal.storyKey) }),
        proposal: {
          id: proposal.id,
          kind: proposal.kind,
          title: proposal.title,
          run: RunId.parse(proposal.run),
        },
        detail: note
          ? `decision note · ${deskText(proposal.detail)}`
          : `${proposal.kind} ${JSON.stringify(deskText(proposal.title))} · ${deskText(proposal.detail)} · from ${proposal.run}`,
        since: iso(proposal.createdAt),
        blocks: this.#blocks(story),
        actions: note
          ? []
          : [
              ...this.#action("proposal.accept", `dipo propose accept ${id}`),
              ...this.#action("proposal.dismiss", `dipo propose dismiss ${id}`),
            ],
        ...(note
          ? { hand: "dipo never writes decision records: add the note by hand if you agree" }
          : {}),
      });
    }
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
 * of the read, for the time left on a worker question's wait; without it none is shown.
 */
export function desk(
  office: OfficeHandle,
  implemented: Implemented,
  sources: DeskSources,
  now?: number,
): DeskItem[] {
  const builder = new DeskBuilder(office, sources, implemented, now);
  builder.startsPaused();
  builder.liveQuestions();
  builder.gatesAndParks();
  builder.handActions();
  builder.proposals();
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
        since: iso(nowMs),
        blocks: [],
        actions: [],
      },
    ],
  });
}
