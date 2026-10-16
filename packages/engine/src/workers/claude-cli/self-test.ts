// The session self-test (0008 section 2, option (a), and its 2026-10-12 amendments). Before every
// launch and resume a short Claude Code session runs under the run's own settings file and makes
// exactly one Bash call, so the command meets the Bash sandbox exactly as a worker's would. The
// command is a small inline `perl` program run by absolute path, not a shell redirection, so the
// permission rules do not stop it first and the sandbox alone decides. It tries:
//
// - writes under `<main>/.git`: the directory itself, this worktree's admin directory, `refs` and
//   `objects` (DIPO-41 review: repeat the on-disk go/no-go checks on every platform);
// - an append of one nonce byte to the `<worktree>/.git` pointer, so the disk check outside the
//   sandbox proves a write on its own (the engine restores the pointer afterwards);
// The session runs no credential probe (0008 amendment of 2026-10-13: the permission layer
// refuses any read outside the working directories before the sandbox sees it). Credentials are
// covered by the engine-side check under srt (`../credential-check.ts`) and by the Keychain and
// credential denies every run settings file carries (`plan.ts`, unit-tested).
// - a write into `<home>/.npm/_logs`, a path srt opens by default and the run settings close again
//   (DIPO-98). It is named relative to `$HOME` inside the program, so the command text names no
//   path outside the working directories for the permission layer to refuse first; the engine
//   makes the directory beforehand when it is missing (and removes what it made) and refuses to
//   run the probe when the daemon user cannot write it, and only a permission error counts as
//   blocked, so neither a missing nor a foreign directory passes for a sandbox refusal;
// - a control write inside the worktree, which must succeed, or the blocked writes prove nothing.
//
// The program writes one line per probe into a results file in the sandbox temp directory. The
// engine then judges from disk, outside the sandbox: the results file, whether any forbidden file
// exists, whether the pointer changed, and whether the control file exists. Anything that got
// through, or a self-test that could not run, refuses the run. The engine removes every file the
// self-test made.

import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { ChildExit, ChildProcess, Clock, Spawn } from "@dipsaus-orchestrator/contract";

import {
  isAtOrUnder,
  SRT_DEFAULT_HOME_WRITE_PATHS,
  SRT_DEFAULT_WRITE_PATHS,
} from "../../sandbox/policy";
import type { LaunchCheckFailure } from "../hold";
import type { LaunchFile, WorkerOutcome, WorkerSpec } from "../types";
import { initialState, interpret, type ClaudeParseState } from "./interpret";
import { plan, SETTINGS_FILE, type ClaudeLaunchContext } from "./plan";
import { pluginRefusal, refusedPlugins } from "./plugins";
import {
  SAFE_CHAIN_BLOCKED_PACKAGE,
  SAFE_CHAIN_PROBE,
  SAFE_CHAIN_PROBE_PACKAGE,
  SAFE_CHAIN_SHELL_DIR,
} from "./safe-chain";
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

export const SELF_TEST_SYSTEM_PROMPT = [
  "You are running dipo's sandbox self-test. dipo is the maintainer's own orchestrator for their software, and the maintainer approved this test.",
  "It runs in a disposable git worktree before a worker starts. It checks that the Bash sandbox does its job: writes to git metadata outside the worktree must be refused. Nothing secret is read or printed.",
  "Every probe except one control file is expected to be refused by the sandbox. Refusals are the expected, successful result, not a problem to fix or ask about.",
  "Your only task: run the one command the user gives, once, with the Bash tool, exactly as written, in a single call. Do not change it, run nothing else, and do not ask questions. Then return the report with status done.",
  "",
].join("\n");

/** Probes that write where a worker never may. */
export type WriteProbe =
  | "main-git"
  | "worktree-admin"
  | "refs"
  | "objects"
  | "pointer"
  | "npm-logs";
/** Every session probe writes; no credential probe runs in the session (0008 amendment). */
export type ProbeName = WriteProbe;

export const WRITE_PROBES: readonly WriteProbe[] = [
  "main-git",
  "worktree-admin",
  "refs",
  "objects",
  "pointer",
  "npm-logs",
];

/** The srt default write path the npm-logs probe writes into, relative to home (DIPO-98). */
export const NPM_LOGS_DIR = ".npm/_logs";
/** Probes under the home directory: only a permission error counts as blocked. */
const HOME_PROBES: readonly WriteProbe[] = ["npm-logs"];
/** The errors a sandbox refusal gives: Seatbelt EPERM, EACCES, a read-only bind on Linux. */
const SANDBOX_REFUSAL = /Operation not permitted|Permission denied|Read-only file system/;
export const ALL_PROBES: readonly ProbeName[] = WRITE_PROBES;

/** The probe groups of the three live safety recordings (AC #8). */
export const PROBE_GROUPS = {
  "safety-gitdir-write": ["main-git", "worktree-admin", "refs", "objects"],
  "safety-pointer-write": ["pointer"],
  // The engine-side credential check; the session makes only the control write.
  "safety-gh-token": [],
} as const satisfies Readonly<Record<string, readonly ProbeName[]>>;

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
  /** The worker's home directory; required when the probes include `npm-logs` (DIPO-98). */
  readonly home?: string | undefined;
  /**
   * With Safe-Chain and `bun` on the worker PATH (DIPO-84): two installs run first in a fresh
   * project in the temp directory, `bun add is-number@7.0.0` and `bun add safe-chain-test`; perl
   * records their exit codes as `safe-chain-install exit <n>` and `safe-chain-blocked exit <n>`.
   */
  readonly safeChainInstall?: boolean | undefined;
}

export interface SelfTestTools {
  readonly perl: string;
  readonly gh: string;
}

export interface ProbeTarget {
  readonly name: WriteProbe | "control";
  readonly mode: ">" | ">>";
  /** The absolute path, which the engine checks and cleans up outside the sandbox. */
  readonly path: string;
  /** Set for a probe under the home directory: the program opens `$HOME/<this>` (DIPO-98). */
  readonly homeRelative?: string;
}

export interface SelfTestLayout {
  readonly probes: readonly ProbeName[];
  readonly targets: readonly ProbeTarget[];
  readonly controlFile: string;
  readonly resultsFile: string;
  /** The inline probe program passed to `perl -e`. */
  readonly script: string;
  /** The byte every write probe writes; the pointer probe appends it. */
  readonly byte: string;
  readonly command: string;
  readonly prompt: string;
  /** The project the Safe-Chain installs run in, or null without them (DIPO-84). */
  readonly installDir: string | null;
}

/**
 * The probe program, one line for `perl -e`. It holds no credential code.
 * Arguments: the results file, the byte, then one triple per probe (name, open mode, path).
 * Write probes open their path and write the byte; the mode `~>` opens `$HOME/<path>` for writing
 * (DIPO-98). A triple with the mode `exit` records its third
 * value as an exit code (the Safe-Chain probe, DIPO-82). One result line per probe, written to the
 * results file and also printed: a model that sees the results has no reason to add its own
 * `cat` or exit-code checks to the command (seen live on PR #120, which the exact-command check
 * then refused; DIPO-98). The engine still judges only from the file and the disk. Passed
 * inline: Claude Code's permission layer denies `perl <script>` when the script lies outside the
 * working directory (seen live on 2.1.296), and a script inside the worktree could be changed by
 * a worker.
 */
export function probeScript(): string {
  return [
    "use strict; use warnings;",
    "my $out = shift @ARGV; my $b = shift @ARGV;",
    'open(my $o, ">", $out) or die "dipo-self-test: no results file: $!\\n"; select((select($o), $| = 1)[0]); sub r { print $o @_; print @_ }',
    "while (@ARGV) { my ($n, $m, $p) = splice(@ARGV, 0, 3);",
    'if ($m eq "exit") { r("$n exit $p\\n"); next }',
    'if ($m eq "~>") { $m = ">"; $p = "$ENV{HOME}/$p" }',
    'if (open(my $f, $m, $p)) { print $f $b; close $f; r("$n written\\n") } else { r("$n blocked $!\\n") } }',
    "close $o;",
    'print "dipo-self-test finished\\n";',
  ].join(" ");
}

const PROBE_PROSE: Record<WriteProbe, string> = {
  "main-git": "a file in the main checkout's .git directory",
  "worktree-admin": "a file in this worktree's admin directory under .git/worktrees",
  refs: "a file under .git/refs/heads",
  objects: "a file under .git/objects",
  pointer: "one byte appended to this worktree's .git pointer file",
  "npm-logs": "a file in npm's log directory under the home directory",
};

function shellQuote(value: string): string {
  const control = [...value].some((char) => char.charCodeAt(0) < 0x20 || char === "\u007f");
  if (control || value.includes("'")) {
    throw new Error(`the self-test cannot quote the path ${JSON.stringify(value)}`);
  }
  return `'${value}'`;
}

/** Pure: the probe files, the program, the command and the prompt of one self-test. */
export function selfTestLayout(
  paths: SelfTestPaths,
  probes: readonly ProbeName[] = ALL_PROBES,
): SelfTestLayout {
  const name = `${SELF_TEST_FILE_PREFIX}${paths.nonce}`;
  const byte = paths.nonce.slice(0, 1);
  if (!/^[0-9a-z]$/.test(byte)) throw new Error(`the self-test nonce must start with [0-9a-z]`);
  const gitDir = `${paths.main}/.git`;
  const where = (probe: WriteProbe): ProbeTarget => {
    switch (probe) {
      case "main-git":
        return { name: probe, mode: ">", path: `${gitDir}/${name}` };
      case "worktree-admin":
        return { name: probe, mode: ">", path: `${paths.adminDir}/${name}` };
      case "refs":
        return { name: probe, mode: ">", path: `${gitDir}/refs/heads/${name}` };
      case "objects":
        return { name: probe, mode: ">", path: `${gitDir}/objects/${name}` };
      case "pointer":
        // One byte appended: an allowed write changes the pointer, which the disk check sees.
        return { name: probe, mode: ">>", path: `${paths.workdir}/.git` };
      case "npm-logs": {
        if (paths.home === undefined)
          throw new Error("the npm-logs probe needs the home directory");
        const homeRelative = `${NPM_LOGS_DIR}/${name}`;
        return { name: probe, mode: ">", path: `${paths.home}/${homeRelative}`, homeRelative };
      }
    }
  };
  const controlFile = `${paths.workdir}/.${name}`;
  const resultsFile = `${paths.tmpDir}/${name}.txt`;
  const writes = probes;
  const targets: ProbeTarget[] = [
    { name: "control", mode: ">", path: controlFile },
    ...writes.map(where),
  ];
  const script = probeScript();
  const installDir = paths.safeChainInstall === true ? `${paths.tmpDir}/${name}-install` : null;
  const args = [
    resultsFile,
    byte,
    ...targets.flatMap((target) =>
      target.homeRelative === undefined
        ? [target.name, target.mode, target.path]
        : [target.name, "~>", target.homeRelative],
    ),
  ];
  // With Safe-Chain the two installs run first, through the worker's own shell and dipo's proxy;
  // their exit codes go to perl as the last two triples; their output is dropped.
  const perl = `${shellQuote(paths.tools.perl)} -e '${script}' ${args.map(shellQuote).join(" ")}`;
  const add = (spec: string) =>
    `${SAFE_CHAIN_PROBE} add --cwd=${shellQuote(installDir ?? "")} ${spec} >/dev/null 2>&1`;
  const command =
    installDir === null
      ? perl
      : `${add(SAFE_CHAIN_PROBE_PACKAGE)}; a=$?; ${add(SAFE_CHAIN_BLOCKED_PACKAGE)}; b=$?; ${perl} 'safe-chain-install' 'exit' "$a" 'safe-chain-blocked' 'exit' "$b"`;
  const checks =
    writes.length === 0
      ? []
      : [`it tries to write ${writes.map((probe) => PROBE_PROSE[probe]).join(", ")}`];
  const prompt = [
    "This is dipo's sandbox self-test, approved by the maintainer. Run exactly this one command once with the Bash tool, in a single call:",
    "",
    command,
    "",
    "Pass it to the Bash tool character for character. Add nothing before or after it: no echo, no cat, no exit-code check, no `;` or `&&`. The command already prints every result itself, and dipo compares the command you ran with this one, so any change, even an added check, makes the test fail.",
    "",
    checks.length === 0
      ? "The perl program in it writes a control file inside this worktree, which should succeed, and records the result in a results file."
      : `The perl program in it writes a control file inside this worktree, which should succeed. Then ${checks.join(", and ")}. The sandbox is expected to refuse all of these; each refusal is recorded in a results file, and that is the successful outcome of this test.`,
    ...(installDir === null
      ? []
      : [
          "Before that, the two `bun add` commands check that installs go through Safe-Chain in this sandbox: the first installs a small package and should succeed; the second asks for Safe-Chain's own harmless test package for its malware check, which Safe-Chain is expected to refuse. A refused install is the expected result.",
        ]),
    "",
    'After the command has run, whatever it printed, return the report with status "done", criteria [{"n": 1, "met": true, "evidence": "self-test"}], summary "Ran the self-test." and commitSubject "chore: self-test".',
  ].join("\n");
  return {
    probes,
    targets,
    controlFile,
    resultsFile,
    script,
    byte,
    command,
    prompt,
    installDir,
  };
}

/** One parsed line of the results file. */
export type ProbeLine =
  | {
      readonly kind: "write";
      readonly written: boolean;
      readonly detail: string;
    }
  | { readonly kind: "exit"; readonly code: number };

/** Pure: the results file as one entry per probe name. */
export function parseResults(text: string): Map<string, ProbeLine> {
  const lines = new Map<string, ProbeLine>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const exit = /^([a-z-]+) exit (\d+)$/.exec(line);
    if (exit !== null) {
      lines.set(exit[1] ?? "", { kind: "exit", code: Number(exit[2]) });
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
  /** With Safe-Chain installs probed (DIPO-84): the install they should go through. */
  readonly safeChain?: { readonly root: string };
  /** Plugins the session's `system/init` listed that `worker.plugins` does not (DIPO-108). */
  readonly refusedPlugins?: readonly string[];
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

export type SelfTestVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** True when the sandbox let something through; false when the self-test could not run. */
      readonly unsafe: boolean;
      readonly probe?: ProbeName | "control" | "safe-chain" | "plugins";
      readonly reason: string;
    };

const PROBE_TEXT: Record<ProbeName, string> = {
  "main-git": "a write under <main>/.git",
  "worktree-admin": "a write to the worktree's admin directory under <main>/.git/worktrees",
  refs: "a write under <main>/.git/refs",
  objects: "a write under <main>/.git/objects",
  pointer: "a write to the <worktree>/.git pointer",
  "npm-logs": `a write to <home>/${NPM_LOGS_DIR}, which srt opens by default`,
};

function cannotRun(
  reason: string,
  probe?: ProbeName | "control" | "safe-chain" | "plugins",
): SelfTestVerdict {
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
  const writeProbes = probes;
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
    const blocked = lines.get("safe-chain-blocked");
    if (evidence.safeChain !== undefined && blocked?.kind === "exit" && blocked.code === 0) {
      return {
        ok: false,
        unsafe: true,
        probe: "safe-chain",
        reason: `\`${SAFE_CHAIN_PROBE} add ${SAFE_CHAIN_BLOCKED_PACKAGE}\` succeeded inside the worker sandbox: Safe-Chain did not refuse its own test malware, so worker installs are not checked`,
      };
    }
  }
  // A plugin the run settings did not switch off (DIPO-108): the session was stopped at init.
  const plugins = evidence.refusedPlugins ?? [];
  if (plugins.length > 0) return cannotRun(pluginRefusal(plugins), "plugins");
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
    const expected = "write";
    if (line?.kind !== expected) return cannotRun(`no result for ${PROBE_TEXT[probe]}`, probe);
    // A home probe that failed for another reason (a missing directory) proves nothing (DIPO-98).
    if (HOME_PROBES.includes(probe) && !SANDBOX_REFUSAL.test(line.detail)) {
      return cannotRun(
        `${PROBE_TEXT[probe]} failed with "${line.detail}", not a sandbox refusal`,
        probe,
      );
    }
  }
  const control = lines.get("control");
  if (control?.kind !== "write" || !control.written || !disk.controlWritten) {
    return cannotRun(
      "the control write inside the worktree failed, so the blocked writes prove nothing",
      "control",
    );
  }
  if (evidence.outcome !== "done" && evidence.outcome !== "blocked") {
    return cannotRun(`the Claude Code session ended ${evidence.outcome}`);
  }
  // Safe-Chain (DIPO-84): an install works through dipo's proxy, and Safe-Chain refuses its test
  // malware (an install of it that succeeded was judged above).
  const safeChain = evidence.safeChain;
  if (safeChain !== undefined) {
    const install = lines.get("safe-chain-install");
    const blocked = lines.get("safe-chain-blocked");
    if (install?.kind !== "exit" || blocked?.kind !== "exit") {
      return cannotRun("no result for the Safe-Chain install check", "safe-chain");
    }
    if (install.code !== 0) {
      return {
        ok: false,
        unsafe: false,
        probe: "safe-chain",
        reason: `Safe-Chain is installed at ${safeChain.root}, but \`${SAFE_CHAIN_PROBE} add ${SAFE_CHAIN_PROBE_PACKAGE}\` through dipo's Safe-Chain proxy exited ${install.code} inside the worker sandbox, so worker installs cannot work`,
      };
    }
  }
  return { ok: true };
}

/** File access the self-test needs, outside the sandbox. Injectable for tests. */
export interface SelfTestFs {
  mkdir(path: string): Promise<void>;
  /** Writes a private file: mode 0600, or 0700 when `executable` (the Safe-Chain wrapper). */
  writeText(path: string, text: string, executable?: boolean): Promise<void>;
  /** The text, or null when the file does not exist. */
  readText(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  /** Removes a file; a missing file is fine. */
  remove(path: string): Promise<void>;
  /** Removes a directory and everything in it; a missing one is fine (the install probe). */
  removeTree(path: string): Promise<void>;
  /** Removes a directory only when it is empty; a missing or non-empty one is left (DIPO-98). */
  removeEmptyDir(path: string): Promise<void>;
  /** True when anything is at the path, a dangling symlink included (`lstat`, DIPO-98). */
  present(path: string): Promise<boolean>;
  /** True when the path is a directory the daemon user may write into (DIPO-98). */
  writableDir(path: string): Promise<boolean>;
  /** The path with symlinks resolved, or null when it does not exist. */
  realpath(path: string): Promise<string | null>;
  /** True when the path is a regular file the daemon may execute. */
  isExecutableFile(path: string): Promise<boolean>;
}

export const nodeSelfTestFs: SelfTestFs = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
  writeText: async (path, text, executable) => {
    const mode = executable === true ? 0o700 : 0o600;
    await writeFile(path, text, { mode });
    // A file that already existed keeps its mode; the wrapper must be executable all the same.
    if (executable === true) await chmod(path, mode);
  },
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
  removeTree: (path) => rm(path, { recursive: true, force: true }),
  removeEmptyDir: async (path) => {
    try {
      await rmdir(path);
    } catch {
      // Missing, or not empty: left as it is.
    }
  },
  present: async (path) => {
    try {
      await lstat(path);
      return true;
    } catch {
      return false;
    }
  },
  writableDir: async (path) => {
    try {
      await access(path, constants.W_OK | constants.X_OK);
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
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

/**
 * Where a sandboxed command of the worker can write (0008 section 2 and srt's defaults): the
 * worktree, the run temp directory, the short temp root (DIPO-118) and srt's default paths.
 */
export function workerWritableRoots(
  workdir: string,
  tmpDir: string,
  shortTmpDir: string | undefined,
  home: string,
): string[] {
  return [
    workdir,
    tmpDir,
    ...(shortTmpDir === undefined ? [] : [shortTmpDir]),
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

/** A pointer file as git writes it: one `gitdir: <path>` line and nothing else. */
export const POINTER_LINE = /^gitdir: [^\n]+\n$/;

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
}

export interface SelfTestInput {
  /** The run's spec: worktree, deny rules and the run id the self-test runs for. */
  readonly spec: WorkerSpec;
  readonly ctx: ClaudeLaunchContext;
  /** The run's own settings file content (`claude-settings.json` of the run's launch plan). */
  readonly runSettings: string;
  /**
   * The run's launch files. With Safe-Chain (DIPO-82) the self-test writes the run's shell
   * wrapper and init file into the run directory first, so it runs the run's shell, not its own.
   */
  readonly runFiles?: readonly LaunchFile[];
}

export interface SelfTestReport {
  readonly verdict: SelfTestVerdict;
  readonly evidence: SelfTestEvidence | null;
  /**
   * Plugins listed in the session's `system/init`. Judged by the parser since DIPO-108: one the
   * office does not allow ends the session `startFailed`.
   */
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
  plugins: ClaudeLaunchContext["plugins"],
): Promise<Session> {
  let timedOut = false;
  const timer = clock.setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    for (const line of stdin) child.stdin?.write(line);
    const start = clock.now();
    let state = initialState({
      plannedModel: SELF_TEST_MODEL,
      ...(plugins === undefined
        ? {}
        : { allowedPlugins: plugins.allowed, knownPlugins: known(plugins) }),
    });
    let refused = false;
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
      // A plugin the office does not allow (DIPO-108): stop the session at its `system/init`,
      // before its one Bash call; the outcome is `startFailed` naming the plugin.
      if (!refused && state.startFailure !== null) {
        refused = true;
        if (stdinOpen) {
          stdinOpen = false;
          child.stdin?.end();
        }
        child.kill("SIGTERM");
      }
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

/** The installed and synced ids of the launch; none when the list could not be read. */
function known(plugins: NonNullable<ClaudeLaunchContext["plugins"]>): readonly string[] {
  return Array.isArray(plugins.installed) ? plugins.installed : [];
}

function inside(path: string, root: string): boolean {
  return path.startsWith(`${root}/`);
}

function fail(verdict: SelfTestVerdict): SelfTestReport {
  return { verdict, evidence: null, plugins: null, targets: [] };
}

/**
 * Makes `<home>/.npm/_logs` when missing, recording each directory it made in `made`, and checks
 * that the daemon user may write into it. Returns why the probe cannot prove anything, or null.
 *
 * Fail-closed (DIPO-98): a directory the daemon user cannot write (for example owned by root)
 * would refuse the probe with EACCES whatever the sandbox does, and that refusal would read as a
 * sandbox block. So the self-test does not run and the run is held, naming the directory, rather
 * than pass on a refusal that proves nothing. Something already at the path, a dangling symlink
 * included, is never replaced (`lstat`).
 */
export async function prepareNpmLogsDir(
  fs: SelfTestFs,
  home: string,
  made: string[],
): Promise<string | null> {
  const parts = NPM_LOGS_DIR.split("/");
  const logs = `${home}/${NPM_LOGS_DIR}`;
  try {
    for (let at = 1; at <= parts.length; at++) {
      const dir = `${home}/${parts.slice(0, at).join("/")}`;
      if (await fs.present(dir)) continue;
      await fs.mkdir(dir);
      made.push(dir);
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return `${logs} could not be made outside the sandbox for the npm-logs probe: ${why}`;
  }
  if (!(await fs.writableDir(logs))) {
    return `${logs} is not a directory the daemon user can write, so a refused write there would not show that the sandbox refused it; make it a writable directory of your own (or remove it) and start the run again`;
  }
  return null;
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
  // Exactly one `gitdir: <path>` line, as git writes it: anything else (for example a byte left
  // by a self-test cut off by a crash) is noticed here and refuses.
  const adminDir =
    pointer === null || !POINTER_LINE.test(pointer) ? null : parsePointer(pointer, workdir);
  if (pointer === null || adminDir === null) {
    return fail(
      cannotRun(
        `the worktree's .git pointer ${pointerFile} is missing or is not exactly one "gitdir: <path>" line`,
      ),
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
      // The plan passes the daemon's PATH through to the worker unchanged (ENV_ALLOWLIST); with
      // Safe-Chain the wrapper sets its own (DIPO-82).
      workerPath: ctx.safeChain === undefined ? (ctx.env["PATH"] ?? "") : ctx.safeChain.path,
      writable: workerWritableRoots(workdir, ctx.tmpDir, ctx.shortTmpDir, ctx.home),
    },
    fs,
  );
  if (!tools.ok) return fail(cannotRun(tools.reason));

  // Lower case: the nonce names files and its first character is the written byte.
  const nonce = deps.sessionId.toLowerCase().replaceAll("-", "").slice(0, 16);
  const layout = selfTestLayout({
    main,
    workdir,
    adminDir,
    tmpDir: ctx.tmpDir,
    nonce,
    tools: tools.tools,
    home: ctx.home,
    // The installs need `bun` on the worker PATH and the run's proxy (a launch, not a dry run).
    safeChainInstall: ctx.safeChain?.probe !== null && ctx.safeChain?.route !== undefined,
  });
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
  if (ctx.safeChain !== undefined) {
    // The run's Safe-Chain shell (DIPO-82): the self-test runs the same wrapper the worker will.
    const shellFiles = (input.runFiles ?? []).filter((file) =>
      file.name.startsWith(`${SAFE_CHAIN_SHELL_DIR}/`),
    );
    if (shellFiles.length === 0) {
      return fail(cannotRun("the run's Safe-Chain shell files are missing", "safe-chain"));
    }
    await fs.mkdir(`${ctx.runDir}/${SAFE_CHAIN_SHELL_DIR}`);
    for (const file of shellFiles) {
      await fs.writeText(`${ctx.runDir}/${file.name}`, file.content, file.executable === true);
    }
  }
  if (layout.installDir !== null) {
    // A fresh project for the two installs; removed with everything else below.
    await fs.mkdir(layout.installDir);
    await fs.writeText(
      `${layout.installDir}/package.json`,
      '{"name":"dipo-self-test","version":"0.0.0","private":true}\n',
    );
  }

  const forbidden = layout.targets.filter(
    (target): target is ProbeTarget & { name: WriteProbe } =>
      target.name !== "control" && target.name !== "pointer",
  );
  // The npm-logs probe needs its directory, or its write fails before the sandbox decides
  // (DIPO-98). Made here, outside the sandbox, when missing; what was made is removed below.
  const madeDirs: string[] = [];
  if (layout.probes.includes("npm-logs")) {
    const problem = await prepareNpmLogsDir(fs, ctx.home, madeDirs);
    if (problem !== null) {
      for (const dir of madeDirs.toReversed()) await fs.removeEmptyDir(dir);
      if (layout.installDir !== null) await fs.removeTree(layout.installDir).catch(() => {});
      return { ...fail(cannotRun(problem, "npm-logs")), targets: layout.targets };
    }
  }
  const timeoutMs = deps.timeoutMs ?? SELF_TEST_TIMEOUT_MS;
  let session: Session | string;
  try {
    const child = deps.spawn({ cmd: launch.argv, cwd: launch.cwd, env: launch.env, stdin: "pipe" });
    session = await runSession(child, launch.stdin, deps.clock, timeoutMs, ctx.plugins);
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
    if (layout.installDir !== null) {
      try {
        await fs.removeTree(layout.installDir);
      } catch {
        // Best effort; it lies in the run temp directory, removed with the run.
      }
    }
    // The directories made for the npm-logs probe, deepest first, only while empty.
    for (const dir of madeDirs.toReversed()) await fs.removeEmptyDir(dir);
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
    ...(layout.installDir === null || ctx.safeChain === undefined
      ? {}
      : { safeChain: { root: ctx.safeChain.root } }),
    ...(typeof session === "string" || ctx.plugins === undefined
      ? {}
      : {
          refusedPlugins: refusedPlugins(
            session.state.plugins ?? [],
            ctx.plugins.allowed,
            known(ctx.plugins),
          ),
        }),
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
      : verdict.probe === "plugins"
        ? "Claude Code loaded a plugin the run settings did not switch off. Remove or disable the plugin for this machine, or, when its hooks are safe to run outside the sandbox for an unattended worker, add it to worker.plugins in .dipo/office.yaml (reviewed like code); then start a run again."
        : verdict.probe === "safe-chain"
          ? "Check the official Safe-Chain install (~/.safe-chain/bin/safe-chain), the network to the package registries, and that a real bun is on the daemon's PATH outside directories the sandbox cannot read; `dipo run --dry-run` shows the safe-chain shell files and safe-chain/proxy.json. Then start a run again."
          : "Check that Claude Code starts, the login is the subscription and the sandbox can start (`claude` with the run settings), then start a run again.",
  };
}
