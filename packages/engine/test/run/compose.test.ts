// The run services have one wiring (DIPO-129): the daemon and the run tests build them through
// `composeRuns`, and neither constructs them by hand again.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { composeRuns } from "../../src/run";

const ROOT = join(import.meta.dir, "..", "..", "..");
const SITES = [
  join(ROOT, "daemon", "src", "runs.ts"),
  join(ROOT, "engine", "test", "run", "run-office.ts"),
];
const BUILT_BY_COMPOSE = [
  "RunLauncher",
  "RunResumer",
  "RunControl",
  "RunOutcomes",
  "RunReattacher",
  "OfficeIngest",
];

describe("composeRuns", () => {
  test("is exported by the engine run feature", () => {
    expect(typeof composeRuns).toBe("function");
  });

  for (const site of SITES) {
    test(`${site.slice(ROOT.length + 1)} builds the run services through composeRuns`, () => {
      const source = readFileSync(site, "utf8");
      expect(source).toContain("composeRuns(");
      for (const name of BUILT_BY_COMPOSE) {
        expect(source).not.toMatch(new RegExp(`new ${name}\\(`));
      }
    });
  }
});
