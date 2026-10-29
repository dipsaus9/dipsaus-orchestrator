// The runner behind the daemon side of the hidden `dipo self-check` (DIPO-17). Each check probes one
// runtime feature the daemon relies on inside the compiled binary. The runner prints one line per
// check and stops at the first failure, so the failing feature is named on the last line.

import { type SelfCheck } from "@dipsaus-orchestrator/engine/platform";

export async function runSelfChecks(
  checks: readonly SelfCheck[],
  writeLine: (line: string) => void,
): Promise<number> {
  for (const check of checks) {
    try {
      await check.run();
    } catch (error) {
      writeLine(`fail ${check.name}: ${describeError(error)}`);
      return 1;
    }
    writeLine(`ok   ${check.name}`);
  }
  return 0;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
