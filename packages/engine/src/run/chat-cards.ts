// The action cards of a chat answer (DIPO-525, pure). The model writes each card in its answer as a
// fenced block with the info string `dipo-card` (`CHAT_CARD_FENCE`) holding one JSON object. At each
// turn end the engine reads every block as it reads proposals (`planning-proposals.ts`): the JSON is
// held to `CARD_BLOCK_MAX_CHARS`, strings are cleaned at the door (0008), the contract's `ChatCard`
// schema decides, then the office's state: a steer card names a running story, an answer card an
// open question, a resume card a parked story and a ready card stories that exist and are not
// running, parked or done. A block that fails is refused with its problems, which go back to the
// session as one message (`cardRefusalMessage`).
//
// A card never sends anything: the maintainer's `c` sends the matching command as their own (origin
// `chat`). Drop and discard have no card of their own: they are `command` cards, whose `c` copies
// the line, so a card that would drop or discard is refused unless it is a command card.

import {
  CHAT_CARD_FENCE,
  ChatCard,
  cleanText,
  type ChatCardView,
} from "@dipsaus-orchestrator/contract";

import { cleanDoorStrings, doorKeysClean } from "../box/door";
import { fencedBlocks } from "./planning-proposals";

/** The largest card block, in characters of JSON, before it is parsed. */
export const CARD_BLOCK_MAX_CHARS = 8_000;

/** What a card is checked against: the office's stories and open questions. */
export interface CardFacts {
  /** The story `id` names: its id as the office writes it and its lifecycle; null when unknown. */
  story(id: string): { readonly id: string; readonly lifecycle: string } | null;
  /** The open question `id` names, with the story that asked it; null when none is open. */
  question(id: string): { readonly story: string } | null;
}

/** One block read from an answer: a valid card with its target and consequence, or why not. */
export type CardRead =
  | {
      readonly ok: true;
      readonly card: ChatCard;
      readonly target: string;
      readonly consequence: string;
    }
  | { readonly ok: false; readonly problems: readonly string[] };

/** The kinds a model might guess for a drop or a discard, which only a command card can carry. */
const DESTRUCTIVE_KINDS = ["drop", "discard", "delete", "remove", "archive"];

/** What a copied line may not hold: a second command, a redirect, a substitution or a newline. */
const UNSAFE_LINE = /[;|&`$<>\\\r\n]/;

/** Pure: the content of every card block in `text`, in order; an unclosed block is null. */
export function cardBlocks(text: string): (string | null)[] {
  return fencedBlocks(text, CHAT_CARD_FENCE);
}

/** The problems of a `dipo …` line a command card holds. */
export function commandLineProblems(line: string): string[] {
  if (!/^dipo [a-z]/.test(line)) return ["line: must start with `dipo ` and a command"];
  if (UNSAFE_LINE.test(line)) {
    return ["line: must be one plain command: no `;`, `|`, `&`, `$`, backtick, `<`, `>` or `\\`"];
  }
  return [];
}

/** The engine's checks of a valid card against the office's state: its problems, or its words. */
export function cardProblems(
  card: ChatCard,
  facts: CardFacts,
): { readonly problems: string[] } | { readonly target: string; readonly consequence: string } {
  switch (card.kind) {
    case "steer": {
      const story = facts.story(card.story);
      if (story === null) return { problems: [`story: this office has no story ${card.story}`] };
      if (story.lifecycle !== "In Progress") {
        return {
          problems: [
            `story: ${story.id} is ${story.lifecycle}, not running; a steer reaches only a running story${story.lifecycle === "Parked" ? " (a resume card resumes a parked story with a note)" : ""}`,
          ],
        };
      }
      return { target: story.id, consequence: "arrives at its next turn" };
    }
    case "answer": {
      const asked = facts.question(card.question);
      if (asked === null) return { problems: [`question: ${card.question} is not open`] };
      return { target: asked.story, consequence: "answers it and resumes the story" };
    }
    case "resume": {
      const story = facts.story(card.story);
      if (story === null) return { problems: [`story: this office has no story ${card.story}`] };
      if (story.lifecycle !== "Parked") {
        return {
          problems: [
            `story: ${story.id} is ${story.lifecycle}, not parked; only a parked story resumes`,
          ],
        };
      }
      return { target: story.id, consequence: "resumes it" };
    }
    case "ready": {
      const problems: string[] = [];
      const ids: string[] = [];
      for (const [index, id] of card.stories.entries()) {
        const story = facts.story(id);
        if (story === null) {
          problems.push(`stories.${index}: this office has no story ${id}`);
        } else if (story.lifecycle !== "Refined") {
          problems.push(
            `stories.${index}: ${story.id} is ${story.lifecycle}; only a Refined story goes Ready`,
          );
        } else ids.push(story.id);
      }
      if (problems.length > 0) return { problems };
      return { target: ids.join(", "), consequence: "goes through the Ready gate" };
    }
    case "command": {
      const problems = commandLineProblems(card.line);
      return problems.length > 0 ? { problems } : { target: card.line, consequence: "" };
    }
  }
}

/** Pure: a card as the model wrote it, checked: valid with its words, or its problems. */
export function checkCard(value: unknown, facts: CardFacts): CardRead {
  if (!doorKeysClean(value)) {
    return { ok: false, problems: ["a key holds characters dipo does not accept"] };
  }
  const cleaned = cleanDoorStrings(value);
  const parsed = ChatCard.safeParse(cleaned);
  if (!parsed.success) {
    const kind = (cleaned as { kind?: unknown } | null)?.kind;
    if (typeof kind === "string" && DESTRUCTIVE_KINDS.includes(kind)) {
      return {
        ok: false,
        problems: [
          `kind: a \`${kind}\` card does not exist; to drop or discard a story write a \`command\` card holding the \`dipo\` line, which the maintainer copies or opens in its prompt`,
        ],
      };
    }
    return {
      ok: false,
      problems: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "card"}: ${issue.message}`,
      ),
    };
  }
  const checked = cardProblems(parsed.data, facts);
  return "problems" in checked
    ? { ok: false, problems: checked.problems }
    : { ok: true, card: parsed.data, ...checked };
}

/** Pure: every card block of an answer, read and checked. */
export function readCards(text: string, facts: CardFacts): CardRead[] {
  return cardBlocks(text).map((block): CardRead => {
    if (block === null) return { ok: false, problems: ["the block is not closed with ```"] };
    if (block.length > CARD_BLOCK_MAX_CHARS) {
      return {
        ok: false,
        problems: [`the block has ${block.length} characters; at most ${CARD_BLOCK_MAX_CHARS}`],
      };
    }
    let value: unknown;
    try {
      value = JSON.parse(block);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return { ok: false, problems: [`the block is not one JSON object: ${cleanText(why)}`] };
    }
    return checkCard(value, facts);
  });
}

/** Pure: the message that tells the session which card blocks of its answer were refused, and why. */
export function cardRefusalMessage(refused: readonly (readonly string[])[]): string {
  const lines = refused.map(
    (problems, index) => `- block ${index + 1} of the refused ones: ${problems.join("; ")}`,
  );
  return [
    `[dipo] dipo refused ${refused.length === 1 ? "a card block" : `${refused.length} card blocks`} of your last answer, so the maintainer cannot send ${refused.length === 1 ? "it" : "them"}. A card is one \`\`\`${CHAT_CARD_FENCE} block holding one JSON object of kind steer, answer, resume, ready or command, against the stories and questions the facts of your message list:`,
    ...lines,
  ].join("\n");
}

/** The view of a card read from an answer. */
export function cardView(
  n: number,
  read: Extract<CardRead, { ok: true }>,
  at: string,
): ChatCardView {
  return { n, card: read.card, target: read.target, consequence: read.consequence, at };
}
