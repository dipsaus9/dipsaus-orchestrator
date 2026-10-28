// Migration 61 (DIPO-361): every message dipo sends a developer session is one `steer` intent of
// the one feedback path (0002), with the detail `feedback <source> <key> <via> <text>`, where `via`
// is `next` for a message held for the next session and `now` for one sent to a live session, and
// `text` is the message as the worker reads it. The three tags it replaces become it:
//
// | Old detail                          | New detail                                              |
// |-------------------------------------|---------------------------------------------------------|
// | `maintainer-steer <request> <text>` | `feedback steer <request> <via> <steer.md with text>`   |
// | `held-feedback <text>`              | `feedback resume - next <text>`                         |
// | `report-feedback <agent> <why>`     | `feedback report <agent> <via> <report.md with why>`    |
//
// `via` is `next` for a row still pending and `now` for any other, so a steer or a held text stored
// before the upgrade still goes with the next session's first message, a retried steer request
// still finds its steer, and a run's one report correction is still counted. `held-feedback` held
// both a resume note and a worker answer held for the next session; the two cannot be told apart,
// so both become source `resume`, never `answer`. The steer and report texts are rendered through
// the templates (`renderTemplate`), so a prompt tag in the stored text is neutralised as in any new
// message.

import reportTemplate from "../../prompts/feedback/report.md" with { type: "text" };
import steerTemplate from "../../prompts/feedback/steer.md" with { type: "text" };
import { renderTemplate } from "../../prompts/templates";
import type { CodeMigration, MigrationContext } from "../migrations";

/** The first word of `rest` and what follows its space; the second part is empty without one. */
function split(rest: string): [string, string] {
  const space = rest.indexOf(" ");
  return space === -1 ? [rest, ""] : [rest.slice(0, space), rest.slice(space + 1)];
}

/** The new detail of an old one, or null when the row is not one of the three old tags. */
function rewrite(detail: string, pending: boolean): string | null {
  const via = pending ? "next" : "now";
  const [tag, rest] = split(detail);
  if (tag === "maintainer-steer") {
    const [request, text] = split(rest);
    return `feedback steer ${request} ${via} ${renderTemplate(steerTemplate, { text })}`;
  }
  if (tag === "held-feedback") return `feedback resume - next ${rest}`;
  if (tag === "report-feedback") {
    const [agent, why] = split(rest);
    return `feedback report ${agent} ${via} ${renderTemplate(reportTemplate, { why })}`;
  }
  return null;
}

export const oneFeedbackTag: CodeMigration = {
  version: 61,
  name: "one feedback tag",
  source:
    "run_intents of kind steer: maintainer-steer, held-feedback and report-feedback details " +
    "rewritten to `feedback <source> <key> <via> <text>`, via next for pending rows else now, " +
    "steer and report texts rendered through feedback/steer.md and feedback/report.md",
  run: (db: MigrationContext) => {
    const rows = db.all<{
      office_id: string;
      run_id: string;
      intent_id: number;
      detail: string;
      state: string;
    }>(
      `select office_id, run_id, intent_id, detail, state from run_intents
        where kind = 'steer' and (detail like 'maintainer-steer %' or detail like 'held-feedback %'
          or detail like 'report-feedback %')`,
    );
    for (const row of rows) {
      const detail = rewrite(row.detail, row.state === "pending");
      if (detail === null) continue;
      db.run(
        `update run_intents set detail = $detail
          where office_id = $office and run_id = $run and intent_id = $id`,
        { detail, office: row.office_id, run: row.run_id, id: row.intent_id },
      );
    }
  },
};
