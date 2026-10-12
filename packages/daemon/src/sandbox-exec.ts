// The hidden form `dipo daemon sandbox-exec --policy <file> -- <cmd> [args...]` (DIPO-37; 0006
// amendment of 2026-10-12): one engine step inside the bundled `srt` library, one process per step,
// alive while the command runs. The engine's `platform/sandbox.ts` is its only caller.

import { runSandboxExec } from "@dipsaus-orchestrator/engine";

import type { DaemonIo } from "./io";

export const SANDBOX_EXEC_USAGE = "dipo daemon sandbox-exec --policy <file> -- <cmd> [args...]";

/** Parses `--policy <file> -- <cmd> [args...]`; null when the arguments do not match. */
export function parseSandboxExecArgs(
  args: readonly string[],
): { policyPath: string; command: [string, ...string[]] } | null {
  const [flag, policyPath, separator, program, ...rest] = args;
  if (flag !== "--policy" || policyPath === undefined || policyPath === "") return null;
  if (separator !== "--" || program === undefined || program === "") return null;
  return { policyPath, command: [program, ...rest] };
}

export async function runSandboxExecForm(args: readonly string[], io: DaemonIo): Promise<number> {
  const parsed = parseSandboxExecArgs(args);
  if (parsed === null) {
    io.writeError(`dipo: usage: ${SANDBOX_EXEC_USAGE}`);
    return 2;
  }
  return runSandboxExec({ ...parsed, writeError: io.writeError, env: io.env });
}
