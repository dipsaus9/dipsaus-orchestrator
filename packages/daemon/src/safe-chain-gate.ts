// The hidden form `dipo daemon safe-chain-gate --dir <dir>` (DIPO-84): the Safe-Chain checking
// proxy's gate. The engine's `platform/safe-chain-proxy.ts` is its only caller and always runs it
// through `dipo daemon sandbox-exec` under the proxy's own policy; it runs until its stdin closes.

import { isAbsolute } from "node:path";

import { runSafeChainGate, systemSpawn } from "@dipsaus-orchestrator/engine";

import type { DaemonIo } from "./io";

export const SAFE_CHAIN_GATE_USAGE = "dipo daemon safe-chain-gate --dir <dir>";

/** Parses `--dir <absolute dir>`; null when the arguments do not match. */
export function parseSafeChainGateArgs(args: readonly string[]): { dir: string } | null {
  const [flag, dir, ...rest] = args;
  if (flag !== "--dir" || dir === undefined || !isAbsolute(dir) || rest.length > 0) return null;
  return { dir };
}

/** Resolves when this process's stdin ends or fails. */
export function processStdinClosed(): Promise<void> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.on("data", () => {});
    stdin.once("end", () => resolve());
    stdin.once("close", () => resolve());
    stdin.once("error", () => resolve());
    stdin.resume();
  });
}

export async function runSafeChainGateForm(
  args: readonly string[],
  io: DaemonIo,
  stdinClosed: () => Promise<void> = processStdinClosed,
): Promise<number> {
  const parsed = parseSafeChainGateArgs(args);
  if (parsed === null) {
    io.writeError(`dipo: usage: ${SAFE_CHAIN_GATE_USAGE}`);
    return 2;
  }
  return runSafeChainGate({
    dir: parsed.dir,
    clock: io.clock,
    spawn: systemSpawn,
    env: io.env,
    stdinClosed: stdinClosed(),
    writeLine: io.writeLine,
    writeError: io.writeError,
  });
}
