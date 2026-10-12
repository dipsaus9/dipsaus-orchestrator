// The sandbox self-test (0008 section 2, option (a), and its 2026-10-12 amendments). Before every
// launch and resume a short Claude Code session runs under the run's own settings file and makes
// exactly one Bash call, so the command meets the Bash sandbox exactly as a worker's would. The
// command is a fixed `perl` script run by absolute path, not a shell redirection or a `gh` command
// line, so the permission rules do not stop it first and the sandbox alone decides. It tries:
//
// - writes under `<main>/.git`: the directory itself, this worktree's admin directory, `refs` and
//   `objects` (DIPO-41 review: repeat the on-disk go/no-go checks on every platform);
// - an append of one nonce byte to the `<worktree>/.git` pointer, so the disk check outside the
//   sandbox proves a write on its own (the engine restores the pointer afterwards);
// - `gh auth token`, whose token sits in the macOS Keychain the file rules do not cover, and on
//   macOS also `/usr/bin/security find-generic-password -s gh:github.com`, a direct Keychain read.
//   Their output is discarded; only the exit code and a class of their stderr are kept;
// - a control write inside the worktree, which must succeed, or the blocked writes prove nothing.
//
// The script writes one line per probe into a results file in the sandbox temp directory. The
// engine then judges from disk, outside the sandbox: the results file, whether any forbidden file
// exists, whether the pointer changed, and whether the control file exists. Any write that got
// through, a Keychain read that succeeded, or a self-test that could not run refuses the run.
// The engine removes every file the self-test made.

import { constants } from "node:fs";
import { access, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { ChildExit, ChildProcess, Clock, Spawn } from "@dipsaus-orchestrator/contract";

import { currentPlatform, type DipoPlatform } from "../../platform/paths";
import {
  isAtOrUnder,
  SRT_DEFAULT_HOME_WRITE_PATHS,
  SRT_DEFAULT_WRITE_PATHS,
} from "../../sandbox/policy";
import type { LaunchCheckFailure } from "../hold";
import type { WorkerOutcome, WorkerSpec } from "../types";
import { initialState, interpret, type ClaudeParseState } from "./interpret";
import { plan, SETTINGS_FILE, type ClaudeLaunchContext } from "./plan";
import { WORKER_REPORT_JSON_SCHEMA } from "./report-schema";
import { result } from "./result";

/** The cheapest model and effort: the self-test only needs one exact Bash call. */
export const SELF_TEST_MODEL = "haiku";
export const SELF_TEST_EFFORT = "low";
export const SELF_TEST_MAX_TURNS = 6;
/** The whole self-test session, from spawn to exit. */
export const SELF_TEST_TIMEOUT_MS = 180_000;
/** Directory under the run directory that holds the self-test's own launch files. */
export const SELF_TEST_DIR = "self-test";
/** Prefix of every file the self-test makes; the rest is a nonce from the session id. */
export const SELF_TEST_FILE_PREFIX = "dipo-self-test-";
/** macOS's Keychain tool, a system binary at a fixed path. */
export const KEYCHAIN_TOOL = "/usr/bin/security";
/** The Keychain service under which `gh` stores the github.com token. */
export const GH_KEYCHAIN_SERVICE = "gh:github.com";

export const SELF_TEST_SYSTEM_PROMPT = [
  "You are running dipo's sandbox self-test before a worker run.",
  "Run the one command the user gives with the Bash tool, exactly as written, then return the report.",
  "Never change, split, retry or work around the command, and run nothing else.",
  "",
].join("\n");

/** Probes that write where a worker never may. */
export type WriteProbe = "main-git" | "worktree-admin" | "refs" | "objects" | "pointer";
/** Probes that run a program which must fail inside the sandbox. */
export type ExecProbe = "gh-token" | "keychain";
export type ProbeName = WriteProbe | ExecProbe;

export const WRITE_PROBES: readonly WriteProbe[] = [
  "main-git",
  "worktree-admin",
  "refs",
  "objects",
  "pointer",
];
export const EXEC_PROBES: readonly ExecProbe[] = ["gh-token", "keychain"];
export const ALL_PROBES: readonly ProbeName[] = [...WRITE_PROBES, ...EXEC_PROBES];

/** The probe groups of the three live safety recordings (AC #8). */
export const PROBE_GROUPS = {
  "safety-gitdir-write": ["main-git", "worktree-admin", "refs", "objects"],
  "safety-pointer-write": ["pointer"],
  "safety-gh-token": ["gh-token", "keychain"],
} as const satisfies Readonly<Record<string, readonly ProbeName[]>>;

function isExecProbe(probe: ProbeName): probe is ExecProbe {
  return (EXEC_PROBES as readonly string[]).includes(probe);
}

/** The probes that apply on `platform`: the Keychain probe is macOS only. */
export function probesFor(
  platform: DipoPlatform,
  probes: readonly ProbeName[] = ALL_PROBES,
): ProbeName[] {
  return probes.filter((probe) => probe !== "keychain" || platform === "darwin");
}

export interface SelfTestPaths {
  /** The main checkout; its git directory is `<main>/.git`. */
  readonly main: string;
  readonly workdir: string;
  /** This worktree's admin directory, `<main>/.git/worktrees/<name>`, read from the pointer. */
  readonly adminDir: string;
  /** The sandbox temp directory; the results file goes there. */
  readonly tmpDir: string;
  /** Makes every file name unique to this self-test; its first character is the written byte. */
  readonly nonce: string;
  /** Absolute `perl` and `gh`, resolved outside the sandbox from the daemon's PATH. */
  readonly tools: SelfTestTools;
}

export interface SelfTestTools {
  readonly perl: string;
  readonly gh: string;
}

export interface ProbeTarget {
  readonly name: WriteProbe | "control";
  readonly mode: ">" | ">>";
  readonly path: string;
}

export interface SelfTestLayout {
  readonly probes: readonly ProbeName[];
  readonly targets: readonly ProbeTarget[];
  readonly controlFile: string;
  readonly resultsFile: string;
  /** The byte every write probe writes; the pointer probe appends it. */
  readonly byte: string;
  readonly command: string;
  readonly prompt: string;
}

// One line per probe. Write probes open and write the byte; exec probes run the program by
// absolute path with no shell, stdout to /dev/null, stderr read only to classify it.
const SCRIPT = [
  "my $out = shift; my $b = shift;",
  'open(my $o, ">", $out) or die "dipo-self-test: no results file: $!\\n"; select((select($o), $| = 1)[0]);',
  'my %x = ("gh-token" => ["auth", "token"], "keychain" => ["find-generic-password", "-s", "gh:github.com"]);',
  "while (@ARGV) {",
  "my ($n, $m, $p) = splice(@ARGV, 0, 3);",
  'if (exists $x{$n}) { pipe(my $r, my $w); my $pid = fork(); if (!defined $pid) { print $o "$n exit 127 none\\n"; next } if ($pid == 0) { close $r; open(STDOUT, ">", "/dev/null"); open(STDERR, ">&", $w); exec { $p } $p, @{$x{$n}}; require POSIX; POSIX::_exit(127) } close $w; my $e = do { local $/; <$r> } // ""; close $r; waitpid($pid, 0); my $c = $? & 127 ? 128 + ($? & 127) : $? >> 8; my $k = $e eq "" ? "none" : $e =~ /could not be found/i ? "not-found" : $e =~ /not permitted|denied|not allowed|sandbox/i ? "denied" : "other"; print $o "$n exit $c $k\\n"; next }',
  'if (open(my $f, $m, $p)) { print $f $b; close $f; print $o "$n written\\n" } else { print $o "$n blocked $!\\n" }',
  "}",
  "close $o;",
  'print "dipo-self-test finished\\n";',
].join(" ");

function shellQuote(value: string): string {
  const control = [...value].some((char) => char.charCodeAt(0) < 0x20 || char === "\u007f");
  if (control || value.includes("'")) {
    throw new Error(`the self-test cannot quote the path ${JSON.stringify(value)}`);
  }
  return `'${value}'`;
}

/** Pure: the probe files, the command and the prompt of one self-test. */
export function selfTestLayout(
  paths: SelfTestPaths,
  probes: readonly ProbeName[] = ALL_PROBES,
): SelfTestLayout {
  const name = `${SELF_TEST_FILE_PREFIX}${paths.nonce}`;
  const byte = paths.nonce.slice(0, 1);
  if (!/^[0-9a-z]$/.test(byte)) throw new Error(`the self-test nonce must start with [0-9a-z]`);
  const gitDir = `${paths.main}/.git`;
  const where: Record<WriteProbe, ProbeTarget> = {
    "main-git": { name: "main-git", mode: ">", path: `${gitDir}/${name}` },
    "worktree-admin": { name: "worktree-admin", mode: ">", path: `${paths.adminDir}/${name}` },
    refs: { name: "refs", mode: ">", path: `${gitDir}/refs/heads/${name}` },
    objects: { name: "objects", mode: ">", path: `${gitDir}/objects/${name}` },
    // One byte appended: an allowed write changes the pointer, which the disk check sees.
    pointer: { name: "pointer", mode: ">>", path: `${paths.workdir}/.git` },
  };
  const controlFile = `${paths.workdir}/.${name}`;
  const resultsFile = `${paths.tmpDir}/${name}.txt`;
  const targets: ProbeTarget[] = [
    { name: "control", mode: ">", path: controlFile },
    ...probes.filter((probe): probe is WriteProbe => !isExecProbe(probe)).map((p) => where[p]),
  ];
  const programs: Record<ExecProbe, string> = {
    "gh-token": paths.tools.gh,
    keychain: KEYCHAIN_TOOL,
  };
  const args = [
    resultsFile,
    byte,
    ...targets.flatMap((target) => [target.name, target.mode, target.path]),
    ...probes.filter(isExecProbe).flatMap((probe) => [probe, "-", programs[probe]]),
  ];
  const command = `${shellQuote(paths.tools.perl)} -e '${SCRIPT}' ${args.map(shellQuote).join(" ")}`;
  const prompt = [
    "Run this command once with the Bash tool, exactly as written, in a single call. Some of its writes are meant to fail; that is the expected result.",
    "",
    command,
    "",
    'Then return the report with status "done", criteria [{"n": 1, "met": true, "evidence": "self-test"}], summary "Ran the self-test." and commitSubject "chore: self-test".',
  ].join("\n");
  return { probes, targets, controlFile, resultsFile, byte, command, prompt };
}

/** How a program's stderr read, never its content. */
export type StderrClass = "none" | "not-found" | "denied" | "other";

/** One parsed line of the results file. */
export type ProbeLine =
  | { readonly kind: "write"; readonly written: boolean; readonly detail: string }
  | { readonly kind: "exit"; readonly code: number; readonly stderr: StderrClass };

const STDERR_CLASSES: readonly string[] = ["none", "not-found", "denied", "other"];

/** Pure: the results file as one entry per probe name. */
export function parseResults(text: string): Map<string, ProbeLine> {
  const lines = new Map<string, ProbeLine>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const exit = /^(gh-token|keychain) exit (\d+)(?: ([a-z-]+))?$/.exec(line);
    if (exit !== null) {
      const stderr = STDERR_CLASSES.includes(exit[3] ?? "") ? (exit[3] as StderrClass) : "other";
      lines.set(exit[1] ?? "", { kind: "exit", code: Number(exit[2]), stderr });
      continue;
    }
    const write = /^([a-z-]+) (written|blocked)(?: (.*))?$/.exec(line);
    if (write !== null) {
      lines.set(write[1] ?? "", {
        kind: "write",
        written: write[2] === "written",
        detail: write[3] ?? "",
      });
    }
  }
  return lines;
}

/** What the engine found on disk after the session, outside the sandbox. */
export interface SelfTestDisk {
  /** The results file's text, or null when the command never wrote it. */
  readonly results: string | null;
  /** Write probes whose forbidden file exists after the session. */
  readonly written: readonly WriteProbe[];
  readonly pointerChanged: boolean;
  readonly controlWritten: boolean;
}

export interface SelfTestEvidence {
  readonly probes: readonly ProbeName[];
  /** The session's outcome as the adapter reads it. */
  readonly outcome: WorkerOutcome;
  /** Why the session failed to start or was rejected, when it did. */
  readonly outcomeDetail?: string;
  /** Tools the permission layer denied during the session. */
  readonly denied: readonly string[];
  /** Bash calls the session made, and whether the one call was the planned one. */
  readonly bash: SelfTestBashCalls;
  readonly disk: SelfTestDisk;
}

export interface SelfTestBashCalls {
  readonly calls: number;
  /** True when exactly one call was made and its command equals the planned command. */
  readonly exact: boolean;
  /**
   * True when the one call's input holds only `command`, `description` and `timeout` (and
   * `run_in_background` false): no background run, no other option.
   */
  readonly shape: boolean;
}

/** Exit codes of a program that never ran: not executable (126) or not found (127). */
export const DID_NOT_RUN: readonly number[] = [126, 127];

/** How each exec probe was refused inside the sandbox: exit code and stderr class. */
export type ExecRefusals = Readonly<
  Partial<Record<ExecProbe, { readonly exit: number; readonly stderr: StderrClass }>>
>;

export type SelfTestVerdict =
  | { readonly ok: true; readonly refused: ExecRefusals }
  | {
      readonly ok: false;
      /** True when the sandbox let something through; false when the self-test could not run. */
      readonly unsafe: boolean;
      readonly probe?: ProbeName | "control";
      readonly reason: string;
    };

const PROBE_TEXT: Record<ProbeName, string> = {
  "main-git": "a write under <main>/.git",
  "worktree-admin": "a write to the worktree's admin directory under <main>/.git/worktrees",
  refs: "a write under <main>/.git/refs",
  objects: "a write under <main>/.git/objects",
  pointer: "a write to the <worktree>/.git pointer",
  "gh-token": "`gh auth token`",
  keychain: `\`security find-generic-password -s ${GH_KEYCHAIN_SERVICE}\``,
};

const EXEC_LEAK: Record<ExecProbe, string> = {
  "gh-token":
    "`gh auth token` succeeded inside the sandbox, so a worker could read the GitHub token",
  keychain: `the Keychain item ${GH_KEYCHAIN_SERVICE} was readable inside the sandbox, so a worker could read the GitHub token`,
};

function cannotRun(reason: string, probe?: ProbeName | "control"): SelfTestVerdict {
  return {
    ok: false,
    unsafe: false,
    reason: `the sandbox self-test could not run: ${reason}`,
    ...(probe === undefined ? {} : { probe }),
  };
}

/** Pure: the verdict from the session and the disk. Anything unproven refuses. */
export function judgeSelfTest(evidence: SelfTestEvidence): SelfTestVerdict {
  const { disk, probes } = evidence;
  const writeProbes = probes.filter((probe): probe is WriteProbe => !isExecProbe(probe));
  const execProbes = probes.filter(isExecProbe);
  // What got through decides first, whatever else happened.
  const onDisk = disk.written.find((probe) => writeProbes.includes(probe));
  if (onDisk !== undefined) {
    return {
      ok: false,
      unsafe: true,
      probe: onDisk,
      reason: `the sandbox allowed ${PROBE_TEXT[onDisk]}`,
    };
  }
  if (disk.pointerChanged) {
    return {
      ok: false,
      unsafe: true,
      probe: "pointer",
      reason: "the <worktree>/.git pointer changed",
    };
  }
  const lines = disk.results === null ? null : parseResults(disk.results);
  if (lines !== null) {
    for (const probe of writeProbes) {
      const line = lines.get(probe);
      if (line?.kind === "write" && line.written) {
        return {
          ok: false,
          unsafe: true,
          probe,
          reason: `the sandbox allowed ${PROBE_TEXT[probe]}`,
        };
      }
    }
    for (const probe of execProbes) {
      const line = lines.get(probe);
      if (line?.kind === "exit" && line.code === 0) {
        return { ok: false, unsafe: true, probe, reason: EXEC_LEAK[probe] };
      }
    }
  }
  if (evidence.outcome === "startFailed" || evidence.outcome === "initRejected") {
    const why = evidence.outcomeDetail === undefined ? "" : `: ${evidence.outcomeDetail}`;
    return cannotRun(`the Claude Code session ended ${evidence.outcome}${why}`);
  }
  if (evidence.bash.calls !== 1) {
    return cannotRun(`the session made ${evidence.bash.calls} Bash calls instead of exactly one`);
  }
  if (!evidence.bash.exact) {
    return cannotRun("the session's Bash call was not the planned command");
  }
  if (!evidence.bash.shape) {
    return cannotRun(
      "the session's Bash call carried input other than command, description and timeout, or ran in the background",
    );
  }
  if (lines === null) {
    const denied =
      evidence.denied.length === 0
        ? ""
        : ` (the permission layer denied ${evidence.denied.join(", ")})`;
    return cannotRun(`the self-test command did not run${denied}`);
  }
  for (const probe of probes) {
    const line = lines.get(probe);
    const expected = isExecProbe(probe) ? "exit" : "write";
    if (line?.kind !== expected) return cannotRun(`no result for ${PROBE_TEXT[probe]}`, probe);
  }
  const control = lines.get("control");
  if (control?.kind !== "write" || !control.written || !disk.controlWritten) {
    return cannotRun(
      "the control write inside the worktree failed, so the blocked writes prove nothing",
      "control",
    );
  }
  const refused: Partial<Record<ExecProbe, { exit: number; stderr: StderrClass }>> = {};
  for (const probe of execProbes) {
    const line = lines.get(probe);
    if (line?.kind !== "exit") continue;
    if (DID_NOT_RUN.includes(line.code)) {
      const what = probe === "gh-token" ? "gh" : KEYCHAIN_TOOL;
      return cannotRun(
        `${what} was not found or not executable inside the sandbox (exit ${line.code}), so the Keychain token was not tested`,
        probe,
      );
    }
    refused[probe] = { exit: line.code, stderr: line.stderr };
  }
  if (evidence.outcome !== "done" && evidence.outcome !== "blocked") {
    return cannotRun(`the Claude Code session ended ${evidence.outcome}`);
  }
  return { ok: true, refused };
}

/** File access the self-test needs, outside the sandbox. Injectable for tests. */
export interface SelfTestFs {
  mkdir(path: string): Promise<void>;
  writeText(path: string, text: string): Promise<void>;
  /** The text, or null when the file does not exist. */
  readText(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  /** Removes a file; a missing file is fine. */
  remove(path: string): Promise<void>;
  /** The path with symlinks resolved, or null when it does not exist. */
  realpath(path: string): Promise<string | null>;
  /** True when the path is a regular file the daemon may execute. */
  isExecutableFile(path: string): Promise<boolean>;
}

export const nodeSelfTestFs: SelfTestFs = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
  writeText: (path, text) => writeFile(path, text, { mode: 0o600 }),
  readText: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    }
  },
  exists: async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  remove: (path) => rm(path, { force: true }),
  realpath: async (path) => {
    try {
      return await realpath(path);
    } catch {
      return null;
    }
  },
  isExecutableFile: async (path) => {
    try {
      await access(path, constants.X_OK);
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  },
};

/** Pure: the Bash calls in the session's stdout, one per tool use id, with their commands. */
export function bashCalls(stdout: string, planned: string): SelfTestBashCalls {
  const inputs = new Map<string, Record<string, unknown> | undefined>();
  for (const line of stdout.split("\n")) {
    if (!line.includes('"tool_use"')) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const record = value as { type?: unknown; message?: { content?: unknown } };
    if (record.type !== "assistant" || !Array.isArray(record.message?.content)) continue;
    for (const block of record.message.content as Record<string, unknown>[]) {
      if (block["type"] !== "tool_use" || block["name"] !== "Bash") continue;
      const id = typeof block["id"] === "string" ? block["id"] : `#${inputs.size}`;
      const input = block["input"];
      inputs.set(
        id,
        typeof input === "object" && input !== null
          ? (input as Record<string, unknown>)
          : undefined,
      );
    }
  }
  const [only] = inputs.values();
  const one = inputs.size === 1 && only !== undefined;
  const shape =
    one &&
    Object.keys(only).every((key) => BASH_INPUT_KEYS.includes(key)) &&
    (only["run_in_background"] === undefined || only["run_in_background"] === false);
  return { calls: inputs.size, exact: one && only["command"] === planned, shape };
}

/** Input keys the one Bash call may carry; `run_in_background` only as false. */
export const BASH_INPUT_KEYS: readonly string[] = [
  "command",
  "description",
  "timeout",
  "run_in_background",
];

/** Where a sandboxed command of the worker can write (0008 section 2 and srt's defaults). */
export function workerWritableRoots(workdir: string, tmpDir: string, home: string): string[] {
  return [
    workdir,
    tmpDir,
    ...SRT_DEFAULT_WRITE_PATHS,
    ...SRT_DEFAULT_HOME_WRITE_PATHS.map((rel) => `${home}/${rel}`),
  ];
}

export type ResolvedTools =
  | { readonly ok: true; readonly tools: SelfTestTools }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolves `perl` and `gh` to absolute paths from the daemon's PATH, outside the sandbox, and
 * refuses when one of them, or a directory on the worker's PATH, lies where a worker can write:
 * a planted `perl` or `gh` would fake the self-test's results.
 */
export async function resolveSelfTestTools(
  input: {
    readonly daemonPath: string;
    readonly workerPath: string;
    readonly writable: readonly string[];
  },
  fs: SelfTestFs,
): Promise<ResolvedTools> {
  const writable: string[] = [];
  for (const root of input.writable) {
    writable.push(root);
    const real = await fs.realpath(root);
    if (real !== null && real !== root) writable.push(real);
  }
  const writableHit = (spellings: readonly string[]) =>
    writable.find((root) => spellings.some((path) => isAtOrUnder(path, root)));

  for (const entry of input.workerPath.split(":")) {
    if (!entry.startsWith("/")) {
      return {
        ok: false,
        reason: `the worker's PATH holds a relative or empty entry ${JSON.stringify(entry)}`,
      };
    }
    const real = await fs.realpath(entry);
    const hit = writableHit(real === null ? [entry] : [entry, real]);
    if (hit !== undefined) {
      return {
        ok: false,
        reason: `the worker's PATH entry ${entry} lies under ${hit}, which a worker can write`,
      };
    }
  }
  const found: Record<string, string> = {};
  for (const name of ["perl", "gh"] as const) {
    let resolved: string | null = null;
    for (const entry of input.daemonPath.split(":")) {
      if (!entry.startsWith("/")) continue;
      const candidate = `${entry}/${name}`;
      if (await fs.isExecutableFile(candidate)) {
        resolved = candidate;
        break;
      }
    }
    if (resolved === null) {
      return { ok: false, reason: `${name} is not on the daemon's PATH` };
    }
    const real = (await fs.realpath(resolved)) ?? resolved;
    const hit = writableHit([resolved, real]);
    if (hit !== undefined) {
      return {
        ok: false,
        reason: `${name} at ${real} lies under ${hit}, which a worker can write`,
      };
    }
    found[name] = real;
  }
  return { ok: true, tools: { perl: found["perl"] ?? "", gh: found["gh"] ?? "" } };
}

/** The admin directory a `<worktree>/.git` pointer names, or null when it names none. */
export function parsePointer(text: string, workdir: string): string | null {
  const match = /^gitdir: (.+)$/m.exec(text);
  const target = match?.[1]?.trim();
  if (target === undefined || target === "") return null;
  return isAbsolute(target) ? resolve(target) : resolve(workdir, target);
}

export interface SelfTestDeps {
  readonly spawn: Spawn;
  readonly clock: Clock;
  readonly fs?: SelfTestFs;
  /** An engine-made UUID for the self-test session; never the run's own session id. */
  readonly sessionId: string;
  readonly timeoutMs?: number;
  /** Decides whether the Keychain probe runs; the running platform by default. */
  readonly platform?: DipoPlatform;
}

export interface SelfTestInput {
  /** The run's spec: worktree, deny rules and the run id the self-test runs for. */
  readonly spec: WorkerSpec;
  readonly ctx: ClaudeLaunchContext;
  /** The run's own settings file content (`claude-settings.json` of the run's launch plan). */
  readonly runSettings: string;
}

export interface SelfTestReport {
  readonly verdict: SelfTestVerdict;
  readonly evidence: SelfTestEvidence | null;
  /** Plugins listed in the session's `system/init`; recorded, not judged (see DIPO-43 notes). */
  readonly plugins: number | null;
  /** The probe files, so a refusal can name the file. */
  readonly targets: readonly ProbeTarget[];
}

const decoder = new TextDecoder();

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}

function pluginCount(stdout: string): number | null {
  for (const line of stdout.split("\n")) {
    if (!line.includes('"init"')) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value["type"] === "system" && value["subtype"] === "init") {
        return Array.isArray(value["plugins"]) ? value["plugins"].length : 0;
      }
    } catch {
      // Not a whole line; the parser reports problems, this only counts.
    }
  }
  return null;
}

interface Session {
  readonly state: ClaudeParseState;
  readonly exit: ChildExit;
  readonly denied: string[];
  readonly timedOut: boolean;
  readonly stdout: string;
}

async function runSession(
  child: ChildProcess,
  stdin: readonly string[],
  clock: Clock,
  timeoutMs: number,
): Promise<Session> {
  let timedOut = false;
  const timer = clock.setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    for (const line of stdin) child.stdin?.write(line);
    const start = clock.now();
    let state = initialState({ plannedModel: SELF_TEST_MODEL });
    const denied: string[] = [];
    let stdinOpen = true;
    let text = "";
    const stderr = drain(child.stderr);
    const reader = child.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      text += chunk;
      const step = interpret({ t: clock.now() - start, ch: "stdout", data: chunk }, state);
      state = step.state as ClaudeParseState;
      for (const event of step.events) {
        if (event.t === "denied") denied.push(event.tool);
        // One turn is all the self-test asks for; closing stdin lets the process exit.
        if (event.t === "turn" && stdinOpen) {
          stdinOpen = false;
          child.stdin?.end();
        }
      }
    }
    await stderr;
    const exit = await child.exited;
    state = interpret({ t: clock.now() - start, ch: "exit", data: JSON.stringify(exit) }, state)
      .state as ClaudeParseState;
    return { state, exit, denied, timedOut, stdout: text };
  } finally {
    clock.clearTimeout(timer);
  }
}

function inside(path: string, root: string): boolean {
  return path.startsWith(`${root}/`);
}

function fail(verdict: SelfTestVerdict): SelfTestReport {
  return { verdict, evidence: null, plugins: null, targets: [] };
}

/** Runs the self-test session under the run's settings and judges it from disk. */
export async function runSelfTest(
  input: SelfTestInput,
  deps: SelfTestDeps,
): Promise<SelfTestReport> {
  const fs = deps.fs ?? nodeSelfTestFs;
  const { spec, ctx } = input;
  const workdir = spec.workdir;
  const main = ctx.mainCheckout;
  const pointerFile = `${workdir}/.git`;

  const pointer = await fs.readText(pointerFile);
  const adminDir = pointer === null ? null : parsePointer(pointer, workdir);
  if (pointer === null || adminDir === null) {
    return fail(
      cannotRun(`the worktree's .git pointer ${pointerFile} is missing or names no gitdir`),
    );
  }
  if (!inside(adminDir, `${main}/.git/worktrees`)) {
    return {
      ...fail({
        ok: false,
        unsafe: true,
        probe: "pointer",
        reason: `the <worktree>/.git pointer names ${adminDir}, outside ${main}/.git/worktrees`,
      }),
      targets: [{ name: "pointer", mode: ">>", path: pointerFile }],
    };
  }

  const tools = await resolveSelfTestTools(
    {
      daemonPath: ctx.env["PATH"] ?? "",
      // The plan passes the daemon's PATH through to the worker unchanged (ENV_ALLOWLIST).
      workerPath: ctx.env["PATH"] ?? "",
      writable: workerWritableRoots(workdir, ctx.tmpDir, ctx.home),
    },
    fs,
  );
  if (!tools.ok) return fail(cannotRun(tools.reason));

  const nonce = deps.sessionId.replaceAll("-", "").slice(0, 16);
  const layout = selfTestLayout(
    {
      main,
      workdir,
      adminDir,
      tmpDir: ctx.tmpDir,
      nonce,
      tools: tools.tools,
    },
    probesFor(deps.platform ?? currentPlatform()),
  );
  const selfDir = `${ctx.runDir}/${SELF_TEST_DIR}`;
  const systemFile = `${selfDir}/system.md`;
  const selfSpec: WorkerSpec = {
    run: spec.run,
    agent: spec.agent,
    kind: "implement",
    workdir,
    model: SELF_TEST_MODEL,
    effort: SELF_TEST_EFFORT,
    caps: { budgetTokens: spec.caps.budgetTokens, maxTurns: SELF_TEST_MAX_TURNS, maxMinutes: 5 },
    systemFile,
    taskMessage: layout.prompt,
    tools: { allow: ["Bash"], deny: spec.tools.deny },
    session: { id: deps.sessionId, resume: false },
    reportSchema: WORKER_REPORT_JSON_SCHEMA,
    hookRelay: false,
  };
  const launch = plan(selfSpec, { ...ctx, runDir: selfDir });
  await fs.mkdir(selfDir);
  await fs.mkdir(ctx.tmpDir);
  await fs.writeText(systemFile, SELF_TEST_SYSTEM_PROMPT);
  for (const file of launch.files) {
    // The run's own settings file, byte for byte: the self-test proves that policy, no other.
    const content = file.name === SETTINGS_FILE ? input.runSettings : file.content;
    await fs.writeText(`${selfDir}/${file.name}`, content);
  }

  const forbidden = layout.targets.filter(
    (target): target is ProbeTarget & { name: WriteProbe } =>
      target.name !== "control" && target.name !== "pointer",
  );
  const timeoutMs = deps.timeoutMs ?? SELF_TEST_TIMEOUT_MS;
  let session: Session | string;
  try {
    const child = deps.spawn({ cmd: launch.argv, cwd: launch.cwd, env: launch.env, stdin: "pipe" });
    session = await runSession(child, launch.stdin, deps.clock, timeoutMs);
  } catch (error) {
    session = error instanceof Error ? error.message : String(error);
  }

  let disk: SelfTestDisk;
  try {
    const results = await fs.readText(layout.resultsFile);
    const written: WriteProbe[] = [];
    for (const target of forbidden) {
      if (await fs.exists(target.path)) written.push(target.name);
    }
    const pointerAfter = await fs.readText(pointerFile);
    disk = {
      results,
      written,
      pointerChanged: pointerAfter !== pointer,
      controlWritten: await fs.exists(layout.controlFile),
    };
  } finally {
    // Put the pointer back as it was before the session, in case a write got through.
    try {
      if ((await fs.readText(pointerFile)) !== pointer) await fs.writeText(pointerFile, pointer);
    } catch {
      // Best effort; a changed pointer was already counted, and the run is refused.
    }
    // Remove everything the self-test made, even when a read above threw; the files carry the
    // nonce, so nothing else is touched. One failed removal does not stop the others.
    for (const path of [layout.resultsFile, layout.controlFile, ...forbidden.map((t) => t.path)]) {
      try {
        await fs.remove(path);
      } catch {
        // Best effort; a forbidden file left behind was already counted as written.
      }
    }
  }

  const outcome = sessionOutcome(session, timeoutMs);
  const evidence: SelfTestEvidence = {
    probes: layout.probes,
    outcome: outcome.outcome,
    ...(outcome.detail === undefined ? {} : { outcomeDetail: outcome.detail }),
    denied: typeof session === "string" ? [] : session.denied,
    bash:
      typeof session === "string"
        ? { calls: 0, exact: false, shape: false }
        : bashCalls(session.stdout, layout.command),
    disk,
  };
  return {
    verdict: judgeSelfTest(evidence),
    evidence,
    plugins: typeof session === "string" ? null : pluginCount(session.stdout),
    targets: layout.targets,
  };
}

function sessionOutcome(
  session: Session | string,
  timeoutMs: number,
): { outcome: WorkerOutcome; detail: string | undefined } {
  if (typeof session === "string") {
    return { outcome: "startFailed", detail: `claude did not start: ${session}` };
  }
  if (session.timedOut) return { outcome: "crashed", detail: `no exit within ${timeoutMs} ms` };
  const read = result(session.state, session.exit);
  return {
    outcome: read.outcome,
    detail: session.state.startFailure ?? session.state.initRejected ?? read.park?.detail,
  };
}

/** The verdict as a launch check failure, naming the probe's file where there is one. */
export function selfTestFailure(report: SelfTestReport): LaunchCheckFailure | null {
  const verdict = report.verdict;
  if (verdict.ok) return null;
  const target = report.targets.find((t) => t.name === verdict.probe);
  return {
    check: "self-test",
    detail: verdict.reason,
    ...(target === undefined ? {} : { file: target.path }),
    ...(verdict.probe === undefined ? {} : { key: verdict.probe }),
    fix: verdict.unsafe
      ? "Do not run workers on this machine until the sandbox blocks it; check the Claude Code version and the sandbox settings."
      : "Check that Claude Code starts, the login is the subscription and the sandbox can start (`claude` with the run settings), then start a run again.",
  };
}
