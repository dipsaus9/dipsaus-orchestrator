// A real daemon process for the unhandled rejection test (DIPO-110): `dipo daemon --foreground`
// with one extra recovery step that leaves a rejected promise nobody handles, as a background job
// without the engine's guard would. Usage: bun rejecting-daemon.ts

import { runForeground } from "../../../src/foreground";
import { defaultIo } from "../../../src/io";

// As the `dipo` binary does (packages/cli/src/main.ts): the exit code is set, not forced.
process.exitCode = await runForeground(
  [],
  { ...defaultIo, version: "test" },
  {
    recoverySteps: [
      {
        name: "unguarded job",
        run: async (context) => {
          context.logger.info("unguarded job started");
          void Promise.reject(Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" }));
        },
      },
    ],
  },
);
