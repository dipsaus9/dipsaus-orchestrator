// A guard that skips a test on some machines (DIPO-191). A skipped test shows as skipped, but a
// verify run in the worker sandbox prints only its pass count, so a skip also writes one line
// naming the guard and the reason to stderr, where the run's output can show it.

/** Writes one line to stderr. */
function writeStderrLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Returns `runs`, the guard's condition, for `it.skipIf(!guardRuns(...))`. When `runs` is false
 * the test is skipped, and this writes one line naming `name` and `reason` through `write`.
 */
export function guardRuns(
  name: string,
  reason: string,
  runs: boolean,
  write: (line: string) => void = writeStderrLine,
): boolean {
  if (!runs) write(`skipped by guard ${name}: ${reason}`);
  return runs;
}
