// The TUI root (0009): the header with office, daemon state and connection, the mode
// that shows, and the footer with the keys that work now. The wiring only (DIPO-443): the mode
// reducer is `mode.ts`; the modes around home (the office switcher, the typed path, the privacy
// confirmation) are `modes.tsx`; home, with the overview, the queue, the desk, the checklist, the
// privacy settings and the agent detail, is `home.tsx`; the hints are `footer.ts`.
//
// Global keys (keymap.json, DIPO-458): `1` Desk, `2` Floor, `3` Queue, `4` Retro (`retro.tsx`,
// DIPO-453), `O` Offices, `P` the planning view (`planning.tsx`, DIPO-449), `q` twice within 2 s
// quits, Ctrl+C quits. Action keys are off while offline. On the daemon screens only their keys
// work: `r` restarts a stopped daemon, `l` opens its log, `c` copies the backup path. Each view's
// keys are in the header of its file (`home.tsx` holds the handlers; the key table is `keys.ts`).
//
// An action is done only when the office stream passes its reply cursor (read-your-writes). An
// error shows in the footer; a retryable one offers Ctrl-R, which sends the same request again
// with the same request id. The store's state is taken at most 10 times per second.

import type { OfficeStore, OfficeStoreState } from "@dipsaus-orchestrator/client";
import {
  type Clock,
  type Cursor,
  type EngineError,
  type OfficeId,
  type RequestId,
  type RunRecord,
  type StoryKey,
  type StoryRefValue,
  type StoryView,
  type Verdict,
} from "@dipsaus-orchestrator/contract";
import type { Key } from "ink";
import { useReducer, useState } from "react";

import {
  type ActionTarget,
  type CommandOutcome,
  type CommandRequest,
  type LossesOutcome,
  type LossesRequest,
  useActions,
} from "./actions";
import { useBatchedState } from "./batch";
import type { ReadChain, ReadGate } from "./chain";
import { type ReadDesk } from "./desk";
import { type ReadOutput, type ReadPrompt } from "./detail";
import { leavesOverlay, useHome } from "./home";
import { useKeys, useQuitKey } from "./input";
import { type ReadDigest } from "./digest";
import type { ActionId } from "./keys";
import { initialMode, modeReducer } from "./mode";
import { usePlanning } from "./planning";
import { type ReadRetro, useRetro } from "./retro";
import {
  type ModeKeys,
  onConfirmPrivacyKey,
  onPathKey,
  onSwitcherKey,
  selectedOfficeIndex,
} from "./modes";
import type { Display } from "./options";
import { Screen } from "./screen";
import { daemonScreen } from "./states";
import { glyphs, isOffline } from "./views";

export type ActionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

/** What `work.run` answered, as far as the TUI shows it. */
export interface RunResult {
  readonly started: readonly { readonly story: string; readonly run: string }[];
  readonly skipped: readonly { readonly story: string; readonly reason: string }[];
}

/** A command reply; a failure on the client side comes back as an error too. */
export type RunOutcome =
  | { readonly ok: true; readonly result: RunResult; readonly cursor?: Cursor }
  | { readonly ok: false; readonly error: EngineError };

export interface RunRequest {
  readonly office: OfficeId;
  /** Omitted: the engine picks the next Ready story. */
  readonly stories?: readonly StoryRefValue[];
  readonly requestId: RequestId;
}

/** One `office.setPrivacy`: `key` is the setting name, such as `storePrompts`. */
export interface PrivacyRequest {
  readonly office: OfficeId;
  readonly key: string;
  readonly value: boolean;
  readonly requestId: RequestId;
}

/** A story's view and runs, as `story.detail` answers (DIPO-81). */
export type StoryOutcome =
  | {
      readonly ok: true;
      readonly result: {
        readonly view: StoryView;
        readonly runs: readonly RunRecord[];
        /** The story's decided gates with their review rounds (0002). */
        readonly verdicts?: readonly Verdict[];
      };
    }
  | { readonly ok: false; readonly error: EngineError };

/** The commands the TUI sends; `run` builds them on the client session. */
export interface TuiActions {
  /** `work.outputRange` for the live agent detail (0005). */
  readOutput: ReadOutput;
  /** `work.prompt` for the prompt pane of the live agent detail (DIPO-137). */
  readPrompt: ReadPrompt;
  /** `story.detail`: the runs of a story that is not running, to open its latest (DIPO-81). */
  readStory(request: {
    readonly office: OfficeId;
    readonly story: StoryKey;
  }): Promise<StoryOutcome>;
  /** `office.open` for a path the maintainer typed. */
  openPath(path: string): Promise<ActionResult<OfficeId>>;
  /** `office.setPrivacy` for the setting the maintainer confirmed (DIPO-136). */
  setPrivacy(request: PrivacyRequest): Promise<ActionResult<null>>;
  /** `work.run` with `origin: "tui"` and the given request id (0009). */
  runStories(request: RunRequest): Promise<RunOutcome>;
  /** One command of the desk, the detail or the queue (`actions.ts`, DIPO-308). */
  sendCommand(request: CommandRequest): Promise<CommandOutcome>;
  /** `story.losses` before a discard, or a drop that deletes the branch. */
  readLosses(request: LossesRequest): Promise<LossesOutcome>;
  /** `office.desk` (DIPO-158). */
  readDesk: ReadDesk;
  /** `office.chain`: the dependency graph for the Floor and the Queue (DIPO-460). */
  readChain: ReadChain;
  /** `story.gate`: the selected Queue story's gate (DIPO-460). */
  readGate: ReadGate;
  /** `office.digest` from the time this TUI last saw the office (`digest.ts`). */
  readDigest: ReadDigest;
  /** `office.retro` (DIPO-453). */
  readRetro: ReadRetro;
  /** A fresh request id for a new action; a retry reuses the old one. */
  newRequestId(): RequestId;
  /** Puts text on the clipboard (`c`, DIPO-458). */
  copy(text: string): void;
  /** Starts the stopped daemon; resolves to why it did not start, or null (DIPO-458). */
  restartDaemon(): Promise<string | null>;
  /** Opens the daemon's log outside the TUI; resolves to why it did not open, or null. */
  openLog(): Promise<string | null>;
}

export interface AppProps {
  readonly store: OfficeStore;
  readonly clock: Clock;
  readonly display: Display;
  readonly actions: TuiActions;
  /** Called once when the maintainer quits. */
  readonly onQuit: () => void;
  /** Start in the switcher, for example when no office could be chosen. */
  readonly startInSwitcher?: boolean;
  /** Bytes an output pane keeps while it follows the tail; `OUTPUT_TAIL_BYTES` by default. */
  readonly outputTailBytes?: number;
}

/** The action prompts of the office, with the two helpers the views start actions with. */
function useAppActions(
  store: OfficeStore,
  actions: TuiActions,
  state: OfficeStoreState,
  ellipsis: string,
  setMessage: (message: string | null) => void,
) {
  const offline = isOffline(state);
  const acts = useActions({
    store,
    sendCommand: actions.sendCommand,
    readLosses: actions.readLosses,
    newRequestId: actions.newRequestId,
    offline,
    office: state.office,
    cursor: state.cursor,
    snapshots: state.snapshots,
    ellipsis,
  });
  /** Starts a key table action, or says why it is off. */
  const act = (id: ActionId, target: ActionTarget) => {
    setMessage(null);
    acts.start(id, target);
  };
  /** True, with the footer saying so, while offline: the caller sends nothing. */
  const refusedOffline = (): boolean => {
    if (offline) setMessage("offline: actions are disabled");
    return offline;
  };
  return { acts, act, refusedOffline };
}

/**
 * The keys of a daemon screen (`states.tsx`): `r` restarts a stopped daemon, `l` opens its log,
 * `c` copies the backup path; only these and quit work there.
 */
function onDaemonScreenKey(
  screen: "stopped" | "database",
  input: string,
  ctx: {
    readonly actions: TuiActions;
    readonly state: OfficeStoreState;
    readonly ellipsis: string;
    readonly setMessage: (message: string | null) => void;
  },
): void {
  const { actions, state, setMessage } = ctx;
  const report = (done: string) => (failure: string | null) => setMessage(failure ?? done);
  if (screen === "stopped" && input === "r") {
    setMessage(`starting the daemon${ctx.ellipsis}`);
    void actions.restartDaemon().then(report("daemon started; reconnecting"));
  } else if (input === "l") {
    void actions.openLog().then(report("opened the daemon log"));
  } else if (screen === "database" && input === "c" && state.database?.backup !== undefined) {
    actions.copy(state.database.backup);
    setMessage(`copied ${state.database.backup}`);
  }
}

export function App(props: AppProps) {
  const { store, clock, display, actions } = props;
  const state = useBatchedState(store, clock);
  const [mode, dispatch] = useReducer(modeReducer, props.startInSwitcher === true, initialMode);
  const [message, setMessage] = useState<string | null>(null);
  const goHome = () => dispatch({ type: "home" });
  const onQuitKey = useQuitKey(clock, props.onQuit, setMessage);
  const { ellipsis } = glyphs(display.ascii);
  const { acts, act, refusedOffline } = useAppActions(store, actions, state, ellipsis, setMessage);
  const home = useHome({
    store,
    clock,
    display,
    actions,
    state,
    ellipsis,
    acts,
    act,
    setMessage,
    refusedOffline,
    openSwitcher: () => dispatch({ type: "switcher", index: selectedOfficeIndex(state) }),
    copy: (text) => actions.copy(text),
    confirmPrivacy: (key, value) => dispatch({ type: "confirm-privacy", key, value }),
  });
  const planning = usePlanning({
    store,
    actions,
    state,
    setMessage,
    refusedOffline,
    leave: goHome,
  });
  const retro = useRetro({ store, actions, state, active: mode.kind === "retro", leave: goHome });
  const modeKeys: ModeKeys = {
    store,
    actions,
    state,
    ellipsis,
    dispatch,
    setMessage,
    refusedOffline,
    resetHome: home.reset,
    sendPrivacy: home.sendPrivacy,
  };

  /** Picks the handler of the mode. */
  const handleKey = (input: string, key: Key) => {
    if (key.ctrl && input === "c") {
      props.onQuit();
      return;
    }
    const screen = daemonScreen(state);
    if (screen !== null) {
      if (!onQuitKey(input))
        onDaemonScreenKey(screen, input, { actions, state, ellipsis, setMessage });
      return;
    }
    home.clearRefusal();
    if (state.notice !== null) store.dismissNotice();
    // An open action prompt takes every key (`actions.ts`).
    if (acts.key(input, key)) return;
    acts.setMessage(null);
    if (mode.kind === "path") onPathKey(mode, input, key, modeKeys);
    else if (mode.kind === "confirm-privacy") onConfirmPrivacyKey(mode, input, modeKeys);
    else if (mode.kind === "planning") planning.onKey(input, key);
    else if (onQuitKey(input)) return;
    else if (mode.kind === "switcher") onSwitcherKey(mode, input, key, modeKeys);
    else if (input === "P") dispatch({ type: "planning" });
    else if (input === "4") dispatch({ type: "retro" });
    else if (mode.kind === "retro" && (leavesOverlay(input) || input === "O")) {
      // A room key or Offices leaves the retro room for it.
      goHome();
      home.onKey(input, key);
    } else if (mode.kind === "retro") retro.onKey(input, key);
    else home.onKey(input, key);
  };

  useKeys(mode.kind === "path" || mode.kind === "planning" || acts.typing, handleKey);

  return (
    <Screen
      mode={mode}
      state={state}
      clock={clock}
      display={display}
      home={home}
      acts={acts}
      planning={planning}
      retro={retro}
      message={message}
      {...(props.outputTailBytes === undefined ? {} : { outputTailBytes: props.outputTailBytes })}
    />
  );
}
