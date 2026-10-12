import { describe, expect, it } from "bun:test";

import type { Meta } from "./format";
import { parseClaudeVersion, staleRecordings } from "./status";

function recording(name: string, version: string | null) {
  const meta: Meta = {
    scenario: name,
    source: "live",
    claude_code_version: version,
    captured_at: "2026-10-12",
    expected: "",
    usage_checksum: "",
  };
  return { name, meta };
}

describe("recordings:status", () => {
  it("reads the version from claude --version output", () => {
    expect(parseClaudeVersion("2.1.296 (Claude Code)\n")).toBe("2.1.296");
    expect(parseClaudeVersion("command not found")).toBeNull();
  });

  it("lists recordings whose claude_code_version differs from the local one", () => {
    const all = [recording("a", "2.1.296"), recording("b", "2.1.290"), recording("c", null)];
    expect(staleRecordings("2.1.296", all)).toEqual([
      { name: "b", recorded: "2.1.290" },
      { name: "c", recorded: null },
    ]);
    expect(staleRecordings("2.1.290", all).map((stale) => stale.name)).toEqual(["a", "c"]);
  });
});
