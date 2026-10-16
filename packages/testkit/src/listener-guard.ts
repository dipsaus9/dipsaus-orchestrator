// Test preload (bunfig.toml): after every test, the test process holds as many `uncaughtException`
// and `unhandledRejection` listeners as before the first one (DIPO-117). A daemon started in this
// process without a fake `uncaughtErrors` source would put the daemon's listener on the test runner,
// where it swallows errors and drains that daemon instead of failing the test. The source scan in
// packages/daemon/test/unit/runtime-isolation.test.ts is the fast hint; this is the check that holds.

import { afterEach } from "bun:test";

export const GUARDED_EVENTS = ["uncaughtException", "unhandledRejection"] as const;

type Counts = Record<(typeof GUARDED_EVENTS)[number], number>;

const counts = (): Counts => ({
  uncaughtException: process.listenerCount("uncaughtException"),
  unhandledRejection: process.listenerCount("unhandledRejection"),
});

/** The listener changes since `baseline`, as messages; empty when none. */
export function listenerChanges(baseline: Counts, now: Counts = counts()): string[] {
  return GUARDED_EVENTS.filter((event) => now[event] !== baseline[event]).map(
    (event) =>
      `the test changed the process's '${event}' listeners from ${baseline[event]} to ${now[event]}`,
  );
}

let baseline = counts();

afterEach(() => {
  const changes = listenerChanges(baseline);
  if (changes.length === 0) return;
  // Report it on the test that left them, not on every test after it.
  baseline = counts();
  throw new Error(
    `${changes.join("; ")}. Pass a fake \`uncaughtErrors\` source to a daemon run in this process, and remove every listener a test adds.`,
  );
});
