// Setting up a claimed worktree (0010 sections 8 and 9, its 0008 amendment; 0013 section 4).
// `claimStory` (DIPO-38) calls it through `ClaimRequest.setup` after the worktree, its lock and
// the live claim record, and before the claim commit and the push (0010 section 7). In order:
//
// 1. takes the lowest free machine-wide port slot (`slots.ts`) and builds the run environment
//    (`run-env.ts`);
// 2. places the configured gitignored files and the filtered `.claude/settings.local.json`
//    (`files.ts`), and the first time an office gets env files, shows the development-secrets
//    notice once with the list of files;
// 3. checks the free space again (below `MIN_FREE_BYTES` fails setup with a log line naming it);
// 4. runs install from the run profile, then the profile's `setup` script, then each
//    `worktree.post_create` argument list, each through the sandboxed step runner (DIPO-37) with
//    the run environment, never through a shell. Install gets the install policy (its registry
//    hosts); `setup` and `post_create` get the closed-network policy;
// 5. reads what the office's verify says about the base commit (DIPO-183): the stored result for
//    this base commit and configuration, else one run of verify in the worktree under the
//    worker's read fence, stored when it ran to the end (`base-verify.ts`). The worktree is
//    restored afterwards. A verify that cannot run gives a not-known result and never fails setup.
//
// A failure frees the slot and returns `{ ok: false, reason, log }`; `claimStory` then rolls the
// claim back (worktree removed, a new branch deleted only while it still points at its start,
// nothing committed or pushed, the story still Ready) and returns a `pickupCheckFailed` skip with
// the log. A success returns the slot and the run environment with `release`, which frees the
// slot when the claim fails after setup. The log names paths, commands and exit codes, never
// file contents.
//
// Setup runs outside the git queue, so a long install does not hold the office's git queue; each
// git step it needs (`check-ignore`) is a queue item of its own.

import { statusPaths } from "../backlog/lane/lane";
import type { OfficeConfig } from "../config";
import type { GitLocation } from "../git/hardened";
import type { GitSession } from "../git/office";
import { type DiskProbe, formatGigabytes } from "../platform/disk";
import type { CommandSpec, RunProfile } from "../scan/detect";
import type { LocalSettingsCopy } from "../workers/port";
import type { CapturedOutput, StepRequest, StepResult } from "../sandbox/step";
import type { StepPolicyKind } from "../sandbox/policy";

import type { BaseVerifyFacts } from "../prompts/base-verify";
import {
  baseVerifyConfigHash,
  failingTests,
  findBaseVerify,
  outputEnd,
  storeBaseVerify,
} from "./base-verify";
import {
  CLAIM_NOTICES,
  type ClaimDeps,
  type ClaimSetupDone,
  type ClaimSetupFailed,
  MIN_FREE_BYTES,
  notice,
  writeWith,
} from "./claim";
import { type FileStepResult, placeFiles } from "./files";
import type { ClaimRecord } from "./records";
import { buildRunEnv } from "./run-env";
import { slotsTakenMessage, type SlotTable } from "./slots";

/** `engine.notice` codes of setup. */
export const SETUP_NOTICES = {
  failed: CLAIM_NOTICES.setupFailed,
  envFiles: "setup.envFiles",
  fileSkipped: "setup.fileSkipped",
  settingsNotCopied: "setup.settingsNotCopied",
} as const;

/** The development-secrets rule (0008 section 2, "Env files"; open question 8). */
export const ENV_FILES_RULE = "worktree env files hold development secrets only";

/** Characters of a failed step's stdout and stderr kept in the setup log. */
export const STEP_OUTPUT_TAIL = 4000;

/** Paths per `git check-ignore` call. */
const CHECK_IGNORE_BATCH = 200;

export interface SetupDeps extends Pick<
  ClaimDeps,
  "officeId" | "office" | "git" | "clock" | "onChanged"
> {
  readonly disk: DiskProbe;
  /** The machine-wide slot table in `<state>`. */
  readonly slots: SlotTable;
  /** The worker port's local settings copy for step 2 (DIPO-113). */
  readonly localSettings: LocalSettingsCopy;
  /** Runs one sandboxed step: `runSandboxedStep` with the daemon's step dependencies. */
  readonly runStep: (request: StepRequest) => Promise<StepResult>;
  /**
   * Logs a failed step (the daemon's logger at warn): script, command and exit. A warn line never
   * shows `stdout` and `stderr` (0006 decision 13), so the output tails also go to `debug`.
   */
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
  /** Logs a failed step's output tails at debug, where the logger shows them (DIPO-200). */
  readonly debug?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

/** Characters of a failed step's stderr (else stdout) the failure reason and its notice carry. */
export const REASON_OUTPUT_TAIL = 300;

/** The last `max` characters of a step's output on one line, or null when it printed nothing. */
export function outputTail(
  output: CapturedOutput,
  max: number = REASON_OUTPUT_TAIL,
): string | null {
  const text = output.text.trim().replace(/\s+/g, " ");
  if (text === "") return null;
  return text.length > max ? `…${text.slice(-max)}` : text;
}

/** The daemon's facts a sandboxed step needs. */
export interface SetupHost {
  readonly home: string;
  readonly uid: number;
  /** The daemon's environment; only the step allowlist passes. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface SetupRequest {
  /** The live claim `claimStory` passes to its `setup`. */
  readonly claim: ClaimRecord;
  readonly config: Pick<OfficeConfig, "worktree" | "timeouts" | "sandbox">;
  /** The office's stored run profile (DIPO-72); null before its first scan. */
  readonly profile: RunProfile | null;
  readonly host: SetupHost;
}

export interface SetupDone extends ClaimSetupDone {
  readonly ok: true;
  readonly slot: number;
  /** The run environment for every later process in the worktree. */
  readonly env: Readonly<Record<string, string>>;
  readonly files: FileStepResult;
  readonly log: readonly string[];
  /**
   * What the office's verify said about the base commit in the worker's sandbox (DIPO-183), from
   * a run now or the stored result of an earlier run on the same base. Absent means not known.
   */
  readonly baseVerify?: BaseVerifyFacts;
}

export type SetupOutcome = SetupDone | ClaimSetupFailed;

/** A setup failure with its reason for the notice. */
class SetupFailure extends Error {}

/** Sets up the claimed worktree; see the file comment. Never throws for a setup failure. */
export async function setupWorktree(deps: SetupDeps, request: SetupRequest): Promise<SetupOutcome> {
  const { claim, config, profile } = request;
  const log: string[] = [];
  try {
    const slot = deps.slots.take(
      {
        office: deps.officeId,
        story: claim.story,
        worktree: claim.worktree,
        takenAt: deps.clock.now(),
      },
      config.worktree.maxSlots,
    );
    if (slot === null) {
      throw new SetupFailure(slotsTakenMessage(deps.slots.live(), config.worktree.maxSlots));
    }
    log.push(`slot: ${slot} (port offset ${slot * config.worktree.ports.stride})`);
    const env = buildRunEnv({
      slot,
      stride: config.worktree.ports.stride,
      story: claim.story,
      worktree: claim.worktree,
      named: config.worktree.ports.named,
      devPort: devPortOf(profile),
      env: config.worktree.env,
    });

    const files = await placeFiles({
      main: deps.git.mainWorktree,
      worktree: claim.worktree,
      files: config.worktree.files,
      ignored: (paths) => ignoredIn(deps, claim.worktree, paths),
      envFiles: new Set(profile?.envFiles.map((file) => file.path) ?? []),
      localSettings: deps.localSettings,
    });
    log.push(...files.log);
    fileNotices(deps, claim, files);

    if (profile === null) {
      throw new SetupFailure("the office has no run profile yet; rescan the office");
    }

    const free = await deps.disk.freeBytes(claim.worktree);
    if (free < MIN_FREE_BYTES) {
      log.push(
        `disk: the filesystem holding ${claim.worktree} has ${formatGigabytes(free)} free, less than the ${formatGigabytes(MIN_FREE_BYTES)} install needs`,
      );
      throw new SetupFailure(
        `only ${formatGigabytes(free)} free before install, less than ${formatGigabytes(MIN_FREE_BYTES)}`,
      );
    }
    log.push(`disk: ${formatGigabytes(free)} free before install`);

    const run = (spec: CommandSpec, kind: StepPolicyKind, script: string) =>
      runCommands(deps, request, env, log, { spec, kind, script });

    const install = profile.capabilities.install;
    if (install.status === "resolved") {
      await run(install.value, "install", "install");
    } else if (install.status === "conflict") {
      throw new SetupFailure("the run profile's install is in conflict; confirm one in the office");
    } else {
      log.push("install: none in the run profile");
    }
    const setup = profile.capabilities.setup;
    if (setup.status === "resolved") {
      await run(setup.value, "verify", "setup");
    } else if (setup.status === "conflict") {
      throw new SetupFailure("the run profile's setup is in conflict; confirm one in the office");
    }
    for (const command of config.worktree.post_create) {
      await run({ commands: [command], cwd: "." }, "verify", "post_create");
    }
    const left = await changedPaths(deps, claim.worktree);
    if (left.length > 0) {
      log.push(`setup: changes outside .gitignore: ${left.join(", ")}`);
      throw new SetupFailure(
        `setup left files git does not ignore (${left.slice(0, 5).join(", ")}${left.length > 5 ? ", and more" : ""}); setup steps may change only ignored files. If install rewrote a lockfile, use a frozen install (for example \`bun install --frozen-lockfile\`); write generated files to ignored paths`,
      );
    }
    // The worktree is installed and, for a new branch, still the base commit: what verify says
    // about the base is read now, before the worker can change anything (DIPO-183).
    const baseVerify = await baseVerifyOf(deps, request, env, log);
    log.push("setup: done");
    const release = (): void => {
      deps.slots.free(claim.worktree);
    };
    return { ok: true, slot, env, files, log, release, baseVerify };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (!(error instanceof SetupFailure)) log.push(`setup: ${why}`);
    try {
      deps.slots.free(claim.worktree);
    } catch (freeError) {
      log.push(`setup: the slot could not be freed: ${String(freeError)}`);
    }
    log.push(`setup: failed: ${why}`);
    return { ok: false, reason: why, log: log.join("\n") };
  }
}

const unknownBecause = (reason: string): BaseVerifyFacts => ({ kind: "unknown", reason });

/**
 * The base commit's verify result: the stored one for this base and configuration, else one run of
 * the office's verify in this worktree under the worker's read fence, stored when it ran to the
 * end. Never fails the setup: a verify that cannot run is a not-known result, logged.
 */
async function baseVerifyOf(
  deps: SetupDeps,
  request: SetupRequest,
  env: Readonly<Record<string, string>>,
  log: string[],
): Promise<BaseVerifyFacts> {
  const { claim } = request;
  const hash = baseVerifyConfigHash(request.config, request.profile);
  const stored = findBaseVerify(deps.office, claim.baseSha, hash);
  if (stored !== null) {
    log.push(`base verify: stored result for ${claim.baseSha.slice(0, 12)}: ${stored.kind}`);
    return stored;
  }
  let result: BaseVerifyFacts;
  try {
    result = await runBaseVerify(deps, request, env, log);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    deps.warn?.("the base verify failed", { story: claim.story, reason: why });
    result = unknownBecause(`the base verify failed: ${why}`);
  }
  // A test run may leave files git does not ignore; the worktree must be as setup left it. A
  // worktree that cannot be restored fails the setup, since the worker would inherit the files.
  await restoreWorktree(deps, claim.worktree);
  if (result.kind === "unknown") {
    log.push(`base verify: not known: ${result.reason}`);
    return result;
  }
  deps.office.immediate(() =>
    storeBaseVerify(deps.office, {
      baseSha: claim.baseSha,
      hash,
      runId: claim.runId,
      result,
      at: deps.clock.now(),
    }),
  );
  log.push(`base verify: ${result.kind}`);
  return result;
}

/** Runs verify once at the base commit. The caller restores the worktree afterwards. */
async function runBaseVerify(
  deps: SetupDeps,
  request: SetupRequest,
  env: Readonly<Record<string, string>>,
  log: string[],
): Promise<BaseVerifyFacts> {
  const { claim, config } = request;
  const verify = request.profile?.capabilities.verify;
  if (verify?.status !== "resolved") {
    return unknownBecause("the run profile has no resolved verify");
  }
  if (verify.value.cwd !== ".") {
    return unknownBecause(`verify runs in ${verify.value.cwd}, not at the worktree root`);
  }
  const head = await deps.git.run(async (git) =>
    (
      await git.ok(deps.git.worktreeLocation(claim.worktree), [
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
      ])
    ).trim(),
  );
  if (head !== claim.baseSha) {
    return unknownBecause(
      `the worktree is at ${head.slice(0, 12)} after setup, not at the base commit ${claim.baseSha.slice(0, 12)}`,
    );
  }
  let ran = false;
  for (const command of verify.value.commands) {
    const [program, ...args] = command;
    if (program === undefined) continue;
    log.push(`base verify: $ ${command.join(" ")}`);
    const result = await deps.runStep({
      kind: "verify",
      script: "verify",
      command: [program, ...args],
      worktree: claim.worktree,
      mainCheckout: deps.git.mainWorktree,
      home: request.host.home,
      uid: request.host.uid,
      sandbox: {
        installCachePaths: config.sandbox.installCachePaths,
        registryHosts: config.sandbox.registryHosts,
      },
      readFence: { readPaths: [...config.sandbox.toolchainReadPaths, ...config.sandbox.allowRead] },
      scriptMinutes: config.timeouts.scriptMinutes,
      env: request.host.env,
      extraEnv: env,
    });
    if (result.outcome === "startFailed") {
      return unknownBecause(`verify did not start: ${result.reason}`);
    }
    if (result.timedOut) {
      return unknownBecause(
        `verify timed out after ${config.timeouts.scriptMinutes["verify"] ?? "?"} min`,
      );
    }
    if (result.code === null) {
      return unknownBecause(`verify ended by ${result.signal ?? "a signal"}`);
    }
    ran = true;
    if (result.code !== 0) {
      const output = `${result.stdout.text}\n${result.stderr.text}`;
      const failing = failingTests(output);
      return { kind: "red", failing, tail: failing.length > 0 ? null : outputEnd(output) };
    }
  }
  return ran ? { kind: "green" } : unknownBecause("the run profile's verify has no command");
}

/**
 * Puts the worktree back to its commit after the base verify: a test run may write files git does
 * not ignore, and the worker's scope check at `done` would count them as the worker's. Setup left
 * only ignored files before the verify, so everything else in the status is the verify's.
 */
async function restoreWorktree(deps: SetupDeps, worktree: string): Promise<void> {
  const left = await changedPaths(deps, worktree);
  if (left.length === 0) return;
  await deps.git.run(async (git) => {
    const location = deps.git.worktreeLocation(worktree);
    await git.ok(location, ["reset", "--hard", "--quiet", "HEAD"]);
    await git.ok(location, ["clean", "-fdq"]);
  });
}

/** The dev port of the root package, else the first the scan found; null when none. */
function devPortOf(profile: RunProfile | null): number | null {
  const ports = profile?.devPorts ?? [];
  return (ports.find((port) => port.dir === ".") ?? ports[0])?.port ?? null;
}

interface Step {
  readonly spec: CommandSpec;
  readonly kind: StepPolicyKind;
  readonly script: string;
}

/** Runs each argument list of `step` in order; the first failure throws `SetupFailure`. */
async function runCommands(
  deps: SetupDeps,
  request: SetupRequest,
  env: Readonly<Record<string, string>>,
  log: string[],
  step: Step,
): Promise<void> {
  if (step.spec.cwd !== ".") {
    log.push(`${step.script}: working directory ${step.spec.cwd}`);
    throw new SetupFailure(
      `${step.script} runs in ${step.spec.cwd}, but setup runs commands only at the worktree root`,
    );
  }
  for (const command of step.spec.commands) {
    const [program, ...args] = command;
    if (program === undefined) continue;
    const shown = command.join(" ");
    log.push(`${step.script}: $ ${shown}`);
    const result = await deps.runStep({
      kind: step.kind,
      script: step.script,
      command: [program, ...args],
      worktree: request.claim.worktree,
      mainCheckout: deps.git.mainWorktree,
      home: request.host.home,
      uid: request.host.uid,
      sandbox: {
        installCachePaths: request.config.sandbox.installCachePaths,
        registryHosts: request.config.sandbox.registryHosts,
      },
      scriptMinutes: request.config.timeouts.scriptMinutes,
      env: request.host.env,
      extraEnv: env,
    });
    if (result.outcome === "startFailed") {
      log.push(`${step.script}: did not start: ${result.reason}`);
      throw new SetupFailure(`${step.script} (${shown}) did not start: ${result.reason}`);
    }
    for (const warning of result.warnings) log.push(`${step.script}: sandbox: ${warning}`);
    if (result.code === 0 && !result.timedOut) {
      log.push(`${step.script}: exit 0`);
      continue;
    }
    const ended = result.timedOut
      ? `timed out after ${request.config.timeouts.scriptMinutes[step.script]} min`
      : result.code === null
        ? `ended by ${result.signal ?? "a signal"}`
        : `exit ${result.code}`;
    log.push(`${step.script}: ${ended}`);
    pushOutput(log, step.script, "stdout", result.stdout);
    pushOutput(log, step.script, "stderr", result.stderr);
    deps.warn?.("a setup step failed", {
      story: request.claim.story,
      script: step.script,
      command: shown,
      exitCode: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      stdout: result.stdout.text.slice(-STEP_OUTPUT_TAIL),
      stderr: result.stderr.text.slice(-STEP_OUTPUT_TAIL),
    });
    deps.debug?.("a setup step's output", {
      story: request.claim.story,
      script: step.script,
      stdout: result.stdout.text.slice(-STEP_OUTPUT_TAIL),
      stderr: result.stderr.text.slice(-STEP_OUTPUT_TAIL),
    });
    const tail = outputTail(result.stderr) ?? outputTail(result.stdout);
    throw new SetupFailure(
      `${step.script} (${shown}) failed: ${ended}${tail === null ? "" : `: ${tail}`}`,
    );
  }
}

function pushOutput(log: string[], script: string, name: string, output: CapturedOutput): void {
  const text = output.text.trimEnd();
  if (text === "") return;
  const cut = text.length > STEP_OUTPUT_TAIL || output.truncated;
  log.push(`${script}: ${name}${cut ? " (tail)" : ""}:`);
  log.push(text.length > STEP_OUTPUT_TAIL ? text.slice(-STEP_OUTPUT_TAIL) : text);
}

/** The paths among `paths` that git ignores in the worktree, through the office's git queue. */
async function ignoredIn(
  deps: SetupDeps,
  worktree: string,
  paths: readonly string[],
): Promise<ReadonlySet<string>> {
  return deps.git.run(async (git) => {
    const location = deps.git.worktreeLocation(worktree);
    const ignored = new Set<string>();
    for (let start = 0; start < paths.length; start += CHECK_IGNORE_BATCH) {
      const batch = paths.slice(start, start + CHECK_IGNORE_BATCH);
      for (const path of await checkIgnore(git, location, batch)) ignored.add(path);
    }
    return ignored;
  });
}

/**
 * `git check-ignore -- <paths>`: the same rule as `check-ignore -q` per path, batched. Exit 0
 * prints the ignored paths one per line, exit 1 means none is ignored; tracked paths are never
 * printed. `files.ts` refuses names git would quote, so each line is a path as given.
 */
async function checkIgnore(
  git: GitSession,
  location: GitLocation,
  paths: readonly string[],
): Promise<string[]> {
  const result = await git.step(location, ["check-ignore", "--", ...paths]);
  if (result.code === 1) return [];
  if (result.code !== 0) {
    throw new SetupFailure(
      `git check-ignore failed: ${result.stderr.trim() || `exit ${result.code}`}`,
    );
  }
  return result.stdout.split("\n").filter((path) => path !== "");
}

/** The notices of step 1: env files once per office, skipped optional files, settings left out. */
function fileNotices(deps: SetupDeps, claim: ClaimRecord, files: FileStepResult): void {
  writeWith(deps, () => {
    const entries = [];
    for (const path of files.skipped) {
      entries.push(
        notice(
          "info",
          SETUP_NOTICES.fileSkipped,
          `${claim.story}: ${path} from worktree.files is not in the main checkout and is optional, so setup skipped it.`,
          claim.key,
        ),
      );
    }
    if (files.settings !== null && !files.settings.copied) {
      entries.push(
        notice(
          "warn",
          SETUP_NOTICES.settingsNotCopied,
          `${claim.story}: .claude/settings.local.json was not copied into the worktree: ${files.settings.why}.`,
          claim.key,
        ),
      );
    }
    if (files.envFiles.length > 0) {
      const first = deps.office.run(
        `insert into once_notices (office_id, code, shown_at)
         values ($office_id, $code, $at) on conflict do nothing`,
        { code: SETUP_NOTICES.envFiles, at: deps.clock.now() },
      );
      if (first.changes > 0) {
        entries.push(
          notice(
            "warn",
            SETUP_NOTICES.envFiles,
            `Setup copied env files into the worktree of ${claim.story}: ${files.envFiles.join(", ")}. Rule: ${ENV_FILES_RULE}. A worker's scripts can read them, so keep production secrets out of them. dipo shows this once per office.`,
            claim.key,
          ),
        );
      }
    }
    return entries;
  });
}

/**
 * Tracked changes and untracked files git does not ignore in the worktree. Setup writes only
 * ignored files, so the claim commit that follows holds only the story's task file.
 */
async function changedPaths(deps: SetupDeps, worktree: string): Promise<string[]> {
  return deps.git.run(async (git) =>
    statusPaths(
      await git.ok(deps.git.worktreeLocation(worktree), [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
    ),
  );
}
