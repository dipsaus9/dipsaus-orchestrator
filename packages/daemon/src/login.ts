// `dipo login box` (DIPO-269, 0021 section 4): sets or replaces the subscription token the model
// proxy adds to a box's model requests. It runs `security` on the maintainer's terminal, which asks
// for the token itself, so the token never passes through dipo: not its arguments, not its memory,
// not its output. It refuses without a terminal, so a token is never piped in from a script or a
// shell history.

import {
  passwdHome,
  storeBoxToken,
  systemSpawnInteractive,
  TOKEN_KEYCHAIN_ACCOUNT,
  TOKEN_KEYCHAIN_SERVICE,
  type SpawnInteractive,
} from "@dipsaus-orchestrator/engine";

import type { DaemonIo } from "./io";

export const LOGIN_USAGE = "dipo login box";

export interface LoginFormOptions {
  readonly spawnInteractive?: SpawnInteractive;
  /** True when stdin is a terminal; `process.stdin.isTTY` by default. */
  readonly isTerminal?: () => boolean;
  /** The maintainer's home folder, for the Keychain `security` opens; the passwd entry by default. */
  readonly home?: () => string;
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
  const result = await storeBoxToken({
    spawnInteractive: options.spawnInteractive ?? systemSpawnInteractive,
    env: { PATH: "/usr/bin:/bin", HOME: (options.home ?? passwdHome)() },
  });
  if (!result.ok) {
    io.writeError(`dipo: ${result.reason}`);
    return 1;
  }
  io.writeLine(
    `dipo: stored the box login in the Keychain (service ${TOKEN_KEYCHAIN_SERVICE}, account ${TOKEN_KEYCHAIN_ACCOUNT}).`,
  );
  return 0;
}
