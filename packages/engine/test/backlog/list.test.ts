// A whole Backlog list (DIPO-323): `--count` output parses to one number or not at all, and
// `listAll` reads the list and its count once more on a mismatch before it fails.

import { describe, expect, it } from "bun:test";

import type { Spawn } from "@dipsaus-orchestrator/contract";

import {
  BacklogListIncompleteError,
  LIST_ATTEMPTS,
  listAll,
  parseCount,
} from "../../src/backlog/list";
import { BacklogParseError } from "../../src/backlog/plain";

const WHOLE = "To Do:\n  TASK-1 - One\n  TASK-2 - Two\n\nDone:\n  TASK-3 - Three\n\n";
const CUT = WHOLE.slice(0, WHOLE.indexOf("Done:"));

describe("parseCount", () => {
  it("reads one number, with or without a final newline", () => {
    expect(parseCount("285\n")).toBe(285);
    expect(parseCount("0\n")).toBe(0);
    expect(parseCount("7")).toBe(7);
  });

  for (const [what, output] of [
    ["text after the digits", "12abc\n"],
    ["two lines", "12\n13\n"],
    ["a blank output", ""],
    ["only blank lines", "\n  \n"],
    ["a negative number", "-1\n"],
  ] as const) {
    it(`refuses ${what}`, () => {
      expect(() => parseCount(output)).toThrow(BacklogParseError);
    });
  }
});

/** A CLI whose `task list` prints `lists[n]` on its n-th call (the last one after that). */
function fakeCli(lists: readonly string[], count = 3): { spawn: Spawn; calls: string[][] } {
  const calls: string[][] = [];
  let listed = 0;
  const spawn: Spawn = ({ cmd }) => {
    const args = cmd.slice(1);
    calls.push(args);
    const stdout = args.includes("--count")
      ? `${count}\n`
      : (lists[Math.min(listed++, lists.length - 1)] ?? "");
    return {
      pid: 1,
      stdin: null,
      stdout: new Response(stdout).body as ReadableStream<Uint8Array>,
      stderr: new Response("").body as ReadableStream<Uint8Array>,
      exited: Promise.resolve({ code: 0, signal: null }),
      kill: () => {},
    };
  };
  return { spawn, calls };
}

const LIST = ["task", "list", "--plain"];
const COUNT = [...LIST, "--count"];

describe("listAll", () => {
  it("reads the list and its count once when they agree", async () => {
    const cli = fakeCli([WHOLE]);
    const list = await listAll(cli, "/w", "task");
    expect(list.entries.map((entry) => entry.id)).toEqual(["TASK-1", "TASK-2", "TASK-3"]);
    expect(cli.calls).toEqual([LIST, COUNT]);
  });

  it("recovers when the second read agrees after a cut first list", async () => {
    const cli = fakeCli([CUT, WHOLE]);
    const list = await listAll(cli, "/w", "task");
    expect(list.entries.map((entry) => entry.id)).toEqual(["TASK-1", "TASK-2", "TASK-3"]);
    expect(cli.calls).toEqual([LIST, COUNT, LIST, COUNT]);
  });

  it("fails after a second mismatch, with both numbers", async () => {
    const cli = fakeCli([CUT, CUT, WHOLE]);
    const read = listAll({ ...cli, command: ["backlog"] }, "/w", "task");
    await expect(read).rejects.toBeInstanceOf(BacklogListIncompleteError);
    await expect(read).rejects.toThrow(
      "`backlog task list --plain` printed 2 entries, but its --count says 3: the list is incomplete",
    );
    expect(cli.calls).toHaveLength(2 * LIST_ATTEMPTS);
  });

  it("does not read again when the count does not parse", async () => {
    const cli = fakeCli([WHOLE]);
    const spawn: Spawn = (options) => {
      const child = cli.spawn(options);
      if (!options.cmd.includes("--count")) return child;
      return { ...child, stdout: new Response("").body as ReadableStream<Uint8Array> };
    };
    await expect(listAll({ spawn }, "/w", "task")).rejects.toBeInstanceOf(BacklogParseError);
    expect(cli.calls).toEqual([LIST, COUNT]);
  });
});
