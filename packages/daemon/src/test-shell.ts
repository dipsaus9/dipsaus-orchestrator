// The daemon side of `dipo test shell <ID>` (DIPO-309, 0002): an interactive shell in a story's
// test box, for a product with nothing to start. The CLI finds the open test's box from
// `office.snapshot` and calls this form with the box's name. It runs Apple `container` from the
// `PATH` with the terminal as its stdio: `exec --interactive --tty` into the test box, the shell run
// contained as the box user in `/work`, like every command dipo starts in a box (`testShellArgs`).
// Only a test box's name is accepted, so it never opens a builder's box.

import {
  passwdHome,
  type SpawnInteractive,
  systemSpawnInteractive,
  testShellArgs,
} from "@dipsaus-orchestrator/engine";

import type { DaemonIo } from "./io";
import { containerOnPath } from "./runs";

export const TEST_SHELL_USAGE = "dipo daemon test-shell <test box> (as `dipo test shell <id>`)";

export interface TestShellOptions {
  readonly spawnInteractive?: SpawnInteractive;
  /** True when stdin is a terminal; `process.stdin.isTTY` by default. */
  readonly isTerminal?: () => boolean;
  /** Apple `container` by absolute path; the one on `PATH` by default. */
  readonly container?: string;
  readonly home?: () => string;
}

/** Runs `test-shell <box>`; resolves to the shell's exit code. */
export async function runTestShellForm(
  args: readonly string[],
  io: DaemonIo,
  options: TestShellOptions = {},
): Promise<number> {
  const [box, ...rest] = args;
  if (box === undefined || rest.length > 0) {
    io.writeError(`dipo: test-shell needs one test box\nusage: ${TEST_SHELL_USAGE}`);
    return 2;
  }
  let argv: string[];
  try {
    argv = testShellArgs(box);
  } catch (error) {
    io.writeError(`dipo: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const isTerminal = options.isTerminal ?? (() => process.stdin.isTTY === true);
  if (!isTerminal()) {
    io.writeError("dipo: test shell needs a terminal.");
    return 2;
  }
  const container = options.container ?? containerOnPath(io.env["PATH"]);
  if (container === undefined) {
    io.writeError("dipo: Apple container is not on the PATH, so no box can be opened.");
    return 1;
  }
  const home = (options.home ?? passwdHome)();
  const exit = await (options.spawnInteractive ?? systemSpawnInteractive)({
    cmd: [container, ...argv],
    // The `container` client's own environment; nothing of it reaches the box.
    env: { PATH: io.env["PATH"] ?? "/usr/bin:/bin", HOME: home },
  });
  return exit.code ?? 1;
}
