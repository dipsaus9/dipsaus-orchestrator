// The footer's key hints (0009, DIPO-308, DIPO-457): which keys work now, read from the key registry
// in `keys.ts` by view, fitted to the width so the lowest priority goes first and `[q] quit` never
// does.

import type { OfficeStoreState } from "@dipsaus-orchestrator/client";

import type { RunAction, View } from "./home";
import { type FooterContext, type FooterView, footerHints } from "./keys";
import type { Mode } from "./mode";
import { boardEntries } from "./overview";

/** A footer hint; when the line is too wide the lowest priority goes first, `[q] quit` never. */
export type Hint = readonly [text: string, priority: number];

/** The hints in their order, without the lowest-priority ones that do not fit in `width`. */
export function fitHints(hints: readonly Hint[], width: number): string {
  const kept = [...hints];
  const text = () => kept.map(([hint]) => hint).join("  ");
  while (text().length > width && kept.length > 1) {
    let lowest = 0;
    for (let i = 1; i < kept.length; i++) {
      if ((kept[i]?.[1] ?? 0) < (kept[lowest]?.[1] ?? 0)) lowest = i;
    }
    kept.splice(lowest, 1);
  }
  return text();
}

const QUIT = 100;

/** The footer's parts that depend on what is selected or open (DIPO-308). */
export interface FooterExtras {
  /** The keys of an open action prompt; they replace every other hint. */
  readonly prompt: string | null;
  /** The keys of the selected row or run. */
  readonly row: readonly Hint[];
  /** True when a failed action offers Ctrl-R. */
  readonly retry: boolean;
  /** True when the desk has a row selected. */
  readonly desk: boolean;
  /** The planning view's state (DIPO-449). */
  readonly planning: FooterContext["planning"];
}

/** The registry's view for a mode and home view. */
function footerView(mode: Mode, view: View | "detail" | "ended" | "card"): FooterView {
  switch (mode.kind) {
    case "path":
      return "path";
    case "planning":
      return "planning";
    case "confirm-privacy":
      return "privacy";
    case "switcher":
      return "switcher";
    default:
      return view === "ended" ? "detail" : view;
  }
}

export function footerKeys(
  mode: Mode,
  view: View | "detail" | "ended" | "card",
  state: OfficeStoreState,
  offline: boolean,
  run: RunAction | null,
  width: number,
  extras: FooterExtras,
): string {
  if (extras.prompt !== null) return fitHints([[extras.prompt, QUIT]], width);
  const shown = footerView(mode, view);
  const hints: Hint[] = [];
  if (shown !== "path" && shown !== "planning" && shown !== "privacy" && shown !== "switcher") {
    if (extras.retry || (run?.status === "failed" && run.error?.retryable === true)) {
      hints.push(["[Ctrl-R] retry", 80]);
    }
    hints.push(...extras.row);
  }
  hints.push(
    ...footerHints(shown, {
      offline,
      office: state.office !== null,
      hasRow: shown === "desk" ? extras.desk : boardEntries(state).length > 0,
      planningOpen: state.planning !== null,
      planning: extras.planning,
    }),
  );
  return fitHints(hints, width);
}
