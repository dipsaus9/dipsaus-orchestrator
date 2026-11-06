// The footer's key hints (0009, DIPO-308): which keys work now, by mode and view, fitted to the
// width so the lowest priority goes first and `[q] quit` never does.

import type { OfficeStoreState } from "@dipsaus-orchestrator/client";

import type { RunAction, View } from "./home";
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

/** The footer's parts the key table adds (DIPO-308). */
export interface FooterExtras {
  /** The keys of an open action prompt; they replace every other hint. */
  readonly prompt: string | null;
  /** The keys of the selected row or run. */
  readonly row: readonly Hint[];
  /** True when a failed action offers Ctrl-R. */
  readonly retry: boolean;
  /** True when the desk has a row selected. */
  readonly desk: boolean;
  /** The keys of the planning view (DIPO-449). */
  readonly planning: readonly Hint[];
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
  const quit: Hint = [`[q] quit${offline ? " (offline: actions disabled)" : ""}`, QUIT];
  const hints: Hint[] = [];
  switch (mode.kind) {
    case "path":
      return fitHints(
        [
          ["[Enter] open", QUIT],
          ["[Esc] cancel", QUIT],
        ],
        width,
      );
    case "planning":
      return fitHints([...extras.planning], width);
    case "confirm-privacy":
      return fitHints(
        [
          ["[y] change it", QUIT],
          ["[any other key] keep it", 50],
        ],
        width,
      );
    case "switcher":
      hints.push(["[Enter] open", 70], ["[n] open new repo path", 40], ["[j/k] move", 30]);
      if (state.office !== null) hints.push(["[Esc] back", 50]);
      hints.push(quit);
      return fitHints(hints, width);
    default:
      if (extras.retry || (run?.status === "failed" && run.error?.retryable === true)) {
        hints.push(["[Ctrl-R] retry", 80]);
      }
      hints.push(...extras.row);
      if (view === "card") {
        hints.push(["[j/k] scroll", 30], ["[Esc] back", 90], quit);
        return fitHints(hints, width);
      }
      if (view === "detail" || view === "ended") {
        hints.push(
          ["[w]orker [v]erify [i] prompt", 75],
          ["[k/j PgUp/PgDn] scroll", 35],
          ["[End] follow tail", 45],
        );
        hints.push(["[Esc] back", 90]);
        hints.push(quit);
        return fitHints(hints, width);
      }
      if (view === "settings") {
        hints.push(
          ["[Enter] toggle", 70],
          ["[j/k] move", 30],
          ["[Esc] back", 50],
          ["[1] overview", 40],
        );
      } else if (view === "queue") {
        hints.push(
          ["[Enter] detail", 60],
          ["r[u]n selected", 70],
          ["[j/k] move", 30],
          ["[.] show done", 20],
          ["[1] overview", 50],
        );
        hints.push(["[3] desk", 45]);
      } else if (view === "checklist") {
        hints.push(
          ["[Space] tick", 70],
          ["[P] pass", 75],
          ["[F] fail", 75],
          ["[j/k] step", 30],
          ["[Esc] back", 90],
        );
      } else if (view === "desk") {
        if (extras.desk) hints.push(["[Enter] detail", 60], ["[j/k] move", 30]);
        hints.push(["[1] overview", 50], ["[2] queue", 45], ["[4] checklist", 35]);
      } else {
        if (boardEntries(state).length > 0) {
          hints.push(["[Enter] detail", 60], ["[j/k] move", 30]);
        }
        hints.push(["[2] queue", 50], ["[3] desk", 48], ["[p] privacy", 45]);
      }
      // The planning key shows while a session is open; every other footer stays as it was.
      if (state.planning !== null) hints.push(["[5] planning", 10]);
      hints.push(["[o] offices", 40]);
      hints.push(quit);
      return fitHints(hints, width);
  }
}
