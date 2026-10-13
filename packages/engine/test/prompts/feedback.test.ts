// Verify feedback items (DIPO-47 AC #6, 0014 section 7): the failing step and command, exit
// code, last 60 output lines and `file:line` locations parsed from tsc, oxlint and bun test.

import { describe, expect, it } from "bun:test";

import { parseLocations, verifyFeedback } from "../../src/prompts";

const ROOT = "/home/maintainer/code/shop.worktrees/SHOP-12";
const ESC = String.fromCharCode(27);

const TSC = [
  "src/greet.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  "src/cli.ts(14,3): error TS2554: Expected 1 arguments, but got 0.",
].join("\n");

const TSC_PRETTY = [
  `${ESC}[96msrc/greet.ts${ESC}[0m:${ESC}[93m1${ESC}[0m:${ESC}[93m7${ESC}[0m - ${ESC}[91merror${ESC}[0m${ESC}[90m TS2322: ${ESC}[0mType 'string' is not assignable to type 'number'.`,
  "",
  `${ESC}[7m1${ESC}[0m const a: number = "x";`,
  "",
  `Found 1 error in src/greet.ts${ESC}[90m:1${ESC}[0m`,
].join("\n");

const OXLINT = [
  "src/greet.ts:1:7: warning eslint(no-unused-vars): Variable 'a' is declared but never used.",
  "src/greet.ts:2:5: error eslint(no-debugger): `debugger` statement is not allowed",
  "Found 1 warning and 1 error.",
].join("\n");

const OXLINT_GRAPHICAL = [
  "",
  "  x eslint(no-debugger): `debugger` statement is not allowed",
  "   ,-[src/cli.ts:9:3]",
  " 8 |   const flags = parse(argv);",
  " 9 |   debugger;",
  "   :   ^^^^^^^^^",
  "   `----",
  "  ! eslint(no-unused-vars): Variable 'x' is declared but never used.",
  "   ╭─[src/cli.ts:12:9]",
].join("\n");

const BUN_TEST = [
  "bun test v1.4.2 (744846f84)",
  "",
  "src/greet.test.ts:",
  '1 | import { expect, test } from "bun:test";',
  '2 | test("greets", () => {',
  '3 |   expect(greet("Ada")).toBe("Hello, Ada!");',
  "                          ^",
  "error: expect(received).toBe(expected)",
  "",
  'Expected: "Hello, Ada!"',
  'Received: "Hi Ada"',
  "",
  `      at <anonymous> (${ROOT}/src/greet.test.ts:3:24)`,
  "      at processTicksAndRejections (native:7:39)",
  `      at ${ROOT}/node_modules/some-lib/index.js:4:2`,
  "      at /usr/lib/bun/internal.js:1:1",
  "(fail) greets [0.71ms]",
  "",
  " 0 pass",
  " 1 fail",
].join("\n");

describe("location parsing", () => {
  it("reads tsc locations", () => {
    expect(parseLocations(TSC, ROOT)).toEqual([
      { file: "src/greet.ts", line: 1, column: 7 },
      { file: "src/cli.ts", line: 14, column: 3 },
    ]);
  });

  it("reads tsc --pretty locations through colour codes", () => {
    expect(parseLocations(TSC_PRETTY, ROOT)).toEqual([
      { file: "src/greet.ts", line: 1, column: 7 },
    ]);
  });

  it("reads oxlint locations in both output styles", () => {
    expect(parseLocations(OXLINT, ROOT)).toEqual([
      { file: "src/greet.ts", line: 1, column: 7 },
      { file: "src/greet.ts", line: 2, column: 5 },
    ]);
    expect(parseLocations(OXLINT_GRAPHICAL, ROOT)).toEqual([
      { file: "src/cli.ts", line: 9, column: 3 },
      { file: "src/cli.ts", line: 12, column: 9 },
    ]);
  });

  it("reads bun test frames inside the work tree only", () => {
    expect(parseLocations(BUN_TEST, ROOT)).toEqual([
      { file: "src/greet.test.ts", line: 3, column: 24 },
    ]);
  });

  it("keeps the first of duplicate locations", () => {
    expect(parseLocations(`${TSC}\n${TSC}`, ROOT)).toHaveLength(2);
  });
});

describe("verify feedback item", () => {
  it("holds the step, command, exit code, locations and output", () => {
    const item = verifyFeedback(
      { step: "test", command: "bun test", exitCode: 1, output: BUN_TEST },
      { root: ROOT },
    );
    expect(item.kind).toBe("verify");
    expect(item.step).toBe("test");
    expect(item.command).toBe("bun test");
    expect(item.exitCode).toBe(1);
    expect(item.locations).toEqual([{ file: "src/greet.test.ts", line: 3, column: 24 }]);
    expect(item.text).toStartWith(
      "Verify failed at the test step.\nCommand: bun test\nExit code: 1\nLocations:\n- src/greet.test.ts:3:24\nLast output lines:\nbun test v1.4.2",
    );
    expect(item.text).toEndWith(" 1 fail");
  });

  it("keeps the last 60 output lines with a marker", () => {
    const output = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
    const item = verifyFeedback({ step: "lint", command: "bun run lint", exitCode: 1, output });
    const tail = item.tail.split("\n");
    expect(tail[0]).toBe("[dipo: showing the last 60 of 200 output lines.]");
    expect(tail.slice(1)).toHaveLength(60);
    expect(tail[1]).toBe("line 141");
    expect(tail.at(-1)).toBe("line 200");
  });

  it("stays within the item budget, keeping the newest lines", () => {
    const output = Array.from({ length: 60 }, (_, i) => `${"x".repeat(80)} ${i + 1}`).join("\n");
    const item = verifyFeedback(
      { step: "test", command: "bun test", exitCode: 1, output },
      { itemMax: 1_000 },
    );
    expect(item.text.length).toBeLessThanOrEqual(1_000);
    expect(item.text).toEndWith(" 60");
    expect(item.tail).toStartWith("[dipo: showing the last ");
  });

  it("gives the same signature for the same failure and another for another", () => {
    const failure = { step: "typecheck", command: "tsc -b", exitCode: 2, output: TSC };
    const a = verifyFeedback(failure, { root: ROOT });
    const b = verifyFeedback({ ...failure, output: `noise\n${TSC}` }, { root: ROOT });
    const c = verifyFeedback({ ...failure, output: OXLINT }, { root: ROOT });
    expect(a.signature).toBe(b.signature);
    expect(a.signature).not.toBe(c.signature);
    expect(a.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("lists at most 20 locations and counts the rest", () => {
    const output = Array.from(
      { length: 25 },
      (_, i) => `src/a.ts(${i + 1},1): error TS1000: bad.`,
    ).join("\n");
    const item = verifyFeedback({ step: "typecheck", command: "tsc -b", exitCode: 2, output });
    expect(item.locations).toHaveLength(25);
    expect(item.text).toContain("- src/a.ts:20:1\n- and 5 more");
    expect(item.text).not.toContain("- src/a.ts:21:1");
  });
});
