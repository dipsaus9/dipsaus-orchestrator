// The inside of `dipo daemon sandbox-exec --policy <file> [--cwd <dir>] -- <cmd>` (DIPO-37; 0004,
// 0006 and 0008 amendments of 2026-10-12). `srt` 0.0.79 is a process-wide singleton whose network
// proxy lives in the wrapping process, so every step gets its own process: it reads the policy
// file, initialises the bundled library once, runs the wrapped command in `--cwd` with this
// process's stdin, stdout and stderr, forwards SIGINT, SIGTERM and SIGHUP, stays alive until the
// command exits, and exits with its code (128 + the signal number when a signal ended it).
//
// The engine starts this process in `/`, never in the worktree, so Bun loads nothing from there.
// The host programs srt runs outside the sandbox (`rg`, `bwrap`, `socat`) come pinned in the policy
// (or are resolved on the absolute PATH entries when the policy has none). Before srt starts, they,
// this binary and every PATH directory must lie outside every path the policy makes writable, and
// PATH may hold no relative entry. srt's own sockets and the extracted `apply-seccomp` live in a
// private 0700 directory outside the step temp root.
//
// Fail-closed: an unreadable or invalid policy, an untrusted path, a failed probe, a dependency
// error or warning (on Linux also a missing `apply-seccomp` helper) or an initialisation error
// refuses the run with exit code 125. The reason goes to `<policy>.refused` (0600), which the
// sandboxed command cannot write, and to stderr for people; the engine trusts only the file.

import { constants } from "node:os";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { SandboxManager, SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
import applySeccompArm64 from "@anthropic-ai/sandbox-runtime/vendor/seccomp/arm64/apply-seccomp" with { type: "file" };
import applySeccompX64 from "@anthropic-ai/sandbox-runtime/vendor/seccomp/x64/apply-seccomp" with { type: "file" };

import {
  coveringDenies,
  expandHome,
  globRoot,
  type SandboxTools,
  type SrtSettings,
} from "../sandbox/policy";
import { refusalPathFor, SANDBOX_REFUSED_EXIT_CODE, SANDBOX_REFUSED_MARKER } from "../sandbox/step";
import { currentPlatform, passwdHome } from "./paths";
import {
  checkTrust,
  isCompiled,
  probeSandbox,
  resolveTools,
  sourceCodeRoots,
  spellings,
} from "./sandbox";

export interface SandboxExecOptions {
  readonly policyPath: string;
  readonly command: readonly [string, ...string[]];
  /** Working directory of the command; defaults to this process's. */
  readonly cwd?: string | undefined;
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
 * cannot execute, so it is copied into the private directory.
 */
async function resolveApplySeccomp(privateDir: string): Promise<string> {
  const embedded = embeddedApplySeccomp();
  if (embedded === null) throw new Refusal(`srt has no apply-seccomp helper for ${process.arch}`);
  if (!embedded.startsWith("/$bunfs/")) return embedded;
  const path = join(privateDir, "apply-seccomp");
  try {
    await writeFile(path, new Uint8Array(await Bun.file(embedded).arrayBuffer()), { mode: 0o700 });
    await chmod(path, 0o700);
  } catch (error) {
    throw new Refusal(`could not extract apply-seccomp: ${describe(error)}`);
  }
  return path;
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

const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Runs the command inside `srt` and resolves to the exit code for this process. */
export async function runSandboxExec(options: SandboxExecOptions): Promise<number> {
  // A copy: this process's TMPDIR changes below, the command's must not.
  const env: Record<string, string> = definedOnly(options.env ?? process.env);
  let privateDir: string | null = null;
  let initialised = false;
  const savedTmpdir = process.env["TMPDIR"];
  try {
    const platform = currentPlatform();
    const config = await loadPolicy(options.policyPath);
    if (options.cwd !== undefined) {
      try {
        process.chdir(options.cwd);
      } catch (error) {
        throw new Refusal(`cannot enter ${options.cwd}: ${describe(error)}`);
      }
    }

    const homes = [env["HOME"], passwdHome()].filter((h): h is string => h !== undefined);
    const resolved = await resolveTools(platform, env["PATH"]);
    const tools: SandboxTools = {
      rg: config.ripgrep?.command ?? resolved.rg,
      bwrap: config.bwrapPath ?? resolved.bwrap,
      socat: config.socatPath ?? resolved.socat,
    };
    const view = trustView(config, homes[0] ?? "/");
    const distrust = await checkTrust({
      settings: view,
      homes,
      PATH: env["PATH"],
      tools,
      binary: process.execPath,
      // From source, Bun runs this repository's code: the step may not be able to write it.
      code: isCompiled()
        ? []
        : sourceCodeRoots(resolve(import.meta.dir, "../../../cli/src/main.ts")),
    });
    if (distrust.length > 0) throw new Refusal(`untrusted paths: ${distrust.join("; ")}`);
    // A read deny over the working directory, the temp root or a write path would hide it.
    const roots = [
      { label: "working directory", path: process.cwd() },
      ...(env["TMPDIR"] ? [{ label: "temp root", path: env["TMPDIR"] }] : []),
      ...view.filesystem.allowWrite.map((path) => ({ label: "write path", path: globRoot(path) })),
    ];
    const covered = coveringDenies(
      config.filesystem.denyRead.map((entry) =>
        typeof entry === "string" ? expandHome(entry, homes[0] ?? "/") : entry.path,
      ),
      await Promise.all(
        roots.map(async (root) => ({ label: root.label, spellings: await spellings(root.path) })),
      ),
    );
    if (covered.length > 0) throw new Refusal(`read denies hide the step: ${covered.join("; ")}`);
    if (distrust.length > 0) throw new Refusal(`untrusted paths: ${distrust.join("; ")}`);
    const probe = await probeSandbox(platform, tools);
    if (!probe.ok) throw new Refusal(probe.reasons.join("; "));
    if (tools.rg !== null) config.ripgrep = { command: tools.rg };
    if (platform === "linux") {
      if (tools.bwrap !== null) config.bwrapPath = tools.bwrap;
      if (tools.socat !== null) config.socatPath = tools.socat;
    }

    // srt puts its bridge sockets and scratch files in os.tmpdir(); keep them out of the step's
    // writable temp root.
    privateDir = await mkdtemp("/tmp/dipo-sx-");
    process.env["TMPDIR"] = privateDir;
    if (platform === "linux") {
      config.seccomp = { applyPath: await resolveApplySeccomp(privateDir) };
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
        env,
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
    await writeFile(refusalPathFor(options.policyPath), `${error.message}\n`, {
      flag: "wx",
      mode: 0o600,
    }).catch(() => undefined);
    return SANDBOX_REFUSED_EXIT_CODE;
  } finally {
    if (initialised) await SandboxManager.reset().catch(() => undefined);
    if (savedTmpdir === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = savedTmpdir;
    if (privateDir !== null) await rm(privateDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The write list of a parsed policy as absolute paths, for the trust check. */
function trustView(
  config: { filesystem: { allowWrite: (string | { path: string })[] } },
  home: string,
): SrtSettings {
  const allowWrite = config.filesystem.allowWrite.map((entry) => {
    const path = typeof entry === "string" ? entry : entry.path;
    return resolve(expandHome(path, home));
  });
  return {
    network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
    filesystem: { denyRead: [], allowWrite, denyWrite: [] },
  };
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
