// The TUI's mode and its reducer (DIPO-443): home, the office switcher, the typed repository path,
// the privacy confirmation and the planning view (DIPO-449). A mode change is one action, so each one is a pure step that
// `mode.test.ts` covers.

export type Mode =
  | { readonly kind: "home" }
  | { readonly kind: "switcher"; readonly index: number }
  | { readonly kind: "path"; readonly index: number; readonly text: string }
  | { readonly kind: "confirm-privacy"; readonly key: string; readonly value: boolean }
  | { readonly kind: "planning" };

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
  | { readonly type: "planning" };

export function initialMode(startInSwitcher: boolean): Mode {
  return startInSwitcher ? { kind: "switcher", index: 0 } : { kind: "home" };
}

/** True in the modes that show the office switcher. */
export function inSwitcherMode(mode: Mode): boolean {
  return mode.kind === "switcher" || mode.kind === "path";
}

/** The next mode; an action that does not fit the mode leaves it as it is. */
export function modeReducer(mode: Mode, action: ModeAction): Mode {
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
  }
}
