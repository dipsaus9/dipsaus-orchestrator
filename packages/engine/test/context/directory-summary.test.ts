// The pack stays small (DIPO-217 AC #6): scope directories are summaries, the decision records and
// recording data have no item unless named, and a scope file is cut at the per-item cap.

import { describe, expect, it } from "bun:test";

import { createDefaultProvider, truncationMarker } from "../../src/context";
import { lines, memoryWorkspace, request } from "./helpers";

const pad = (i: number) => String(i).padStart(3, "0");

function fixture(): Record<string, string> {
  const files: Record<string, string> = { "src/big.ts": lines(250) }; // 10,000 characters
  for (let i = 0; i < 120; i += 1) files[`packages/app/src/f${pad(i)}.ts`] = "";
  for (let i = 0; i < 20; i += 1) files[`docs/decisions/${pad(i)}-decision.md`] = "";
  for (let i = 0; i < 60; i += 1) {
    files[`packages/engine/test/recordings/claude-cli/run-${pad(i)}.json`] = "";
  }
  for (let i = 0; i < 14; i += 1) files[`tools/recordings/script-${pad(i)}.ts`] = "";
  return files;
}

const SCOPE = [
  "packages/app/src/",
  "docs/decisions/",
  "packages/engine/test/recordings/claude-cli/",
  "tools/recordings/",
  "src/big.ts",
];

describe("the context pack of a story with large scope directories", () => {
  it("holds summaries, hides the unnamed data directories and has one pinned size", async () => {
    const provider = createDefaultProvider({ workspace: memoryWorkspace(fixture()) });
    const pack = await provider.gather(request({ scope: SCOPE }), 24_000);

    expect(pack.items.map((item) => `${item.reason.kind} ${item.path}`)).toEqual([
      "scope-dir packages/app/src/",
      "scope-file src/big.ts",
      "scope-dir tools/recordings/",
    ]);
    const reasons = pack.items.map((item) => item.reason);
    expect(reasons[0]).toEqual({
      kind: "scope-dir",
      scope: "packages/app/src/",
      shown: 15,
      total: 120,
    });
    expect(reasons[2]).toEqual({
      kind: "scope-dir",
      scope: "tools/recordings/",
      shown: 14,
      total: 14,
    });
    expect(pack.items[0]?.text.split("\n")).toHaveLength(15);

    const big = pack.items[1];
    const to = big?.range?.to ?? 0;
    expect(big?.text).toBe(
      lines(250).slice(0, to * 40) + truncationMarker(to * 40, 10_000, "src/big.ts", to + 1),
    );

    // Any growth of the pack fails this number.
    expect(pack.usedChars).toBe(PINNED_USED_CHARS);
  });
});

const PINNED_USED_CHARS = 4_831;
