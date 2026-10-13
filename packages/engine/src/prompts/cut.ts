// Deterministic cuts for prompt sections (0014 section 4): on line boundaries, the head for text
// and the tail for logs, each leaving a marker. File cuts in the context pack use
// `context/truncate.ts`; these are for sections whose source is not one repository file.

export interface Cut {
  readonly text: string;
  readonly truncated: boolean;
}

/** Splits text into lines that keep their `\n`, so joining them gives the text back. */
function splitLines(text: string): string[] {
  const lines = text.split(/(?<=\n)/);
  return lines.length === 1 && lines[0] === "" ? [] : lines;
}

/**
 * `text` when it has at most `limit` characters; otherwise the longest head of whole lines that,
 * with a newline and `marker(shown, total)`, stays within `limit`.
 */
export function cutHead(
  text: string,
  limit: number,
  marker: (shown: number, total: number) => string,
): Cut {
  if (text.length <= limit) return { text, truncated: false };
  const room = limit - marker(text.length, text.length).length - 1;
  let shown = 0;
  for (const line of splitLines(text)) {
    if (shown + line.length > room) break;
    shown += line.length;
  }
  const head = text.slice(0, shown);
  const separator = head === "" || head.endsWith("\n") ? "" : "\n";
  return { text: `${head}${separator}${marker(shown, text.length)}`, truncated: true };
}

/**
 * The last `count` lines of `text` that, with `marker(shown, total)` on a line before them, stay
 * within `limit` characters. `total` counts lines; the marker is left out when nothing was cut.
 */
export function cutTailLines(
  text: string,
  count: number,
  limit: number,
  marker: (shown: number, total: number) => string,
): Cut {
  const lines = text.replace(/\n$/, "").split("\n");
  const all = text === "" ? [] : lines;
  let start = Math.max(0, all.length - count);
  const render = (from: number): string => {
    const tail = all.slice(from).join("\n");
    if (from === 0) return tail;
    const note = marker(all.length - from, all.length);
    return tail === "" ? note : `${note}\n${tail}`;
  };
  while (start < all.length && render(start).length > limit) start += 1;
  return { text: render(start), truncated: start > 0 };
}
