// The steer message of the Run (0009, DIPO-461): `s` opens the Composer at the foot of the stream,
// Enter sends `work.steer`, and the message stays in the stream as a `you` line that says when it
// arrives (`next turn`, `on resume`) or why it was not sent. The sent lines are kept per run for as
// long as the TUI runs.

import type { OfficeStoreState } from "@dipsaus-orchestrator/client";
import type { Clock } from "@dipsaus-orchestrator/contract";
import type { Key } from "ink";
import { useRef, useState } from "react";

import type { TuiActions } from "./app";
import { composerKey } from "./composer";
import { type SentSteer, steerState } from "./stream";

export interface Steering {
  /** The draft while the Composer is open, else null. */
  readonly draft: string | null;
  readonly sent: (run: string) => readonly SentSteer[];
  readonly open: () => void;
  readonly close: () => void;
  /** Takes a key while the Composer is open; true when it was the Composer's. */
  readonly onKey: (input: string, key: Key, run: string, story: string) => boolean;
}

export function useSteering(args: {
  readonly actions: TuiActions;
  readonly state: OfficeStoreState;
  readonly clock: Clock;
}): Steering {
  const { actions, state, clock } = args;
  const [draft, setDraft] = useState<string | null>(null);
  const [sent, setSent] = useState<Readonly<Record<string, readonly SentSteer[]>>>({});
  const counter = useRef(0);

  const update = (run: string, id: number, next: SentSteer["state"]) =>
    setSent((all) => ({
      ...all,
      [run]: (all[run] ?? []).map((line) => (line.id === id ? { ...line, state: next } : line)),
    }));

  const send = (run: string, story: string, text: string) => {
    if (state.office === null) return;
    const id = ++counter.current;
    const line: SentSteer = { id, at: clock.now(), text, state: { kind: "sending" } };
    setSent((all) => ({ ...all, [run]: [...(all[run] ?? []), line] }));
    actions
      .sendCommand({
        office: state.office,
        command: "work.steer",
        args: { story, text },
        requestId: actions.newRequestId(),
        confirmed: false,
      })
      .then(
        (outcome) => update(run, id, steerState(outcome)),
        (error) =>
          update(run, id, {
            kind: "failed",
            message: error instanceof Error ? error.message : String(error),
          }),
      );
  };

  return {
    draft,
    sent: (run) => sent[run] ?? [],
    open: () => setDraft(""),
    close: () => setDraft(null),
    onKey: (input, key, run, story) => {
      if (draft === null) return false;
      const event = composerKey(draft, input, key);
      if (event.kind === "cancel") setDraft(null);
      else if (event.kind === "edit") setDraft(event.draft);
      else if (event.kind === "send") {
        const text = draft.trim();
        // An empty message sends nothing and keeps the Composer open.
        if (text !== "") {
          send(run, story, text);
          setDraft(null);
        }
      }
      return true;
    },
  };
}
