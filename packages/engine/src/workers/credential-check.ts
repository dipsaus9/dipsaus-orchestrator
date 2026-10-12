// The engine-side credential check (0008 section 2, amendment of 2026-10-12 "DIPO-43 live
// sessions"). Claude Code's permission layer denies a credential command in the worker session
// before its sandbox sees it, so the engine runs `gh auth token` and, on macOS,
// `security find-generic-password -s gh:github.com` itself, with no model, through
// `dipo daemon sandbox-exec` under the verify-kind `srt` policy (no network). Both must fail.
// Their output never reaches the engine: each runs under `/bin/sh` with stdout and stderr sent to
// /dev/null, then the shell prints one marker line with the program's exit code. The marker is
// written from inside the sandbox, so a wrapper that failed before the program ran (exit 125
// without a refusal file, an exception, a usage error) never passes as a refusal. A success holds
// the adapter (fail-closed), and so does a check that cannot run. This tests the sandbox mechanism with the engine's own policy;
// the session self-test covers the run's settings file.

import type { DipoPlatform } from "../platform/paths";
import type { StepRequest, StepResult } from "../sandbox/step";
import type { LaunchCheckFailure } from "./hold";

/** macOS's Keychain tool, a system binary at a fixed path. */
export const KEYCHAIN_TOOL = "/usr/bin/security";
/** The Keychain service under which `gh` stores the github.com token. */
export const GH_KEYCHAIN_SERVICE = "gh:github.com";
/** The `timeouts.scriptMinutes` key the check runs under. */
export const CREDENTIAL_CHECK_SCRIPT = "credential-check";
/** Minutes each credential command may take inside the sandbox. */
export const CREDENTIAL_CHECK_MINUTES = 1;
/** Exit codes of a program that never ran: not executable (126) or not found (127). */
export const DID_NOT_RUN: readonly number[] = [126, 127];

export type CredentialProbe = "gh-token" | "keychain";

/** The credential commands for `platform`; the Keychain one is macOS only. */
export function credentialCommands(
  platform: DipoPlatform,
  gh: string,
): readonly { readonly probe: CredentialProbe; readonly argv: readonly string[] }[] {
  return [
    { probe: "gh-token", argv: [gh, "auth", "token"] },
    ...(platform === "darwin"
      ? [
          {
            probe: "keychain" as const,
            argv: [KEYCHAIN_TOOL, "find-generic-password", "-s", GH_KEYCHAIN_SERVICE],
          },
        ]
      : []),
  ];
}

/** The line the shell prints inside the sandbox after the program ran. */
export const CREDENTIAL_MARKER = "dipo-credential-exit";
const MARKER_LINE = /^dipo-credential-exit (\d+)\n?$/;

/**
 * `/bin/sh` runs the program with both output streams to /dev/null, then prints
 * `dipo-credential-exit <code>`: the only output that reaches the engine.
 */
export function marked(argv: readonly string[]): [string, ...string[]] {
  return ["/bin/sh", "-c", `"$0" "$@" >/dev/null 2>&1; echo "${CREDENTIAL_MARKER} $?"`, ...argv];
}

export type CredentialCheckResult =
  | { readonly ok: true; readonly refused: Readonly<Partial<Record<CredentialProbe, number>>> }
  | { readonly ok: false; readonly failure: LaunchCheckFailure; readonly unsafe: boolean };

export interface CredentialCheckInput {
  readonly platform: DipoPlatform;
  /** The absolute, trusted `gh` (resolved outside the sandbox from the daemon's PATH). */
  readonly gh: string;
  readonly worktree: string;
  readonly mainCheckout: string;
  readonly home: string;
  readonly uid: number;
  /** The daemon's environment; the step takes only allowlisted names from it. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Runs one step inside the sandbox; `runSandboxedStep` with its deps bound. */
export type RunStep = (request: StepRequest) => Promise<StepResult>;

const TEXT: Record<CredentialProbe, string> = {
  "gh-token": "`gh auth token`",
  keychain: `\`security find-generic-password -s ${GH_KEYCHAIN_SERVICE}\``,
};

function failure(probe: CredentialProbe, detail: string, unsafe: boolean): CredentialCheckResult {
  return {
    ok: false,
    unsafe,
    failure: {
      check: "credential-check",
      key: probe,
      detail,
      fix: unsafe
        ? "Do not run workers on this machine until the sandbox blocks it."
        : "Check that the sandbox runtime can start and the program is installed, then start a run again.",
    },
  };
}

/** Pure: the verdict on one credential command's step result. */
export function judgeCredentialStep(
  probe: CredentialProbe,
  step: StepResult,
): { readonly ok: true; readonly code: number } | CredentialCheckResult {
  if (step.outcome === "startFailed") {
    return failure(probe, `the sandbox could not run ${TEXT[probe]}: ${step.reason}`, false);
  }
  if (step.timedOut || step.code === null) {
    return failure(probe, `${TEXT[probe]} did not exit inside the sandbox`, false);
  }
  // The wrapper must succeed and print exactly the marker line from inside the sandbox.
  const marker = MARKER_LINE.exec(step.stdout.text);
  if (step.code !== 0 || marker === null || step.stdout.truncated) {
    return failure(
      probe,
      `the sandbox wrapper exited ${step.code} without the marker line, so nothing shows ${TEXT[probe]} ran inside the sandbox`,
      false,
    );
  }
  const code = Number(marker[1]);
  if (code === 0) {
    return failure(
      probe,
      `${TEXT[probe]} succeeded inside the sandbox, so a sandboxed command could read the GitHub token`,
      true,
    );
  }
  if (DID_NOT_RUN.includes(code)) {
    return failure(
      probe,
      `${TEXT[probe]} was not found or not executable inside the sandbox (exit ${code}), so the token was not tested`,
      false,
    );
  }
  return { ok: true, code };
}

/** Runs every credential command for the platform inside the sandbox; all must fail. */
export async function engineCredentialCheck(
  runStep: RunStep,
  input: CredentialCheckInput,
): Promise<CredentialCheckResult> {
  const refused: Partial<Record<CredentialProbe, number>> = {};
  for (const { probe, argv } of credentialCommands(input.platform, input.gh)) {
    const step = await runStep({
      kind: "verify",
      script: CREDENTIAL_CHECK_SCRIPT,
      command: marked(argv),
      worktree: input.worktree,
      mainCheckout: input.mainCheckout,
      home: input.home,
      uid: input.uid,
      sandbox: { installCachePaths: [], registryHosts: [] },
      scriptMinutes: { [CREDENTIAL_CHECK_SCRIPT]: CREDENTIAL_CHECK_MINUTES },
      env: input.env,
    });
    const verdict = judgeCredentialStep(probe, step);
    if (!("code" in verdict)) return verdict;
    refused[probe] = verdict.code;
  }
  return { ok: true, refused };
}
