// The box of a box worker's run (DIPO-271, 0021 sections 1 to 6): one box per story run, made at
// the launch, used by every developer session of the run, and checked and deleted at its end.
// Keeping a box from claim to merge is DIPO-278; until then a run that ended has no box.
//
// - `create` (the launch's setup): the start check, the office image built from the base branch's
//   box block (`ensureImageWithBuildProxy`: a build proxy only for the length of a build), the
//   host-only box network, the box with nothing of the Mac mounted (the office package cache only
//   when one is given: the DIPO-267 seam), started, and the code copied in (`stageBoxCode`: the
//   start commit from git's objects plus the listed files, never `.git`).
// - `session` (each developer session): the box running again, dipo's web route and model proxy
//   for the box network (both started only once a box on it runs, because the network's address
//   exists on the Mac only then), and dipo's files copied to `BOX_DIPO_DIR`: the system file and
//   the Safe-Chain CA bundle. It returns how the worker host runs a command in the box and stops it.
// - `finish` (the run ended): the post-run token check (`checkBoxAfterRun`, which holds the adapter
//   when the token is found or the check cannot finish), then the box deleted and its routes
//   released. `discard` deletes a box whose worker never ran, without the check.
// - `finishEnded` finishes the box of every run that has ended (after an exit, at daemon start),
//   and `close` stops every box at daemon stop, which ends the worker inside it.
//
// Two records: the run directory's `BOX_RUN_FILE` says the run is a box worker's, so every later
// session of the run plans in its box; the index folder holds one file per box not yet finished,
// so a daemon after a restart finds them, and a daemon with no box run never calls the backend
// for `finishEnded` or `close`. Nothing here names a worker CLI.

import { copyFile, mkdtemp, rm } from "node:fs/promises";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import type { OfficeGit } from "../git/office";
import { type AdapterHolds, holdMessage } from "../workers/hold";
import { ensureImageWithBuildProxy } from "./build-proxy";
import { BOX_DIPO_DIR, BOX_WORKDIR, type BoxCodeDeps, stageBoxCode } from "./code";
import type { BaseBox } from "./image";
import { boxModelEnvironment, type RunningModelProxy } from "./model-proxy";
import {
  BoxError,
  type BoxBuildNetwork,
  type BoxClientCommand,
  type BoxNetwork,
  type BoxPort,
  boxName,
  runIdOfBox,
} from "./port";
import { type BoxTokenCheck, checkBoxAfterRun, tokenCheckFailure } from "./token-check";
import { BoxWebRoute, type BoxWebRouteStart, type RunningBoxWebRoute } from "./web-proxy";

/** The run directory's record that the run's developer works in a box. */
export const BOX_RUN_FILE = "box-run.json";
/** The system file's path in a box. */
export const BOX_SYSTEM_FILE = `${BOX_DIPO_DIR}/system.md`;
/** The Safe-Chain CA bundle's path in a box, for the package managers' TLS to Safe-Chain. */
export const BOX_CA_FILE = `${BOX_DIPO_DIR}/safe-chain-ca.pem`;
/** The prefix of the host folder dipo's files are staged in for a box. */
export const BOX_FILES_STAGE_PREFIX = "dipo-box-files-";
/** The index folder in dipo's temp root: one file per box not yet finished, named by its box. */
export const BOX_INDEX_DIR = "dipo-box-runs";

type Log = (message: string, fields: Readonly<Record<string, unknown>>) => void;

/** The run directory's record. */
export interface BoxRunRecord {
  readonly runId: string;
  readonly office: string;
  readonly box: string;
  /** Set once the run ended and its box was deleted. */
  readonly finished?: boolean;
}

/** One developer session's box: how the worker host runs claude in it and stops it. */
export interface BoxSession {
  readonly box: string;
  /** The working directory in the box: the code. */
  readonly workdir: string;
  /**
   * The box environment of the routes: exactly `boxModelEnvironment`, HTTPS_PROXY and HTTP_PROXY
   * for the web proxy, and NODE_EXTRA_CA_CERTS for the Safe-Chain CA bundle.
   */
  readonly env: Readonly<Record<string, string>>;
  /** The system file's path in the box. */
  readonly systemFile: string;
  /** A long-running exec of `command` in the box, at `workdir`, with `env` set in the box. */
  exec(
    command: readonly [string, ...string[]],
    env: Readonly<Record<string, string>>,
  ): BoxClientCommand;
  /** The call that stops the box, which ends every process the worker left in it. */
  readonly stop: BoxClientCommand;
}

export interface BoxWorkersDeps {
  readonly boxes: BoxPort;
  /** Starts dipo's web route (Safe-Chain and the web proxy) on the box network's host address. */
  readonly startWebRoute: (network: Pick<BoxNetwork, "hostAddress">) => Promise<BoxWebRouteStart>;
  /** Starts the model proxy on the box network's host address; it reads the token at start. */
  readonly startModelProxy: (
    network: Pick<BoxNetwork, "hostAddress">,
  ) => Promise<RunningModelProxy>;
  /** Starts the build's web route on the builder's network (`ensureImageWithBuildProxy`). */
  readonly startBuildRoute: (network: BoxBuildNetwork) => Promise<BoxWebRouteStart>;
  /** Reads the office's box from its base branch (`readBaseBox`). */
  readonly readBaseBox: (git: OfficeGit) => Promise<BaseBox>;
  readonly code: BoxCodeDeps;
  /**
   * The adapter holds: the post-run token check holds through them, and a sticky hold (the
   * box-token hold) refuses a new box before anything is made.
   */
  readonly holds: Pick<AdapterHolds, "hold" | "adapterHeld">;
  /** The adapter the boxes run, for its hold. */
  readonly adapter: string;
  /** dipo's temp root: the index, code and file stages, token check exports. */
  readonly tmpRoot: string;
  /** dipo's private folder for image build folders. */
  readonly scratchRoot: string;
  /**
   * The office package cache to mount read-only (DIPO-267, set up by DIPO-275); undefined mounts
   * nothing, which is the default.
   */
  readonly packageCache?: (office: OfficeId) => string | undefined;
  readonly warn?: Log;
  readonly info?: Log;
}

/** What `finish` did. */
export type BoxFinish =
  | { readonly kind: "checked"; readonly check: BoxTokenCheck }
  | { readonly kind: "gone" }
  | { readonly kind: "failed"; readonly reason: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The code of `error`, never its message. */
function codeOf(error: unknown): string {
  if (error instanceof BoxError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "error";
}

/** Reads a run directory's record; null when the run is not a box worker's. */
export function readBoxRun(runDir: string): BoxRunRecord | null {
  let text: string;
  try {
    text = readFileSync(join(runDir, BOX_RUN_FILE), "utf8");
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(text) as Partial<BoxRunRecord>;
    if (typeof value.runId !== "string" || typeof value.box !== "string") return null;
    return {
      runId: value.runId,
      office: typeof value.office === "string" ? value.office : "",
      box: value.box,
      ...(value.finished === true ? { finished: true } : {}),
    };
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export class BoxWorkers {
  readonly #deps: BoxWorkersDeps;
  readonly #index: string;
  #network: BoxNetwork | null = null;
  readonly #web: BoxWebRoute<RunningBoxWebRoute>;
  readonly #model: BoxWebRoute<RunningModelProxy>;
  /** Finishes in flight, by run id. */
  readonly #finishing = new Map<string, Promise<BoxFinish>>();

  constructor(deps: BoxWorkersDeps) {
    this.#deps = deps;
    this.#index = join(deps.tmpRoot, BOX_INDEX_DIR);
    this.#web = new BoxWebRoute(async () => {
      const started = await deps.startWebRoute(await this.#networkOf());
      if (!started.ok) {
        throw new BoxError("box.routeFailed", `the box web route did not start: ${started.reason}`);
      }
      return started.route;
    });
    this.#model = new BoxWebRoute(async () => deps.startModelProxy(await this.#networkOf()));
  }

  /** True when the run of `runDir` runs its developer in a box. */
  isBoxRun(runDir: string): boolean {
    return existsSync(join(runDir, BOX_RUN_FILE));
  }

  /** The boxes using the web route and the model proxy now. */
  get routeUsers(): { readonly web: readonly string[]; readonly model: readonly string[] } {
    return { web: this.#web.users, model: this.#model.users };
  }

  /** The run ids whose box is not finished yet, from the index. */
  pending(): string[] {
    let names: string[];
    try {
      names = readdirSync(this.#index);
    } catch {
      return [];
    }
    return names.flatMap((name) => {
      const runId = runIdOfBox(name);
      return runId === null ? [] : [runId];
    });
  }

  async #networkOf(): Promise<BoxNetwork> {
    this.#network ??= await this.#deps.boxes.network();
    return this.#network;
  }

  #indexFile(runId: string): string {
    return join(this.#index, boxName(runId));
  }

  /** The run directory the index names for `runId`, or undefined. */
  #runDirOf(runId: string): string | undefined {
    try {
      const value = JSON.parse(readFileSync(this.#indexFile(runId), "utf8")) as {
        runDir?: unknown;
      };
      return typeof value.runDir === "string" ? value.runDir : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Makes the run's box (the launch's setup): image, network, the box started and the code
   * copied in. Throws a `BoxError` when it cannot; a box it made is deleted again then.
   */
  async create(input: {
    readonly office: OfficeId;
    readonly runId: string;
    readonly runDir: string;
    readonly git: OfficeGit;
    readonly startCommit: string;
  }): Promise<string> {
    const { boxes } = this.#deps;
    const held = this.#deps.holds.adapterHeld(this.#deps.adapter);
    if (held?.liftedBy !== undefined) throw new BoxError("box.held", holdMessage(held));
    const check = await boxes.check();
    if (!check.ok) throw new BoxError("box.unavailable", `boxes cannot run here: ${check.reason}`);
    const base = await this.#deps.readBaseBox(input.git);
    if (!base.ok) {
      const why = base.errors.map((error) => `${error.path}: ${error.message}`).join("; ");
      throw new BoxError("box.refused", `the base branch's box block cannot be read: ${why}`);
    }
    const image = await ensureImageWithBuildProxy(
      { boxes, startRoute: this.#deps.startBuildRoute, scratchRoot: this.#deps.scratchRoot },
      base.description.image,
    );
    const network = await this.#networkOf();
    const name = boxName(input.runId);
    // Recorded before the box exists, so a crash in between leaves a box dipo knows to clean up.
    writeJson(join(input.runDir, BOX_RUN_FILE), {
      runId: input.runId,
      office: input.office,
      box: name,
    } satisfies BoxRunRecord);
    mkdirSync(this.#index, { recursive: true, mode: 0o700 });
    writeJson(this.#indexFile(input.runId), { runDir: input.runDir });
    const cache = this.#deps.packageCache?.(input.office);
    try {
      await boxes.create({
        runId: input.runId,
        image: image.tag,
        network,
        ...(cache === undefined ? {} : { packageCache: cache }),
      });
      await boxes.start(name);
      const staged = await stageBoxCode(this.#deps.code, {
        git: input.git,
        commit: input.startCommit,
        files: base.description.files,
        source: input.git.baseWorktreePath(),
        tmpRoot: this.#deps.tmpRoot,
      });
      try {
        await boxes.copyIn(name, `${staged.dir}/.`, BOX_WORKDIR);
      } finally {
        await staged.remove();
      }
      for (const skipped of staged.skipped) {
        this.#deps.warn?.("a listed box file was not copied into the box", {
          run: input.runId,
          path: skipped.path,
          why: skipped.why,
        });
      }
    } catch (error) {
      await this.discard(input.runId);
      if (error instanceof BoxError) throw error;
      throw new BoxError("box.failed", `the box could not be made: ${messageOf(error)}`);
    }
    this.#deps.info?.("box ready", { run: input.runId, box: name, image: image.tag });
    return name;
  }

  /**
   * The box of the run's next developer session: running, with its routes, and dipo's files
   * copied in. Throws a `BoxError`: `box.gone` when the run has no box any more.
   */
  async session(input: {
    readonly runId: string;
    readonly runDir: string;
    readonly systemFile: string;
  }): Promise<BoxSession> {
    const record = readBoxRun(input.runDir);
    if (record === null || record.runId !== input.runId) {
      throw new BoxError("box.gone", `run ${input.runId} has no box record.`);
    }
    if (record.finished === true) {
      throw new BoxError(
        "box.gone",
        `the box of run ${input.runId} was deleted when the run ended; a new box for it is DIPO-278's.`,
      );
    }
    const name = record.box;
    const { boxes } = this.#deps;
    await this.#running(name);
    // The routes only now: the box network's address exists on the Mac once a box on it runs.
    const web = await this.#web.acquire(name);
    const model = await this.#model.acquire(name);
    await this.#copyDipoFiles(name, input.systemFile, web.caFile);
    const env = {
      ...boxModelEnvironment(model),
      HTTPS_PROXY: web.url,
      HTTP_PROXY: web.url,
      NODE_EXTRA_CA_CERTS: BOX_CA_FILE,
    };
    return {
      box: name,
      workdir: BOX_WORKDIR,
      env,
      systemFile: BOX_SYSTEM_FILE,
      exec: (command, commandEnv) =>
        boxes.execLiveCommand(name, command, { cwd: BOX_WORKDIR, env: commandEnv }),
      stop: boxes.stopCommand(name),
    };
  }

  /** Starts box `name` when it is not running; throws `box.gone` when it does not exist. */
  async #running(name: string): Promise<void> {
    const listed = (await this.#deps.boxes.list()).find((box) => box.name === name);
    if (listed === undefined) throw new BoxError("box.gone", `box ${name} does not exist.`);
    if (listed.state !== "running") await this.#deps.boxes.start(name);
  }

  /** Copies the system file and the CA bundle into `BOX_DIPO_DIR` through a stage of dipo's. */
  async #copyDipoFiles(name: string, systemFile: string, caFile: string): Promise<void> {
    const stage = await mkdtemp(join(this.#deps.tmpRoot, BOX_FILES_STAGE_PREFIX));
    try {
      await copyFile(systemFile, join(stage, "system.md"));
      await copyFile(caFile, join(stage, "safe-chain-ca.pem"));
      await this.#deps.boxes.copyIn(name, `${stage}/.`, BOX_DIPO_DIR);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  /**
   * The end of a box run: the post-run token check, then the box deleted and its routes released.
   * Never rejects; once per run (a second call waits for the first).
   */
  finish(runId: string): Promise<BoxFinish> {
    const pending = this.#finishing.get(runId);
    if (pending !== undefined) return pending;
    const started = this.#finish(runId).finally(() => this.#finishing.delete(runId));
    this.#finishing.set(runId, started);
    return started;
  }

  async #finish(runId: string): Promise<BoxFinish> {
    const name = boxName(runId);
    const { boxes } = this.#deps;
    let outcome: BoxFinish;
    let exists = false;
    let checked = false;
    try {
      const listed = (await boxes.list()).find((box) => box.name === name);
      if (listed === undefined) {
        outcome = { kind: "gone" };
      } else {
        exists = true;
        // The check reads the environment of the running box, so a stopped box starts first.
        if (listed.state !== "running") await boxes.start(name);
        const model = await this.#model.acquire(name);
        const { result } = await checkBoxAfterRun(
          {
            box: boxes,
            token: model,
            tmpRoot: this.#deps.tmpRoot,
            holds: this.#deps.holds,
            adapter: this.#deps.adapter,
          },
          name,
        );
        checked = true;
        outcome = { kind: "checked", check: result };
        await boxes.delete(name);
      }
    } catch (error) {
      outcome = { kind: "failed", reason: messageOf(error) };
      this.#deps.warn?.("the end of a box run failed", {
        run: runId,
        box: name,
        reason: outcome.reason,
      });
      // A box whose check could not even start proves nothing: it holds as a failed check does.
      // Only the error's code goes into the hold, never a message that may quote the box.
      if (exists && !checked) {
        const failure = tokenCheckFailure(
          {
            ok: false,
            code: "box.tokenCheckFailed",
            hold: true,
            reason: `the check could not start (${codeOf(error)}).`,
          },
          name,
        );
        if (failure !== null) this.#deps.holds.hold(this.#deps.adapter, [failure]);
      }
    }
    await this.#release(name);
    // A box that could not be deleted stays in the index, for the next pass.
    if (outcome.kind !== "failed") this.#forget(runId, name);
    return outcome;
  }

  /** Deletes the box of a run whose worker never ran (a failed launch); no token check. */
  async discard(runId: string): Promise<void> {
    const name = boxName(runId);
    try {
      await this.#deps.boxes.delete(name);
    } catch (error) {
      this.#deps.warn?.("deleting a box failed", {
        run: runId,
        box: name,
        reason: messageOf(error),
      });
    }
    await this.#release(name);
    this.#forget(runId, name);
  }

  async #release(name: string): Promise<void> {
    await this.#web.release(name).catch(() => undefined);
    await this.#model.release(name).catch(() => undefined);
  }

  /** Marks the run's record finished and drops it from the index. */
  #forget(runId: string, name: string): void {
    const runDir = this.#runDirOf(runId);
    rmSync(this.#indexFile(runId), { force: true });
    if (runDir === undefined || !existsSync(runDir)) return;
    const record = readBoxRun(runDir);
    try {
      writeJson(join(runDir, BOX_RUN_FILE), {
        runId,
        office: record?.office ?? "",
        box: name,
        finished: true,
      } satisfies BoxRunRecord);
    } catch (error) {
      this.#deps.warn?.("marking a box run finished failed", {
        run: runId,
        reason: messageOf(error),
      });
    }
  }

  /**
   * Finishes the box of every indexed run that has ended: `ended` says true for a run that ended
   * with its worker hosts exited, false for one still going, null for a run no loaded office knows
   * (left alone). Never rejects; resolves to the run ids it finished.
   */
  async finishEnded(ended: (runId: string) => boolean | null): Promise<string[]> {
    const finished: string[] = [];
    for (const runId of this.pending()) {
      if (ended(runId) !== true) continue;
      await this.finish(runId);
      finished.push(runId);
    }
    return finished;
  }

  /**
   * Daemon stop: stops every indexed box that runs, which ends the worker inside it (its host
   * then records the exit), and stops the routes. The boxes keep their files for the run's next
   * session. Never rejects.
   */
  async close(): Promise<void> {
    const pending = new Set(this.pending().map((runId) => boxName(runId)));
    if (pending.size > 0) {
      let listed: Awaited<ReturnType<BoxPort["list"]>> = [];
      try {
        listed = await this.#deps.boxes.list();
      } catch (error) {
        this.#deps.warn?.("listing the boxes at stop failed", { reason: messageOf(error) });
      }
      for (const box of listed) {
        if (box.state !== "running" || !pending.has(box.name)) continue;
        try {
          await this.#deps.boxes.stop(box.name);
        } catch (error) {
          this.#deps.warn?.("stopping a box failed", { box: box.name, reason: messageOf(error) });
        }
      }
    }
    await this.#web.close().catch(() => undefined);
    await this.#model.close().catch(() => undefined);
  }
}
