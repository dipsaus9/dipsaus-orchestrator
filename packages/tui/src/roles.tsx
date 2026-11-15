// The Roles room (`6`, DIPO-473, 0017): the roles of the office from its role files on the base,
// each with its purpose, model and effort, the files that failed to load below them with their
// problem, and the selected role's instructions beside the list. Read-only. The engine holds the
// roster (`office.roles`); the TUI reads it when the room opens and again on `roles.changed`.
// Up and down select a role, PgUp and PgDn scroll its instructions; Esc goes back home. Its footer
// keys come from the key registry (`FOOTER_KEYS`).

import type { OfficeStore, OfficeStoreState } from "@dipsaus-orchestrator/client";
import type {
  EngineError,
  InvalidRoleFile,
  OfficeId,
  RoleView,
} from "@dipsaus-orchestrator/contract";
import { Box, type Key, Text, useWindowSize } from "ink";
import { type ReactNode, useEffect, useState } from "react";

import type { TuiActions } from "./app";
import { Colored } from "./colour";
import { truncate, wrapWords } from "./format";
import type { Display } from "./options";
import { glyphs } from "./views";

export interface RolesResult {
  readonly roles: readonly RoleView[];
  readonly invalid: readonly InvalidRoleFile[];
}

export type RolesOutcome =
  | { readonly ok: true; readonly result: RolesResult }
  | { readonly ok: false; readonly error: EngineError };

/** `office.roles` for `office`. */
export type ReadRoles = (office: OfficeId) => Promise<RolesOutcome>;

/** The left column's width, and the gap between the columns. */
const LIST_MAX = 46;
const GAP = 3;

export function listWidth(columns: number): number {
  return Math.max(20, Math.min(LIST_MAX, Math.floor(columns * 0.4)));
}

export interface Roles {
  readonly result: RolesResult | null;
  readonly error: EngineError | null;
  /** The selected role's index among `result.roles`. */
  readonly selected: number;
  /** The first instruction line shown. */
  readonly top: number;
  /** Handles a key of the Roles room. */
  onKey(input: string, key: Key): void;
}

/** The roles of the open office, read when the room opens and after each `roles.changed`. */
export function useRoles(options: {
  readonly store: OfficeStore;
  readonly actions: TuiActions;
  readonly state: OfficeStoreState;
  readonly active: boolean;
  readonly leave: () => void;
  /** The chat key: starts a roles session (DIPO-475). */
  readonly chat: () => void;
}): Roles {
  const { store, actions, state: current, active, leave, chat } = options;
  const { office } = current;
  const { rows, columns } = useWindowSize();
  const height = Math.max(1, rows - 7);
  const [state, setState] = useState<{
    result: RolesResult | null;
    error: EngineError | null;
  }>({ result: null, error: null });
  const [selected, setSelected] = useState(0);
  const [top, setTop] = useState(0);

  useEffect(() => {
    if (!active || office === null) return;
    let stopped = false;
    const read = () => {
      void actions.readRoles(office).then((outcome) => {
        if (stopped || store.state.office !== office) return;
        setState((previous) =>
          outcome.ok
            ? { result: outcome.result, error: null }
            : { result: previous.result, error: outcome.error },
        );
      });
    };
    read();
    const stop = store.onOfficeEvent((event) => {
      if (event.type === "roles.changed") read();
    });
    return () => {
      stopped = true;
      stop();
    };
  }, [store, actions, office, active]);

  useEffect(() => {
    if (!active) {
      setTop(0);
      setSelected(0);
    }
  }, [active]);

  const roles = state.result?.roles ?? [];
  // A roster that got shorter keeps the selection on a role.
  const at = Math.min(selected, Math.max(0, roles.length - 1));
  const lines = instructionLines(roles[at], columns);
  const last = Math.max(0, lines.length - height);
  return {
    ...state,
    selected: at,
    top: Math.min(top, last),
    onKey: (input, key) => {
      if (key.escape) leave();
      else if (input === "c") chat();
      else if (key.downArrow || input === "j") {
        setSelected(Math.min(Math.max(0, roles.length - 1), at + 1));
        setTop(0);
      } else if (key.upArrow || input === "k") {
        setSelected(Math.max(0, at - 1));
        setTop(0);
      } else if (key.pageDown) setTop(Math.min(last, Math.min(top, last) + height));
      else if (key.pageUp) setTop(Math.max(0, Math.min(top, last) - height));
    },
  };
}

/** The selected role's instructions as the right column wraps them. */
export function instructionLines(role: RoleView | undefined, columns: number): string[] {
  if (role === undefined) return [];
  return wrapWords(role.instructions, columns - listWidth(columns) - GAP - 1);
}

/** What a role leaves to its tier is named so. */
export function modelLine(role: RoleView): string {
  return `kind ${role.kind} · model ${role.model ?? "tier"} · effort ${role.effort ?? "tier"}`;
}

interface ListRow {
  readonly key: string;
  readonly node: ReactNode;
}

/** The left column's rows: each role in three, then the files that failed to load. */
function listRows(
  result: RolesResult,
  selected: number,
  display: Display,
  left: number,
): ListRow[] {
  const { ellipsis } = glyphs(display.ascii);
  const fit = (text: string) => truncate(text, left - 2, ellipsis);
  const listed: ListRow[] = [];
  result.roles.forEach((role, i) => {
    const here = i === selected;
    listed.push(
      {
        key: `${role.name}:name`,
        node: (
          <Colored display={display} role={here ? "hi" : undefined} bold={here} wrap="truncate-end">
            {`${here ? "›" : " "} ${fit(role.name)}`}
          </Colored>
        ),
      },
      {
        key: `${role.name}:purpose`,
        node: (
          <Colored display={display} role="dim" wrap="truncate-end">
            {`  ${fit(role.purpose)}`}
          </Colored>
        ),
      },
      {
        key: `${role.name}:model`,
        node: (
          <Colored display={display} role="dim" wrap="truncate-end">
            {`  ${fit(modelLine(role))}`}
          </Colored>
        ),
      },
    );
  });
  if (result.invalid.length > 0) {
    listed.push({
      key: "invalid",
      node: (
        <Colored display={display} role="err" wrap="truncate-end">
          {" ! files that failed to load"}
        </Colored>
      ),
    });
    for (const file of result.invalid) {
      // A problem is never cut: it wraps under the file's path.
      wrapWords(`${file.path}: ${file.problem}`, left - 4).forEach((line, i) => {
        listed.push({
          key: `invalid:${file.path}:${i}`,
          node: (
            <Colored display={display} role="err" wrap="truncate-end">
              {`   ${line}`}
            </Colored>
          ),
        });
      });
    }
  }
  return listed;
}

export interface RolesModeProps {
  readonly roles: Roles;
  /** The chat shown beside the list while a roles session is open (DIPO-475); it fills the right column. */
  readonly chat?: (width: number) => ReactNode;
  readonly display: Display;
  readonly columns: number;
  /** Rows for the view. */
  readonly height: number;
}

/** The Roles room's body. */
export function RolesMode(props: RolesModeProps) {
  const { roles, display, columns, height } = props;
  const rows = Math.max(1, height - 1);
  const { result } = roles;
  const left = listWidth(columns);
  const head = <Text wrap="truncate-end">{" Roles: the role files on the base"}</Text>;
  if (result === null) {
    return (
      <Box flexDirection="column">
        {head}
        <Text wrap="truncate-end">
          {roles.error === null ? " reading…" : ` ${roles.error.code}: ${roles.error.message}`}
        </Text>
      </Box>
    );
  }
  if (result.roles.length === 0 && result.invalid.length === 0) {
    return (
      <Box flexDirection="column">
        {head}
        <Text wrap="truncate-end">
          {" This office has no roles. `dipo office init` seeds the developer role."}
        </Text>
      </Box>
    );
  }
  const listed = listRows(result, roles.selected, display, left);
  // Each role takes three rows; the list scrolls to keep the selected one in view.
  const first = Math.max(0, Math.min(roles.selected * 3, roles.selected * 3 + 3 - rows));
  const role = result.roles[roles.selected];
  const instructions = instructionLines(role, columns).slice(roles.top, roles.top + rows);
  const chat = props.chat?.(Math.max(10, columns - left - GAP));
  return (
    <Box flexDirection="column">
      {head}
      <Box flexDirection="row" height={rows} overflow="hidden">
        <Box flexDirection="column" width={left} flexShrink={0}>
          {listed.slice(first, first + rows).map((line) => (
            <Box key={line.key}>{line.node}</Box>
          ))}
        </Box>
        <Box flexDirection="column" marginLeft={GAP} flexGrow={1}>
          {chat ??
            instructions.map((line, i) => (
              <Text key={`${roles.top + i}`} wrap="truncate-end">
                {line}
              </Text>
            ))}
        </Box>
      </Box>
    </Box>
  );
}
