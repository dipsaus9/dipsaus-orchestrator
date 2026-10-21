// The Apple `container` backend of the box interface (DIPO-265, 0021 section 1 and its amendment
// of 2026-10-21). Each call is one `container` command through the injected `Spawn`, its argv from
// `apple-args.ts`, killed at its deadline (default 60 s) and failed with `box.timedOut`. Only
// `execLive`, a long-running command, has no deadline. The JSON shapes read here are those of
// `container` 1.6.0, the version the escape probe passed on (tools/box-probe/RESULTS.md).

import { availableParallelism, homedir, totalmem } from "node:os";

import type { ChildProcess, Clock, Spawn, TimerHandle } from "@dipsaus-orchestrator/contract";

import {
  buildArgs,
  copyInArgs,
  copyOutArgs,
  createArgs,
  deleteArgs,
  execArgs,
  exportArgs,
  type HostResources,
  imageInspectArgs,
  listArgs,
  networkCreateArgs,
  networkListArgs,
  BOX_NETWORK_NAME,
  startArgs,
  statsArgs,
  stopArgs,
  systemStatusArgs,
  versionArgs,
} from "./apple-args";
import { resolvePackageCacheMount } from "./cache";
import {
  BOX_BUILD_TIMEOUT_MS,
  BOX_CALL_TIMEOUT_MS,
  BOX_LABEL,
  BoxError,
  type BoxCallOptions,
  type BoxCheck,
  type BoxExecOptions,
  type BoxExecResult,
  type BoxImageBuild,
  type BoxInfo,
  type BoxMemory,
  type BoxNetwork,
  type BoxPort,
  type BoxProcess,
  type BoxSpec,
  type BoxState,
  boxName,
  runIdOfBox,
} from "./port";

export const APPLE_CONTAINER_BACKEND_ID = "apple-container";
/** The oldest `container` dipo runs boxes on: the version the escape probe passed on (0021). */
export const MIN_CONTAINER_VERSION = "1.6.0";
/** How many lines of a failed build's output its error keeps. */
export const BUILD_ERROR_LINES = 40;

/** The Mac's total memory and CPU count, which every box may use (0021 decision 16). */
export function systemHostResources(): HostResources {
  return { memoryBytes: totalmem(), cpus: availableParallelism() };
}

export interface AppleContainerDeps {
  readonly spawn: Spawn;
  readonly clock: Clock;
  /** The `container` program: an absolute path the daemon resolved, or `container`. */
  readonly cli?: string;
  /**
   * The environment of the `container` program itself. A box never inherits it: every variable a
   * box gets is passed as `KEY=VALUE`.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Defaults to `systemHostResources()`. */
  readonly host?: HostResources;
  /** The maintainer's home folder, which the package cache may not be; `os.homedir()` by default. */
  readonly home?: string;
  /**
   * dipo's own package cache root of the office (DIPO-267). A box's package cache must resolve,
   * with realpath, to a folder under it; without a root no box gets a package cache.
   */
  readonly packageCacheRoot?: string;
  /** The default deadline of a call; `BOX_CALL_TIMEOUT_MS` when absent. */
  readonly timeoutMs?: number;
}

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** `1.6.0` from `container CLI version 1.6.0 (build: release, commit: …)`; null without one. */
export function parseContainerVersion(text: string): string | null {
  return /\bversion (\d+\.\d+\.\d+)\b/.exec(text)?.[1] ?? null;
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

function parseJson(args: readonly string[], text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BoxError("box.unreadable", `container ${args.join(" ")} printed no JSON.`, false, {
      args: [...args],
    });
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(args: readonly string[], value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new BoxError(
      "box.unreadable",
      `container ${args.join(" ")} printed no JSON list.`,
      false,
      {
        args: [...args],
      },
    );
  }
  return value;
}

/** The network named `name` from `container network list --format json`, or null. */
export function findNetwork(listed: readonly unknown[], name: string): BoxNetworkFound | null {
  for (const entry of listed) {
    const item = record(entry);
    const configuration = record(item["configuration"]);
    const found = configuration["name"] ?? item["id"];
    if (found !== name) continue;
    const gateway = record(item["status"])["ipv4Gateway"];
    return {
      name,
      mode: typeof configuration["mode"] === "string" ? configuration["mode"] : "unknown",
      hostAddress: typeof gateway === "string" ? gateway : null,
    };
  }
  return null;
}

/** A network as `container network list` describes it, mode not yet checked. */
export interface BoxNetworkFound {
  readonly name: string;
  readonly mode: string;
  readonly hostAddress: string | null;
}

const STATES: readonly BoxState[] = ["running", "stopped"];

/** dipo's boxes from `container list --all --format json`: named `dipo-<run id>`, labelled so. */
export function dipoBoxes(listed: readonly unknown[]): BoxInfo[] {
  const boxes: BoxInfo[] = [];
  for (const entry of listed) {
    const item = record(entry);
    const configuration = record(item["configuration"]);
    const name = configuration["id"] ?? item["id"];
    if (typeof name !== "string") continue;
    const runId = runIdOfBox(name);
    if (runId === null || record(configuration["labels"])[BOX_LABEL] !== runId) continue;
    const state = record(item["status"])["state"];
    boxes.push({
      name,
      runId,
      state: STATES.find((known) => known === state) ?? "unknown",
    });
  }
  return boxes;
}

/** The memory of box `name` from `container stats --no-stream --format json`; null when absent. */
export function boxMemory(listed: readonly unknown[], name: string): BoxMemory | null {
  for (const entry of listed) {
    const item = record(entry);
    if (item["id"] !== name) continue;
    const used = item["memoryUsageBytes"];
    const limit = item["memoryLimitBytes"];
    if (typeof used !== "number") {
      throw new BoxError(
        "box.unreadable",
        `container stats shows no memory use for ${name}.`,
        false,
        {
          name,
        },
      );
    }
    return { usedBytes: used, limitBytes: typeof limit === "number" ? limit : null };
  }
  return null;
}

/**
 * True when a failed `container stats` says box `name` is not running. 1.6.0 leaves a stopped box
 * out of its list and exits 0; this covers a version that fails instead. The output must name the
 * box, so a system service that is not running (`apiserver is not running`) still fails the call.
 */
export function saysNotRunning(output: string, name: string): boolean {
  return (
    output.includes(name) &&
    !/apiserver/i.test(output) &&
    /\b(not running|is stopped|state:? stopped)\b/i.test(output)
  );
}

/** The `box.failed` error of a call that exited non-zero, with `container`'s message. */
function failed(args: readonly string[], result: CliResult): BoxError {
  return new BoxError(
    "box.failed",
    `container ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
    false,
    { args: [...args], code: result.code, stderr: result.stderr },
  );
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

export class AppleContainerBoxes implements BoxPort {
  readonly id = APPLE_CONTAINER_BACKEND_ID;
  readonly #deps: AppleContainerDeps;
  readonly #cli: string;

  constructor(deps: AppleContainerDeps) {
    this.#deps = deps;
    this.#cli = deps.cli ?? "container";
  }

  async check(options: BoxCallOptions = {}): Promise<BoxCheck> {
    let version: CliResult;
    try {
      version = await this.#run(versionArgs(), options);
    } catch (error) {
      if (error instanceof BoxError && error.code === "box.cliMissing") {
        return { ok: false, version: null, reason: error.message };
      }
      throw error;
    }
    const found = version.code === 0 ? parseContainerVersion(version.stdout) : null;
    if (found === null) {
      return {
        ok: false,
        version: null,
        reason: "`container --version` printed no version; is Apple container installed?",
      };
    }
    if (compareVersions(found, MIN_CONTAINER_VERSION) < 0) {
      return {
        ok: false,
        version: found,
        reason: `Apple container ${found} is older than ${MIN_CONTAINER_VERSION}; update it.`,
      };
    }
    const status = await this.#run(systemStatusArgs(), options);
    const state =
      status.code === 0 ? record(parseJson(systemStatusArgs(), status.stdout))["status"] : null;
    if (state !== "running") {
      return {
        ok: false,
        version: found,
        reason:
          "the Apple container system service is not running; start it with `container system start`.",
      };
    }
    return { ok: true, version: found };
  }

  async network(options: BoxCallOptions = {}): Promise<BoxNetwork> {
    let found = await this.#findNetwork(options);
    if (found === null) {
      await this.#runOk(networkCreateArgs(), options);
      found = await this.#findNetwork(options);
    }
    if (found === null) {
      throw new BoxError(
        "box.failed",
        `network ${BOX_NETWORK_NAME} is missing after its creation.`,
      );
    }
    if (found.mode !== "hostOnly") {
      throw new BoxError(
        "box.refused",
        `network ${found.name} is ${found.mode}, not host-only; delete it so dipo can create it host-only.`,
        false,
        { network: found.name, mode: found.mode },
      );
    }
    if (found.hostAddress === null) {
      throw new BoxError("box.unreadable", `network ${found.name} has no host address.`);
    }
    return { name: found.name, mode: "hostOnly", hostAddress: found.hostAddress };
  }

  async create(spec: BoxSpec, options: BoxCallOptions = {}): Promise<string> {
    const input = {
      runId: spec.runId,
      image: spec.image,
      network: spec.network,
      host: this.#deps.host ?? systemHostResources(),
      home: this.#deps.home ?? homedir(),
    };
    let args = createArgs({
      ...input,
      ...(spec.packageCache === undefined ? {} : { packageCache: spec.packageCache }),
    });
    if (spec.packageCache !== undefined) {
      // The mount gets the real path, and only one under dipo's cache root: a symlink cannot
      // point the read-only mount anywhere else (DIPO-267).
      const root = this.#deps.packageCacheRoot;
      if (root === undefined) {
        throw new BoxError(
          "box.cacheOutsideRoot",
          "no package cache root is set, so no box may get a package cache.",
          false,
          { path: spec.packageCache },
        );
      }
      args = createArgs({
        ...input,
        packageCache: await resolvePackageCacheMount(spec.packageCache, root),
      });
    }
    await this.#runOk(args, options);
    return boxName(spec.runId);
  }

  async start(name: string, options: BoxCallOptions = {}): Promise<void> {
    await this.#runOk(startArgs(name), options);
  }

  async stop(name: string, options: BoxCallOptions = {}): Promise<void> {
    await this.#runOk(stopArgs(name), options);
  }

  async delete(name: string, options: BoxCallOptions = {}): Promise<void> {
    await this.#runOk(deleteArgs(name), options);
  }

  async copyIn(
    name: string,
    from: string,
    to: string,
    options: BoxCallOptions = {},
  ): Promise<void> {
    await this.#runOk(copyInArgs(name, from, to), options);
  }

  async copyOut(
    name: string,
    from: string,
    to: string,
    options: BoxCallOptions = {},
  ): Promise<void> {
    await this.#runOk(copyOutArgs(name, from, to), options);
  }

  async exportFiles(name: string, to: string, options: BoxCallOptions = {}): Promise<void> {
    await this.#runOk(exportArgs(name, to), options);
  }

  async exec(
    name: string,
    command: readonly [string, ...string[]],
    options: BoxExecOptions = {},
  ): Promise<BoxExecResult> {
    const args = execArgs({
      name,
      command,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    return this.#run(args, options);
  }

  execLive(
    name: string,
    command: readonly [string, ...string[]],
    options: Omit<BoxExecOptions, "timeoutMs"> = {},
  ): BoxProcess {
    const args = execArgs({
      name,
      command,
      interactive: true,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    const child = this.#spawn(args, "pipe");
    const stdin = child.stdin;
    if (stdin === null) {
      child.kill("SIGKILL");
      throw new BoxError("box.failed", "the box command started without stdin.");
    }
    return {
      stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited: child.exited,
      kill: (signal) => child.kill(signal),
    };
  }

  async memory(name: string, options: BoxCallOptions = {}): Promise<BoxMemory | null> {
    const args = statsArgs(name);
    const result = await this.#run(args, options);
    if (result.code !== 0) {
      if (saysNotRunning(`${result.stderr}\n${result.stdout}`, name)) return null;
      throw failed(args, result);
    }
    return boxMemory(array(args, parseJson(args, result.stdout)), name);
  }

  async list(options: BoxCallOptions = {}): Promise<BoxInfo[]> {
    const args = listArgs();
    const result = await this.#runOk(args, options);
    return dipoBoxes(array(args, parseJson(args, result.stdout)));
  }

  async hasImage(tag: string, options: BoxCallOptions = {}): Promise<boolean> {
    // `container image inspect` exits non-zero for an image it does not have. Any other failure
    // reads as absent too: the build that follows then fails with `container`'s own message.
    const result = await this.#run(imageInspectArgs(tag), options);
    return result.code === 0;
  }

  async buildImage(build: BoxImageBuild, options: BoxCallOptions = {}): Promise<void> {
    const args = buildArgs(build);
    const result = await this.#run(args, { timeoutMs: options.timeoutMs ?? BOX_BUILD_TIMEOUT_MS });
    if (result.code === 0) return;
    // A build prints its whole progress; the error keeps the end, where the failing step is.
    const tail = `${result.stderr}\n${result.stdout}`.trim().split("\n").slice(-BUILD_ERROR_LINES);
    throw new BoxError(
      "box.failed",
      `container build of ${build.tag} failed: ${tail.join("\n") || `exit ${result.code}`}`,
      false,
      { args: [...args], code: result.code, tail },
    );
  }

  async #findNetwork(options: BoxCallOptions): Promise<BoxNetworkFound | null> {
    const args = networkListArgs();
    const result = await this.#runOk(args, options);
    return findNetwork(array(args, parseJson(args, result.stdout)), BOX_NETWORK_NAME);
  }

  #spawn(args: readonly string[], stdin: "pipe" | "ignore"): ChildProcess {
    try {
      return this.#deps.spawn({ cmd: [this.#cli, ...args], env: this.#deps.env, stdin });
    } catch (error) {
      throw new BoxError(
        "box.cliMissing",
        `Apple container (${this.#cli}) could not be started; is it installed?`,
        false,
        { cli: this.#cli, error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  /** Runs one command to its end, killed and failed with `box.timedOut` at its deadline. */
  async #run(args: readonly string[], options: BoxCallOptions): Promise<CliResult> {
    const timeoutMs = options.timeoutMs ?? this.#deps.timeoutMs ?? BOX_CALL_TIMEOUT_MS;
    const { clock } = this.#deps;
    const child = this.#spawn(args, "ignore");
    let timer: TimerHandle | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = clock.setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new BoxError(
            "box.timedOut",
            `container ${args[0] ?? ""} did not finish within ${Math.round(timeoutMs / 1000)} s and was killed.`,
            false,
            { args: [...args], timeoutMs },
          ),
        );
      }, timeoutMs);
    });
    const finished = Promise.all([readAll(child.stdout), readAll(child.stderr), child.exited]).then(
      ([stdout, stderr, exit]) => ({ code: exit.code, stdout, stderr }),
    );
    try {
      // A killed `container` may leave a helper holding its pipes, so the call does not wait for
      // its output once the deadline passed.
      return await Promise.race([finished, timedOut]);
    } finally {
      if (timer !== undefined) clock.clearTimeout(timer);
    }
  }

  /** Like `#run`, but a non-zero exit fails with `box.failed` and `container`'s message. */
  async #runOk(args: readonly string[], options: BoxCallOptions): Promise<CliResult> {
    const result = await this.#run(args, options);
    if (result.code !== 0) throw failed(args, result);
    return result;
  }
}
