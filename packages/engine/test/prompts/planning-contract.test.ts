// The planning prompts (DIPO-480): the contract says how a story is set Ready in words, says
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
  it("say how a story is set Ready in words, and say a listed story may be missing from the copy", () => {
    const contract = read("contract/planning-box.md");
    expect(contract).toContain("the terminal UI lists the stories that stayed Refined and why");
    expect(contract).toContain("runs the `dipo ready` command with its ID");
    expect(contract).toContain("Never name a key");
    expect(contract).toContain("never refreshed");
    expect(contract).toContain('is in the list but not in the copy is never "missing"');
  });

  it("say an edit or split may set dependencies, and never to ask the maintainer to set them by hand", () => {
    const contract = read("contract/planning-box.md");
    expect(contract).toContain("an empty dependencies list clears them");
    expect(contract).toContain("(it may set dependencies too)");
    expect(contract).toContain("Never tell the maintainer to set dependencies by hand.");
    expect(read("task/planning.md")).toContain(
      "An edit or split may set an existing story's dependencies, as the whole list; never ask the maintainer to set dependencies by hand.",
    );
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
