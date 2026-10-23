// The desk (0020 section 12, DIPO-158): what waits on the maintainer, as `office.desk` returns it
// and `dipo desk` prints it. Code builds every item, its order and the command line it offers from
// stored facts; nothing asks a model, and clients never derive it (0005, 0009).
//
// The six groups, in order:
// 1. a question, permission or scope request a live worker waits on (no park took it over); a
//    worker question shows the time left on its wait (DIPO-159) and offers `dipo answer <question>
//    --text "<answer>"`;
// 2. merge gates that wait on the maintainer, with the PR from `story_prs`; a gate whose PR is
//    labelled `autorelease: pending` offers a hand merge and no `dipo approve`;
// 3. open parks: needing a decision, then a direction or grant, then a restart. A `review-blocked`
//    park whose merge gate is open is one row with both `dipo resume --note` and `dipo approve
//    --note` (or the hand merge when its PR is labelled `autorelease: pending`), and that gate gets
//    no MERGE row of its own;
// 4. hand actions: a backlog PR whose structural check failed or could not run, the items of
//    `DeskSources.handItems` (DIPO-161's DONE ELSEWHERE and LEFTOVERS), and the run profile's rows
//    (DIPO-310): each pending proposal of the scan fallback and each stale confirmation, an office
//    item with no story, offering its `dipo office confirm` lines (no TUI keys yet);
// 5. proposals and decision notes of worker reports (`proposals.ts`), spike before follow-up;
// 6. the stories parked `on-hold`, "Held by you".
// Within a group the items whose story blocks the most active stories come first, then the oldest.
//
// Every stored free text an item shows (questions, park details, gate summaries, PR titles, check
// failures, proposals) is cleaned of escape sequences, controls and bidi overrides, put on one line
// and capped at `DESK_DETAIL_MAX` (`deskText`, `deskLine`): worker and host text is data, and a
// terminal must never run it.
//
// An action is listed only when this engine registers its command as shipped, so the desk never
// offers a command the daemon would answer with `capability.missing`. Seams for stories not built
// yet are `DeskSources`: the resume needs of a park (DIPO-155's resume matrix), the hand-merge-only
// label of a gate's PR (DIPO-150) and further hand items (DIPO-161's are in `DESK_SOURCES`).

import {
  type CommandName,
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

import { openPrs } from "../backlog/pr/records";
import { cleanDoorText } from "../box/door";
import type { FeatureRegistry, ReadContext, Registry } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import { openParkQuestions, openQuestions, type StoredQuestion } from "../hooks/questions";
import { parkResumeRow } from "../run/resume-policy";
import { profileDeskItems } from "../scan/profile-view";
import { findStoryPr, latestStoryPr } from "../story-pr/records";
import { doneElsewhereDeskItems } from "../worktree/done-elsewhere";

import { proposalItems, type ProposalItem } from "./proposals";
import { lifecycleOf } from "./story";

/**
 * What `work.resume` needs for a park's reason and cause: a resume with a required or optional
 * note (and a budget top-up), or a refusal (never resumable, or resumed by a decision); null when
 * this engine cannot resume it. DIPO-155's `parkResumeRow` has this shape.
 */
export type ResumeNeed =
  | {
      readonly kind: "resume";
      readonly note: "required" | "optional";
      readonly topUp?: true;
    }
  | { readonly kind: "refuse"; readonly code: string };

export type ResumeNeeds = (reason: string, cause: string | null) => ResumeNeed | null;

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

/** An open merge gate, as `DeskSources.handMergeOnly` sees it. */
export interface DeskGate {
  readonly gate: string;
  readonly key: string;
  readonly run: string;
}

/** The desk's seams for facts other stories add. */
export interface DeskSources {
  readonly resumeNeeds: ResumeNeeds;
  /** True when the gate's PR is labelled `autorelease: pending` (0016 rule 12, DIPO-150). */
  readonly handMergeOnly: (office: OfficeHandle, gate: DeskGate) => boolean;
  /** Further hand-action items, in group 4. */
  readonly handItems: readonly ((office: OfficeHandle) => readonly HandDeskItem[])[];
}

/**
 * The resume needs `work.resume` meets (`resume-policy.ts`, DIPO-155): an `on-hold` park resumes
 * with an optional note through the planning lane, every other park as its row of the 0020 matrix
 * says (`parkResumeRow`), refusals included; a reason and cause with no row offer no resume.
 */
export const policyResumeNeeds: ResumeNeeds = (reason, cause) =>
  reason === "on-hold" ? { kind: "resume", note: "optional" } : parkResumeRow(reason, cause);

/**
 * The sources of this engine: no stored PR labels yet; the hand items are DIPO-161's DONE ELSEWHERE
 * (a live worker of a story Done on the base) and LEFTOVERS (what such a story left kept, with
 * `dipo discard <id> --note "<why>"`).
 */
export const DESK_SOURCES: DeskSources = {
  resumeNeeds: policyResumeNeeds,
  handMergeOnly: () => false,
  handItems: [doneElsewhereDeskItems],
};

/** Whether a command is registered and shipped, so the desk may offer it. */
export type Implemented = (command: CommandName) => boolean;

export function implementedIn(registry: Registry): Implemented {
  return (command) => registry.command(command)?.definition.since !== undefined;
}

// Groups 1 to 6 of 0020 section 12.
const GROUP = { live: 1, merge: 2, park: 3, hand: 4, proposal: 5, held: 6 } as const;

/** Group 3's order: a decision, then a direction or grant, then a restart, then anything else. */
const PARK_RANK: Readonly<Record<string, number>> = {
  "needs-permission": 0,
  "needs-scope": 0,
  "ambiguous-spec": 0,
  "review-blocked": 1,
  conflict: 1,
  "verify-failing": 1,
  "scope-violation": 1,
  "budget-exceeded": 1,
  "worker-failed": 2,
  interrupted: 2,
  stopped: 2,
};
const OTHER_PARK_RANK = 3;

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
      ...(item.cause === undefined ? {} : { cause: deskText(item.cause) }),
      ...(item.proposal === undefined
        ? {}
        : { proposal: { ...item.proposal, title: deskText(item.proposal.title) } }),
    };
    this.#items.push({ group, rank, sinceMs, item: clean });
  }

  /** The hand text of a gate whose PR only the maintainer merges (`autorelease: pending`). */
  #handMerge(record: { readonly number: number; readonly url: string } | null): string {
    const where = record === null ? "its PR" : `PR #${record.number} (${record.url})`;
    return `merge ${where} by hand on GitHub: it is labelled autorelease: pending, so dipo never approves it`;
  }

  /** The answer actions of a question: allow and deny for a permission, a text for a question. */
  #answerActions(question: StoredQuestion): DeskAction[] {
    const id = question.questionId;
    if (question.kind === "question") {
      // A worker question's answer is a flag, never read as a decision (0020 section 7).
      return this.#action("work.answer", `dipo answer ${id} --text "<answer>"`);
    }
    return [
      ...this.#action("work.answer", `dipo answer ${id} allow`),
      ...this.#action("work.answer", `dipo answer ${id} deny "<reason>"`),
    ];
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
      const kind =
        question.kind === "permission"
          ? "PERMISSION"
          : question.kind === "question"
            ? "QUESTION"
            : "SCOPE";
      // The time left on a worker question's live wait (0020 section 7, DIPO-159), kept whole when
      // a long question is cut.
      const waiting = ` · worker waiting${this.#timeLeft(question)}`;
      const room = DESK_DETAIL_MAX - Array.from(waiting).length - (kind === "QUESTION" ? 2 : 0);
      const text = cut(deskText(question.text), room);
      this.#add(GROUP.live, 0, question.askedAt, {
        kind,
        ...(story === null || key === null ? {} : { story, key: StoryKey.parse(key) }),
        question: QuestionId.parse(question.questionId),
        detail: `${kind === "QUESTION" ? JSON.stringify(text) : text}${waiting}`,
        since: iso(question.askedAt),
        blocks: this.#blocks(story),
        actions: this.#answerActions(question),
      });
    }
  }

  /** The open merge gates that wait on the maintainer, oldest first. */
  #openMergeGates(): {
    gate_id: string;
    key: string;
    run_id: string;
    opened_at: number;
    summary: string;
  }[] {
    return this.#office.all(
      `select g.gate_id, g.key, g.run_id, g.opened_at, g.summary from gates g
        where g.office_id = $office_id and g.kind = 'merge' and g.waiting_on = 'maintainer'
          and g.key is not null and g.run_id is not null
          and not exists (select 1 from gate_decisions d
                           where d.office_id = g.office_id and d.gate_id = g.gate_id)
        order by g.opened_at, g.gate_id`,
    );
  }

  /** Groups 2 and 3: merge gates and open parks other than `on-hold`. */
  gatesAndParks(): void {
    const parks = this.#office.all<{
      park_id: number;
      key: string;
      story_id: string;
      reason: string;
      cause: string | null;
      detail: string;
      at: number;
    }>(
      `select park_id, key, story_id, reason, cause, detail, at from parks
        where office_id = $office_id and resolved_at is null
        order by at, park_id`,
    );
    const gates = this.#openMergeGates();
    const reviewBlocked = new Set(
      parks.filter((park) => park.reason === "review-blocked").map((park) => park.key),
    );
    for (const gate of gates) {
      // A review-blocked park's gate is the PARKED row's `dipo approve --note` (0019 section 11).
      if (reviewBlocked.has(gate.key)) continue;
      const story = storyIdOf(this.#office, gate.key);
      if (story === null) continue;
      const record =
        findStoryPr(this.#office, RunId.parse(gate.run_id)) ??
        latestStoryPr(this.#office, gate.key);
      const handOnly = this.#sources.handMergeOnly(this.#office, {
        gate: gate.gate_id,
        key: gate.key,
        run: gate.run_id,
      });
      this.#add(GROUP.merge, 0, gate.opened_at, {
        kind: "MERGE",
        story,
        key: StoryKey.parse(gate.key),
        gate: GateId.parse(gate.gate_id),
        ...prOf(record),
        detail: deskText(gate.summary),
        since: iso(gate.opened_at),
        blocks: this.#blocks(story),
        actions: handOnly
          ? []
          : [
              ...this.#action("gate.approve", `dipo approve ${story}`),
              ...this.#action("gate.reject", `dipo reject ${story} --note "<why>"`),
            ],
        ...(handOnly ? { hand: this.#handMerge(record) } : {}),
      });
    }
    for (const park of parks) {
      const story = storyIdOf(this.#office, park.key) ?? StoryId.parse(park.story_id);
      const held = park.reason === "on-hold";
      const actions: DeskAction[] = [];
      for (const question of openParkQuestions(this.#office, park.park_id)) {
        actions.push(...this.#answerActions(question));
      }
      actions.push(...this.#resumeActions(story, park.reason, park.cause));
      const record = held ? null : latestStoryPr(this.#office, park.key);
      let gate: string | null = null;
      let hand: string | null = null;
      const open =
        park.reason === "review-blocked"
          ? (gates.find((candidate) => candidate.key === park.key) ?? null)
          : null;
      if (open !== null) {
        // The park's merge gate (0019 section 11): `dipo approve --note`, unless its PR is labelled
        // `autorelease: pending`, which only the maintainer merges, by hand.
        gate = open.gate_id;
        const handOnly = this.#sources.handMergeOnly(this.#office, {
          gate: open.gate_id,
          key: open.key,
          run: open.run_id,
        });
        if (handOnly) {
          hand = this.#handMerge(findStoryPr(this.#office, RunId.parse(open.run_id)) ?? record);
        } else {
          actions.push(...this.#action("gate.approve", `dipo approve ${story} --note "<why>"`));
        }
      }
      this.#add(
        held ? GROUP.held : GROUP.park,
        held ? 0 : (PARK_RANK[park.reason] ?? OTHER_PARK_RANK),
        park.at,
        {
          kind: held ? "HELD" : "PARKED",
          story,
          key: StoryKey.parse(park.key),
          ...(gate === null ? {} : { gate: GateId.parse(gate) }),
          ...prOf(record),
          reason: park.reason,
          ...(park.cause === null ? {} : { cause: park.cause }),
          detail: deskText(park.detail),
          since: iso(park.at),
          blocks: this.#blocks(story),
          actions,
          ...(hand === null ? {} : { hand }),
        },
      );
    }
  }

  /** The resume (or discard) a park offers, from its reason's resume needs. */
  #resumeActions(story: StoryId, reason: string, cause: string | null): DeskAction[] {
    const need = this.#sources.resumeNeeds(reason, cause);
    if (need === null) return [];
    if (need.kind === "refuse") {
      return need.code === "resume.notResumable"
        ? this.#action("work.discard", `dipo discard ${story} --note "<why>"`)
        : [];
    }
    const placeholder = reason === "ambiguous-spec" ? "<answer>" : "<why>";
    const budget = need.topUp === true ? " --budget +50%" : "";
    const note = need.note === "required" || need.topUp === true ? ` --note "${placeholder}"` : "";
    return this.#action("work.resume", `dipo resume ${story}${budget}${note}`);
  }

  /** Group 4: backlog PRs whose check failed or could not run, then the sources' hand items. */
  handActions(): void {
    for (const pr of openPrs(this.#office)) {
      const failed = pr.check === "failed";
      if (!failed && pr.checkError === null) continue;
      const why =
        pr.checkError !== null
          ? `its check cannot run: ${deskText(pr.checkError)}`
          : `its check failed: ${pr.failures.map((failure) => deskText(failure.message)).join("; ")}`;
      const since = pr.checkedAt ?? pr.updatedAt;
      this.#add(GROUP.hand, 0, since, {
        kind: "BACKLOG PR",
        pr: { number: pr.number, url: pr.url, state: pr.state },
        detail: `#${pr.number} ${JSON.stringify(deskText(pr.title))} · ${why}`,
        since: iso(since),
        blocks: [],
        actions: [],
        hand: `fix the branch ${deskText(pr.branch)} of PR #${pr.number} by hand on GitHub (${pr.url})`,
      });
    }
    for (const source of this.#sources.handItems) {
      for (const hand of source(this.#office)) {
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

  /** Group 5: open proposals and decision notes of worker reports. */
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
  sources: DeskSources = DESK_SOURCES,
  now?: number,
): DeskItem[] {
  const builder = new DeskBuilder(office, sources, implemented, now);
  builder.liveQuestions();
  builder.gatesAndParks();
  builder.handActions();
  builder.proposals();
  return builder.sorted();
}

/** Registers `office.desk`; `views/feature.ts` calls it with this engine's sources. */
export function registerDesk(registry: FeatureRegistry, sources: DeskSources = DESK_SOURCES): void {
  registry.addRead({
    definition: officeDesk,
    handle: (ctx: ReadContext) => {
      if (ctx.office === undefined) throw new Error("office.desk runs with its office");
      return desk(ctx.office, implementedIn(ctx.registry), sources, ctx.clock.now());
    },
  });
}
