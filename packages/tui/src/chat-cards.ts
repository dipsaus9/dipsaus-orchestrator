// The chat's action cards in the TUI (DIPO-525, P4 of the chat design, pure). An answer of dipo may
// carry steer, answer, resume, ready and command cards, which the engine checked against the
// office's state (`PlanningView.cards`). A focused card shows its keys; `c` sends the matching
// command as the maintainer's own, with origin `chat`, and the card turns into one line in place:
// pending, sent or failed, the failed one with `^R` to try again. A command card holds a `dipo`
// line: its `c` copies it, `X` and `D` open the existing drop and discard prompts for the story it
// names, so a drop or a discard is never sent from a card.

import type { CommandRequest } from "./actions";
import type {
  ChatCard,
  ChatCardView,
  EngineError,
  OfficeId,
  RequestId,
} from "@dipsaus-orchestrator/contract";

import { wrapSpans } from "./markdown";
import type { Span } from "./spans";
import { glyphs } from "./views";

/** How far a card's command got. `sent` carries what the reply said, as words. */
export type CardSend =
  | { readonly status: "sending"; readonly request: CommandRequest }
  | {
      readonly status: "sent";
      readonly request: CommandRequest;
      /** The time of the reply, as the clock shows it (`11:03`). */
      readonly at: string;
      readonly words: string;
    }
  | {
      readonly status: "failed";
      readonly request: CommandRequest;
      readonly error: EngineError;
      /** The time of the failure, as the clock shows it. */
      readonly at: string;
    };

/** The commands a card sends, by kind; a `command` card sends none. */
const COMMANDS = {
  steer: "work.steer",
  answer: "work.answer",
  resume: "work.resume",
  ready: "story.ready",
} as const;

/** The card's text as the maintainer has edited it, or the card's own. */
export function cardText(card: ChatCard, edited?: string): string {
  if (edited !== undefined) return edited;
  switch (card.kind) {
    case "steer":
    case "answer":
      return card.text;
    case "resume":
      return card.note ?? "resumes the story with no note";
    case "ready":
      return "Each one that passes the Ready gate goes into a backlog PR; the others stay Refined.";
    case "command":
      return card.effect;
  }
}

/** The command a card sends with `c`, as the maintainer's own (origin `chat`); null for a command card. */
export function cardRequest(
  card: ChatCard,
  office: OfficeId,
  requestId: RequestId,
  edited?: string,
): CommandRequest | null {
  const base = { office, requestId, confirmed: false, origin: "chat" } as const;
  switch (card.kind) {
    case "steer":
      return {
        ...base,
        command: COMMANDS.steer,
        args: { story: card.story, text: edited ?? card.text },
      };
    case "answer":
      return {
        ...base,
        command: COMMANDS.answer,
        args: { question: card.question, text: edited ?? card.text },
      };
    case "resume": {
      const note = edited ?? card.note;
      return {
        ...base,
        command: COMMANDS.resume,
        args: { story: card.story, ...(note === undefined ? {} : { note }) },
      };
    }
    case "ready":
      return { ...base, command: COMMANDS.ready, args: { stories: card.stories } };
    case "command":
      return null;
  }
}

/** A steer that failed because its story no longer runs: the text goes on as a resume note. */
export const NOT_RUNNING_CODES: readonly string[] = ["story.notRunning", "story.notSteerable"];

/** The resume that carries a failed steer's text as its note; null when the card is not such a steer. */
export function resumeNoteRequest(
  card: ChatCard,
  send: CardSend,
  requestId: RequestId,
  edited?: string,
): CommandRequest | null {
  if (card.kind !== "steer" || send.status !== "failed") return null;
  if (!NOT_RUNNING_CODES.includes(send.error.code)) return null;
  return {
    office: send.request.office,
    command: COMMANDS.resume,
    args: { story: card.story, note: edited ?? card.text },
    requestId,
    confirmed: false,
    origin: "chat",
  };
}

/** What `^R` does for a failed card: a resume note, the same request again, or nothing. */
export function retryKind(card: ChatCard, send: CardSend | undefined): "resume" | "same" | null {
  if (send?.status !== "failed") return null;
  if (card.kind === "steer" && NOT_RUNNING_CODES.includes(send.error.code)) return "resume";
  return send.error.retryable ? "same" : null;
}

/** The story a command card's `dipo drop` or `dipo discard` line names, and which of the two. */
export function dropTarget(
  card: ChatCard,
): { readonly action: "drop" | "discard"; readonly story: string } | null {
  if (card.kind !== "command") return null;
  const match = /^dipo (drop|discard) ([A-Za-z][A-Za-z0-9]*-[0-9]+)(?: |$)/.exec(card.line);
  return match === null
    ? null
    : { action: match[1] as "drop" | "discard", story: (match[2] as string).toUpperCase() };
}

/** The verb a card's lines call it by. */
const verbOf = (card: ChatCard): string => card.kind;

/** What the reply of the card's command says, as words after the story. */
export function deliveredWords(card: ChatCard, result: unknown): string {
  const reply = (result ?? {}) as { delivered?: unknown; queued?: unknown; refused?: unknown };
  switch (card.kind) {
    case "steer":
      return reply.delivered === "on-resume" ? "delivered when it resumes" : "delivered next turn";
    case "answer":
      return "answered";
    case "resume":
      return reply.queued === true ? "queued to resume" : "resumed";
    case "ready": {
      const refused = Array.isArray(reply.refused) ? reply.refused.length : 0;
      return refused === 0 ? "set Ready" : `${refused} refused by the Ready gate`;
    }
    case "command":
      return "copied";
  }
}

/** Where a card's one line says it is aimed: its target, as the engine worked it out. */
const aimOf = (view: ChatCardView): string => view.target;

/**
 * The one line a card shows once `c` sent it (07-states, C5): `◌ steer · DIPO-512 · sending…`, then
 * `✓ sent 11:03 · steer · DIPO-512 · delivered next turn` or `✗ steer not sent: <why> · ^R retry`.
 */
export function sendLine(view: ChatCardView, send: CardSend, ascii: boolean): Span[] {
  const { dot, ellipsis, met, failed, pending } = glyphs(ascii);
  const verb = verbOf(view.card);
  const aim = aimOf(view);
  switch (send.status) {
    case "sending":
      return [
        { text: pending, role: "acc" },
        { text: ` ${verb} ${dot} ${aim} ${dot} sending${ellipsis}`, role: "dim" },
      ];
    case "sent":
      return [
        {
          text: `${met} sent ${send.at} ${dot} ${verb} ${dot} ${aim} ${dot} ${send.words}`,
          role: "ok",
        },
      ];
    case "failed": {
      const again = retryKind(view.card, send);
      return [
        { text: failed, role: "err" },
        { text: ` ${verb} not sent: ${send.error.message}`, role: "err" },
        ...(again === null
          ? []
          : [
              { text: ` ${dot} `, role: "dim" as const },
              { text: "^R", role: "acc" as const },
              {
                text: again === "resume" ? " retry as a resume note" : " retry",
                role: "dim" as const,
              },
            ]),
      ];
    }
  }
}

/** The keys a focused card shows, as its last line. */
function keysLine(card: ChatCard): string {
  if (card.kind !== "command") return "c send   e edit   x drop   esc to the input";
  return dropTarget(card) === null
    ? "c copy   x drop   esc to the input"
    : `c copy   ${dropTarget(card)?.action === "drop" ? "X drop here" : "D discard here"} (asks first)   esc to the input`;
}

/** What a card's text is cut to before it wraps: the rows of one card show no more. */
const CARD_TEXT_ROWS = 6;

/**
 * The rows of a card, `width` cells wide after a gutter of `gutter` cells: a head `◆ steer · DIPO-512 ·
 * arrives at its next turn`, its text dim and indented, and while it has focus the bar, the focus
 * background and its keys. A card that was sent shows `sendLine` alone. In the conversation the focus
 * background covers the gutter of every row but the head's (`gutterInside`, 07-plan.txt); beside
 * a room it starts after the gutter (05-run-with-dock-wide.txt).
 */
export function cardRows(
  view: ChatCardView,
  options: {
    readonly focused: boolean;
    readonly width: number;
    readonly gutter: number;
    readonly gutterInside: boolean;
    readonly ascii: boolean;
    readonly send?: CardSend | undefined;
    readonly edited?: string | undefined;
  },
): Span[][] {
  const { focused, width, ascii } = options;
  const { dot, bar, ellipsis } = glyphs(ascii);
  const gutter = (row: Span[], index: number): Span[] => [
    {
      text: " ".repeat(options.gutter),
      role: "dim",
      sel: focused && options.gutterInside && index > 0,
    },
    ...row,
  ];
  if (options.send !== undefined) return [gutter(sendLine(view, options.send, ascii), 0)];
  const mark = ascii ? "#" : "◆";
  const aim = [
    verbOf(view.card),
    aimOf(view),
    ...(view.consequence === "" ? [] : [view.consequence]),
  ];
  const head: Span[] = [
    { text: focused ? bar : " ", role: "acc", sel: focused },
    {
      text: ` ${mark} ${aim.join(` ${dot} `)}`,
      role: focused ? "hi" : "fg",
      bold: focused,
      sel: focused,
    },
  ];
  const text = wrapSpans(
    [{ text: cardText(view.card, options.edited).replace(/\s+/g, " ").trim() }],
    Math.max(10, width - 4),
  )
    .slice(0, CARD_TEXT_ROWS)
    .map((row, i, all): Span[] => {
      const spans = row.map((span) => ({ ...span, role: "dim" as const, sel: focused }));
      if (i === all.length - 1 && all.length === CARD_TEXT_ROWS) {
        const last = spans.at(-1);
        if (last !== undefined)
          spans[spans.length - 1] = { ...last, text: `${last.text}${ellipsis}` };
      }
      return [{ text: "    ", role: "dim", sel: focused }, ...spans];
    });
  const rows = [head, ...text];
  if (focused) {
    rows.push([{ text: `    ${keysLine(view.card)}`, role: "acc", sel: true }]);
  }
  return rows.map(gutter);
}
