// One question path (DIPO-428 AC #2; 0001, 0020): a worker's question parks at once, whichever
// client is connected. No source file of any package names the live question route, the TUI
// presence the daemon fed the engine, or the office's question wait, nor their plumbing. One
// written exception: the office configuration's version 15 retires `timeouts.questionWaitMinutes`,
// so its retired-key entry in `config/schema.ts` names the path once, for the migration from 14.

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const PACKAGES = join(import.meta.dir, "..", "..", "..");

/** The three names of the story and their plumbing. */
const NAMES = [
  "questionRoute",
  "TuiPresence",
  "questionWaitMinutes",
  "live-question",
  "LiveQuestions",
  "setTuiPresent",
  "presenceChanged",
  "onPresenceChanged",
  "presenceMayHaveChanged",
  "questionWaitMs",
];

const SCHEMA = "engine/src/config/schema.ts";
const RETIRED_ENTRY = 'path: "timeouts.questionWaitMinutes",';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.(ts|tsx|json|md)$/.test(entry.name) ? [path] : [];
  });
}

function srcFiles(): string[] {
  return readdirSync(PACKAGES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      try {
        return sources(join(PACKAGES, entry.name, "src"));
      } catch {
        return [];
      }
    });
}

describe("no live question route (DIPO-428)", () => {
  it("scans the src folders of the packages", () => {
    const files = srcFiles().map((file) => relative(PACKAGES, file));
    expect(files).toContain("engine/src/questions/answers.ts");
    expect(files).toContain("daemon/src/server.ts");
    expect(files).toContain(SCHEMA);
  });

  it("finds none of the names in any package's src, apart from the version 15 retired key", () => {
    const found: string[] = [];
    for (const file of srcFiles()) {
      const name = relative(PACKAGES, file);
      let text = readFileSync(file, "utf8");
      if (name === SCHEMA) {
        expect(text.split(RETIRED_ENTRY)).toHaveLength(2);
        text = text.replace(RETIRED_ENTRY, "");
      }
      for (const forbidden of NAMES) {
        if (text.includes(forbidden)) found.push(`${name}: ${forbidden}`);
      }
    }
    expect(found).toEqual([]);
  });
});
