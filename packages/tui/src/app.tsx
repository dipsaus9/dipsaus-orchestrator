// The TUI root (0009 sections 4, 6, 7 and 9): the header with office, daemon state and
// connection, the banners, the office body or the office switcher, and the footer with the keys
// that work now. Global keys: `o` offices, `q` twice within 2 s quits, Ctrl+C quits. In the
// switcher: `j`/`k` or arrows move, Enter opens the office through `office.switch`, `n` opens a
// new repository path through `office.open`, Esc goes back. Action keys are off while offline.

import type { OfficeStore, OfficeStoreState } from "@dipsaus-orchestrator/client";
import type { Clock, OfficeId } from "@dipsaus-orchestrator/contract";
import { Box, Text, useInput, useWindowSize } from "ink";
import { useState, useSyncExternalStore } from "react";

import type { Display } from "./options";
import {
  Banners,
  Footer,
  glyphs,
  Header,
  isOffline,
  NARROW_COLUMNS,
  NARROW_ROWS,
  NarrowBody,
  OfficeBody,
  SwitcherBody,
} from "./views";

/** A second `q` within this window quits (0009 section 6). */
export const QUIT_WINDOW_MS = 2_000;

export type ActionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

/** The commands the TUI sends; `run` builds them on the client session. */
export interface TuiActions {
  /** `office.open` for a path the maintainer typed. */
  openPath(path: string): Promise<ActionResult<OfficeId>>;
  /** `daemon.resumeScheduling`, after the maintainer agreed. */
  resumeScheduling(): Promise<ActionResult<null>>;
}

type Mode =
  | { readonly kind: "home" }
  | { readonly kind: "switcher"; readonly index: number }
  | { readonly kind: "path"; readonly index: number; readonly text: string }
  | { readonly kind: "confirm-resume" };

export interface AppProps {
  readonly store: OfficeStore;
  readonly clock: Clock;
  readonly display: Display;
  readonly actions: TuiActions;
  /** Called once when the maintainer quits. */
  readonly onQuit: () => void;
  /** Start in the switcher, for example when no office could be chosen. */
  readonly startInSwitcher?: boolean;
}

function useStoreState(store: OfficeStore): OfficeStoreState {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.state,
  );
}

function selectedIndex(state: OfficeStoreState): number {
  const index = state.offices.findIndex((entry) => entry.office === state.office);
  return index === -1 ? 0 : index;
}

export function App(props: AppProps) {
  const { store, clock, display, actions } = props;
  const state = useStoreState(store);
  const { columns, rows } = useWindowSize();
  const [mode, setMode] = useState<Mode>(
    props.startInSwitcher === true ? { kind: "switcher", index: 0 } : { kind: "home" },
  );
  const [message, setMessage] = useState<string | null>(null);
  const [quitArmedAt, setQuitArmedAt] = useState<number | null>(null);
  const offline = isOffline(state);
  const { ellipsis } = glyphs(display.ascii);

  const quit = () => props.onQuit();

  const switchTo = (office: OfficeId, name: string) => {
    setMessage(`opening ${name}${ellipsis}`);
    void store.switchTo(office).then((outcome) => {
      if (outcome.ok) {
        setMessage(null);
        setMode({ kind: "home" });
      } else {
        setMessage(`${outcome.error.code}: ${outcome.error.message}`);
      }
    });
  };

  const openPath = (path: string, index: number) => {
    setMessage(`opening ${path}${ellipsis}`);
    void actions.openPath(path).then((outcome) => {
      if (!outcome.ok) {
        setMessage(outcome.message);
        setMode({ kind: "switcher", index });
        return;
      }
      switchTo(outcome.value, path);
    });
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      quit();
      return;
    }
    if (state.notice !== null) store.dismissNotice();

    if (mode.kind === "path") {
      if (key.escape) {
        setMode({ kind: "switcher", index: mode.index });
        setMessage(null);
      } else if (key.return) {
        const path = mode.text.trim();
        if (path === "") return;
        if (offline) {
          setMessage("offline: actions are disabled");
          return;
        }
        openPath(path, mode.index);
      } else if (key.backspace || key.delete) {
        setMode({ ...mode, text: mode.text.slice(0, -1) });
      } else if (!key.ctrl && !key.meta && input !== "") {
        setMode({ ...mode, text: mode.text + input });
      }
      return;
    }

    if (mode.kind === "confirm-resume") {
      setMode({ kind: "home" });
      if (input !== "y" && input !== "Y") {
        setMessage("scheduling stays off");
        return;
      }
      setMessage(`resuming scheduling${ellipsis}`);
      void actions.resumeScheduling().then((outcome) => {
        setMessage(outcome.ok ? "scheduling resumed" : outcome.message);
      });
      return;
    }

    if (input === "q") {
      const now = clock.now();
      if (quitArmedAt !== null && now - quitArmedAt <= QUIT_WINDOW_MS) {
        quit();
        return;
      }
      setQuitArmedAt(now);
      setMessage("press q again to quit");
      return;
    }
    if (quitArmedAt !== null) {
      setQuitArmedAt(null);
      setMessage(null);
    }

    if (mode.kind === "switcher") {
      const count = state.offices.length;
      if (key.escape) {
        if (state.office !== null) setMode({ kind: "home" });
      } else if (key.downArrow || input === "j") {
        setMode({ kind: "switcher", index: Math.min(Math.max(0, count - 1), mode.index + 1) });
      } else if (key.upArrow || input === "k") {
        setMode({ kind: "switcher", index: Math.max(0, mode.index - 1) });
      } else if (key.return) {
        const entry = state.offices[mode.index];
        if (entry === undefined) return;
        if (offline) {
          setMessage("offline: actions are disabled");
          return;
        }
        switchTo(entry.office, entry.name);
      } else if (input === "n") {
        if (offline) {
          setMessage("offline: actions are disabled");
          return;
        }
        setMessage(null);
        setMode({ kind: "path", index: mode.index, text: "" });
      }
      return;
    }

    // Home.
    if (input === "o") {
      setMessage(null);
      setMode({ kind: "switcher", index: selectedIndex(state) });
    } else if (input === "S" && state.daemon === "safe") {
      if (offline) {
        setMessage("offline: actions are disabled");
        return;
      }
      setMode({ kind: "confirm-resume" });
    }
  });

  const narrow = columns < NARROW_COLUMNS || rows < NARROW_ROWS;
  const inSwitcher = mode.kind === "switcher" || mode.kind === "path";
  const switcherIndex = mode.kind === "switcher" || mode.kind === "path" ? mode.index : 0;
  const notice = state.notice;
  const footerMessage = message ?? notice;
  const keys = footerKeys(mode, state, offline);

  if (narrow) {
    return (
      <Box flexDirection="column">
        <NarrowBody
          state={state}
          display={display}
          switcher={inSwitcher ? { index: switcherIndex } : null}
        />
        {footerMessage === null ? null : <Text wrap="truncate-end">{footerMessage}</Text>}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header state={state} display={display} />
      <Banners state={state} display={display} />
      {inSwitcher ? (
        <SwitcherBody state={state} display={display} index={switcherIndex} now={clock.now()} />
      ) : (
        <OfficeBody state={state} display={display} />
      )}
      {mode.kind === "path" ? <Text>{` open repository path: ${mode.text}_`}</Text> : null}
      {mode.kind === "confirm-resume" ? <Text>{" Resume scheduling? [y/N]"}</Text> : null}
      <Footer keys={keys} message={footerMessage} display={display} />
    </Box>
  );
}

function footerKeys(mode: Mode, state: OfficeStoreState, offline: boolean): string {
  const off = offline ? " (offline: actions disabled)" : "";
  switch (mode.kind) {
    case "path":
      return "[Enter] open  [Esc] cancel";
    case "confirm-resume":
      return "[y] resume scheduling  [any other key] cancel";
    case "switcher":
      return `[Enter] open  [n] open new repo path  [j/k] move${state.office === null ? "" : "  [Esc] back"}  [q] quit${off}`;
    default:
      return `[o] offices${state.daemon === "safe" ? "  [S] resume scheduling" : ""}  [q] quit${off}`;
  }
}
