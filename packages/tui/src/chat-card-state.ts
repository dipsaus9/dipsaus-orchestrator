// The state of the chat's cards in the TUI (DIPO-525): which card was sent and how far its command
// got, which the maintainer dropped from view and which they edited. It is kept per planning
// session, so a card of another thread never shows another's result. Sending is the maintainer's
// key: `send` is called by `c` and nothing else calls it.

import type { OfficeStoreState } from "@dipsaus-orchestrator/client";
import type { ChatCardView, Clock } from "@dipsaus-orchestrator/contract";
import { useEffect, useState } from "react";

import type { CommandOutcome, CommandRequest } from "./actions";
import {
  type CardSend,
  cardRequest,
  deliveredWords,
  dropTarget,
  resumeNoteRequest,
  retryKind,
} from "./chat-cards";
import { clockTime } from "./views";

/** What the cards need of the app around them. */
export interface ChatCardArgs {
  readonly state: Pick<OfficeStoreState, "planning" | "office">;
  readonly actions: {
    readonly sendCommand: (request: CommandRequest) => Promise<CommandOutcome>;
    readonly newRequestId: () => CommandRequest["requestId"];
    readonly copy: (text: string) => void;
  };
  readonly clock: Clock;
  /** Opens the existing drop or discard prompt for a story; false when it cannot start. */
  readonly startPrompt: (action: "drop" | "discard", story: string) => boolean;
  readonly setMessage: (message: string | null) => void;
  /** True, with the footer saying so, while offline: nothing is sent. */
  readonly refusedOffline: () => boolean;
}

export interface ChatCards {
  /** The cards of the thread the maintainer has not dropped from view, in order. */
  readonly views: readonly ChatCardView[];
  readonly sends: ReadonlyMap<number, CardSend>;
  readonly edited: ReadonlyMap<number, string>;
  /** The cards that wait for `c`: none sent yet, none failed. */
  readonly open: readonly ChatCardView[];
  /** `c`: sends the card's command, or copies a command card's line. */
  send(n: number): void;
  /** `x`: takes the card out of the view; nothing is sent. */
  hide(n: number): void;
  /** `X` or `D` on a command card that names a story: the existing prompt opens. */
  startPrompt(n: number, action: "drop" | "discard"): void;
  /** `e` saved: the text the card sends from now on. */
  edit(n: number, text: string): void;
  /** `^R`: sends the latest failed card again; false when none failed. */
  retry(): boolean;
}

interface Kept {
  readonly session: string | null;
  readonly sends: ReadonlyMap<number, CardSend>;
  readonly edited: ReadonlyMap<number, string>;
  readonly hidden: readonly number[];
}

const empty = (session: string | null): Kept => ({
  session,
  sends: new Map(),
  edited: new Map(),
  hidden: [],
});

/** The state of the cards of the open planning session. */
export function useChatCards(planning: ChatCardArgs): ChatCards {
  const { state, actions } = planning;
  const args = { ...planning, office: state.office };
  const view = state.planning;
  const session = view === null ? null : (view.session ?? view.run);
  const [kept, setKept] = useState<Kept>(() => empty(session));
  // Another session or office starts over.
  useEffect(() => {
    setKept((was) => (was.session === session ? was : empty(session)));
  }, [session, args.office]);
  const current = kept.session === session ? kept : empty(session);

  const views = (view?.cards ?? []).filter((card) => !current.hidden.includes(card.n));
  const open = views.filter((card) => !current.sends.has(card.n));
  const card = (n: number) => views.find((candidate) => candidate.n === n);

  /** Changes what is kept for this session; another session's is dropped first. */
  const update = (change: (base: Kept) => Partial<Kept>) =>
    setKept((was) => {
      const base = was.session === session ? was : empty(session);
      return { ...base, ...change(base) };
    });
  const setSend = (n: number, sent: CardSend) =>
    update((base) => ({ sends: new Map(base.sends).set(n, sent) }));

  const dispatch = (n: number, request: CommandRequest) => {
    const found = card(n);
    if (found === undefined) return;
    setSend(n, { status: "sending", request });
    void actions.sendCommand(request).then((outcome) => {
      const at = clockTime(args.clock.now());
      setSend(
        n,
        outcome.ok
          ? { status: "sent", request, at, words: deliveredWords(found.card, outcome.result) }
          : { status: "failed", request, error: outcome.error, at },
      );
    });
  };

  return {
    views,
    sends: current.sends,
    edited: current.edited,
    open,
    send: (n) => {
      const found = card(n);
      if (found === undefined || args.office === null) return;
      if (found.card.kind === "command") {
        actions.copy(found.card.line);
        args.setMessage(`copied: ${found.card.line}`);
        return;
      }
      if (args.refusedOffline()) return;
      const request = cardRequest(
        found.card,
        args.office,
        actions.newRequestId(),
        current.edited.get(n),
      );
      if (request !== null) dispatch(n, request);
    },
    hide: (n) => update((base) => ({ hidden: [...base.hidden, n] })),
    startPrompt: (n, action) => {
      const found = card(n);
      const target = found === undefined ? null : dropTarget(found.card);
      if (target === null || target.action !== action) {
        args.setMessage(`this card holds no dipo ${action} line`);
        return;
      }
      if (args.refusedOffline()) return;
      args.startPrompt(action, target.story);
    },
    edit: (n, text) => update((base) => ({ edited: new Map(base.edited).set(n, text) })),
    retry: () => {
      const failed = [...current.sends.entries()].filter(([, sent]) => sent.status === "failed");
      const latest = failed.at(-1);
      if (latest === undefined) return false;
      const [n, sent] = latest;
      const found = card(n);
      if (found === undefined) return false;
      const how = retryKind(found.card, sent);
      if (how === null) {
        args.setMessage("this card cannot be sent again");
        return true;
      }
      if (args.refusedOffline()) return true;
      const request =
        how === "same"
          ? sent.request
          : resumeNoteRequest(found.card, sent, actions.newRequestId(), current.edited.get(n));
      if (request !== null) dispatch(n, request);
      return true;
    },
  };
}
