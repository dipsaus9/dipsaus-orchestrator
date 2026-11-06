// The modes around home (0009, DIPO-443): the office switcher, the typed repository path and the
// privacy confirmation. Each has its key handler and its component; `ModeScreen` draws the one
// that shows, with home's body behind the privacy question.

import type { OfficeStore, OfficeStoreState } from "@dipsaus-orchestrator/client";
import type { Clock, OfficeId } from "@dipsaus-orchestrator/contract";
import { Text, type Key } from "ink";
import type { Dispatch, ReactNode } from "react";

import type { TuiActions } from "./app";
import type { Mode, ModeAction } from "./mode";
import type { Display } from "./options";
import { confirmPrompt, settingName } from "./settings";
import { SwitcherBody } from "./views";

/** The row of the switcher the open office is on. */
export function selectedOfficeIndex(state: OfficeStoreState): number {
  const index = state.offices.findIndex((entry) => entry.office === state.office);
  return index === -1 ? 0 : index;
}

/** What the keys of the modes need from the app around them. */
export interface ModeKeys {
  readonly store: OfficeStore;
  readonly actions: TuiActions;
  readonly state: OfficeStoreState;
  readonly ellipsis: string;
  readonly dispatch: Dispatch<ModeAction>;
  readonly setMessage: (message: string | null) => void;
  /** True, with the footer saying so, while offline: the caller sends nothing. */
  readonly refusedOffline: () => boolean;
  /** The maintainer switched office: home forgets what it had selected. */
  readonly resetHome: () => void;
  /** `office.setPrivacy` for a confirmed setting. */
  readonly sendPrivacy: (key: string, value: boolean) => void;
}

function switchTo(ctx: ModeKeys, office: OfficeId, name: string) {
  ctx.setMessage(`opening ${name}${ctx.ellipsis}`);
  void ctx.store.switchTo(office).then((outcome) => {
    if (outcome.ok) {
      ctx.setMessage(null);
      ctx.dispatch({ type: "home" });
      ctx.resetHome();
    } else {
      ctx.setMessage(`${outcome.error.code}: ${outcome.error.message}`);
    }
  });
}

function openPath(ctx: ModeKeys, path: string, index: number) {
  ctx.setMessage(`opening ${path}${ctx.ellipsis}`);
  void ctx.actions.openPath(path).then((outcome) => {
    if (!outcome.ok) {
      ctx.setMessage(outcome.message);
      ctx.dispatch({ type: "switcher", index });
      return;
    }
    switchTo(ctx, outcome.value, path);
  });
}

export function onPathKey(
  current: Extract<Mode, { kind: "path" }>,
  input: string,
  key: Key,
  ctx: ModeKeys,
) {
  if (key.escape) {
    ctx.dispatch({ type: "switcher", index: current.index });
    ctx.setMessage(null);
  } else if (key.return) {
    const path = current.text.trim();
    if (path === "" || ctx.refusedOffline()) return;
    openPath(ctx, path, current.index);
  } else if (key.backspace || key.delete) {
    ctx.dispatch({ type: "erase" });
  } else if (!key.ctrl && !key.meta && input !== "") {
    ctx.dispatch({ type: "type", input });
  }
}

export function onConfirmPrivacyKey(
  current: Extract<Mode, { kind: "confirm-privacy" }>,
  input: string,
  ctx: ModeKeys,
) {
  ctx.dispatch({ type: "home" });
  if (input !== "y" && input !== "Y") {
    ctx.setMessage(`${settingName(current.key)} stays as it was`);
    return;
  }
  if (ctx.refusedOffline()) return;
  ctx.sendPrivacy(current.key, current.value);
}

export function onSwitcherKey(
  current: Extract<Mode, { kind: "switcher" }>,
  input: string,
  key: Key,
  ctx: ModeKeys,
) {
  if (key.escape) {
    if (ctx.state.office !== null) ctx.dispatch({ type: "home" });
  } else if (key.downArrow || input === "j") {
    ctx.dispatch({ type: "move", delta: 1, count: ctx.state.offices.length });
  } else if (key.upArrow || input === "k") {
    ctx.dispatch({ type: "move", delta: -1, count: ctx.state.offices.length });
  } else if (key.return) {
    const entry = ctx.state.offices[current.index];
    if (entry === undefined || ctx.refusedOffline()) return;
    switchTo(ctx, entry.office, entry.name);
  } else if (input === "n") {
    if (ctx.refusedOffline()) return;
    ctx.setMessage(null);
    ctx.dispatch({ type: "enter-path" });
  }
}

/** The lines under a body (a run, a desk row's actions, an open action prompt). */
function Panel(props: { readonly lines: readonly string[] }) {
  return props.lines.map((line, i) => <Text key={i} wrap="truncate-end">{` ${line}`}</Text>);
}

interface ScreenProps {
  readonly state: OfficeStoreState;
  readonly display: Display;
  readonly clock: Clock;
  readonly columns: number;
}

/** The switcher: the offices, and the typed path under them in the path mode. */
function SwitcherMode(props: ScreenProps & { readonly index: number; readonly path?: string }) {
  return (
    <>
      <SwitcherBody
        state={props.state}
        display={props.display}
        index={props.index}
        now={props.clock.now()}
        columns={props.columns}
      />
      {props.path === undefined ? null : <Text>{` open repository path: ${props.path}_`}</Text>}
    </>
  );
}

/** The question before a privacy change, under the panel. */
function ConfirmPrivacyMode(props: {
  readonly mode: Extract<Mode, { kind: "confirm-privacy" }>;
  readonly home: ReactNode;
  readonly panel: readonly string[];
}) {
  return (
    <>
      {props.home}
      <Panel lines={props.panel} />
      <Text>{` ${confirmPrompt(props.mode.key, props.mode.value)} [y/N]`}</Text>
    </>
  );
}

export interface ModeScreenProps extends ScreenProps {
  readonly mode: Mode;
  /** What home shows: its view, or the detail. */
  readonly home: ReactNode;
  /** Home's lines under its body; the switcher has none. */
  readonly panel: readonly string[];
}

/** The body of the mode, then the lines and prompt under it. */
export function ModeScreen(props: ModeScreenProps) {
  const { mode } = props;
  switch (mode.kind) {
    case "switcher":
      return <SwitcherMode {...props} index={mode.index} />;
    case "path":
      return <SwitcherMode {...props} index={mode.index} path={mode.text} />;
    case "confirm-privacy":
      return <ConfirmPrivacyMode mode={mode} home={props.home} panel={props.panel} />;
    case "home":
      return (
        <>
          {props.home}
          <Panel lines={props.panel} />
        </>
      );
  }
}

/** The lines the prompt of the mode takes under the body at `columns` wide. */
export function promptHeight(mode: Mode, columns: number): number {
  switch (mode.kind) {
    case "path":
      return 1;
    case "confirm-privacy":
      // A confirmation question that wraps takes more than one line.
      return Math.ceil((confirmPrompt(mode.key, mode.value).length + 8) / Math.max(1, columns));
    default:
      return 0;
  }
}
