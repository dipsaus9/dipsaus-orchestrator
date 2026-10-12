// The Backlog.md version check (0010 section 1, 0017; 0016 amendment of 2026-10-12): the engine
// supports Backlog.md 1.53.x and checks `backlog --version` as an office load step. Any other
// version refuses the office with a notice naming it and the install command. A new minor is
// adopted by recording new `--plain` fixtures and passing the parser tests.

import type { LoadStep, LoadStepResult } from "../office/steps";

import { type BacklogCli, BacklogCommandError, runBacklog } from "./runner";

/** The supported major and minor; any patch is accepted. */
export const SUPPORTED_VERSION = { major: 1, minor: 53 } as const;
/** The install command the refusal names. */
export const INSTALL_COMMAND = "bun add -g backlog.md@1.53.0";
/** The load step's name in the registry. */
export const VERSION_STEP = "backlog.version";

/** Checks the output of `backlog --version`. */
export function checkVersion(output: string): LoadStepResult & { version?: string } {
  const text = output.trim();
  const match = /^v?(\d+)\.(\d+)\.(\d+)\S*$/.exec(text);
  if (match === null) {
    return {
      ok: false,
      reason: `\`backlog --version\` printed ${JSON.stringify(text)}, not a version; dipo needs Backlog.md 1.53.x. Install it with \`${INSTALL_COMMAND}\`.`,
    };
  }
  const version = text.replace(/^v/, "");
  if (
    Number(match[1]) !== SUPPORTED_VERSION.major ||
    Number(match[2]) !== SUPPORTED_VERSION.minor
  ) {
    return {
      ok: false,
      reason: `Backlog.md ${version} is not supported; dipo needs 1.53.x. Install it with \`${INSTALL_COMMAND}\`.`,
    };
  }
  return { ok: true, version };
}

/** The load step: runs `backlog --version` in the office's git directory and checks it. */
export function versionStep(cli: BacklogCli): LoadStep {
  return async (ctx) => {
    try {
      // `--version` reads no project; the common directory keeps it out of the main checkout.
      const { stdout } = await runBacklog(cli, ctx.commonDir, ["--version"]);
      const result = checkVersion(stdout);
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    } catch (error) {
      if (!(error instanceof BacklogCommandError)) throw error;
      return {
        ok: false,
        reason: `${error.message}. dipo needs Backlog.md 1.53.x; install it with \`${INSTALL_COMMAND}\`.`,
      };
    }
  };
}
