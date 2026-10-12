// The daemon package's public surface is `runDaemon(argv)` (0004): every form of the binary that runs
// daemon-side code calls it, and it dispatches on the first argument. Later stories add
// `--foreground`, `worker-host`, `wait-pid`, `sandbox-exec` and `hook`.

import { tmpdir } from "node:os";

import { platformSelfChecks } from "@dipsaus-orchestrator/engine";

import { runSelfChecks } from "./self-check";

export const packageName = "@dipsaus-orchestrator/daemon";

export type DaemonIo = {
  readonly writeLine: (line: string) => void;
  readonly writeError: (line: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
};

const defaultIo: DaemonIo = {
  writeLine: (line) => process.stdout.write(`${line}\n`),
  writeError: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
};

/** Runs one daemon-side form and resolves to its exit code. */
export async function runDaemon(
  argv: readonly string[],
  io: DaemonIo = defaultIo,
): Promise<number> {
  const [form] = argv;
  switch (form) {
    case "self-check": {
      // Temporary files only under DIPO_TMP when it is set (0017).
      const tmpRoot = io.env["DIPO_TMP"] || tmpdir();
      return runSelfChecks(platformSelfChecks(tmpRoot), io.writeLine);
    }
    default:
      io.writeError(`dipo: unknown daemon form ${JSON.stringify(form ?? "")}`);
      return 2;
  }
}
