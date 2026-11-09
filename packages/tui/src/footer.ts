// The footer's key hints (0009, DIPO-308, DIPO-457, DIPO-458): which keys work now, read from the
// key registry in `keys.ts` by view, fitted to the width so the lowest priority goes first and
// `q q quit` never does. Verbs for the focused item print left, three spaces apart; the global keys
// (`esc back`, `O offices`, `q q quit`) print at the right end. Offline only the reading keys stay,
// followed by `actions off while offline`.

import type { OfficeStoreState } from "@dipsaus-orchestrator/client";

import type { RunAction, View } from "./home";
import { type FooterContext, type FooterView, footerHints, type Hint, hintText } from "./keys";
import type { Mode } from "./mode";
import { boardEntries } from "./overview";

export type { Hint } from "./keys";

/** The gap between two hints. */
export const HINT_GAP = "   ";

/** The footer's two sides as plain text. */
export interface FooterText {
  readonly left: string;
  readonly right: string;
}

/** The hints of one side as one line. */
export function sideText(hints: readonly Hint[], side: "left" | "right"): string {
  return hints
    .filter((hint) => (hint.side ?? "left") === side)
    .map(hintText)
    .join(HINT_GAP);
}

/** The width the hints take on one line, the gap between the sides included. */
function lineWidth(hints: readonly Hint[]): number {
  const left = sideText(hints, "left");
  const right = sideText(hints, "right");
  return left.length + (left !== "" && right !== "" ? HINT_GAP.length : 0) + right.length;
}

/** The hints in their order, without the lowest-priority ones that do not fit in `width`. */
export function fitHints(hints: readonly Hint[], width: number): Hint[] {
  const kept = [...hints];
  while (lineWidth(kept) > width && kept.length > 1) {
    let lowest = 0;
    for (let i = 1; i < kept.length; i++) {
      if ((kept[i]?.priority ?? 0) < (kept[lowest]?.priority ?? 0)) lowest = i;
    }
    kept.splice(lowest, 1);
  }
  return kept;
}

/** The footer as one line of `width` cells: left hints, then the right ones at the end. */
export function footerLine(hints: readonly Hint[], width: number): string {
  const left = sideText(hints, "left");
  const right = sideText(hints, "right");
  if (right === "") return left;
  const gap = Math.max(HINT_GAP.length, width - left.length - right.length);
  return left === "" ? right.padStart(width) : `${left}${" ".repeat(gap)}${right}`;
}

const NEVER = 100;

/** The footer's parts that depend on what is selected or open (DIPO-308). */
export interface FooterExtras {
  /** The keys of an open action prompt; they replace every other hint. */
  readonly prompt: readonly Hint[] | null;
  /** The keys of the selected row or run. */
  readonly row: readonly Hint[];
  /** True when a failed action offers ctrl-r. */
  readonly retry: boolean;
  /** True when the desk has a row selected. */
  readonly desk: boolean;
  /** The planning view's state (DIPO-449). */
  readonly planning: FooterContext["planning"];
  /** `--ascii`: the keys and labels in ASCII. */
  readonly ascii: boolean;
}

/** The ASCII twins of the footer's key glyphs. */
const ASCII_KEYS: Readonly<Record<string, string>> = {
  "↑↓": "up/down",
  "←→": "left/right",
  "⏎": "enter",
  "↑↓ PgUp PgDn": "up/down PgUp PgDn",
};

/** A hint in ASCII for `--ascii`. */
export function asciiHint(hint: Hint): Hint {
  return {
    ...hint,
    key: ASCII_KEYS[hint.key] ?? hint.key,
    label: hint.label.replaceAll("…", "..."),
  };
}

/** The registry's view for a mode and home view. */
function footerView(mode: Mode, view: View | "detail" | "ended" | "card"): FooterView {
  switch (mode.kind) {
    case "path":
      return "path";
    case "planning":
      return "planning";
    case "retro":
      return "retro";
    case "palette":
      return "palette";
    case "help":
      return "help";
    case "confirm-privacy":
      return "privacy";
    case "switcher":
      return "switcher";
    default:
      return view === "ended" ? "detail" : view;
  }
}

/** The footer's hints for the screen, fitted to `width`. */
export function footerKeys(
  mode: Mode,
  view: View | "detail" | "ended" | "card",
  state: OfficeStoreState,
  offline: boolean,
  run: RunAction | null,
  width: number,
  extras: FooterExtras,
): Hint[] {
  const fit = (hints: readonly Hint[]) =>
    fitHints(extras.ascii ? hints.map(asciiHint) : hints, width);
  if (extras.prompt !== null) return fit(extras.prompt);
  const shown = footerView(mode, view);
  const hints: Hint[] = [];
  const ownKeys: readonly FooterView[] = [
    "path",
    "planning",
    "retro",
    "palette",
    "help",
    "privacy",
    "switcher",
  ];
  if (!ownKeys.includes(shown) && !offline) {
    if (extras.retry || (run?.status === "failed" && run.error?.retryable === true)) {
      hints.push({ key: "^R", label: "retry", priority: 80 });
    }
    hints.push(...extras.row);
  }
  hints.push(
    ...footerHints(shown, {
      offline,
      office: state.office !== null,
      hasRow:
        shown === "desk" ? extras.desk : shown === "queue" ? true : boardEntries(state).length > 0,
      planningOpen: state.planning !== null,
      planning: extras.planning,
      narrow: width < 99,
    }),
  );
  if (!offline) return fit(hints);
  // Offline the keys read as one line: `↑↓ move   ⏎ read   q q quit   actions off while offline`.
  const reading = hints.map((hint): Hint => ({
    ...hint,
    side: "left",
    ...(hint.key === "⏎" ? { label: "read" } : {}),
  }));
  reading.push({ key: "", label: "actions off while offline", priority: NEVER, warning: true });
  return fit(reading);
}
