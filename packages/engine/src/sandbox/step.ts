// One engine step on worker-written code (install, setup, verify; 0008 section 2, 0010, 0014): the
// step runs inside the bundled `srt` through `dipo daemon sandbox-exec`, under a per-step policy,
// in a fresh temp root, with an allowlisted environment, the script's timeout from
// `timeouts.scriptMinutes`, and its output captured for storage. Fail-closed: when the sandbox is
// missing, fails its probe or refuses to start, the step returns `startFailed` with the reason and
// the command never runs unsandboxed.
//
// Order matters: the host programs srt runs outside the sandbox are resolved first (nothing runs),
// checked against the paths the policy makes writable, and only then probed. A refusal counts only
// when `sandbox-exec` wrote it to the refusal file next to the policy, which the sandboxed command
// cannot write; a command that prints the refusal line and exits 125 is an ordinary failure.

import type { ChildProcess, Clock, TimerHandle } from "@dipsaus-orchestrator/contract";

import type { DipoPlatform } from "../platform/paths";
import { stepEnv } from "./env";
import {
  translatePolicy,
  type SandboxTools,
  type SrtSettings,
  type StepPolicyKind,
} from "./policy";
import type { ProbeResult } from "./probe";

/** Exit code of `dipo daemon sandbox-exec` when it refuses to run the command. */
export const SANDBOX_REFUSED_EXIT_CODE = 125;

/** Prefix of the stderr line `dipo daemon sandbox-exec` writes when it refuses (for people). */
export const SANDBOX_REFUSED_MARKER = "dipo sandbox-exec: refused: ";

/** The refusal file of a policy: `sandbox-exec` writes the reason there, outside the temp root. */
export function refusalPathFor(policyPath: string): string {
  return `${policyPath}.refused`;
}

/** Time between SIGTERM and SIGKILL when a step overruns its timeout. */
export const KILL_GRACE_MS = 5000;

/** Bytes kept of each output stream; past this the head is dropped and the tail kept. */
export const OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

/** What a step needs from the machine; `systemSandboxHost` in the platform module is the real one. */
export interface SandboxHost {
  /** Creates a fresh, private temp root `/tmp/dipo-s-<id>`. */
  createTempRoot(): Promise<string>;
  /** Removes a temp root, its policy file and its refusal file. */
  removeTempRoot(tempRoot: string): Promise<void>;
  /**
   * dipo's own state, logs and runtime directories (every runtime candidate), derived from the
   * daemon's environment with the DIPO-23 path rules; the step may not read them.
   */
  dipoDirs(daemonEnv: Readonly<Record<string, string | undefined>>): Promise<string[]>;
  /** Resolves `rg`, `bwrap` and `socat` on the absolute entries of PATH; runs nothing. */
  resolveTools(env: Readonly<Record<string, string>>): Promise<SandboxTools>;
  /**
   * Reasons the step may not run: a relative PATH entry, or a pinned program, the dipo binary or a
   * PATH directory under a path the settings make writable. Runs nothing.
   */
  trustCheck(input: {
    readonly settings: SrtSettings;
    readonly home: string;
    readonly env: Readonly<Record<string, string>>;
  }): Promise<string[]>;
  /** Checks the pinned programs (runs `bwrap --version` on Linux); call after `trustCheck`. */
  probe(tools: SandboxTools): Promise<ProbeResult>;
  /** Writes the settings file for a temp root and returns its path. */
  writePolicy(tempRoot: string, settings: SrtSettings): Promise<string>;
  /**
   * Spawns `dipo daemon sandbox-exec --policy <file> --cwd <cwd> -- <command>` from a trusted
   * working directory, so nothing in the worktree is loaded before srt starts.
   */
  start(options: {
    readonly policyPath: string;
    readonly command: readonly [string, ...string[]];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
  }): ChildProcess;
  /**
   * The reason `sandbox-exec` wrote to the refusal file of a policy, or null when there is no
   * such file; throws when the file exists but cannot be read.
   */
  readRefusal(policyPath: string): Promise<string | null>;
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
  /** The user id, for `/run/user/<uid>`. */
  readonly uid: number;
  readonly sandbox: {
    readonly installCachePaths: readonly string[];
    readonly registryHosts: readonly string[];
  };
  readonly scriptMinutes: Readonly<Record<string, number>>;
  /** The daemon's environment; only allowlisted names pass. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Variables the engine sets for the step, such as ports. */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** Called with each piece of stdout or stderr text as it arrives (verify streams it, DIPO-49). */
  readonly onOutput?: (text: string) => void;
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
    let dipoDirs: string[];
    try {
      dipoDirs = await deps.host.dipoDirs(request.env);
    } catch (error) {
      return startFailed(`could not resolve dipo's own directories: ${message(error)}`);
    }
    const run = {
      platform: deps.platform,
      kind: request.kind,
      home: request.home,
      uid: request.uid,
      mainCheckout: request.mainCheckout,
      worktree: request.worktree,
      tempRoot,
      dipoDirs,
      sshAuthSock: request.env["SSH_AUTH_SOCK"],
      installCachePaths: request.sandbox.installCachePaths,
      registryHosts: request.sandbox.registryHosts,
    };

    let tools: SandboxTools;
    let distrust: string[];
    let probe: ProbeResult;
    try {
      tools = await deps.host.resolveTools(env);
      distrust = await deps.host.trustCheck({
        settings: translatePolicy({ ...run, tools }).settings,
        home: request.home,
        env,
      });
      if (distrust.length > 0) {
        return startFailed(`sandbox refused untrusted paths: ${distrust.join("; ")}`);
      }
      probe = await deps.host.probe(tools);
    } catch (error) {
      return startFailed(`sandbox probe failed: ${message(error)}`);
    }
    if (!probe.ok) return startFailed(`sandbox unavailable: ${probe.reasons.join("; ")}`);

    const { settings, warnings } = translatePolicy({ ...run, tools });

    let child: ChildProcess;
    let policyPath: string;
    try {
      policyPath = await deps.host.writePolicy(tempRoot, settings);
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
      capture(child.stdout, OUTPUT_LIMIT_BYTES, request.onOutput),
      capture(child.stderr, OUTPUT_LIMIT_BYTES, request.onOutput),
      child.exited,
    ]);
    deps.clock.clearTimeout(timeoutTimer);
    if (killTimer !== undefined) deps.clock.clearTimeout(killTimer);

    if (exit.code === SANDBOX_REFUSED_EXIT_CODE) {
      let refusal: string | null;
      try {
        refusal = await deps.host.readRefusal(policyPath);
      } catch (error) {
        // An unreadable refusal file cannot show the command ran: fail closed.
        return startFailed(
          `sandbox-exec exited ${SANDBOX_REFUSED_EXIT_CODE} and its refusal file could not be read: ${message(error)}`,
        );
      }
      if (refusal !== null) return startFailed(`sandbox refused to start: ${refusal}`);
    }
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

function startFailed(reason: string): StepResult {
  return { outcome: "startFailed", reason };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads a stream to the end, keeping at most `limit` bytes of its tail. `onText` gets each piece
 * as it arrives, decoded as UTF-8 across chunk boundaries.
 */
export async function capture(
  stream: ReadableStream<Uint8Array>,
  limit: number = OUTPUT_LIMIT_BYTES,
  onText?: (text: string) => void,
): Promise<CapturedOutput> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const live = onText === undefined ? null : new TextDecoder();
  for await (const chunk of stream) {
    if (live !== null) {
      const text = live.decode(chunk, { stream: true });
      if (text !== "") onText?.(text);
    }
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
  const rest = live?.decode() ?? "";
  if (rest !== "") onText?.(rest);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}
