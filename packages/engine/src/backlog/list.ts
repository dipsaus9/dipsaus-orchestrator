// A whole `task list --plain` or `draft list --plain` (DIPO-323). On CI the Ready gate check now
// and then failed R13 for a Done dependency that is in the backlog: each time the one dependency
// among the last lines of the list, so the list's output reached the engine without its tail while
// the CLI exited 0. The parser also skips a line it does not know, and Backlog.md skips a task
// file it cannot read. Each way a task goes missing without an error, and a decision read from the
// list is wrong. So the list is read together with its `--count`, and the two must agree; a
// mismatch is read once more before it fails, so one cut output does not fail a check.

import { BacklogParseError, parseList, type PlainList, plainLines } from "./plain";
import { type BacklogCli, BacklogCommandError, runBacklog } from "./runner";

/** The two lists the engine reads whole. */
export type ListKind = "task" | "draft";

/** The number `<kind> list --plain --count` printed: one line with one non-negative integer. */
export function parseCount(output: string): number {
  const lines = plainLines(output).filter((line) => line.trim() !== "");
  const only = lines.length === 1 ? lines[0]?.trim() : undefined;
  if (only === undefined || !/^\d+$/.test(only)) {
    throw new BacklogParseError("--count printed no number");
  }
  return Number(only);
}

/**
 * The list printed fewer or more entries than its `--count` says. A CLI error, so every caller
 * that reports a failed CLI read reports this one; the message leaves out the list itself.
 */
export class BacklogListIncompleteError extends BacklogCommandError {
  constructor(
    command: readonly string[],
    stdout: string,
    stderr: string,
    readonly listed: number,
    readonly counted: number,
  ) {
    const reason = `printed ${listed} entries, but its --count says ${counted}: the list is incomplete`;
    super(command, 0, stdout, stderr, reason);
    this.message = `\`${command.join(" ")}\` ${reason}`;
    this.name = "BacklogListIncompleteError";
  }
}

/** How many times `listAll` reads the list and its count before it gives up on a mismatch. */
export const LIST_ATTEMPTS = 2;

/**
 * Every entry of `<kind> list --plain` in `cwd`, checked against `<kind> list --plain --count`
 * (both run at once). On a mismatch both run once more, so one cut output does not fail the read;
 * a second mismatch throws `BacklogListIncompleteError`. Throws `BacklogParseError` when an output
 * does not parse, and as `runBacklog` does when the CLI fails.
 */
export async function listAll(cli: BacklogCli, cwd: string, kind: ListKind): Promise<PlainList> {
  const args = [kind, "list", "--plain"];
  for (let attempt = 1; ; attempt++) {
    const [list, count] = await Promise.all([
      runBacklog(cli, cwd, args),
      runBacklog(cli, cwd, [...args, "--count"]),
    ]);
    const parsed = parseList(list.stdout);
    const counted = parseCount(count.stdout);
    if (parsed.entries.length === counted) return parsed;
    if (attempt >= LIST_ATTEMPTS) {
      throw new BacklogListIncompleteError(
        [...(cli.command ?? ["backlog"]), ...args],
        list.stdout,
        list.stderr,
        parsed.entries.length,
        counted,
      );
    }
  }
}
