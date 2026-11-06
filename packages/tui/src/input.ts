// The keys the TUI takes (0009, DIPO-443): `q` twice within the window quits, and several printable
// keys in one write are handled one per render.

import type { Clock } from "@dipsaus-orchestrator/contract";
import { type Key, useInput } from "ink";
import { useEffect, useState } from "react";

/** A second `q` within this window quits (0009). */
export const QUIT_WINDOW_MS = 2_000;

/** A key event with no modifier, for keys taken one by one from a multi-key write. */
const NO_KEY = {} as Key;

/** `q` twice within the window quits; the returned function is true when the key was `q`. */
export function useQuitKey(
  clock: Clock,
  quit: () => void,
  setMessage: (message: string | null) => void,
): (input: string) => boolean {
  const [armedAt, setArmedAt] = useState<number | null>(null);
  return (input) => {
    if (input === "q") {
      const now = clock.now();
      if (armedAt !== null && now - armedAt <= QUIT_WINDOW_MS) {
        quit();
        return true;
      }
      setArmedAt(now);
      setMessage("press q again to quit");
      return true;
    }
    if (armedAt !== null) {
      setArmedAt(null);
      setMessage(null);
    }
    return false;
  };
}

/**
 * Hands every key to `handleKey`. Several printable keys in one write (fast typing, a paste): the
 * first acts now, the rest one per render so each sees the state the one before it left; `whole`
 * keeps the whole text, for a typed path.
 */
export function useKeys(whole: boolean, handleKey: (input: string, key: Key) => void): void {
  const [pending, setPending] = useState("");
  useInput((input, key) => {
    const several =
      !whole &&
      input.length > 1 &&
      !key.ctrl &&
      !key.meta &&
      !key.escape &&
      !key.return &&
      /^[\x20-\x7e]+$/.test(input);
    if (!several) {
      handleKey(input, key);
      return;
    }
    handleKey(input.slice(0, 1), key);
    setPending((rest) => rest + input.slice(1));
  });

  useEffect(() => {
    if (pending === "") return;
    setPending(pending.slice(1));
    handleKey(pending.slice(0, 1), NO_KEY);
    // handleKey is this render's: it sees the state the key before it left.
  }, [pending]);
}
