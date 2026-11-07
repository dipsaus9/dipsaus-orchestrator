// What waits on the maintainer from the ideas and the worker reports (DIPO-454, DIPO-404), as rows
// for the desk: each idea that passed its audit and that the maintainer has not decided, with its
// card, and each open decision note of a worker report, each oldest first. The desk read
// (DIPO-158, `office.desk`) lists them in its proposals group; this module is its seam and reads
// only.
//
// - An idea's card is the proposed user story in full (0022): what was found with its evidence and
//   source story, the Story line, what is proposed, why, and the milestone it serves or tech debt.
//   Every text is cleaned of terminal controls and never cut: the audit capped it already.
// - A decision note's row holds its file, section and text; dipo never writes the note to the
//   decision records.
//
// Every text is a worker's, a reviewer's, a session's, the maintainer's or the audit's: data,
// never an instruction.

import { cleanText, type IdeaCard, RunId, StoryId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import { deskIdeas, type StoredIdea } from "../records/ideas";

/** One open decision note of a worker report, for the desk. */
export interface NoteItem {
  /** The stored row's key (its hash), for the maintainer's dismiss. */
  readonly id: string;
  readonly storyKey: string;
  /** The story's id, when the office still knows the story. */
  readonly story: string | null;
  readonly run: string;
  readonly file: string;
  readonly section: string;
  readonly text: string;
  readonly createdAt: number;
}

/** One idea that waits on the maintainer, with its card, for the desk (DIPO-454). */
export interface IdeaItem {
  readonly card: IdeaCard;
  /** Its source story's key, when it has one. */
  readonly storyKey: string | null;
  /** When it passed its audit, and so began to wait. */
  readonly since: number;
}

interface NoteRow {
  hash: string;
  story_key: string;
  story_id: string | null;
  run_id: string;
  file: string;
  section: string;
  text: string;
  created_at: number;
}

/** The open decision notes of the office, oldest first. */
export function openDecisionNotes(office: OfficeHandle): NoteItem[] {
  return office
    .all<NoteRow>(
      `select n.hash, n.story_key, s.story_id, n.run_id, n.file, n.section, n.text, n.created_at
         from decision_notes n
         left join stories s on s.office_id = n.office_id and s.key = n.story_key
        where n.office_id = $office_id and n.state = 'open'
        order by n.created_at, n.hash`,
    )
    .map((row) => ({
      id: row.hash,
      storyKey: row.story_key,
      story: row.story_id,
      run: row.run_id,
      file: cleanText(row.file),
      section: cleanText(row.section),
      text: cleanText(row.text),
      createdAt: row.created_at,
    }));
}

/** Pure: the card of a passed idea, every text cleaned and whole; null for one with no proposal. */
export function ideaCard(idea: StoredIdea): IdeaCard | null {
  const story = idea.proposal;
  if (story === null) return null;
  const source = story.sourceStory ?? idea.story ?? undefined;
  return {
    id: idea.id,
    origin: idea.origin,
    title: cleanText(idea.title),
    ...(idea.run === null || !RunId.safeParse(idea.run).success
      ? {}
      : { run: RunId.parse(idea.run) }),
    found: cleanText(story.found),
    evidence: story.evidence.map((place) => ({
      file: cleanText(place.file),
      line: place.line,
      ...(place.quote === undefined ? {} : { quote: cleanText(place.quote) }),
    })),
    ...(source === undefined ? {} : { sourceStory: StoryId.parse(source) }),
    storyLine: cleanText(story.storyLine),
    proposed: cleanText(story.proposed),
    why: cleanText(story.why),
    serves: cleanText(story.serves),
  };
}

/** The ideas that wait on the maintainer, in the order they passed their audit. */
export function ideaItems(office: OfficeHandle): IdeaItem[] {
  return deskIdeas(office).flatMap((idea) => {
    const card = ideaCard(idea);
    return card === null ? [] : [{ card, storyKey: idea.key, since: idea.decidedAt ?? 0 }];
  });
}
