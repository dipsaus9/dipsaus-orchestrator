// The palette and the keys overlay in the app (0009, DIPO-463): the keys that open them, the keys
// they take, what a chosen row does, and the view of each over the body. The rows are
// `palette.tsx`'s and the keys overlay's `help.tsx`; both read the key registry.

import type { OfficeStoreState } from "@dipsaus-orchestrator/client";
import { Box, type Key } from "ink";
import type { Dispatch, ReactNode } from "react";

import { Shaded } from "./colour";
import { Help } from "./help";
import type { Home } from "./home";
import { binding, NAV_KEYS } from "./keys";
import type { Mode, ModeAction } from "./mode";
import { selectedOfficeIndex } from "./modes";
import type { Display } from "./options";
import {
  filterRows,
  NO_FOCUS,
  Palette,
  type PaletteRow,
  paletteRows,
  type PaletteFocus,
} from "./palette";
import { isOffline } from "./views";

export interface OverlayArgs {
  readonly state: OfficeStoreState;
  readonly home: Home;
  readonly dispatch: Dispatch<ModeAction>;
  readonly setMessage: (message: string | null) => void;
}

type PaletteMode = Extract<Mode, { kind: "palette" }>;

/** The item the overlays are about: home's focus, none over the retro room. */
function focusOf(home: Home, back: "home" | "retro"): PaletteFocus {
  return back === "home" ? home.paletteFocus() : NO_FOCUS;
}

/** The keys of the palette and the keys overlay, and what a row of the palette does. */
export function useOverlays(args: OverlayArgs) {
  const { state, home, dispatch, setMessage } = args;

  /** Runs a row of the palette, or says why it cannot run. */
  const runRow = (mode: PaletteMode, row: PaletteRow) => {
    if (row.disabled !== null) {
      setMessage(`${row.label}: ${row.disabled}`);
      return;
    }
    setMessage(null);
    dispatch({ type: "close-overlay" });
    const run = row.run;
    if (run.kind === "settings") {
      dispatch({ type: "home" });
      home.openSettings();
    } else if (run.kind === "go") {
      if (run.to === "retro" || run.to === "planning") {
        dispatch({ type: "home" });
        dispatch({ type: run.to });
      } else if (run.to === "offices") {
        dispatch({ type: "switcher", index: selectedOfficeIndex(state) });
      } else {
        dispatch({ type: "home" });
        home.pressKey(NAV_KEYS.find((nav) => nav.id === run.to)?.key ?? "1");
      }
    } else if (run.id === "stop") {
      const story = home.paletteFocus().story;
      if (story !== null) home.stopRun(story);
    } else if (mode.back === "home") {
      home.pressKey(binding(run.id).key);
    }
  };

  /** The palette takes every key; Enter runs the selected row. */
  const onPaletteKey = (mode: PaletteMode, input: string, key: Key) => {
    const shown = filterRows(paletteRows(focusOf(home, mode.back), isOffline(state)), mode.query);
    if (key.escape) dispatch({ type: "close-overlay" });
    else if (key.return) {
      const chosen = shown[Math.min(mode.index, shown.length - 1)];
      if (chosen !== undefined) runRow(mode, chosen.row);
    } else if (key.downArrow || (key.ctrl && input === "n")) {
      dispatch({ type: "move", delta: 1, count: shown.length });
    } else if (key.upArrow || (key.ctrl && input === "p")) {
      dispatch({ type: "move", delta: -1, count: shown.length });
    } else if (key.backspace || key.delete) dispatch({ type: "erase" });
    else if (!key.ctrl && !key.meta && input !== "") dispatch({ type: "type", input });
  };

  /** The keys overlay: Esc closes it, typing filters it and Enter carries the text to the palette. */
  const onHelpKey = (input: string, key: Key) => {
    if (key.escape) dispatch({ type: "close-overlay" });
    else if (key.return) dispatch({ type: "help-to-palette" });
    else if (key.backspace || key.delete) dispatch({ type: "erase" });
    else if (!key.ctrl && !key.meta && input !== "") dispatch({ type: "type", input });
  };

  return {
    /** True when the key was an overlay's: it opened one, or one is open and took it. */
    onKey(mode: Mode, input: string, key: Key): boolean {
      if (mode.kind === "palette") onPaletteKey(mode, input, key);
      else if (mode.kind === "help") onHelpKey(input, key);
      else if (mode.kind !== "home" && mode.kind !== "retro") return false;
      else if (input === ":" || (key.ctrl && input === "k")) {
        dispatch({ type: "palette", back: mode.kind });
      } else if (input === "?") dispatch({ type: "help", back: mode.kind });
      else return false;
      return true;
    },
  };
}

/** The overlay of the mode over the body; none in any other mode. */
export function OverlayMode(props: {
  readonly mode: Mode;
  readonly home: Home;
  readonly state: OfficeStoreState;
  readonly display: Display;
  readonly columns: number;
}) {
  const { mode, display, columns } = props;
  if (mode.kind !== "palette" && mode.kind !== "help") return null;
  const focus = focusOf(props.home, mode.back);
  const offline = isOffline(props.state);
  if (mode.kind === "help") {
    return (
      <Help
        display={display}
        columns={columns}
        focus={focus}
        offline={offline}
        query={mode.query}
      />
    );
  }
  return (
    <Palette
      display={display}
      columns={columns}
      shown={filterRows(paletteRows(focus, offline), mode.query)}
      query={mode.query}
      index={mode.index}
      focus={focus}
    />
  );
}

/** The palette or the keys over the body they opened on, which waits behind them in shade (S5, S9). */
export function OverlayOver(props: {
  readonly mode: Mode;
  readonly home: Home;
  readonly state: OfficeStoreState;
  readonly display: Display;
  readonly columns: number;
  readonly height: number;
  readonly behind: { readonly home: ReactNode; readonly retro: ReactNode };
}) {
  const { mode, display } = props;
  if (mode.kind !== "palette" && mode.kind !== "help") return null;
  return (
    <Box flexDirection="column" height={props.height} overflow="hidden">
      <Shaded display={display}>
        {mode.back === "retro" ? props.behind.retro : props.behind.home}
      </Shaded>
      <Box position="absolute" flexDirection="column" width="100%">
        <OverlayMode
          mode={mode}
          home={props.home}
          state={props.state}
          display={display}
          columns={props.columns}
        />
      </Box>
    </Box>
  );
}
