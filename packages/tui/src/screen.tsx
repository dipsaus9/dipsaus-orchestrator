// What the TUI draws (0009, DIPO-443): the header, the banners, the mode that shows and the footer,
// or the short form on a narrow terminal.

import type { OfficeStoreState } from "@dipsaus-orchestrator/client";
import type { Clock } from "@dipsaus-orchestrator/contract";
import { Box, Text, useWindowSize } from "ink";

import type { useActions } from "./actions";
import { footerKeys } from "./footer";
import { type Home, HomeMode } from "./home";
import { inSwitcherMode, type Mode } from "./mode";
import { ModeScreen, promptHeight } from "./modes";
import type { Display } from "./options";
import {
  Banners,
  bannerLines,
  Footer,
  Header,
  isOffline,
  NARROW_COLUMNS,
  NARROW_ROWS,
  NarrowBody,
} from "./views";

export interface ScreenProps {
  readonly mode: Mode;
  readonly state: OfficeStoreState;
  readonly clock: Clock;
  readonly display: Display;
  readonly home: Home;
  readonly acts: ReturnType<typeof useActions>;
  /** The footer's message of the moment, such as "press q again to quit". */
  readonly message: string | null;
  readonly outputTailBytes?: number;
}

export function Screen(props: ScreenProps) {
  const { mode, state, clock, display, home, acts } = props;
  const { columns, rows } = useWindowSize();
  const offline = isOffline(state);
  const inSwitcher = inSwitcherMode(mode);
  const footerMessage =
    props.message ?? acts.statusLine() ?? home.refusal ?? home.failure ?? state.notice;

  if (columns < NARROW_COLUMNS || rows < NARROW_ROWS) {
    return (
      <Box flexDirection="column">
        <NarrowBody
          state={state}
          display={display}
          switcher={mode.kind === "switcher" || mode.kind === "path" ? { index: mode.index } : null}
        />
        {/* An open action prompt shows at every size, so what a key does is on screen. */}
        {acts.promptLines().map((line, i) => (
          <Text key={`prompt:${i}`} wrap="truncate-end">
            {line}
          </Text>
        ))}
        {footerMessage === null ? null : <Text wrap="truncate-end">{footerMessage}</Text>}
      </Box>
    );
  }

  const keys = footerKeys(mode, home.footerView, state, offline, home.run, columns - 1, {
    prompt: acts.promptHints(),
    row: home.rowHintList,
    retry: acts.retryable,
    desk: home.deskItem !== null,
  });
  const panel = inSwitcher ? [] : [...home.panelLines(columns), ...acts.promptLines()];
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
    <Box flexDirection="column">
      <Header state={state} display={display} />
      <Banners state={state} display={display} />
      <ModeScreen
        mode={mode}
        state={state}
        display={display}
        clock={clock}
        columns={columns}
        panel={panel}
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
      <Footer keys={keys} message={footerMessage} display={display} />
    </Box>
  );
}
