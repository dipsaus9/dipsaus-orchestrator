// The office's ideas (0022, DIPO-452): every incoming idea is held here with its origin and source
// story, and nothing else holds it as a draft. A worker's proposal, a reviewer's advisory finding,
// a planning session's aside and the maintainer's quick idea each come in through `holdIdea`.
//
// - An idea of a story run waits for that run's end (merged or parked); an idea without a run, or
//   of a session run, is due when it arrives (`dueIdeas`).
// - Code decides first (`codeRejections`): an idea equal to one already held (title and text, case
//   and spacing aside) or whose title is that of an open or Done story is rejected with that
//   reason, and no model sees it.
// - The audit's outcome is written here: passed with its proposed user story, rejected with its
//   reason, or still held after a failed, cut-off or refused audit (`auditMissed`), counted in
//   `attempts`. A held idea is never dropped; a rejected one is kept with its reason.
// - A passed idea waits on the desk (`openPassedIdeas`) until the maintainer answers it
//   (`answerIdea`, DIPO-454): `accepted`, with the draft the lane filed, or `dismissed`, kept for
//   retro.
//
// Every text of an idea came from a worker, a reviewer, a session or the maintainer: it is
// cleaned and capped at the door and kept as data.

import {
  cleanText,
  IDEA_CAPS,
  type IdeaAnswer,
  type IdeaDecidedBy,
  type IdeaOrigin,
  type IdeaState,
  type IdeaView,
  type ProposedStory,
  RunId,
  StoryId,
  type StoryKey,
} from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import { ideaIdOf } from "../db/idea-ids";

/** One incoming idea. `runId` is the run it came from, if any; `key` its source story. */
export interface NewIdea {
  readonly origin: IdeaOrigin;
  readonly key: StoryKey | null;
  readonly runId: string | null;
  readonly title: string;
  readonly text: string;
  readonly at: number;
}

/** A held idea, as the audit reads it. */
export interface HeldIdea {
  readonly id: string;
  readonly origin: IdeaOrigin;
  readonly key: StoryKey | null;
  /** The source story's id, when the office still knows it. */
  readonly story: StoryId | null;
  readonly run: string | null;
  readonly title: string;
  readonly text: string;
  readonly attempts: number;
  readonly createdAt: number;
}

/**
 * `text` at most `max` characters long: over the cap it is cut at the last word boundary that
 * fits (a word longer than the cap is cut where the cap falls), and nothing is added, so no mark
 * outside ASCII ends up in a draft's title and so in its file name (DIPO-488).
 */
export function cutWords(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const head = chars.slice(0, max);
  const boundary = /\s/u.test(chars[max] ?? "")
    ? max
    : head.findLastIndex((char) => /\s/u.test(char));
  return (boundary > 0 ? head.slice(0, boundary) : head).join("").trimEnd();
}

/** An idea's title as held: cleaned, on one line, capped. */
export function ideaTitle(text: string): string {
  return cutWords(cleanText(text).replace(/\s+/g, " ").trim(), IDEA_CAPS.title);
}

/** An idea's text as held: cleaned, trimmed, capped. */
export function ideaText(text: string): string {
  return cutWords(cleanText(text).trim(), IDEA_CAPS.text);
}

/** The id `idea` is held by, or null when its title or text is empty once cleaned. */
export function newIdeaId(idea: NewIdea): string | null {
  const title = ideaTitle(idea.title);
  const text = ideaText(idea.text);
  if (title === "" || text === "") return null;
  return ideaIdOf(idea.origin, idea.runId ?? idea.key ?? "", title, text);
}

/**
 * Holds one idea, state `held`; the same idea from the same source is held once. Returns its id
 * when this call held it, else null. Inside the caller's transaction.
 */
export function holdIdea(office: OfficeHandle, idea: NewIdea): string | null {
  const title = ideaTitle(idea.title);
  const text = ideaText(idea.text);
  const id = newIdeaId(idea);
  if (id === null) return null;
  const changes = office.run(
    `insert into ideas (office_id, idea_id, origin, story_key, run_id, title, body, created_at,
       updated_at)
     values ($office_id, $id, $origin, $key, $run, $title, $body, $at, $at)
     on conflict (office_id, idea_id) do nothing`,
    {
      id,
      origin: idea.origin,
      key: idea.key,
      run: idea.runId,
      title,
      body: text,
      at: idea.at,
    },
  ).changes;
  return changes > 0 ? id : null;
}

interface HeldRow {
  idea_id: string;
  origin: string;
  story_key: string | null;
  story_id: string | null;
  run_id: string | null;
  title: string;
  body: string;
  attempts: number;
  created_at: number;
}

const HELD_SELECT = `
  select i.idea_id, i.origin, i.story_key, s.story_id, i.run_id, i.title, i.body, i.attempts,
         i.created_at
    from ideas i
    left join stories s on s.office_id = i.office_id and s.key = i.story_key
    left join runs r on r.office_id = i.office_id and r.run_id = i.run_id`;

function heldOf(row: HeldRow): HeldIdea {
  return {
    id: row.idea_id,
    origin: row.origin,
    key: row.story_key as StoryKey | null,
    story: row.story_id === null ? null : StoryId.parse(row.story_id),
    run: row.run_id,
    title: row.title,
    text: row.body,
    attempts: row.attempts,
    createdAt: row.created_at,
  };
}

/**
 * The held ideas an audit may take now, oldest first: those without a run, of a session run, or
 * whose story run has ended (merged or parked; a resumed run holds its ideas again until its next
 * end). Never one of a story run that runs. With `retry` false only the ideas never audited.
 */
export function dueIdeas(office: OfficeHandle, retry: boolean): HeldIdea[] {
  return office
    .all<HeldRow>(
      `${HELD_SELECT}
       where i.office_id = $office_id and i.state = 'held'
         and (i.run_id is null or r.run_id is null or r.kind = 'session' or r.ended_at is not null)
         and ($retry = 1 or i.attempts = 0)
       order by i.created_at, i.idea_id`,
      { retry: retry ? 1 : 0 },
    )
    .map(heldOf);
}

/** Case and spacing aside, as the code check compares titles and texts. */
const normal = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Pure over the office's rows: why code rejects each idea of `batch` it rejects, by idea id. An
 * idea equal to another held or passed one held before it, or one of the batch kept before it, is
 * a duplicate; an idea whose title is that of a story not removed (open or Done) is covered.
 */
export function codeRejections(
  office: OfficeHandle,
  batch: readonly HeldIdea[],
): Map<string, string> {
  const stories = office.all<{ story_id: string; kind: string; status: string; title: string }>(
    `select s.story_id, m.kind, m.status, m.title from stories s
       join backlog_mirror m on m.office_id = s.office_id and m.key = s.key
      where s.office_id = $office_id and s.removed_at is null
      order by s.story_id`,
  );
  const byTitle = new Map<string, { story: string; status: string }>();
  for (const row of stories) {
    const status = row.kind === "draft" ? "Draft" : row.status;
    if (!byTitle.has(normal(row.title)))
      byTitle.set(normal(row.title), { story: row.story_id, status });
  }
  const kept = office.all<{ idea_id: string; title: string; body: string; created_at: number }>(
    `select idea_id, title, body, created_at from ideas
      where office_id = $office_id and state <> 'rejected'
      order by created_at, idea_id`,
  );
  const rejected = new Map<string, string>();
  for (const idea of batch) {
    const story = byTitle.get(normal(idea.title));
    if (story !== undefined) {
      rejected.set(
        idea.id,
        `its title is that of ${story.story} (${story.status}), a story the office already has`,
      );
      continue;
    }
    const same = kept.find(
      (other) =>
        other.idea_id !== idea.id &&
        !rejected.has(other.idea_id) &&
        (other.created_at < idea.createdAt ||
          (other.created_at === idea.createdAt && other.idea_id < idea.id)) &&
        normal(other.title) === normal(idea.title) &&
        normal(other.body) === normal(idea.text),
    );
    if (same !== undefined) {
      rejected.set(idea.id, `it is the same as idea ${same.idea_id.slice(0, 12)}, held already`);
    }
  }
  return rejected;
}

/** Rejects a held idea with its reason; false when it was not held. Inside a transaction. */
export function rejectIdea(
  office: OfficeHandle,
  id: string,
  decision: {
    readonly by: IdeaDecidedBy;
    readonly reason: string;
    readonly auditRun: string | null;
    readonly at: number;
  },
): boolean {
  return (
    office.run(
      `update ideas set state = 'rejected', decided_by = $by, reason = $reason,
         audit_run_id = coalesce($run, audit_run_id), decided_at = $at, updated_at = $at
       where office_id = $office_id and idea_id = $id and state = 'held'`,
      {
        id,
        by: decision.by,
        reason: cutWords(cleanText(decision.reason).trim(), IDEA_CAPS.reason),
        run: decision.auditRun,
        at: decision.at,
      },
    ).changes > 0
  );
}

/** Passes a held idea with its proposed user story; false when it was not held. */
export function passIdea(
  office: OfficeHandle,
  id: string,
  decision: { readonly proposal: ProposedStory; readonly auditRun: string; readonly at: number },
): boolean {
  return (
    office.run(
      `update ideas set state = 'passed', decided_by = 'audit', proposal = $proposal,
         audit_run_id = $run, decided_at = $at, updated_at = $at
       where office_id = $office_id and idea_id = $id and state = 'held'`,
      {
        id,
        proposal: JSON.stringify(decision.proposal),
        run: decision.auditRun,
        at: decision.at,
      },
    ).changes > 0
  );
}

/**
 * An audit that did not decide these held ideas (it failed, was cut off or was refused by schema,
 * or left them out): each stays held with the problem, one attempt more, and is audited again at
 * the next trigger.
 */
export function auditMissed(
  office: OfficeHandle,
  ids: readonly string[],
  missed: { readonly problem: string; readonly auditRun: string | null; readonly at: number },
): void {
  for (const id of ids) {
    office.run(
      `update ideas set attempts = attempts + 1, last_problem = $problem,
         audit_run_id = coalesce($run, audit_run_id), updated_at = $at
       where office_id = $office_id and idea_id = $id and state = 'held'`,
      {
        id,
        problem: cutWords(cleanText(missed.problem).trim(), IDEA_CAPS.reason),
        run: missed.auditRun,
        at: missed.at,
      },
    );
  }
}

interface ViewRow extends HeldRow {
  state: IdeaState;
  decided_by: IdeaDecidedBy | null;
  reason: string | null;
  proposal: string | null;
  last_problem: string | null;
  decided_at: number | null;
  answer: IdeaAnswer | null;
  answered_at: number | null;
  draft_id: string | null;
}

const VIEW_SELECT = `
  select i.idea_id, i.origin, i.story_key, s.story_id, i.run_id, i.title, i.body, i.attempts,
         i.created_at, i.state, i.decided_by, i.reason, i.proposal, i.last_problem,
         i.decided_at, i.answer, i.answered_at, i.draft_id
    from ideas i
    left join stories s on s.office_id = i.office_id and s.key = i.story_key`;

const iso = (ms: number) => new Date(ms).toISOString();

function viewOf(row: ViewRow): IdeaView {
  return {
    id: row.idea_id,
    origin: row.origin,
    ...(row.story_id === null ? {} : { story: StoryId.parse(row.story_id) }),
    ...(row.run_id === null ? {} : { run: RunId.parse(row.run_id) }),
    title: row.title,
    text: row.body,
    state: row.state,
    ...(row.decided_by === null ? {} : { decidedBy: row.decided_by }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.proposal === null ? {} : { proposal: JSON.parse(row.proposal) as ProposedStory }),
    attempts: row.attempts,
    ...(row.last_problem === null ? {} : { lastProblem: row.last_problem }),
    createdAt: iso(row.created_at),
    ...(row.decided_at === null ? {} : { decidedAt: iso(row.decided_at) }),
    ...(row.answer === null ? {} : { answer: row.answer }),
    ...(row.answered_at === null ? {} : { answeredAt: iso(row.answered_at) }),
    ...(row.draft_id === null ? {} : { draft: row.draft_id }),
  };
}

/** The office's ideas as `office.ideas` lists them, oldest first; only `state` when given. */
export function ideaViews(office: OfficeHandle, state?: IdeaState): IdeaView[] {
  return office
    .all<ViewRow>(
      `${VIEW_SELECT}
        where i.office_id = $office_id and ($state is null or i.state = $state)
        order by i.created_at, i.idea_id`,
      { state: state ?? null },
    )
    .map(viewOf);
}

/** The ideas that passed and wait on the desk for the maintainer's answer, oldest first. */
export function openPassedIdeas(office: OfficeHandle): IdeaView[] {
  return office
    .all<ViewRow>(
      `${VIEW_SELECT}
        where i.office_id = $office_id and i.state = 'passed' and i.answer is null
        order by i.decided_at, i.idea_id`,
    )
    .map(viewOf);
}

/** The ideas whose id starts with `ref` (a hex prefix), at most two. */
export function ideasByPrefix(office: OfficeHandle, ref: string): IdeaView[] {
  return office
    .all<ViewRow>(
      `${VIEW_SELECT}
        where i.office_id = $office_id and substr(i.idea_id, 1, length($ref)) = $ref
        order by i.idea_id
        limit 2`,
      { ref: ref.toLowerCase() },
    )
    .map(viewOf);
}

/**
 * The maintainer's answer to a passed idea not answered yet; false when it is not passed or was
 * answered already. Inside the caller's transaction.
 */
export function answerIdea(
  office: OfficeHandle,
  id: string,
  answer: IdeaAnswer,
  at: number,
): boolean {
  return (
    office.run(
      `update ideas set answer = $answer, answered_at = $at, updated_at = $at
        where office_id = $office_id and idea_id = $id and state = 'passed' and answer is null`,
      { id, answer, at },
    ).changes > 0
  );
}

/** Where an accepted idea's draft came from, as a triage session lists it (DIPO-454). */
export interface DraftOrigin {
  readonly origin: IdeaOrigin;
  /** The idea's title; Backlog.md reuses draft ids, so the title tells the draft apart. */
  readonly title: string;
  /** The idea's source story, when the office knows it. */
  readonly story: string | null;
}

/** The origin of each draft an accepted idea was filed as, by upper-case draft id; the newest wins. */
export function draftOrigins(office: OfficeHandle): Map<string, DraftOrigin> {
  const rows = office.all<{
    draft_id: string;
    origin: string;
    title: string;
    story_id: string | null;
    proposal: string | null;
  }>(
    `select i.draft_id, i.origin, i.title, s.story_id, i.proposal
       from ideas i
       left join stories s on s.office_id = i.office_id and s.key = i.story_key
      where i.office_id = $office_id and i.answer = 'accepted' and i.draft_id is not null
      order by i.answered_at, i.idea_id`,
  );
  const origins = new Map<string, DraftOrigin>();
  for (const row of rows) {
    const source =
      row.proposal === null
        ? null
        : ((JSON.parse(row.proposal) as ProposedStory).sourceStory ?? null);
    origins.set(row.draft_id.toUpperCase(), {
      origin: row.origin,
      title: row.title,
      story: source ?? row.story_id,
    });
  }
  return origins;
}
