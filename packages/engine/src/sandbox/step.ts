// What `dipo daemon sandbox-exec` and its callers share (DIPO-37, 0008 section 2): the exit code and
// the refusal file of a run it refuses, and the kill grace. The engine steps on worker-written code
// (install, setup, verify) that once ran through it went with the Mac worker path (DIPO-240): a
// developer's install and verify run in its box. Only the Safe-Chain checking proxy runs in
// `sandbox-exec` now (DIPO-84).

/** Exit code of `dipo daemon sandbox-exec` when it refuses to run the command. */
export const SANDBOX_REFUSED_EXIT_CODE = 125;

/** Prefix of the stderr line `dipo daemon sandbox-exec` writes when it refuses (for people). */
export const SANDBOX_REFUSED_MARKER = "dipo sandbox-exec: refused: ";

/** The refusal file of a policy: `sandbox-exec` writes the reason there, outside the temp root. */
export function refusalPathFor(policyPath: string): string {
  return `${policyPath}.refused`;
}

/** Time between SIGTERM and SIGKILL when a sandboxed command overruns its deadline. */
export const KILL_GRACE_MS = 5000;
