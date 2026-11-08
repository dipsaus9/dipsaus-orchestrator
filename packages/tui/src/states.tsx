// The daemon state screens (0009, DIPO-458; spec.md, States; screens/12-states.txt): the daemon
// stopped body, the lines under the frozen offline body, and the database problem that holds the
// daemon in `recovering` (DIPO-111, DIPO-120). Each reassures first, then gives the cause and one
// fix. A plain reconcile shows only the header chip.

import type { OfficeStoreState } from "@dipsaus-orchestrator/client";
import { Box, Text } from "ink";

import { Colored } from "./colour";
import type { Hint } from "./footer";
import type { Display } from "./options";
import { clockTime, daemonStopped, glyphs, isOffline } from "./views";

/** The daemon screen that replaces the body, or null when the mode's body shows. */
export type DaemonScreen = "stopped" | "database" | null;

export function daemonScreen(state: OfficeStoreState): DaemonScreen {
  if (daemonStopped(state)) return "stopped";
  if (!isOffline(state) && state.database !== null) return "database";
  return null;
}

/** The command line that shows the daemon's log. */
export const DAEMON_LOGS_COMMAND = "dipo daemon logs";

/** The footer keys of a daemon screen; only these keys work there (keymap.json). */
export function daemonScreenKeys(screen: Exclude<DaemonScreen, null>, backup: boolean): Hint[] {
  const quit: Hint = { key: "q q", label: "quit", priority: 100, side: "right" };
  if (screen === "stopped") {
    return [
      { key: "r", label: "restart daemon", priority: 90 },
      { key: "l", label: "open its log", priority: 80 },
      quit,
    ];
  }
  return [
    { key: "l", label: "open daemon log", priority: 90 },
    ...(backup ? [{ key: "c", label: "copy the backup path", priority: 80 }] : []),
    quit,
  ];
}

/** S6 daemon stopped: no work is lost, when it was last seen, and the two keys. */
export function DaemonStoppedBody(props: {
  readonly state: OfficeStoreState;
  readonly display: Display;
}) {
  const { state, display } = props;
  const g = glyphs(display.ascii);
  const seen = state.offlineSince === null ? null : `Last seen ${clockTime(state.offlineSince)}`;
  return (
    <Box flexDirection="column">
      <Text> </Text>
      <Text>
        {"    "}
        <Colored display={display} role="err">
          {g.failed}
        </Colored>{" "}
        <Colored display={display} role="hi">
          The office manager isn't running.
        </Colored>
      </Text>
      <Text> </Text>
      <Text>{"      No work is lost. Boxes pause until it's back."}</Text>
      {seen === null ? null : (
        <Colored display={display} role="dim">
          {`      ${seen}`}
        </Colored>
      )}
      <Text> </Text>
      <Text>
        {"      "}
        <Colored display={display} role="acc">
          r
        </Colored>
        {" restart daemon    "}
        <Colored display={display} role="acc">
          l
        </Colored>
        {" open its log"}
      </Text>
    </Box>
  );
}

/** S8 offline: under the frozen body, what happened and that the daemon may still work. */
export function OfflineLines(props: {
  readonly state: OfficeStoreState;
  readonly display: Display;
}) {
  const { state, display } = props;
  const g = glyphs(display.ascii);
  const since = state.offlineSince === null ? "" : ` from ${clockTime(state.offlineSince)}`;
  return (
    <Box flexDirection="column">
      <Text> </Text>
      <Text>
        {"  "}
        <Colored display={display} role="err">
          {g.failed}
        </Colored>{" "}
        <Colored display={display} role="hi">
          {`Lost the daemon. Reconnecting${g.ellipsis}`}
        </Colored>
      </Text>
      <Colored display={display} role="dim">
        {`    What you see is${since}. Actions are off.`}
      </Colored>
      <Colored display={display} role="dim">
        {"    The daemon keeps working if it's still up."}
      </Colored>
    </Box>
  );
}

/** The rows `OfflineLines` takes under the frozen body. */
export const OFFLINE_LINES = 4;

/** S8 recovering because of the database: the reason, the backup, what is safe, the two keys. */
export function DatabaseBody(props: {
  readonly state: OfficeStoreState;
  readonly display: Display;
}) {
  const { state, display } = props;
  const database = state.database;
  if (database === null) return null;
  return (
    <Box flexDirection="column">
      <Text>
        {"  "}
        <Colored display={display} role="acc">
          !
        </Colored>{" "}
        <Colored display={display} role="hi">
          Database unavailable
        </Colored>
      </Text>
      <Text> </Text>
      <Text>
        <Colored display={display} role="dim">
          {"    reason  "}
        </Colored>
        {database.reason}
      </Text>
      {database.backup === undefined ? null : (
        <Text wrap="truncate-end">
          <Colored display={display} role="dim">
            {"    backup  "}
          </Colored>
          {database.backup}
        </Text>
      )}
      <Text> </Text>
      <Colored display={display} role="dim">
        {"    Stories and code are safe: they live in git."}
      </Colored>
      <Colored display={display} role="dim">
        {"    Only run history is at stake."}
      </Colored>
      <Text> </Text>
      <Text>
        {"    "}
        <Colored display={display} role="acc">
          l
        </Colored>
        {" open daemon log"}
        {database.backup === undefined ? null : (
          <>
            {"   "}
            <Colored display={display} role="acc">
              c
            </Colored>
            {" copy the backup path"}
          </>
        )}
      </Text>
      <Colored display={display} role="dim">
        {`    $ ${DAEMON_LOGS_COMMAND}`}
      </Colored>
    </Box>
  );
}
