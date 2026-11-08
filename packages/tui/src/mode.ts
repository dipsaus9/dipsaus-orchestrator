// The TUI's mode and its reducer (DIPO-443): home, the office switcher, the typed repository path,
// the privacy confirmation, the planning view (DIPO-449), the retro view (DIPO-453) and the two overlays, the command palette and
// the keys overlay (DIPO-463), which return to the mode they opened over. A mode change is one action, so each one is a pure step that
// `mode.test.ts` covers.

export type Mode =
  | { readonly kind: "home" }
  | { readonly kind: "switcher"; readonly index: number }
  | { readonly kind: "path"; readonly index: number; readonly text: string }
  | { readonly kind: "confirm-privacy"; readonly key: string; readonly value: boolean }
  | { readonly kind: "planning" }
  | { readonly kind: "retro" }
  | {
      readonly kind: "palette";
      readonly query: string;
      readonly index: number;
      readonly back: Back;
    }
  | { readonly kind: "help"; readonly query: string; readonly back: Back };

/** The modes an overlay opens over and returns to. */
export type Back = "home" | "retro";

export type ModeAction =
  /** Back to home: an office opened, Esc in the switcher, or a privacy answer. */
  | { readonly type: "home" }
  /** The switcher with row `index` selected: opened with `o`, or back from the path entry. */
  | { readonly type: "switcher"; readonly index: number }
  /** Moves the switcher's selection by `delta` among `count` offices. */
  | { readonly type: "move"; readonly delta: number; readonly count: number }
  /** `n` in the switcher: starts typing a repository path. */
  | { readonly type: "enter-path" }
  /** A printable key while typing the path. */
  | { readonly type: "type"; readonly input: string }
  /** Backspace while typing the path. */
  | { readonly type: "erase" }
  /** The privacy setting `key` is to become `value`, once the maintainer says yes. */
  | { readonly type: "confirm-privacy"; readonly key: string; readonly value: boolean }
  /** `5` on home: the planning view (DIPO-449). */
  | { readonly type: "planning" }
  /** `6` on home: the retro view (DIPO-453). */
  | { readonly type: "retro" }
  /** `:` or Ctrl-K: the command palette over `back`. */
  | { readonly type: "palette"; readonly back: Back }
  /** `?`: the keys overlay over `back`. */
  | { readonly type: "help"; readonly back: Back }
  /** Enter in the keys overlay: the palette with the same query. */
  | { readonly type: "help-to-palette" }
  /** Esc in an overlay: back to the mode it opened over. */
  | { readonly type: "close-overlay" };

export function initialMode(startInSwitcher: boolean): Mode {
  return startInSwitcher ? { kind: "switcher", index: 0 } : { kind: "home" };
}

/** True in the modes that show the office switcher. */
export function inSwitcherMode(mode: Mode): boolean {
  return mode.kind === "switcher" || mode.kind === "path";
}

/** The next mode; an action that does not fit the mode leaves it as it is. */
export function modeReducer(mode: Mode, action: ModeAction): Mode {
  const queried = queryStep(mode, action);
  if (queried !== null) return queried;
  switch (action.type) {
    case "home":
      return { kind: "home" };
    case "switcher":
      return { kind: "switcher", index: action.index };
    case "move":
      if (mode.kind !== "switcher") return mode;
      return {
        kind: "switcher",
        index: Math.max(0, Math.min(Math.max(0, action.count - 1), mode.index + action.delta)),
      };
    case "enter-path":
      return mode.kind === "switcher" ? { kind: "path", index: mode.index, text: "" } : mode;
    case "type":
      return mode.kind === "path" ? { ...mode, text: mode.text + action.input } : mode;
    case "erase":
      return mode.kind === "path" ? { ...mode, text: mode.text.slice(0, -1) } : mode;
    case "confirm-privacy":
      return { kind: "confirm-privacy", key: action.key, value: action.value };
    case "planning":
      return mode.kind === "home" ? { kind: "planning" } : mode;
    case "retro":
      return mode.kind === "home" ? { kind: "retro" } : mode;
    default:
      return overlayStep(mode, action);
  }
}

/** True in the modes that take typed text, whole: a path, a planning message, an overlay's query. */
export function typesText(mode: Mode): boolean {
  return (
    mode.kind === "path" ||
    mode.kind === "planning" ||
    mode.kind === "palette" ||
    mode.kind === "help"
  );
}

/** The overlays' steps: opening, typing into the query, choosing a row, closing. */
function overlayStep(mode: Mode, action: ModeAction): Mode {
  const over = mode.kind === "home" || mode.kind === "retro";
  switch (action.type) {
    case "palette":
      return over ? { kind: "palette", query: "", index: 0, back: action.back } : mode;
    case "help":
      return over ? { kind: "help", query: "", back: action.back } : mode;
    case "help-to-palette":
      return mode.kind === "help"
        ? { kind: "palette", query: mode.query, index: 0, back: mode.back }
        : mode;
    case "close-overlay":
      return mode.kind === "palette" || mode.kind === "help" ? { kind: mode.back } : mode;
    default:
      return mode;
  }
}

/** The step of an overlay's query: a typed character, an erase, or a move over the rows. */
function queryStep(mode: Mode, action: ModeAction): Mode | null {
  if (mode.kind !== "palette" && mode.kind !== "help") return null;
  if (action.type !== "type" && action.type !== "erase" && action.type !== "move") return null;
  const query =
    action.type === "type"
      ? mode.query + action.input
      : action.type === "erase"
        ? mode.query.slice(0, -1)
        : mode.query;
  if (mode.kind === "help") return { ...mode, query };
  const moved =
    action.type === "move"
      ? Math.max(0, Math.min(Math.max(0, action.count - 1), mode.index + action.delta))
      : 0;
  return { ...mode, query, index: moved };
}
