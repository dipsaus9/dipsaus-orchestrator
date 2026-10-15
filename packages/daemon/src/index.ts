// The daemon package's only export is `runDaemon(argv)` (0004, 0006 decision 2): every form of the
// binary that runs daemon-side code calls it with the arguments after `daemon` (or `self-check`),
// and it dispatches on the first one. The table below is the one place a form is added; later
// stories add more. `hook` (DIPO-59) is reached as `dipo hook <event>`, `restore` (DIPO-76) as
// `dipo restore <file>`.

import { tmpdir } from "node:os";

import { platformSelfChecks, RUN_ID_PATTERN } from "@dipsaus-orchestrator/engine";

import { FOREGROUND_USAGE, runForeground } from "./foreground";
import { runHookForm } from "./hook";
import { RESTORE_USAGE, runRestoreForm } from "./restore";
import { runSafeChainGateForm } from "./safe-chain-gate";
import { runSandboxExecForm } from "./sandbox-exec";
import { defaultIo, type DaemonIo } from "./io";
import { runSelfChecks } from "./self-check";
import { runWaitPidForm } from "./wait-pid";
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
  [
    "wait-pid",
    {
      usage: "dipo daemon wait-pid <pid>",
      run: async (args, io) => {
        const [pid, ...rest] = args;
        if (pid === undefined || !/^[1-9]\d*$/.test(pid) || rest.length > 0) {
          return usageError(io, "wait-pid needs one process id");
        }
        return runWaitPidForm(Number(pid), io);
      },
    },
  ],
  // Hidden: relays a worker hook payload to its worker host (DIPO-59). The CLI routes `dipo hook <event>`
  // here.
  ["hook", { usage: null, run: runHookForm }],
  // Offline maintenance outside the contract (0006 amendment of 2026-10-12, DIPO-76).
  ["restore", { usage: RESTORE_USAGE, run: (args, io) => runRestoreForm(args, io) }],
  // Hidden: runs one engine step inside the bundled sandbox runtime (DIPO-37).
  ["sandbox-exec", { usage: null, run: runSandboxExecForm }],
  // Hidden: the gate of the Safe-Chain checking proxy, inside its own sandbox (DIPO-84).
  ["safe-chain-gate", { usage: null, run: (args, io) => runSafeChainGateForm(args, io) }],
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
