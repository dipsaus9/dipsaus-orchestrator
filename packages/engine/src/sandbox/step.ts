// One engine step on worker-written code (install, setup, verify; 0008 section 2, 0010, 0014): the
// step runs inside the bundled `srt` through `dipo daemon sandbox-exec`, under a per-step policy,
// in a fresh temp root, with an allowlisted environment, the script's timeout from
// `timeouts.scriptMinutes`, and its output captured for storage. Fail-closed: when the sandbox is
// missing, fails its probe or refuses to start, the step returns `startFailed` with the reason and
// the command never runs unsandboxed.

import type { ChildProcess, Clock, TimerHandle } from "@dipsaus-orchestrator/contract";

import type { DipoPlatform } from "../platform/paths";
import { stepEnv } from "./env";
import { translatePolicy, type SrtSettings, type StepPolicyKind } from "./policy";
import type { ProbeResult } from "./probe";

/** Exit code of `dipo daemon sandbox-exec` when it refuses to run the command. */
export const SANDBOX_REFUSED_EXIT_CODE = 125;

/** Prefix of the stderr line `dipo daemon sandbox-exec` writes when it refuses. */
export const SANDBOX_REFUSED_MARKER = "dipo sandbox-exec: refused: ";

/** Time between SIGTERM and SIGKILL when a step overruns its timeout. */
export const KILL_GRACE_MS = 5000;

/** Bytes kept of each output stream; past this the head is dropped and the tail kept. */
export const OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

/** What a step needs from the machine; `systemSandboxHost` in the platform module is the real one. */
export interface SandboxHost {
  /** Runs the probe with the step's PATH. */
  probe(env: Readonly<Record<string, string>>): Promise<ProbeResult>;
  /** Creates a fresh, private temp root `/tmp/dipo-s-<id>`. */
  createTempRoot(): Promise<string>;
  /** Removes a temp root and its policy file. */
  removeTempRoot(tempRoot: string): Promise<void>;
  /** Writes the settings file for a temp root and returns its path. */
  writePolicy(tempRoot: string, settings: SrtSettings): Promise<string>;
  /** Spawns `dipo daemon sandbox-exec --policy <file> -- <command>`. */
  start(options: {
    readonly policyPath: string;
    readonly command: readonly [string, ...string[]];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
  }): ChildProcess;
}

export interface StepDeps {
  readonly clock: Clock;
  readonly platform: DipoPlatform;
  readonly host: SandboxHost;
}

export interface StepRequest {
  readonly kind: StepPolicyKind;
  /** Script name whose `timeouts.scriptMinutes` entry bounds the step, such as `install`. */
  readonly script: string;
  readonly command: readonly [string, ...string[]];
  readonly worktree: string;
  readonly mainCheckout: string;
  readonly home: string;
  readonly sandbox: {
    readonly toolchainPaths: readonly string[];
    readonly registryHosts: readonly string[];
  };
  readonly scriptMinutes: Readonly<Record<string, number>>;
  /** The daemon's environment; only allowlisted names pass. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Variables the engine sets for the step, such as ports. */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

export interface CapturedOutput {
  readonly text: string;
  /** True when the head was dropped to stay under `OUTPUT_LIMIT_BYTES`. */
  readonly truncated: boolean;
}

export type StepResult =
  | { readonly outcome: "startFailed"; readonly reason: string }
  | {
      readonly outcome: "exited";
      /** Exit code, or null when the step ended by a signal. */
      readonly code: number | null;
      readonly signal: string | null;
      readonly timedOut: boolean;
      readonly stdout: CapturedOutput;
      readonly stderr: CapturedOutput;
      /** Policy paths that could not be translated (globs on Linux). */
      readonly warnings: readonly string[];
    };

/** Runs one step inside the sandbox. Never throws for a sandbox problem: that is `startFailed`. */
export async function runSandboxedStep(deps: StepDeps, request: StepRequest): Promise<StepResult> {
  const minutes = request.scriptMinutes[request.script];
  if (minutes === undefined || !(minutes > 0)) {
    return startFailed(`no timeouts.scriptMinutes entry for script ${request.script}`);
  }

  let tempRoot: string;
  try {
    tempRoot = await deps.host.createTempRoot();
  } catch (error) {
    return startFailed(`could not create the step temp root: ${message(error)}`);
  }
  try {
    const env = stepEnv(request.env, tempRoot, request.extraEnv);
    let probe: ProbeResult;
    try {
      probe = await deps.host.probe(env);
    } catch (error) {
      return startFailed(`sandbox probe failed: ${message(error)}`);
    }
    if (!probe.ok) return startFailed(`sandbox unavailable: ${probe.reasons.join("; ")}`);

    const { settings, warnings } = translatePolicy({
      platform: deps.platform,
      kind: request.kind,
      home: request.home,
      mainCheckout: request.mainCheckout,
      worktree: request.worktree,
      tempRoot,
      toolchainPaths: request.sandbox.toolchainPaths,
      registryHosts: request.sandbox.registryHosts,
    });

    let child: ChildProcess;
    try {
      const policyPath = await deps.host.writePolicy(tempRoot, settings);
      child = deps.host.start({ policyPath, command: request.command, cwd: request.worktree, env });
    } catch (error) {
      return startFailed(`could not start dipo daemon sandbox-exec: ${message(error)}`);
    }

    let timedOut = false;
    let killTimer: TimerHandle | undefined;
    const timeoutTimer = deps.clock.setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = deps.clock.setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, minutes * 60_000);

    const [stdout, stderr, exit] = await Promise.all([
      capture(child.stdout),
      capture(child.stderr),
      child.exited,
    ]);
    deps.clock.clearTimeout(timeoutTimer);
    if (killTimer !== undefined) deps.clock.clearTimeout(killTimer);

    const refusal = refusalReason(exit.code, stderr.text);
    if (refusal !== null) return startFailed(refusal);
    return {
      outcome: "exited",
      code: exit.code,
      signal: exit.signal,
      timedOut,
      stdout,
      stderr,
      warnings,
    };
  } finally {
    await deps.host.removeTempRoot(tempRoot).catch(() => undefined);
  }
}

/** The reason `dipo daemon sandbox-exec` gave when it refused, or null when it ran the command. */
export function refusalReason(code: number | null, stderr: string): string | null {
  if (code !== SANDBOX_REFUSED_EXIT_CODE) return null;
  const line = stderr.split("\n").find((l) => l.startsWith(SANDBOX_REFUSED_MARKER));
  if (line === undefined) return null;
  return `sandbox refused to start: ${line.slice(SANDBOX_REFUSED_MARKER.length)}`;
}

function startFailed(reason: string): StepResult {
  return { outcome: "startFailed", reason };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads a stream to the end, keeping at most `limit` bytes of its tail. */
export async function capture(
  stream: ReadableStream<Uint8Array>,
  limit: number = OUTPUT_LIMIT_BYTES,
): Promise<CapturedOutput> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of stream) {
    chunks.push(chunk);
    size += chunk.byteLength;
    while (size > limit && chunks.length > 0) {
      const head = chunks[0] as Uint8Array;
      const excess = size - limit;
      truncated = true;
      if (head.byteLength <= excess) {
        chunks.shift();
        size -= head.byteLength;
      } else {
        chunks[0] = head.subarray(excess);
        size -= excess;
      }
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}
