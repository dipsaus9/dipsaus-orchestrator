// The card of an idea that passed its audit (DIPO-454, 0022), as plain-text lines shared by the TUI
// and the CLI so every view shows the same proposed user story in full: what was found with its
// evidence and source story, the Story line, what is proposed, why, and the milestone it serves or
// tech debt. Nothing is cut; each text is cleaned of terminal controls again, since a terminal shows
// it, and a text of several lines keeps them.

import { cleanText, type IdeaCard, TECH_DEBT } from "@dipsaus-orchestrator/contract";

/** One labelled part of a card: its label and its lines. */
export interface IdeaCardPart {
  readonly label: string;
  readonly lines: readonly string[];
}

const linesOf = (text: string): string[] => cleanText(text).trim().split("\n");

/** Where an idea came from, in words. */
const ORIGIN_WORDS: Readonly<Record<string, string>> = {
  proposal: "a worker's proposal",
  finding: "a reviewer's finding",
  aside: "a planning session's aside",
  quick: "your quick idea",
};

/** The parts of `card`, in the order the card shows them. */
export function ideaCardParts(card: IdeaCard): IdeaCardPart[] {
  const evidence = card.evidence.map((place) => {
    const where = `${cleanText(place.file)}:${place.line}`;
    return place.quote === undefined ? where : `${where} ${JSON.stringify(cleanText(place.quote))}`;
  });
  const origin = ORIGIN_WORDS[card.origin] ?? card.origin;
  return [
    { label: "Found", lines: linesOf(card.found) },
    { label: "Evidence", lines: evidence },
    {
      label: "Source",
      lines: [card.sourceStory === undefined ? origin : `${origin} of ${card.sourceStory}`],
    },
    { label: "Story", lines: linesOf(card.storyLine) },
    { label: "Proposed", lines: linesOf(card.proposed) },
    { label: "Why", lines: linesOf(card.why) },
    {
      label: "Serves",
      lines: [card.serves === TECH_DEBT ? "tech debt" : `milestone ${cleanText(card.serves)}`],
    },
  ];
}

/** The card as lines: each part's label, then its lines, the later ones under the first. */
export function ideaCardLines(card: IdeaCard): string[] {
  const parts = ideaCardParts(card);
  const width = Math.max(...parts.map((part) => part.label.length)) + 2;
  return parts.flatMap((part) =>
    part.lines.map((line, index) => `${index === 0 ? `${part.label}: ` : ""}`.padEnd(width) + line),
  );
}
