// The hidden form `dipo daemon sandbox-exec --policy <file> [--cwd <dir>] -- <cmd> [args...]`
// (DIPO-37; 0006 amendment of 2026-10-12): one engine step inside the bundled `srt` library, one
// process per step, alive while the command runs. The engine's `platform/sandbox.ts` is its only
// caller; it starts this process in `/` and names the worktree with `--cwd`.

import { runSandboxExec } from "@dipsaus-orchestrator/engine";

import type { DaemonIo } from "./io";

export const SANDBOX_EXEC_USAGE =
  "dipo daemon sandbox-exec --policy <file> [--cwd <dir>] -- <cmd> [args...]";

export type SandboxExecArgs = {
  policyPath: string;
  cwd: string | undefined;
  command: [string, ...string[]];
};

/** Parses `--policy <file> [--cwd <dir>] -- <cmd> [args...]`; null when the arguments do not match. */
export function parseSandboxExecArgs(args: readonly string[]): SandboxExecArgs | null {
  const [flag, policyPath, ...after] = args;
  if (flag !== "--policy" || policyPath === undefined || policyPath === "") return null;
  let rest = after;
  let cwd: string | undefined;
  if (rest[0] === "--cwd") {
    cwd = rest[1];
    if (cwd === undefined || !cwd.startsWith("/")) return null;
    rest = rest.slice(2);
  }
  const [separator, program, ...commandArgs] = rest;
  if (separator !== "--" || program === undefined || program === "") return null;
  return { policyPath, cwd, command: [program, ...commandArgs] };
}

export async function runSandboxExecForm(args: readonly string[], io: DaemonIo): Promise<number> {
  const parsed = parseSandboxExecArgs(args);
  if (parsed === null) {
    io.writeError(`dipo: usage: ${SANDBOX_EXEC_USAGE}`);
    return 2;
  }
  return runSandboxExec({ ...parsed, writeError: io.writeError, env: io.env });
}
