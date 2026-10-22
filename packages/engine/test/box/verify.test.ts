// The base in the box and the verdict (DIPO-294; 0021 section 9): what a failed box verify counts
// as against the base result measured in the box (`boxVerifyVerdict`, pure), and the base verify
// itself in a fake box (`runBoxBaseVerify` on the fake backend): green, red with the failing
// tests, and the not-known results of a timeout, a kill and a box that stopped under it.

import { describe, expect, it } from "bun:test";

import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { BOX_WORKDIR } from "../../src/box/code";
import { boxName } from "../../src/box/port";
import {
  BOX_VERDICT_MAX_NAMES,
  boxVerifyVerdict,
  runBoxBaseVerify,
  type BoxBaseVerifyRequest,
} from "../../src/box/verify";
import type { BaseVerifyFacts } from "../../src/prompts/base-verify";
import { FakeBoxes, type LiveReply } from "./fake-boxes";

/** bun test output with `names` failing, its summary and the `(fail)` lines again at the end. */
export function bunFailures(names: readonly string[], extra = ""): string {
  return [
    "bun test v1.4.2",
    ...names.map((name) => `\u001b[31m(fail)\u001b[0m ${name} [1.20ms]`),
    "",
    " 10 pass",
    ` ${names.length} fail`,
    extra,
    `Ran ${10 + names.length} tests across 3 files. [1.00s]`,
    "",
    `${names.length} tests failed:`,
    ...names.map((name) => `(fail) ${name} [1.20ms]`),
  ].join("\n");
}

const NEEDS_GIT = ["git > reads the log", "worktree > adds a worktree"];
const BASE_RED: BaseVerifyFacts = { kind: "red", failing: NEEDS_GIT, tail: null };

describe("the verdict of a failed verify in the box", () => {
  it("passes when every failing test also fails at the start commit in the box", () => {
    expect(
      boxVerifyVerdict({
        code: 1,
        timedOut: false,
        output: bunFailures(NEEDS_GIT),
        base: BASE_RED,
      }),
    ).toEqual({ counts: false, baseFailures: NEEDS_GIT });
    // A subset of the base failures passes too.
    expect(
      boxVerifyVerdict({
        code: 1,
        timedOut: false,
        output: bunFailures(["git > reads the log"]),
        base: BASE_RED,
      }),
    ).toEqual({ counts: false, baseFailures: ["git > reads the log"] });
  });

  it("fails on one new failing test and names it", () => {
    const verdict = boxVerifyVerdict({
      code: 1,
      timedOut: false,
      output: bunFailures([...NEEDS_GIT, "greet > says hello"]),
      base: BASE_RED,
    });
    expect(verdict.counts).toBe(true);
    if (!verdict.counts) return;
    expect(verdict.note).toContain("this failing test does not fail at the start commit");
    expect(verdict.note).toContain("- greet > says hello");
    expect(verdict.note).not.toContain("git > reads the log");
  });

  it("caps the new failing tests it names", () => {
    const fresh = Array.from({ length: BOX_VERDICT_MAX_NAMES + 3 }, (_, i) => `new > test ${i}`);
    const verdict = boxVerifyVerdict({
      code: 1,
      timedOut: false,
      output: bunFailures(fresh),
      base: BASE_RED,
    });
    if (!verdict.counts) throw new Error("expected the failure to count");
    expect(verdict.note).toContain("[dipo: 3 more new failing tests are not listed.]");
  });

  it("fails on a lint, format or typecheck failure, which names no failing test", () => {
    for (const output of [
      "Checking formatting...\nsrc/a.ts\nFormat issues found in above 1 files.",
      "  x eslint(no-unused-vars): Variable 'x' is declared but never used.\nFound 0 warnings and 1 error.",
      "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    ]) {
      const verdict = boxVerifyVerdict({ code: 1, timedOut: false, output, base: BASE_RED });
      expect(verdict.counts).toBe(true);
      if (verdict.counts) expect(verdict.note).toContain("without a failing test name");
    }
  });

  it("fails on a crash after base failures, and on an error outside a named test", () => {
    const crash = boxVerifyVerdict({
      code: 139,
      timedOut: false,
      output: bunFailures(NEEDS_GIT),
      base: BASE_RED,
    });
    if (!crash.counts) throw new Error("expected the crash to count");
    expect(crash.note).toContain("exited with 139");

    const unhandled = boxVerifyVerdict({
      code: 1,
      timedOut: false,
      output: bunFailures(NEEDS_GIT, " 1 error\n# Unhandled error between tests"),
      base: BASE_RED,
    });
    if (!unhandled.counts) throw new Error("expected the error to count");
    expect(unhandled.note).toContain("1 error outside a named test");
  });

  it("fails on a timeout and on a kill, whatever the base", () => {
    const output = bunFailures(NEEDS_GIT);
    expect(boxVerifyVerdict({ code: null, timedOut: true, output, base: BASE_RED })).toEqual({
      counts: true,
      note: null,
    });
    expect(boxVerifyVerdict({ code: null, timedOut: false, output, base: BASE_RED }).counts).toBe(
      true,
    );
  });

  it("is strict when the base result in the box is not known", () => {
    const verdict = boxVerifyVerdict({
      code: 1,
      timedOut: false,
      output: bunFailures(NEEDS_GIT),
      base: {
        kind: "unknown",
        reason: "dipo has no verify result of the start commit in this box",
      },
    });
    expect(verdict.counts).toBe(true);
    if (verdict.counts) expect(verdict.note).toContain("is not known");
  });

  it("counts every failing test against a green base, and against a red base without names", () => {
    const output = bunFailures(NEEDS_GIT);
    expect(
      boxVerifyVerdict({ code: 1, timedOut: false, output, base: { kind: "green" } }).counts,
    ).toBe(true);
    expect(
      boxVerifyVerdict({
        code: 1,
        timedOut: false,
        output,
        base: { kind: "red", failing: [], tail: "error: cannot find module" },
      }).counts,
    ).toBe(true);
  });
});

// ---- the base verify in a fake box ---------------------------------------------------------------

const RUN = "run_01BOXBASE";
const BOX = boxName(RUN);

async function boxWith(live: (command: readonly string[]) => LiveReply): Promise<FakeBoxes> {
  const boxes = new FakeBoxes({ live: (_box, command) => live(command) });
  await boxes.create({
    runId: RUN,
    image: "dipo-box:image-1",
    network: { name: "dipo", mode: "hostOnly", hostAddress: "192.0.2.10" },
  });
  await boxes.start(BOX);
  return boxes;
}

const REQUEST: BoxBaseVerifyRequest = {
  box: BOX,
  commands: [["bun", "run", "verify"]],
  env: { DIPO_STORY: "DIPO-1", DIPO_WORKTREE: BOX_WORKDIR },
  timeoutMs: 20 * 60_000,
};

describe("the base verify in the box", () => {
  it("runs verify in /work with only the run environment and reads it green", async () => {
    const boxes = await boxWith(() => ({ stdout: " 12 pass\n" }));
    const result = await runBoxBaseVerify({ boxes, clock: new ManualClock() }, REQUEST);
    expect(result).toEqual({ facts: { kind: "green" }, ended: null });
    expect(boxes.liveExecs).toEqual([
      { box: BOX, command: ["bun", "run", "verify"], env: REQUEST.env, cwd: BOX_WORKDIR },
    ]);
  });

  it("reads the failing tests of a red verify", async () => {
    const boxes = await boxWith(() => ({ stdout: bunFailures(NEEDS_GIT), code: 1 }));
    const result = await runBoxBaseVerify({ boxes, clock: new ManualClock() }, REQUEST);
    expect(result.facts).toEqual({ kind: "red", failing: NEEDS_GIT, tail: null });
  });

  it("keeps the output's end when a red verify names no test", async () => {
    const boxes = await boxWith(() => ({ stdout: "error: Cannot find module 'oxfmt'\n", code: 1 }));
    const result = await runBoxBaseVerify({ boxes, clock: new ManualClock() }, REQUEST);
    expect(result.facts).toEqual({
      kind: "red",
      failing: [],
      tail: "error: Cannot find module 'oxfmt'",
    });
  });

  it("is not known when the box stopped under it, as a daemon stop does", async () => {
    const boxes = await boxWith(() => ({
      stdout: bunFailures(["half > ran"]),
      code: 137,
      stopsBox: true,
    }));
    const result = await runBoxBaseVerify({ boxes, clock: new ManualClock() }, REQUEST);
    expect(result.facts).toEqual({ kind: "unknown", reason: "the box stopped while verify ran" });
  });

  it("is not known past its deadline, and ends the command inside the box", async () => {
    const clock = new ManualClock();
    const boxes = await boxWith((command) => (command[0] === "bun" ? { hang: true } : { code: 0 }));
    const pending = runBoxBaseVerify({ boxes, clock }, { ...REQUEST, timeoutMs: 60_000 });
    await Promise.resolve();
    clock.advance(60_000);
    const result = await pending;
    expect(result).toEqual({
      facts: { kind: "unknown", reason: "verify timed out after 1 min" },
      ended: "killed",
    });
    // The kill inside the box ran after the client was killed.
    expect(boxes.liveExecs.map((exec) => exec.command[0])).toEqual(["bun", "/bin/sh"]);
  });

  it("is not known when the command cannot start in the box", async () => {
    const boxes = await boxWith(() => ({}));
    await boxes.stop(BOX);
    const result = await runBoxBaseVerify({ boxes, clock: new ManualClock() }, REQUEST);
    expect(result.facts).toEqual({
      kind: "unknown",
      reason: "verify could not start in the box (box.failed)",
    });
  });

  it("stops at the first failing command list", async () => {
    const boxes = await boxWith((command) =>
      command[0] === "lint" ? { stdout: "1 problem\n", code: 1 } : { stdout: "ok\n" },
    );
    const result = await runBoxBaseVerify(
      { boxes, clock: new ManualClock() },
      { ...REQUEST, commands: [["lint"], ["bun", "test"]] },
    );
    expect(result.facts).toEqual({ kind: "red", failing: [], tail: "1 problem" });
    expect(boxes.liveExecs.map((exec) => exec.command.join(" "))).toEqual(["lint"]);
  });
});
