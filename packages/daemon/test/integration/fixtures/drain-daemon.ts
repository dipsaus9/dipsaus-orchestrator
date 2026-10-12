// A real daemon process for the drain test (DIPO-68): `dipo daemon --foreground` with one extra
// recovery step that starts a child through the daemon's child tracker, and a drain cap from the
// command line. Usage: bun drain-daemon.ts <shell command> <drain cap ms>

import { runForeground } from "../../../src/foreground";
import { defaultIo } from "../../../src/io";

const [command, cap] = process.argv.slice(2);
if (command === undefined || cap === undefined)
  throw new Error("usage: drain-daemon.ts <cmd> <ms>");
const capMs = Number(cap);

const code = await runForeground(
  [],
  { ...defaultIo, version: "test" },
  {
    recoverySteps: [
      {
        name: "test child",
        run: async (context) => {
          const child = context.children.spawn(["/bin/sh", "-c", command]);
          context.logger.info("test child started", { childPid: child.pid });
        },
      },
    ],
    drainCaps: { normalMs: capMs, stopWorkersMs: capMs },
  },
);
process.exit(code);
