// `probe` for the Claude CLI adapter (0008 sections 2 and 11): `claude --version` and
// `claude auth status`. It refuses a version below the minimum, which the sandbox locks need, and
// any login other than `authMethod: "claude.ai"`, so a run never starts unlocked or bills an API
// key. The judgement is pure; running the two commands goes through the injected `Spawn`.

import type { ChildProcess, Clock, Spawn } from "@dipsaus-orchestrator/contract";

import type { AdapterStatus } from "../types";

/** The oldest Claude Code with the `--settings` sandbox locks (0008 section 2). */
export const MIN_CLAUDE_VERSION = "2.1.285";
/** The only login a worker may run on (0008 section 2). */
export const REQUIRED_AUTH_METHOD = "claude.ai";
/**
 * What this adapter offers (0008 section 11). `hooks` joins when the hook relay lands (DIPO-59);
 * until then `plan` refuses `hookRelay`.
 */
export const CLAUDE_CLI_CAPABILITIES: readonly string[] = [
  "steer",
  "pause",
  "resume",
  "structuredReport",
  "planLimitEvents",
  "costEstimate",
];
/** How long one probe command may take. */
export const PROBE_TIMEOUT_MS = 30_000;

/** `2.1.296` from `2.1.296 (Claude Code)`; null when the text holds no version. */
export function parseClaudeVersion(text: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/.exec(text)?.[1] ?? null;
}

/** Negative, zero or positive as `a` is older than, equal to or newer than `b` (x.y.z). */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** What the two commands printed; null output means the command failed or timed out. */
export interface ProbeOutput {
  readonly version: { readonly code: number | null; readonly stdout: string } | null;
  readonly auth: { readonly code: number | null; readonly stdout: string } | null;
}

function refuse(version: string | null, login: string | null, reason: string): AdapterStatus {
  return { ok: false, version, login, capabilities: CLAUDE_CLI_CAPABILITIES, reason };
}

/** Pure: the version, or the refusal, from what `claude --version` printed. */
export function evaluateVersion(output: ProbeOutput["version"]): string | AdapterStatus {
  if (output === null || output.code !== 0) {
    return refuse(null, null, "`claude --version` did not run; is Claude Code installed?");
  }
  const version = parseClaudeVersion(output.stdout);
  if (version === null) {
    return refuse(null, null, "`claude --version` printed no version");
  }
  if (compareVersions(version, MIN_CLAUDE_VERSION) < 0) {
    return refuse(
      version,
      null,
      `Claude Code ${version} is older than ${MIN_CLAUDE_VERSION}; update Claude Code`,
    );
  }
  return version;
}

/** Pure: the adapter status from what `claude --version` and `claude auth status` printed. */
export function evaluateProbe(output: ProbeOutput): AdapterStatus {
  const version = evaluateVersion(output.version);
  if (typeof version !== "string") return version;
  if (output.auth === null) {
    return refuse(version, null, "`claude auth status` did not run");
  }
  let status: unknown;
  try {
    status = JSON.parse(output.auth.stdout);
  } catch {
    return refuse(version, null, "`claude auth status` printed no JSON; run `claude auth login`");
  }
  const record =
    typeof status === "object" && status !== null ? (status as Record<string, unknown>) : {};
  const method = record["authMethod"];
  if (typeof method !== "string" || method.length === 0) {
    return refuse(
      version,
      null,
      "`claude auth status` shows no authMethod; run `claude auth login`",
    );
  }
  if (method !== REQUIRED_AUTH_METHOD) {
    return refuse(
      version,
      method,
      `authMethod is ${method}, not ${REQUIRED_AUTH_METHOD}; log in with the subscription (\`claude auth login\`)`,
    );
  }
  if (record["loggedIn"] === false) {
    return refuse(
      version,
      method,
      "`claude auth status` shows loggedIn false; run `claude auth login`",
    );
  }
  return { ok: true, version, login: method, capabilities: CLAUDE_CLI_CAPABILITIES };
}

const decoder = new TextDecoder();

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Runs one short command to its end; null when it could not start or ran past the timeout. */
export async function runShort(
  spawn: Spawn,
  clock: Clock,
  cmd: readonly [string, ...string[]],
  env: Readonly<Record<string, string>>,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<{ code: number | null; stdout: string } | null> {
  let child: ChildProcess;
  try {
    child = spawn({ cmd, env, stdin: "ignore" });
  } catch {
    return null;
  }
  let timedOut = false;
  const timer = clock.setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [stdout, , exit] = await Promise.all([
      readAll(child.stdout),
      readAll(child.stderr),
      child.exited,
    ]);
    return timedOut ? null : { code: exit.code, stdout };
  } finally {
    clock.clearTimeout(timer);
  }
}

export interface ProbeDeps {
  readonly spawn: Spawn;
  readonly clock: Clock;
  /** The absolute `claude` path the daemon resolved. */
  readonly claudePath: string;
  /** The worker's allowlisted environment, so the login seen is the one the worker gets. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/** Runs `claude --version` and `claude auth status` and judges them. */
export async function probe(deps: ProbeDeps): Promise<AdapterStatus> {
  const timeout = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const version = await runShort(
    deps.spawn,
    deps.clock,
    [deps.claudePath, "--version"],
    deps.env,
    timeout,
  );
  const checked = evaluateVersion(version);
  if (typeof checked !== "string") return checked;
  const auth = await runShort(
    deps.spawn,
    deps.clock,
    [deps.claudePath, "auth", "status"],
    deps.env,
    timeout,
  );
  return evaluateProbe({ version, auth });
}
