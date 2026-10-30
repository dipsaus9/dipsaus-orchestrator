// The daemon package's only export is `runDaemon(argv)` (0004, 0006 decision 2): every form of the
// binary that runs daemon-side code calls it with the arguments after `daemon` (or `self-check`),
// and it dispatches on the first one. The table below is the one place a form is added; later
// stories add more. `login` (DIPO-269) is reached as `dipo login box`, `config-migrate` as
// `dipo config migrate`.

import { tmpdir } from "node:os";

import { platformSelfChecks, RUN_ID_PATTERN } from "@dipsaus-orchestrator/engine/platform";

import { CONFIG_MIGRATE_USAGE, runConfigMigrateForm } from "./config-migrate";
import { FOREGROUND_USAGE, runForeground } from "./foreground";
import { LOGIN_USAGE, runLoginForm } from "./login";
import { defaultIo, type DaemonIo } from "./io";
import { runSelfChecks } from "./self-check";
import { runTestShellForm, TEST_SHELL_USAGE } from "./test-shell";
import { runWorkerHostForm } from "./worker-host";

type Form = {
  /** Shown in the usage message; hidden forms have none. */
  readonly usage: string | null;
  readonly run: (args: readonly string[], io: DaemonIo) => Promise<number>;
};

const FORMS: ReadonlyMap<string, Form> = new Map<string, Form>([
  ["--foreground", { usage: FOREGROUND_USAGE, run: runForeground }],
  [
    "worker-host",
    {
      usage: "dipo daemon worker-host <run-id>",
      run: async (args, io) => {
        const [runId, ...rest] = args;
        if (runId === undefined || !RUN_ID_PATTERN.test(runId) || rest.length > 0) {
          return usageError(io, "worker-host needs one run id (run_<ulid>)");
        }
        return runWorkerHostForm(runId, io);
      },
    },
  ],
  // Sets the box login in the Keychain on the maintainer's terminal (DIPO-269), as `dipo login box`.
  ["login", { usage: LOGIN_USAGE, run: (args, io) => runLoginForm(args, io) }],
  // Rewrites the office files at version 14 (0017), as `dipo config migrate`.
  [
    "config-migrate",
    { usage: CONFIG_MIGRATE_USAGE, run: (args, io) => runConfigMigrateForm(args, io) },
  ],
  // A shell in a story's test box (DIPO-309), as `dipo test shell <id>`.
  ["test-shell", { usage: TEST_SHELL_USAGE, run: (args, io) => runTestShellForm(args, io) }],
  // Hidden: the daemon side of `dipo self-check` (DIPO-17).
  [
    "self-check",
    {
      usage: null,
      run: async (_args, io) => {
        // Temporary files only under DIPO_TMP when it is set (0017).
        const tmpRoot = io.env["DIPO_TMP"] || tmpdir();
        return runSelfChecks(platformSelfChecks(tmpRoot), io.writeLine);
      },
    },
  ],
]);

function usage(): string {
  const lines = [...FORMS.values()]
    .map((form) => form.usage)
    .filter((line): line is string => line !== null);
  return `usage:\n${lines.map((line) => `  ${line}`).join("\n")}`;
}

function usageError(io: DaemonIo, message: string): number {
  io.writeError(`dipo: ${message}\n${usage()}`);
  return 2;
}

/** Runs one daemon-side form and resolves to its exit code. */
export async function runDaemon(
  argv: readonly string[],
  io: Partial<DaemonIo> = {},
): Promise<number> {
  const full: DaemonIo = { ...defaultIo, ...io };
  const [name = "", ...args] = argv;
  const form = FORMS.get(name);
  if (form === undefined) return usageError(full, `unknown daemon form ${JSON.stringify(name)}`);
  return form.run(args, full);
}
