// What the TUI draws (0009, DIPO-443): the header, the banners, the mode that shows and the footer,
// all in the Frame, which says to widen the terminal instead when it is too small.

import type { OfficeStoreState } from "@dipsaus-orchestrator/client";
import type { Clock } from "@dipsaus-orchestrator/contract";
import { useWindowSize } from "ink";

import type { useActions } from "./actions";
import { footerKeys } from "./footer";
import { Frame } from "./frame";
import { type Home, HomeMode } from "./home";
import { inSwitcherMode, type Mode } from "./mode";
import { ModeScreen, promptHeight } from "./modes";
import { type Planning, PlanningMode } from "./planning";
import type { Display } from "./options";
import { Banners, bannerLines, Header, isOffline } from "./views";

export interface ScreenProps {
  readonly mode: Mode;
  readonly state: OfficeStoreState;
  readonly clock: Clock;
  readonly display: Display;
  readonly home: Home;
  readonly acts: ReturnType<typeof useActions>;
  readonly planning: Planning;
  /** The footer's message of the moment, such as "press q again to quit". */
  readonly message: string | null;
  readonly outputTailBytes?: number;
}

export function Screen(props: ScreenProps) {
  const { mode, state, clock, display, home, acts, planning } = props;
  const { columns, rows } = useWindowSize();
  const offline = isOffline(state);
  const inSwitcher = inSwitcherMode(mode);
  const footerMessage =
    props.message ?? acts.statusLine() ?? home.refusal ?? home.failure ?? state.notice;

  const keys = footerKeys(mode, home.footerView, state, offline, home.run, columns - 1, {
    prompt: acts.promptHints(),
    row: home.rowHintList,
    retry: acts.retryable,
    desk: home.deskItem !== null,
    planning: {
      session: planning.view !== null,
      sending: planning.sending !== null,
      confirmingEnd: planning.confirmingEnd,
    },
  });
  const panel =
    inSwitcher || mode.kind === "planning"
      ? []
      : [...home.panelLines(columns), ...acts.promptLines()];
  // Header, banners, footer keys and message, and the run lines stay on screen; the view gets
  // the rest.
  const height =
    rows -
    3 -
    bannerLines(state, display.ascii).length -
    panel.length -
    promptHeight(mode, columns) -
    (footerMessage === null ? 0 : 1);

  return (
    <Frame
      display={display}
      header={
        <>
          <Header state={state} display={display} />
          <Banners state={state} display={display} />
        </>
      }
      ticker={footerMessage}
      keys={keys}
    >
      <ModeScreen
        mode={mode}
        state={state}
        display={display}
        clock={clock}
        columns={columns}
        panel={panel}
        planning={
          <PlanningMode planning={planning} display={display} columns={columns} height={height} />
        }
        home={
          <HomeMode
            home={home}
            columns={columns}
            height={height}
            keysActive={mode.kind === "home" && acts.flow === null}
            {...(props.outputTailBytes === undefined
              ? {}
              : { outputTailBytes: props.outputTailBytes })}
          />
        }
      />
    </Frame>
  );
}
