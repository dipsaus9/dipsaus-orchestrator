// An in-memory `Workspace` and a request builder for the context provider tests.

import type { ContextRequest, Workspace } from "../../src/context";

/** A workspace over `files` (path to text). `untracked` paths are listed but not tracked. */
export function memoryWorkspace(
  files: Readonly<Record<string, string | Uint8Array>>,
  untracked: readonly string[] = [],
): Workspace & { reads: string[] } {
  const reads: string[] = [];
  const all = Object.keys(files).toSorted();
  return {
    reads,
    root: "/work",
    headSha: async () => "0".repeat(40),
    trackedFiles: async () => all.filter((path) => !untracked.includes(path)),
    files: async () => all,
    readFile: async (path) => {
      reads.push(path);
      const content = files[path];
      if (content === undefined) return undefined;
      return typeof content === "string" ? new TextEncoder().encode(content) : content;
    },
  };
}

export function request(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    storyId: "DIPO-1",
    outcome: "Do the thing.",
    criteria: ["It works."],
    scope: [],
    inputs: [],
    components: [],
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    sizeClass: "S",
    inputsBudget: 8_000,
    ...overrides,
  };
}

/** `count` lines of `width` characters each (newline included), numbered for readable failures. */
export function lines(count: number, width = 40): string {
  return Array.from({ length: count }, (_, i) =>
    `${String(i + 1).padStart(5, "0")} `.padEnd(width - 1, "x"),
  )
    .map((line) => `${line}\n`)
    .join("");
}
