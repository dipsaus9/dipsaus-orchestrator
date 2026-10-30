// A starter of its own process for the lock tests (0005, DIPO-387): it prints `ready` and waits for
// a line on stdin, so several starters try at the same moment. Then it takes the lock in `<dir>`
// with its own PID, drops its own reference to the outcome and collects garbage (the lock must
// survive that), prints the outcome's kind, and holds what it took until it is killed.

import { acquireLock } from "../../../src/platform/lock";
import { systemClock } from "../../../src/platform/clock";

const [dir = ""] = process.argv.slice(2);

console.log("ready");
for await (const _ of console) break;

const { kind } = await acquireLock({
  stateDir: dir,
  self: { pid: process.pid, startTimeMs: systemClock.now(), version: "test", runtimeDir: null },
  // No process is a `dipo daemon` here: a starter that cannot take the lock reports it held.
  probe: async () => null,
  clock: systemClock,
  handshake: async () => false,
  logger: { info: () => {}, warn: () => {} },
  waitMs: 100,
  pollMs: 20,
});
Bun.gc(true);
console.log(kind);
// Holds until killed.
systemClock.setTimeout(() => {}, 86_400_000);
