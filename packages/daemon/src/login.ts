// `dipo login box` (DIPO-269, 0021 section 4): sets or replaces the subscription token the model
// proxy adds to a box's model requests. It runs `security` on the maintainer's terminal, which asks
// for the token itself, so the token never passes through dipo: not its arguments, not its memory,
// not its output. It refuses without a terminal, so a token is never piped in from a script or a
// shell history.
//
// Once the token is stored, it removes the box-token hold's record from dipo's state directory
// (DIPO-271): a hold for a token found in a box stays until the token is replaced, and a running
// daemon lifts it at its next look at the record. A failed store keeps the record.

import {
  boxTokenHoldPath,
  clearBoxTokenHold,
  passwdHome,
  resolveSoftwareDirs,
  storeBoxToken,
  systemSpawnInteractive,
  TOKEN_KEYCHAIN_ACCOUNT,
  TOKEN_KEYCHAIN_SERVICE,
  type SpawnInteractive,
} from "@dipsaus-orchestrator/engine/platform";

import type { DaemonIo } from "./io";

export const LOGIN_USAGE = "dipo login box";

export interface LoginFormOptions {
  readonly spawnInteractive?: SpawnInteractive;
  /** True when stdin is a terminal; `process.stdin.isTTY` by default. */
  readonly isTerminal?: () => boolean;
  /** The maintainer's home folder, for the Keychain `security` opens; the passwd entry by default. */
  readonly home?: () => string;
  /** dipo's state directory, which holds the box-token hold's record; the daemon's by default. */
  readonly stateDir?: () => string;
}

/** Runs `dipo login <what>`; resolves to the exit code. */
export async function runLoginForm(
  args: readonly string[],
  io: DaemonIo,
  options: LoginFormOptions = {},
): Promise<number> {
  if (args.length !== 1 || args[0] !== "box") {
    io.writeError(`dipo: login sets the box login only\nusage: ${LOGIN_USAGE}`);
    return 2;
  }
  const isTerminal = options.isTerminal ?? (() => process.stdin.isTTY === true);
  if (!isTerminal()) {
    io.writeError(
      "dipo: login box needs a terminal: the Keychain asks for the token there, so it is never piped in.",
    );
    return 2;
  }
  io.writeError(
    [
      "dipo: paste the token from `claude setup-token` at the prompt below.",
      "dipo: the Keychain asks for it (it may ask twice) and shows nothing as you type; dipo never sees it.",
    ].join("\n"),
  );
  const home = (options.home ?? passwdHome)();
  const result = await storeBoxToken({
    spawnInteractive: options.spawnInteractive ?? systemSpawnInteractive,
    env: { PATH: "/usr/bin:/bin", HOME: home },
  });
  if (!result.ok) {
    io.writeError(`dipo: ${result.reason}`);
    return 1;
  }
  io.writeLine(
    `dipo: stored the box login in the Keychain (service ${TOKEN_KEYCHAIN_SERVICE}, account ${TOKEN_KEYCHAIN_ACCOUNT}).`,
  );
  const stateDir = options.stateDir?.() ?? resolveSoftwareDirs({ env: io.env, home }).state;
  try {
    if (clearBoxTokenHold(boxTokenHoldPath(stateDir))) {
      io.writeLine("dipo: the box-token hold is lifted; new runs may start again.");
    }
  } catch (error) {
    io.writeError(
      `dipo: the box-token hold could not be lifted (${error instanceof Error ? error.message : String(error)}); remove ${boxTokenHoldPath(stateDir)} by hand.`,
    );
    return 1;
  }
  return 0;
}
