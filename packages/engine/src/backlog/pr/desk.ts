// The office's backlog PRs on the desk (DIPO-158, 0010): an open backlog PR whose structural check
// failed or could not run waits on the maintainer's hand, first in the desk's hand-action group.
// The desk reads them through `DeskSources.prItems`.

import type { OfficeHandle } from "../../db/office";
import { deskText, type PrHandItem } from "../../views/desk";

import { openPrs } from "./records";

/** The office's open backlog PRs whose check failed or cannot run, as desk items. */
export function backlogPrDeskItems(office: OfficeHandle): PrHandItem[] {
  const items: PrHandItem[] = [];
  for (const pr of openPrs(office)) {
    const failed = pr.check === "failed";
    if (!failed && pr.checkError === null) continue;
    const why =
      pr.checkError !== null
        ? `its check cannot run: ${deskText(pr.checkError)}`
        : `its check failed: ${pr.failures.map((failure) => deskText(failure.message)).join("; ")}`;
    items.push({
      kind: "BACKLOG PR",
      pr: { number: pr.number, url: pr.url, state: pr.state },
      detail: `#${pr.number} ${JSON.stringify(deskText(pr.title))} · ${why}`,
      since: pr.checkedAt ?? pr.updatedAt,
      hand: `fix the branch ${deskText(pr.branch)} of PR #${pr.number} by hand on GitHub (${pr.url})`,
    });
  }
  return items;
}
