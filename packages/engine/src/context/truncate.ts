// Deterministic truncation (0014 section 4): cut on line boundaries, keep the head, and leave a
// marker. A file's marker names the path and the first line not shown, so a worker can read on;
// a listing's marker names the list and has no line, because a listing is not a file.

/** Formats a count with comma thousands separators, independent of the locale. */
export function formatCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The 0014 marker for a cut that shows `shown` of `total` characters of `path`. */
export function truncationMarker(shown: number, total: number, path: string, line: number): string {
  return `[dipo: truncated, showing ${formatCount(shown)} of ${formatCount(total)} characters. The rest is in ${path} from line ${formatCount(line)}; read it only if the shown part is not enough.]`;
}

/** The marker for a cut entry list (a directory or component listing) labelled `label`. */
export function listingTruncationMarker(shown: number, total: number, label: string): string {
  return `[dipo: list cut, showing ${formatCount(shown)} of ${formatCount(total)} characters of the ${label} listing; list the rest yourself only if the shown part is not enough.]`;
}

export interface Truncated {
  /** The text to use: the original, or its head plus the marker on its own line. */
  readonly text: string;
  readonly truncated: boolean;
  /** Characters of the original shown. */
  readonly shown: number;
  readonly total: number;
  /** Lines of the original shown (1-based: the head is lines 1 to `lines`). */
  readonly lines: number;
}

/** Splits text into lines that keep their `\n`, so joining them gives the text back. */
function splitLines(text: string): string[] {
  const lines = text.split(/(?<=\n)/);
  return lines.length === 1 && lines[0] === "" ? [] : lines;
}

type Marker = (shown: number, total: number, line: number) => string;

function cutHead(text: string, limit: number, marker: Marker): Truncated {
  const lines = splitLines(text);
  const total = text.length;
  if (total <= limit) {
    return { text, truncated: false, shown: total, total, lines: lines.length };
  }
  // The marker's length with the largest numbers it can name bounds every real marker.
  const reserve = marker(total, total, lines.length + 1).length + 1;
  const room = limit - reserve;
  let shown = 0;
  let count = 0;
  for (const line of lines) {
    if (shown + line.length > room) break;
    shown += line.length;
    count += 1;
  }
  const head = text.slice(0, shown);
  const separator = head === "" || head.endsWith("\n") ? "" : "\n";
  return {
    text: `${head}${separator}${marker(shown, total, count + 1)}`,
    truncated: true,
    shown,
    total,
    lines: count,
  };
}

/**
 * `text` when it has at most `limit` characters; otherwise the longest head of whole lines that,
 * with a newline and the marker, stays within `limit`. A first line longer than the room shows
 * nothing but the marker.
 */
export function truncateHead(text: string, limit: number, path: string): Truncated {
  return cutHead(text, limit, (shown, total, line) => truncationMarker(shown, total, path, line));
}

/** `truncateHead` for an entry list: the same cut, with the listing marker. */
export function truncateListing(text: string, limit: number, label: string): Truncated {
  return cutHead(text, limit, (shown, total) => listingTruncationMarker(shown, total, label));
}
