// Code cites ADRs by number only and tells what it does now (0003): no source file names an ADR
// section, rule or line, and no comment tells how the code came to be ("amendment of", "since
// DIPO-n"). Such text goes stale when an ADR is rewritten, and agents act on it. Every `.ts`,
// `.tsx` and `.js` file under `packages/*/src`, `packages/*/test`, `scripts`, `tools` and `test`
// is read, comments, strings and test names alike. Generated JSON (the contract and office
// schemas) and the committed worker recordings (`.json` and `.jsonl`) are not read; this file is
// left out because it holds the patterns.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

const REPO = join(import.meta.dir, "..", "..");
const ROOTS = ["packages/*/src", "packages/*/test", "scripts", "tools", "test"];
const SELF = "test/lint-boundaries/adr-citations.test.ts";

/** An ADR number: four digits with a leading zero, not after `RFC `, so years and RFCs pass. */
const ADR = String.raw`(?<!RFC )\b0\d{3}`;

/** Each refused form, with what it is. */
const PATTERNS: readonly (readonly [RegExp, string])[] = [
  [new RegExp(String.raw`${ADR}(?:'s)? sections?\b`), "an ADR section"],
  [new RegExp(String.raw`${ADR}(?:'s)? (?:rules?|sources?|decisions?) \d`), "an ADR rule"],
  [new RegExp(String.raw`\b(?:sections?|rules?) \d+[a-z]? of 0\d{3}\b`), "an ADR section"],
  [/§/, "a section sign"],
  [new RegExp(String.raw`(?<![\w:.])0\d{3}:\d+(?![\w:])`), "an ADR line"],
  [new RegExp(String.raw`${ADR}-[a-z0-9-]+\.md:\d`), "an ADR line"],
  [/\bamendments?\b|\bamended by\b/i, "history (an amendment)"],
  [/\b(?:since|before|added by) DIPO-\d/i, "history (a story)"],
  [/\bearlier binar(?:y|ies)\b/i, "history (an earlier binary)"],
  [/\bformerly\b/i, "history (formerly)"],
];

/** The forms `line` holds, by name. */
function refused(line: string): string[] {
  return PATTERNS.filter(([pattern]) => pattern.test(line)).map(([, what]) => what);
}

/** Every source file under the roots, relative to the repository. */
function sources(): string[] {
  return ROOTS.flatMap((root) => [
    ...new Bun.Glob(`${root}/**/*.{ts,tsx,js}`).scanSync({ cwd: REPO, onlyFiles: true }),
  ])
    .filter((path) => !path.includes("node_modules/") && path !== SELF)
    .toSorted();
}

describe("ADR citations and history in code (0003)", () => {
  it("knows each refused form and lets the look-alikes pass", () => {
    const missed = [
      "// (0008 section 6)",
      "// 0005 sections 3, 8 and 9",
      "// (DIPO-149; 0019 section",
      "// the grammar of 0016 rule 1",
      "// rule 1 of 0016",
      "// see §6",
      "// 0008:170",
      "// 0001-foundational-decisions.md:26",
      "// (0004 amendment of 2026-10-12)",
      "// 0009, as amended by DIPO-81",
      "// since DIPO-240 every run is a box run",
      "// made before DIPO-374",
      "// a host an earlier binary started",
      "// formerly the hold",
    ].filter((line) => refused(line).length === 0);
    expect(missed).toEqual([]);
    const wronglyRefused = [
      "// (0008)",
      "// (0012 F16, R05)",
      "/** One masked client text frame (RFC 6455 section 5.2). */",
      "// RFC 9110 section 9.3, RFC 0793 section 3",
      '["2001:0:4136:e378:8000:63bf:3fff:fdd2", "Teredo"],',
      '["/bin/chown", "-R", "1000:1000", "--", stage]',
      'reason: "amend",',
      "// the Ready gate rule R05 of 0012",
      "// one section per engine-derived column",
    ].filter((line) => refused(line).length > 0);
    expect(wronglyRefused).toEqual([]);
  });

  it("finds the source files of every root", () => {
    const all = sources();
    const roots = ["packages/engine/src/", "packages/cli/test/", "scripts/", "tools/", "test/"];
    expect(roots.filter((root) => !all.some((path) => path.startsWith(root)))).toEqual([]);
    expect(all).not.toContain(SELF);
  });

  it("are absent from every source file", () => {
    const found: string[] = [];
    for (const path of sources()) {
      readFileSync(join(REPO, path), "utf8")
        .split("\n")
        .forEach((line, index) => {
          const what = refused(line);
          if (what.length > 0)
            found.push(`${path}:${index + 1}: ${what.join(", ")}: ${line.trim()}`);
        });
    }
    // Cite an ADR by its number alone, as (0008), and say what the code does now (0003).
    expect(found).toEqual([]);
  });
});
