import { describe, expect, it } from "bun:test";

import { checkPrTitle, TYPES } from "./check-pr-title";

const SCRIPT = new URL("./check-pr-title.ts", import.meta.url).pathname;

describe("checkPrTitle", () => {
  const valid = [
    // Examples from decision 0016.
    "feat(DIPO-21): stream worker events to the TUI",
    "chore(deps): update oxlint to 1.88.0",
    "fix(deps): bump zod to 4.6.6",
    "chore(main): release 0.3.0",
    "chore(backlog): plan M1 stories",
    "revert(DIPO-21): stream worker events to the TUI",
    // Grammar edges.
    "feat(DIPO-1.2): a sub-story scope",
    "feat(DIPO-21)!: drop the old event shape",
    "docs(DIPO-14): x",
    `chore(DIPO-16): ${"a".repeat(100)}`,
    ...TYPES.map((type) => `${type}(DIPO-7): every type is accepted`),
  ];

  for (const title of valid) {
    it(`accepts ${JSON.stringify(title)}`, () => {
      expect(checkPrTitle(title)).toEqual({ ok: true });
    });
  }

  const invalid: Array<[string, string]> = [
    ["missing scope", "feat: stream worker events"],
    ["old story style", "DIPO-1: Language, runtime and project structure (ADR 0004)"],
    ["wrong type", "feature(DIPO-21): stream worker events"],
    ["uppercase type", "Feat(DIPO-21): stream worker events"],
    ["trailing period", "feat(DIPO-21): stream worker events."],
    ["101-character subject", `chore(DIPO-16): ${"a".repeat(101)}`],
    ["empty subject", "feat(DIPO-21): "],
    ["no space after colon", "feat(DIPO-21):stream worker events"],
    ["leading whitespace in subject", "feat(DIPO-21):  stream worker events"],
    ["trailing whitespace", "feat(DIPO-21): stream worker events "],
    ["second line", "feat(DIPO-21): stream worker events\nmore"],
    ["GitHub revert title", 'Revert "feat(DIPO-21): stream worker events"'],
    ["unknown scope", "feat(engine): stream worker events"],
    ["lowercase story scope", "feat(dipo-21): stream worker events"],
    ["story number zero", "feat(DIPO-0): stream worker events"],
    ["empty story sub-number", "feat(DIPO-21.): stream worker events"],
    ["empty scope", "feat(): stream worker events"],
    ["deps with feat", "feat(deps): add a dependency"],
    ["main with feat", "feat(main): release 0.3.0"],
    ["breaking marker before scope", "feat!(DIPO-21): stream worker events"],
  ];

  for (const [name, title] of invalid) {
    it(`rejects ${name}`, () => {
      expect(checkPrTitle(title).ok).toBe(false);
    });
  }
});

function runScript(title: string | undefined): number {
  const env: Record<string, string> = { PATH: process.env["PATH"] ?? "" };
  if (title !== undefined) env["PR_TITLE"] = title;
  const result = Bun.spawnSync([process.execPath, SCRIPT], { env, stdout: "pipe", stderr: "pipe" });
  return result.exitCode;
}

describe("check-pr-title script", () => {
  it("exits 0 for a valid title", () => {
    expect(runScript("chore(DIPO-16): bootstrap the Bun workspace")).toBe(0);
  });

  it("exits 1 for an invalid title", () => {
    expect(runScript("DIPO-99: test")).toBe(1);
  });

  it("exits 2 when PR_TITLE is not set", () => {
    expect(runScript(undefined)).toBe(2);
  });
});
