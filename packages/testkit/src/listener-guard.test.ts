// The listener guard (DIPO-117): it is preloaded for every test, takes the counts when each test
// starts, and names each uncaught-error event whose listener count that test changed. A listener
// this file adds when it is imported, and removes after its last test, blames none of its tests.

import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { listenerChanges } from "./listener-guard";

const listener = (): void => {};
const atImport = (): void => {};

// Added at import, before any test's count: no test here fails for it.
process.on("unhandledRejection", atImport);
afterAll(() => {
  process.off("unhandledRejection", atImport);
});

describe("the uncaught-error listener guard", () => {
  it("is preloaded for every test", () => {
    const bunfig = readFileSync(resolve(import.meta.dir, "../../../bunfig.toml"), "utf8");
    expect(bunfig).toMatch(/^preload = \[.*"\.\/packages\/testkit\/src\/listener-guard\.ts".*\]$/m);
  });

  it("reports a changed listener count and nothing when the counts are back", () => {
    const baseline = { uncaughtException: 1, unhandledRejection: 0 };
    expect(listenerChanges(baseline, { uncaughtException: 1, unhandledRejection: 0 })).toEqual([]);
    expect(listenerChanges(baseline, { uncaughtException: 2, unhandledRejection: 1 })).toEqual([
      "the test changed the process's 'uncaughtException' listeners from 1 to 2",
      "the test changed the process's 'unhandledRejection' listeners from 0 to 1",
    ]);
  });

  it("sees a listener a test leaves on the real process", () => {
    const baseline = {
      uncaughtException: process.listenerCount("uncaughtException"),
      unhandledRejection: process.listenerCount("unhandledRejection"),
    };
    process.on("unhandledRejection", listener);
    try {
      expect(listenerChanges(baseline)).toHaveLength(1);
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(listenerChanges(baseline)).toEqual([]);
  });
});
