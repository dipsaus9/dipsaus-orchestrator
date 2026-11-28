// What the TUI draws (0009, DIPO-443, DIPO-458): the header, the rooms, the mode that shows, the
// ticker and the footer, all in the Frame, which says to widen the terminal instead when it is too
// small. A stopped daemon or a database problem replaces the body with its screen; offline the
// body stays, frozen in shade, with what happened under it.

import type { OfficeStoreState } from "@dipsaus-orchestrator/client";
import type { BackgroundItem, Clock } from "@dipsaus-orchestrator/contract";
import { useWindowSize } from "ink";
import type { ReactNode } from "react";

import type { useActions } from "./actions";
import { Shaded } from "./colour";
import { footerKeys, type Hint } from "./footer";
import { Frame, frameRows } from "./frame";
import { tickerLines } from "./format";
import { type Home, HomeMode } from "./home";
import { inSwitcherMode, type Mode } from "./mode";
import { ModeScreen, promptHeight } from "./modes";
import { OverlayOver } from "./overlays";
import { promptRows } from "./prompt-box";
import type { SegLine } from "./segments";
import type { LaneProgress } from "@dipsaus-orchestrator/contract";
import { endingKind, type Planning, PlanningMode } from "./planning";
import { dialogOnSubmit } from "./question-dialog";
import { type Retro, RetroMode } from "./retro";
import { type Roles, RolesMode } from "./roles";
import type { Display } from "./options";
import {
  DaemonStoppedBody,
  DatabaseBody,
  daemonScreen,
  daemonScreenKeys,
  OFFLINE_LINES,
  OfflineLines,
} from "./states";
import { backgroundTicker, Header, isOffline, officeName, type Room, Rooms } from "./views";
import {
  BackgroundDetailBody,
  BackgroundHeader,
  BackgroundTitle,
  itemStory,
} from "./background-detail";

export interface ScreenProps {
  readonly mode: Mode;
  readonly state: OfficeStoreState;
  readonly clock: Clock;
  readonly display: Display;
  readonly home: Home;
  readonly acts: ReturnType<typeof useActions>;
  readonly planning: Planning;
  readonly retro: Retro;
  readonly roles: Roles;
  /** The ticker's message of the moment, such as "press q again to quit". */
  readonly message: string | null;
  readonly outputTailBytes?: number;
}

/** The rows the story line and the Pipeline of a background level take above its rule. */
const LEVEL_ROWS = 2;

const overlaid = (mode: Mode) => mode.kind === "palette" || mode.kind === "help";

/** The room the rooms band marks, or null where it does not show; an overlay keeps its room's. */
function currentRoom(mode: Mode, home: Home): Room | null {
  if (mode.kind === "retro" || mode.kind === "roles") return mode.kind;
  if ((mode.kind === "palette" || mode.kind === "help") && mode.back !== "home") return mode.back;
  if (mode.kind !== "home" && mode.kind !== "confirm-privacy" && !overlaid(mode)) return null;
  switch (home.view) {
    case "desk":
    case "checklist":
      return "desk";
    case "overview":
      return "floor";
    case "queue":
      return "queue";
    default:
      return null;
  }
}

/** The footer keys: a daemon screen's own, else the mode's from the registry. */
function screenKeys(props: ScreenProps, columns: number): Hint[] {
  const { mode, state, display, home, acts, planning } = props;
  const screen = daemonScreen(state);
  if (screen !== null) return daemonScreenKeys(screen, state.database?.backup !== undefined);
  // The Roles room's chat takes the planning view's keys (DIPO-475).
  const shown: Mode = mode.kind === "roles" && planning.chatting ? { kind: "planning" } : mode;
  return footerKeys(shown, home.footerView, state, isOffline(state), home.run, columns - 1, {
    prompt: acts.promptHints(),
    row: home.rowHintList,
    retry: acts.retryable,
    desk: home.deskItem !== null,
    ascii: display.ascii,
    planning: {
      session: planning.view !== null,
      sending: planning.sending !== null,
      ending: endingKind(planning),
      card: planning.focused !== null,
      editing: planning.editing,
      cards: (planning.view?.proposals ?? []).some(
        (p) => p.state === "open" || p.state === "failed",
      ),
      dialog:
        planning.dialog === null
          ? null
          : {
              typing: planning.dialog.state.typing !== null,
              submit: dialogOnSubmit(planning.dialog.state),
            },
    },
  });
}

/** The body for the daemon's state: its screen, the mode's body frozen in shade, or the body. */
function StateBody(props: {
  readonly state: OfficeStoreState;
  readonly display: Display;
  readonly children: ReactNode;
}) {
  const { state, display } = props;
  const screen = daemonScreen(state);
  if (screen === "stopped") return <DaemonStoppedBody state={state} display={display} />;
  if (screen === "database") return <DatabaseBody state={state} display={display} />;
  if (!isOffline(state)) return props.children;
  return (
    <>
      <Shaded display={display}>{props.children}</Shaded>
      <OfflineLines state={state} display={display} />
    </>
  );
}

/**
 * The open prompt's box under the body (`prompt-box.ts`); none in the views with their own input,
 * and none when the Desk draws it in the focused item's preview.
 */
function panelRows(props: ScreenProps, columns: number): SegLine[] {
  const { mode, acts, home, display } = props;
  const own =
    inSwitcherMode(mode) ||
    mode.kind === "planning" ||
    mode.kind === "retro" ||
    mode.kind === "roles";
  if (own || overlaid(mode) || acts.flow === null || home.promptInDesk) return [];
  return promptRows(acts.flow, { width: columns - 1, ascii: display.ascii, context: true });
}

/** The Roles room's chat: the planning view in the right column of the room (DIPO-475). */
function chatOf(planning: Planning, display: Display, height: number, lane: LaneProgress | null) {
  return (width: number) => (
    <PlanningMode
      planning={planning}
      display={display}
      columns={width}
      height={Math.max(1, height - 1)}
      lane={lane}
    />
  );
}

function RolesRoom(props: { props: ScreenProps; columns: number; height: number }) {
  const { planning, display, state } = props.props;
  const { columns, height } = props;
  return (
    <RolesMode
      roles={props.props.roles}
      display={display}
      columns={columns}
      height={height}
      {...(planning.chatting ? { chat: chatOf(planning, display, height, state.lane) } : {})}
    />
  );
}

/** The keys of a background item's level (DIPO-528). */
function levelKeys(item: BackgroundItem): Hint[] {
  return [
    { key: "↑↓", label: "check", priority: 90 },
    ...(item.url === undefined ? [] : [{ key: "o", label: "PR", priority: 80 }]),
    { key: "c", label: "copy id", priority: 60 },
    { key: "esc", label: "back", priority: 100, side: "right" as const },
    { key: "?", label: "keys", priority: 100, side: "right" as const },
  ];
}

/** The ticker's line of the moment: a message, an action's status, a refusal, a notice, else the background's. */
function tickerOf(props: ScreenProps): string | null {
  const { state, acts, home } = props;
  return (
    props.message ??
    acts.statusLine() ??
    home.refusal ??
    home.failure ??
    home.runSummary ??
    state.notice ??
    backgroundTicker(state)
  );
}

/** A background item's level (DIPO-528): the Frame around the item's header, title and checks. */
function LevelScreen(props: { readonly props: ScreenProps; readonly item: BackgroundItem }) {
  const { state, clock, display, home } = props.props;
  const { item } = props;
  const ticker = tickerOf(props.props);
  const { columns, rows } = useWindowSize();
  const width = columns - 1;
  const height =
    rows - frameRows(false, ticker === null ? 0 : tickerLines(ticker, width).length) - LEVEL_ROWS;
  const title = state.stories.find((story) => String(story.story) === itemStory(item))?.title;
  return (
    <Frame
      display={display}
      header={
        <BackgroundHeader
          office={officeName(state) ?? "no office"}
          item={item}
          live={!isOffline(state)}
          now={clock.now()}
          width={width}
          display={display}
        />
      }
      rooms={<BackgroundTitle item={item} title={title ?? ""} width={width} display={display} />}
      ticker={ticker}
      keys={levelKeys(item)}
    >
      <BackgroundDetailBody
        item={item}
        focus={home.backgroundCheck}
        width={width}
        height={height}
        display={display}
      />
    </Frame>
  );
}

export function Screen(props: ScreenProps) {
  const { mode, state, home } = props;
  // A background item's level replaces the Floor under its header (DIPO-528).
  const level =
    daemonScreen(state) === null &&
    mode.kind === "home" &&
    home.view === "overview" &&
    home.detail === null
      ? home.levelItem
      : null;
  return level === null ? <RoomScreen {...props} /> : <LevelScreen props={props} item={level} />;
}

function RoomScreen(props: ScreenProps) {
  const { mode, state, clock, display, home, acts, planning, retro } = props;
  const { columns, rows } = useWindowSize();
  const offline = isOffline(state);
  const inSwitcher = inSwitcherMode(mode);
  const screen = daemonScreen(state);
  const ticker = tickerOf(props);

  const keys = screenKeys(props, columns);
  const room = screen === null ? currentRoom(mode, home) : null;
  const bare = home.expanded && home.detail !== null && screen === null;
  const panel = panelRows(props, columns);
  // The bands and the lines under the body stay on screen; the view gets the rest.
  const height = bare
    ? rows - 1
    : rows -
      frameRows(room !== null, ticker === null ? 0 : tickerLines(ticker, columns - 1).length) -
      panel.length -
      promptHeight(mode, columns) -
      (offline && screen === null ? OFFLINE_LINES : 0);

  const retroBody = <RetroMode retro={retro} height={height} />;
  const rolesBody = <RolesRoom props={props} columns={columns} height={height} />;
  const homeBody = (
    <HomeMode
      home={home}
      columns={columns}
      height={height}
      keysActive={mode.kind === "home" && acts.flow === null}
      {...(props.outputTailBytes === undefined ? {} : { outputTailBytes: props.outputTailBytes })}
    />
  );
  const body = (
    <ModeScreen
      mode={mode}
      state={state}
      display={display}
      clock={clock}
      columns={columns}
      panel={panel}
      planning={
        <PlanningMode
          planning={planning}
          display={display}
          columns={columns}
          height={height}
          lane={state.lane}
        />
      }
      retro={retroBody}
      roles={rolesBody}
      overlay={
        <OverlayOver
          mode={mode}
          home={home}
          state={state}
          display={display}
          columns={columns}
          height={height}
          behind={{ home: homeBody, retro: retroBody, roles: rolesBody }}
        />
      }
      home={homeBody}
    />
  );

  return (
    <Frame
      display={display}
      header={
        <Header
          state={state}
          display={display}
          now={clock.now()}
          columns={columns - 1}
          planOpen={room === "desk" && state.planning !== null}
          {...(inSwitcher ? { title: "Offices" } : {})}
        />
      }
      rooms={room === null ? undefined : <Rooms state={state} display={display} current={room} />}
      ticker={ticker}
      keys={keys}
      bare={bare}
    >
      <StateBody state={state} display={display}>
        {body}
      </StateBody>
    </Frame>
  );
}
