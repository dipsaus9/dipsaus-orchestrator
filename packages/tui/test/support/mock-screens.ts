// The text mocks of `docs/design/tui-v2/screens/` as plain screen rows (DIPO-460): the tests hold
// the Floor and the Queue to the design cell for cell.

import { readFileSync } from "node:fs";

/**
 * The rows of a mock as plain text: `[role]` tags, `[/]`, `**` and `__` removed (spec.md, Reading
 * the screen files), right-trimmed. The caption names the row count; notes after it are dropped.
 */
export function mockRows(file: string): string[] {
  const text = readFileSync(
    new URL(`../../../../docs/design/tui-v2/screens/${file}`, import.meta.url),
    "utf8",
  );
  const [caption, ...rest] = text.split("\n");
  const rows = Number(/ (\d+) rows ===/.exec(caption ?? "")?.[1]);
  return rest.slice(0, rows).map((line) =>
    line
      .replaceAll(/\[(?:\/|[a-z]+)\]/g, "")
      .replaceAll(/\*\*|__/g, "")
      .trimEnd(),
  );
}
