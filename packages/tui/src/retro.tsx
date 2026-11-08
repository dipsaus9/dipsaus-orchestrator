// The retro room (`4`, DIPO-453, 0022): why stories parked, the fix rounds and loops, the
// cost and the time from Ready to merged per tier and type, where stories came from, the rework
// share and what the audit and the maintainer turned away. The engine counts every number from its
// database and builds the lines (`office.retro`); the TUI only reads them, scrolls them and draws
// them. The view reads again after the events that change a number. Esc goes back to home. Its footer
// keys come from the key registry (`FOOTER_KEYS`, DIPO-457).

import type { OfficeStore, OfficeStoreState } from "@dipsaus-orchestrator/client";
import type { EngineError, OfficeId } from "@dipsaus-orchestrator/contract";
import { Box, type Key, Text, useWindowSize } from "ink";
import { useEffect, useState } from "react";

import type { TuiActions } from "./app";

export interface RetroResult {
  readonly lines: readonly string[];
}

export type RetroOutcome =
  | { readonly ok: true; readonly result: RetroResult }
  | { readonly ok: false; readonly error: EngineError };

/** `office.retro` for `office`. */
export type ReadRetro = (office: OfficeId) => Promise<RetroOutcome>;

/** The events after which a retro number may have changed. */
export const RETRO_EVENTS: ReadonlySet<string> = new Set([
  "story.state",
  "story.parked",
  "story.pr",
  "run.ended",
  "idea.passed",
  "idea.answered",
]);

export interface Retro {
  readonly lines: readonly string[] | null;
  readonly error: EngineError | null;
  /** The first line shown. */
  readonly top: number;
  /** Handles a key of the retro mode. */
  onKey(input: string, key: Key): void;
}

/** The retro of the open office, read when the mode opens and after the events above. */
export function useRetro(options: {
  readonly store: OfficeStore;
  readonly actions: TuiActions;
  readonly state: OfficeStoreState;
  readonly active: boolean;
  readonly leave: () => void;
}): Retro {
  const { store, actions, state: current, active, leave } = options;
  const { office, snapshots } = current;
  const { rows } = useWindowSize();
  const height = Math.max(1, rows - 6);
  const [state, setState] = useState<{
    lines: readonly string[] | null;
    error: EngineError | null;
  }>({ lines: null, error: null });
  const [top, setTop] = useState(0);

  useEffect(() => {
    if (!active || office === null) return;
    let stopped = false;
    const read = () => {
      void actions.readRetro(office).then((outcome) => {
        if (stopped || store.state.office !== office) return;
        setState((previous) =>
          outcome.ok
            ? { lines: outcome.result.lines, error: null }
            : { lines: previous.lines, error: outcome.error },
        );
      });
    };
    read();
    const stop = store.onOfficeEvent((event) => {
      if (RETRO_EVENTS.has(event.type)) read();
    });
    return () => {
      stopped = true;
      stop();
    };
  }, [store, actions, office, active, snapshots]);

  useEffect(() => {
    if (!active) setTop(0);
  }, [active]);

  const count = state.lines?.length ?? 0;
  return {
    ...state,
    top,
    onKey: (input, key) => {
      const last = Math.max(0, count - height);
      if (key.escape) leave();
      else if (key.downArrow || input === "j") setTop((value) => Math.min(last, value + 1));
      else if (key.upArrow || input === "k") setTop((value) => Math.max(0, value - 1));
      else if (key.pageDown) setTop((value) => Math.min(last, value + height));
      else if (key.pageUp) setTop((value) => Math.max(0, value - height));
    },
  };
}

export interface RetroModeProps {
  readonly retro: Retro;
  /** Rows for the view. */
  readonly height: number;
}

/** The retro mode's body. */
export function RetroMode(props: RetroModeProps) {
  const { retro, height } = props;
  const rows = Math.max(1, height - 1);
  const shown = (retro.lines ?? []).slice(retro.top, retro.top + rows);
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">{" Retro: counted by dipo from its database"}</Text>
      {retro.lines === null ? (
        <Text wrap="truncate-end">
          {retro.error === null ? " reading…" : ` ${retro.error.code}: ${retro.error.message}`}
        </Text>
      ) : (
        shown.map((line, i) => (
          <Text key={`${retro.top + i}`} wrap="truncate-end">{` ${line}`}</Text>
        ))
      )}
    </Box>
  );
}
