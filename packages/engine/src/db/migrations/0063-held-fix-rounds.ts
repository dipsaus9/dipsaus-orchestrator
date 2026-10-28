// Migration 63 (DIPO-362): a fix round's message and a resumed park's first message go through the
// one feedback path (0002) as held messages, like every other message dipo sends a developer
// session. Two kinds of stored intent change with it:
//
// | Old row                                                   | New row                              |
// |-----------------------------------------------------------|--------------------------------------|
// | `steer` `fix-round {"head":…,"advisories":[…]}`           | `feedback <source> <head> next <text>` |
// | `answer` `maintainer-resume {…, "fix": n}`, not resolved  | the same without `fix`               |
//
// A fix round's `text` is the round's message rendered from its stored `feedback_items` rows and
// advisories (`fixRoundMessage`), and `source` is its first item's (`review` without items), so a
// round held at upgrade time still goes with its session, and one per head still holds for rounds
// already sent. Its state is kept.
//
// A top-up resume's `fix` named the fix round still waiting for its session, and its `message`
// started with that round's message (DIPO-205). The round is held now on its own, so its message is
// cut from the front of the resume's `message`, and the findings go to the worker once.
//
// A maintainer resume whose transaction ran (`sent`) but whose developer session has not started
// held its first message in the intent, for the session start to send. That message is held now
// in its place: the reason's part as `feedback park resume-<intent> next <message>`, then the note
// as `feedback resume - next <maintainer-note.md with the note>` unless the park was answered (the
// answer is the reason's part). Both texts are rendered through the templates, so a prompt tag in a
// note is neutralised as in any new message.

import maintainerNoteTemplate from "../../prompts/feedback/maintainer-note.md" with { type: "text" };
import { fixRoundMessage, type FeedbackSource } from "../../prompts/feedback";
import { capNote } from "../../prompts/handoff";
import { renderTemplate } from "../../prompts/templates";
import type { CodeMigration, MigrationContext } from "../migrations";

interface IntentRow {
  office_id: string;
  run_id: string;
  intent_id: number;
  detail: string;
  state: string;
  created_at: number;
}

const FIX_ROUND = "fix-round ";
const RESUME = "maintainer-resume ";

/** The JSON after `tag`, or null when it does not parse to an object. */
function json(detail: string, tag: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(detail.slice(tag.length)) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function rewriteFixRounds(db: MigrationContext): void {
  const rows = db.all<IntentRow>(
    `select office_id, run_id, intent_id, detail, state, created_at from run_intents
      where kind = 'steer' and detail like 'fix-round %'`,
  );
  for (const row of rows) {
    const detail = json(row.detail, FIX_ROUND);
    const head = detail?.["head"];
    if (typeof head !== "string" || head === "" || /\s/.test(head)) continue;
    const advisories = Array.isArray(detail?.["advisories"])
      ? (detail["advisories"] as unknown[]).filter(
          (line): line is string => typeof line === "string",
        )
      : [];
    const items = db
      .all<{ source: FeedbackSource; text: string; repeat: number }>(
        `select source, text, repeat from feedback_items
          where office_id = $office and run_id = $run and intent_id = $id order by item_id`,
        { office: row.office_id, run: row.run_id, id: row.intent_id },
      )
      .map((item) => ({ source: item.source, text: item.text, repeat: item.repeat === 1 }));
    const source = items[0]?.source ?? "review";
    const text = fixRoundMessage({ head, items, advisories });
    db.run(
      `update run_intents set detail = $detail
        where office_id = $office and run_id = $run and intent_id = $id`,
      {
        detail: `feedback ${source} ${head} next ${text}`,
        office: row.office_id,
        run: row.run_id,
        id: row.intent_id,
      },
    );
  }
}

/** Stores a held message on the run, after its newest intent. */
function hold(db: MigrationContext, row: IntentRow, detail: string): void {
  const next =
    db.get<{ id: number }>(
      `select coalesce(max(intent_id), 0) + 1 as id from run_intents
        where office_id = $office and run_id = $run`,
      { office: row.office_id, run: row.run_id },
    )?.id ?? 1;
  db.run(
    `insert into run_intents (office_id, run_id, intent_id, kind, detail, state, created_at)
     values ($office, $run, $id, 'steer', $detail, 'pending', $at)`,
    { office: row.office_id, run: row.run_id, id: next, detail, at: row.created_at },
  );
}

/** The held text of the fix round `fix` of `row`'s run, when that round still waits; else null. */
function pendingRoundText(db: MigrationContext, row: IntentRow, fix: unknown): string | null {
  if (typeof fix !== "number") return null;
  const round = db.get<{ detail: string }>(
    `select detail from run_intents where office_id = $office and run_id = $run
      and intent_id = $id and state = 'pending' and detail like 'feedback % next %'`,
    { office: row.office_id, run: row.run_id, id: fix },
  );
  if (round === null) return null;
  // `feedback <source> <head> next <text>`
  const parts = round.detail.split(" ");
  return parts.length < 5 ? null : parts.slice(4).join(" ");
}

function heldResumes(db: MigrationContext): void {
  const rows = db.all<IntentRow>(
    `select office_id, run_id, intent_id, detail, state, created_at from run_intents
      where kind = 'answer' and resolved_at is null and detail like 'maintainer-resume %'`,
  );
  for (const row of rows) {
    const detail = json(row.detail, RESUME);
    if (detail === null) continue;
    const round = pendingRoundText(db, row, detail["fix"]);
    const original = detail["message"];
    if (round !== null && typeof original === "string" && original.startsWith(round)) {
      const rest = original.slice(round.length).replace(/^\n\n/, "");
      detail["message"] = rest === "" ? null : rest;
    }
    if (row.state === "sent" && detail["session"] === "developer") {
      const message = detail["message"];
      if (typeof message === "string" && message !== "") {
        hold(db, row, `feedback park resume-${row.intent_id} next ${message}`);
      }
      const note = detail["note"];
      if (typeof note === "string" && note.trim() !== "" && detail["answer"] == null) {
        const text = renderTemplate(maintainerNoteTemplate, { text: capNote(note) });
        hold(db, row, `feedback resume - next ${text}`);
      }
    }
    if (!("fix" in detail)) continue;
    delete detail["fix"];
    db.run(
      `update run_intents set detail = $detail
        where office_id = $office and run_id = $run and intent_id = $id`,
      {
        detail: `${RESUME}${JSON.stringify(detail)}`,
        office: row.office_id,
        run: row.run_id,
        id: row.intent_id,
      },
    );
  }
}

export const heldFixRounds: CodeMigration = {
  version: 63,
  name: "held fix rounds",
  source:
    "run_intents: steer fix-round {head, advisories} rewritten to `feedback <source> <head> next " +
    "<fixRoundMessage of its feedback_items>`; unresolved maintainer-resume intents lose `fix`, " +
    "and a sent developer resume's message and note are held as `feedback park resume-<intent> " +
    "next <message>` and `feedback resume - next <maintainer-note.md>`, a still-pending `fix` " +
    "round's message cut from the front of the resume's message",
  run: (db: MigrationContext) => {
    rewriteFixRounds(db);
    heldResumes(db);
  },
};
