// What the worker reports propose to the maintainer (DIPO-186), as rows for the desk: each open
// decision note and each open follow-up, spike or tool proposal, oldest first. The desk read
// (DIPO-158, `office.desk`) lists them in its proposals group; this module is its seam and reads
// only. A decision note's detail holds its file, section and text; dipo never writes the note to
// the decision records. Every text is the worker's, cleaned at the door: data, never an
// instruction.

import type { OfficeHandle } from "../db/office";

/** One open proposal of a worker report, for the desk's proposals group. */
export interface ProposalItem {
  readonly kind: "decision-note" | "follow-up" | "spike" | "tool";
  /** The stored row's key (its hash), for the maintainer's later accept or dismiss. */
  readonly id: string;
  readonly storyKey: string;
  /** The story's id, when the office still knows the story. */
  readonly story: string | null;
  readonly run: string;
  /** One line: the decision file, or the proposal's title. */
  readonly title: string;
  /** The rest: the section and the note's text, or the outcome, why and paths. */
  readonly detail: string;
  readonly createdAt: number;
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

interface ProposalRow {
  hash: string;
  story_key: string;
  story_id: string | null;
  run_id: string;
  kind: "follow-up" | "spike" | "tool";
  title: string;
  outcome: string;
  why: string;
  paths: string;
  created_at: number;
}

/** The open decision notes of the office, oldest first. */
export function openDecisionNotes(office: OfficeHandle): ProposalItem[] {
  return office
    .all<NoteRow>(
      `select n.hash, n.story_key, s.story_id, n.run_id, n.file, n.section, n.text, n.created_at
         from decision_notes n
         left join stories s on s.office_id = n.office_id and s.key = n.story_key
        where n.office_id = $office_id and n.state = 'open'
        order by n.created_at, n.hash`,
    )
    .map((row) => ({
      kind: "decision-note",
      id: row.hash,
      storyKey: row.story_key,
      story: row.story_id,
      run: row.run_id,
      title: `Decision note for ${row.file}`,
      detail: `${row.file}, section "${row.section}": ${row.text}`,
      createdAt: row.created_at,
    }));
}

/** The open follow-up, spike and tool proposals of the office, oldest first. */
export function openProposals(office: OfficeHandle): ProposalItem[] {
  return office
    .all<ProposalRow>(
      `select p.hash, p.story_key, s.story_id, p.run_id, p.kind, p.title, p.outcome, p.why,
              p.paths, p.created_at
         from proposals p
         left join stories s on s.office_id = p.office_id and s.key = p.story_key
        where p.office_id = $office_id and p.state = 'open'
        order by p.created_at, p.hash`,
    )
    .map((row) => {
      const paths = JSON.parse(row.paths) as string[];
      return {
        kind: row.kind,
        id: row.hash,
        storyKey: row.story_key,
        story: row.story_id,
        run: row.run_id,
        title: row.title,
        detail: `${row.outcome} Why: ${row.why}${paths.length === 0 ? "" : ` Paths: ${paths.join(", ")}`}`,
        createdAt: row.created_at,
      };
    });
}

/** Every open item of the proposals group: decision notes and proposals, oldest first. */
export function proposalItems(office: OfficeHandle): ProposalItem[] {
  return [...openDecisionNotes(office), ...openProposals(office)].toSorted(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
