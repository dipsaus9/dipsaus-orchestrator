// The inside of `dipo daemon sandbox-exec --policy <file> -- <cmd>` (DIPO-37; 0004, 0006 and 0008
// amendments of 2026-10-12). `srt` 0.0.79 is a process-wide singleton whose network proxy lives in
// the wrapping process, so every step gets its own process: it reads the policy file, initialises
// the bundled library once, runs the wrapped command with this process's stdin, stdout and stderr,
// forwards SIGINT, SIGTERM and SIGHUP, stays alive until the command exits, and exits with its
// code (128 + the signal number when a signal ended it).
//
// Fail-closed: an unreadable or invalid policy, a failed probe, a dependency error or warning
// (on Linux also a missing `apply-seccomp` helper) or an initialisation error refuses the run with
// exit code 125 and one `dipo sandbox-exec: refused: <reason>` line on stderr.

import { constants } from "node:os";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SandboxManager, SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
import applySeccompArm64 from "@anthropic-ai/sandbox-runtime/vendor/seccomp/arm64/apply-seccomp" with { type: "file" };
import applySeccompX64 from "@anthropic-ai/sandbox-runtime/vendor/seccomp/x64/apply-seccomp" with { type: "file" };

import { SANDBOX_REFUSED_EXIT_CODE, SANDBOX_REFUSED_MARKER } from "../sandbox/step";
import { currentPlatform } from "./paths";
import { probeSandbox } from "./sandbox";

export interface SandboxExecOptions {
  readonly policyPath: string;
  readonly command: readonly [string, ...string[]];
  readonly writeError: (line: string) => void;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

class Refusal extends Error {}

/** Quotes one argument for `/bin/sh`. */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_\-./=:@%+,]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** The embedded `apply-seccomp` for this CPU, or null on an architecture `srt` has none for. */
export function embeddedApplySeccomp(arch: string = process.arch): string | null {
  if (arch === "x64") return applySeccompX64;
  if (arch === "arm64") return applySeccompArm64;
  return null;
}

/**
 * Makes the `apply-seccomp` helper available as a real file. From source it is the vendored file
 * in `node_modules`; inside the compiled binary it is embedded under `/$bunfs/`, which bubblewrap
 * cannot execute, so it is copied into a fresh private directory that the caller removes.
 */
async function resolveApplySeccomp(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const embedded = embeddedApplySeccomp();
  if (embedded === null) throw new Refusal(`srt has no apply-seccomp helper for ${process.arch}`);
  if (!embedded.startsWith("/$bunfs/")) return { path: embedded, cleanup: noCleanup };
  const dir = await mkdtemp("/tmp/dipo-seccomp-");
  const path = join(dir, "apply-seccomp");
  try {
    await writeFile(path, new Uint8Array(await Bun.file(embedded).arrayBuffer()), { mode: 0o700 });
    await chmod(path, 0o700);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw new Refusal(`could not extract apply-seccomp: ${describe(error)}`);
  }
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function loadPolicy(policyPath: string) {
  let text: string;
  try {
    text = await readFile(policyPath, "utf8");
  } catch (error) {
    throw new Refusal(`cannot read policy ${policyPath}: ${describe(error)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Refusal(`policy ${policyPath} is not JSON: ${describe(error)}`);
  }
  const parsed = SandboxRuntimeConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Refusal(`policy ${policyPath} is not a valid srt settings file: ${issues}`);
  }
  return parsed.data;
}

async function noCleanup(): Promise<void> {}

const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Runs the command inside `srt` and resolves to the exit code for this process. */
export async function runSandboxExec(options: SandboxExecOptions): Promise<number> {
  const env = options.env ?? process.env;
  let cleanupSeccomp: () => Promise<void> = noCleanup;
  let initialised = false;
  try {
    const platform = currentPlatform();
    const config = await loadPolicy(options.policyPath);
    const probe = await probeSandbox(platform, env);
    if (!probe.ok) throw new Refusal(probe.reasons.join("; "));
    if (platform === "linux") {
      const helper = await resolveApplySeccomp();
      cleanupSeccomp = helper.cleanup;
      config.seccomp = { applyPath: helper.path };
    }

    try {
      initialised = true;
      await SandboxManager.initialize(config);
    } catch (error) {
      throw new Refusal(describe(error));
    }
    if (!SandboxManager.isSandboxingEnabled()) {
      throw new Refusal("sandboxing is not enabled on this platform");
    }
    const deps = SandboxManager.checkDependencies();
    const problems = [...deps.errors, ...deps.warnings];
    if (problems.length > 0) throw new Refusal(problems.join("; "));
    for (const warning of SandboxManager.getLinuxGlobPatternWarnings()) {
      options.writeError(`dipo sandbox-exec: warning: ${warning}`);
    }

    const wrapped = await withSrtTmpdir(env["TMPDIR"], () =>
      SandboxManager.wrapWithSandbox(options.command.map(shellQuote).join(" ")),
    ).catch((error: unknown) => {
      throw new Refusal(`srt could not wrap the command: ${describe(error)}`);
    });
    let child: Bun.Subprocess<"inherit", "inherit", "inherit">;
    try {
      child = Bun.spawn({
        cmd: ["/bin/sh", "-c", wrapped],
        env: definedOnly(env),
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
    } catch (error) {
      throw new Refusal(`could not start the sandboxed command: ${describe(error)}`);
    }
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    for (const signal of FORWARDED) process.on(signal, forward);
    try {
      await child.exited;
    } finally {
      for (const signal of FORWARDED) process.off(signal, forward);
    }
    SandboxManager.cleanupAfterCommand();
    if (child.signalCode !== null) {
      return 128 + (constants.signals[child.signalCode] ?? 0);
    }
    return child.exitCode ?? 1;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    options.writeError(`${SANDBOX_REFUSED_MARKER}${error.message}`);
    return SANDBOX_REFUSED_EXIT_CODE;
  } finally {
    if (initialised) await SandboxManager.reset().catch(() => undefined);
    await cleanupSeccomp().catch(() => undefined);
  }
}

/**
 * `srt` sets the wrapped command's `TMPDIR` to `CLAUDE_CODE_TMPDIR` of the wrapping process, or to
 * `/tmp/claude`. Pointing it at the step's own `TMPDIR` keeps the step temp root as the temp
 * directory inside the sandbox.
 */
async function withSrtTmpdir<T>(tmpdir: string | undefined, fn: () => Promise<T>): Promise<T> {
  const name = "CLAUDE_CODE_TMPDIR";
  const saved = process.env[name];
  if (tmpdir !== undefined && tmpdir !== "") process.env[name] = tmpdir;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

function definedOnly(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) out[name] = value;
  return out;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
