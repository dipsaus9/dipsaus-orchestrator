// A real daemon process for the uncaught error tests (DIPO-110, DIPO-117): `dipo daemon
// --foreground` with one extra recovery step that, by mode, leaves errors no code catches, as a
// background job without the engine's guard would:
//   reject       two rejected promises nobody handles, the second 300 ms after the first
//   timer-throw  a timer callback that throws synchronously
//   stop-throw   nothing at start; 100 ms after SIGTERM a timer callback throws
//   none         no error at all
// With a child command, the step also starts that child through the daemon's child tracker, so a
// drain waits for it, up to the drain cap. Usage: bun uncaught-daemon.ts <mode> [<cmd> <cap ms>]

import { runForeground } from "../../../src/foreground";
import { defaultIo } from "../../../src/io";

const [mode, command, cap] = process.argv.slice(2);
if (mode === undefined) throw new Error("usage: uncaught-daemon.ts <mode> [<cmd> <cap ms>]");
const capMs = cap === undefined ? 20_000 : Number(cap);
// The daemon's real clock: its timers are plain `setTimeout` callbacks, as the engine's are.
const clock = defaultIo.clock;

function failing(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

if (mode === "stop-throw") {
  process.on("SIGTERM", () => {
    clock.setTimeout(() => {
      throw failing("thrown during the drain", "EPIPE");
    }, 100);
  });
}

// As the `dipo` binary does (packages/cli/src/main.ts): the exit code is set, not forced.
process.exitCode = await runForeground(
  [],
  { ...defaultIo, version: "test" },
  {
    recoverySteps: [
      {
        name: "uncaught error",
        run: async (context) => {
          if (command !== undefined) {
            const child = context.children.spawn(["/bin/sh", "-c", command]);
            context.logger.info("test child started", { childPid: child.pid });
          }
          context.logger.info("uncaught error step started", { mode });
          if (mode === "reject") {
            void Promise.reject(failing("disk I/O error", "SQLITE_IOERR"));
            clock.setTimeout(() => {
              void Promise.reject(failing("second disk I/O error", "SQLITE_IOERR"));
            }, 300);
          } else if (mode === "timer-throw") {
            clock.setTimeout(() => {
              throw failing("no space left on device", "ENOSPC");
            }, 50);
          }
        },
      },
    ],
    drainCaps: { normalMs: capMs, stopWorkersMs: capMs },
  },
);
