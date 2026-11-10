// The planning prompts (DIPO-480): the contract names the planning view's Ready step in words, says
// the box copy is not refreshed and a listed story is never missing, and no planning prompt names a
// key of the terminal UI.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../src/prompts");
const PLANNING_PROMPTS = [
  "contract/planning-box.md",
  "roles/planner.md",
  "task/planning.md",
  "task/planning-preferences.md",
];
const read = (file: string) => readFileSync(join(root, file), "utf8");

/** A key name as the maintainer would press it: a modifier chord or a single-letter key in backticks. */
const KEY_NAME = /\b(?:ctrl|control|alt|cmd|shift)[-+ ][a-z]\b|`[A-Za-z]`/i;

describe("the planning prompts", () => {
  it("name the Ready step in words, and say a listed story may be missing from the copy", () => {
    const contract = read("contract/planning-box.md");
    expect(contract).toContain("the planning view's Ready step");
    expect(contract).toContain("Never name a key");
    expect(contract).toContain("never refreshed");
    expect(contract).toContain('is in the list but not in the copy is never "missing"');
  });

  it("name no key of the terminal UI", () => {
    for (const file of PLANNING_PROMPTS) expect(read(file)).not.toMatch(KEY_NAME);
  });

  it("the key check fails on a key name", () => {
    for (const text of ["press ctrl-r", "press Ctrl+R", "press `r` to set Ready"]) {
      expect(text).toMatch(KEY_NAME);
    }
  });
});
