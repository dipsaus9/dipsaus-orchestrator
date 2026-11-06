// The Composer (0009, DIPO-457): the one multi-line input of the TUI. Enter adds a line, Ctrl-S
// sends, Esc cancels, Backspace erases, and a paste keeps its line breaks. The planning view uses
// it for the goal and the messages; later views mount it for answers, notes and steering.

import type { Key } from "ink";
import { Box, Text } from "ink";

import { wrapLines } from "./output";

/** The lines of the input the Composer shows; the rest scrolls up out of sight. */
export const COMPOSER_ROWS = 6;

/** The text a key adds to the draft: a paste keeps its line breaks, control characters go. */
function typed(input: string): string {
  let text = "";
  for (const char of input.replace(/\r\n?/g, "\n")) {
    if (char === "\n" || char.charCodeAt(0) >= 32) {
      if (char.charCodeAt(0) !== 127) text += char;
    }
  }
  return text;
}

/**
 * The draft after `key`, or null when the key is not an edit. Enter adds a line; the send key
 * (Ctrl-S) and Esc are not edits.
 */
export function editDraft(draft: string, input: string, key: Key): string | null {
  if (key.return) return `${draft}\n`;
  if (key.backspace || key.delete) return draft.slice(0, -1);
  if (key.ctrl || key.meta || key.escape || key.tab) return null;
  if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return null;
  const text = typed(input);
  return text === "" ? null : draft + text;
}

/** What a key does to the Composer: change the draft, send it, cancel, or nothing it knows. */
export type ComposerEvent =
  | { readonly kind: "edit"; readonly draft: string }
  | { readonly kind: "send" }
  | { readonly kind: "cancel" }
  | { readonly kind: "other" };

/** Reads one key: Ctrl-S sends, Esc cancels, anything else is an edit or not the Composer's. */
export function composerKey(draft: string, input: string, key: Key): ComposerEvent {
  if (key.escape) return { kind: "cancel" };
  if (key.ctrl && input === "s") return { kind: "send" };
  const next = editDraft(draft, input, key);
  return next === null ? { kind: "other" } : { kind: "edit", draft: next };
}

/** The draft as rows: the last `rows`, a prompt on the first, the cursor on the last. */
export function composerRows(
  draft: string,
  columns: number,
  rows: number = COMPOSER_ROWS,
  prompt = "> ",
): string[] {
  const indent = " ".repeat(prompt.length);
  const wrapped = wrapLines(
    draft.split("\n").map((line, i) => `${i === 0 ? prompt : indent}${line}`),
    Math.max(10, columns - 2),
  );
  wrapped[wrapped.length - 1] = `${wrapped.at(-1) ?? prompt}_`;
  return wrapped.slice(-rows);
}

export interface ComposerProps {
  readonly draft: string;
  readonly columns: number;
  readonly rows?: number;
  readonly prompt?: string;
}

/** The Composer's rows; the keys come through `composerKey`, so a view owns its draft. */
export function Composer(props: ComposerProps) {
  const rows = composerRows(props.draft, props.columns, props.rows, props.prompt);
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <Text key={`input:${i}`} wrap="truncate-end">{` ${row}`}</Text>
      ))}
    </Box>
  );
}
