// The box of a box worker's run (DIPO-271, 0021 sections 1 to 6): one box per story run, made at
// the launch, used by every developer session of the run, and checked and deleted at its end.
// Keeping a box from claim to merge is DIPO-278; until then a run that ended has no box.
//
// - `create` (the launch's setup): the start check, the office image built from the base branch's
//   box block (`ensureImageWithBuildProxy`: a build proxy only for the length of a build), the
//   host-only box network, the box with nothing of the Mac mounted (the office package cache only
//   when one is given: the DIPO-267 seam), started, and the code copied in (`stageBoxCode`: the
//   start commit from git's objects plus the listed files from the office's main checkout, never
//   `.git`), and dipo's `dipo-part` command installed (`installDipoPart`, DIPO-272).
// - `session` (each developer session): the box running again, dipo's web route and model proxy
//   for the box network (both started only once a box on it runs, because the network's address
//   exists on the Mac only then), and dipo's files copied to `BOX_DIPO_DIR`: the system file and
//   the Safe-Chain CA bundle. A box that already runs when a session starts may still hold an
//   earlier session's claude (a host killed with SIGKILL, or one that crashed, never ran its stop
//   command), so it is stopped and started again first; only a box `create` just made is not. It returns how the worker host runs a command in the box and stops it.
//   With `door`, the box's part queue is read while the session runs (`BoxDoor`, DIPO-272).
// - `finish` (the run ended): the post-run token check (`checkBoxAfterRun`, which holds the adapter
//   when the token is found or the check cannot finish), then the box deleted and its routes
//   released. `discard` deletes a box whose worker never ran, without the check.
// - `finishEnded` finishes the box of every run that has ended (after an exit, at daemon start;
//   at daemon start also every dipo box the backend lists), and `close` stops every box at daemon
//   stop, which ends the worker inside it, and a base verify still running in it.
// - The base in the box (the launch, after `create`, before the worker's first session; DIPO-294):
//   `install` runs the office's install in the box with the box's web route, `baseVerify` the
//   office's verify, and `changedSinceStart` checks that `/work` holds nothing but the start
//   commit and ignored files. `baseKeyOf` reads what keys the result: the image and listed files.
//
// Two records: the run directory's `BOX_RUN_FILE` says the run is a box worker's, so every later
// session of the run plans in its box; the index folder in dipo's state folder holds one file per
// box not yet finished, so a daemon after a restart finds them, and a daemon that never ran a box
// never calls the backend for `finishEnded` or `close`. Nothing here names a worker CLI.

import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import type { OfficeGit } from "../git/office";
import type { BaseVerifyFacts } from "../prompts/base-verify";
import type { BoxBaseKey } from "../worktree/base-verify";
import { ensurePrivateDir } from "../platform/paths";
import { type AdapterHolds, holdMessage } from "../workers/hold";
import { ensureImageWithBuildProxy } from "./build-proxy";
import { BOX_DIPO_DIR, BOX_WORKDIR, type BoxCodeDeps, stageBoxCode } from "./code";
import { BoxDoor, type BoxDoorDeps, type DoorRead, installDipoPart } from "./door";
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
import { type BoxInstallResult, runBoxBaseVerify, runBoxInstall } from "./verify";
import type { PartRun } from "./parts";
import { BoxWebRoute, type BoxWebRouteStart, type RunningBoxWebRoute } from "./web-proxy";

/** The run directory's record that the run's developer works in a box. */
export const BOX_RUN_FILE = "box-run.json";
/** The system file's path in a box. */
export const BOX_SYSTEM_FILE = `${BOX_DIPO_DIR}/system.md`;
/** The Safe-Chain CA bundle's path in a box, for the package managers' TLS to Safe-Chain. */
export const BOX_CA_FILE = `${BOX_DIPO_DIR}/safe-chain-ca.pem`;
/** The prefix of the host folder dipo's files are staged in for a box. */
export const BOX_FILES_STAGE_PREFIX = "dipo-box-files-";
/** The index folder's name in dipo's state folder: one file per box not yet finished. */
export const BOX_INDEX_DIR = "dipo-box-runs";

type Log = (message: string, fields: Readonly<Record<string, unknown>>) => void;

/** What `/work` holds besides the start commit (`BoxWorkers.changedSinceStart`). */
export type TreeCheck =
  | { readonly kind: "same" }
  | { readonly kind: "changed"; readonly paths: readonly string[] }
  | { readonly kind: "unknown"; readonly reason: string };

/** The run directory's record. */
export interface BoxRunRecord {
  readonly runId: string;
  readonly office: string;
  readonly box: string;
  /** The image the box was made from (`dipo-box:<sha256 of its build file>`), keying its base verify. */
  readonly image?: string;
  /** The listed box files copied in from the main checkout, sorted; they key the base verify too. */
  readonly files?: readonly string[];
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
  /** dipo's temp root: code and file stages, token check exports. */
  readonly tmpRoot: string;
  /**
   * The index folder of the boxes not yet finished, in dipo's state folder (made private on first
   * use); `join(<state>, BOX_INDEX_DIR)` in the daemon.
   */
  readonly indexDir: string;
  /** dipo's private folder for image build folders. */
  readonly scratchRoot: string;
  /**
   * The office package cache to mount read-only (DIPO-267, set up by DIPO-275); undefined mounts
   * nothing, which is the default.
   */
  readonly packageCache?: (office: OfficeId) => string | undefined;
  /**
   * The box door (DIPO-272): with it, dipo reads each box's part queue while a session runs and
   * hands each part to `onPart` (DIPO-273 delivers it). Without it no queue is read; `dipo-part` is
   * installed in every box either way.
   */
  readonly door?: Pick<BoxDoorDeps, "onPart" | "onRefused" | "pollMs">;
  /**
   * Compares a box's `/work` with the start commit (`BoxParts.changedSinceStart`, DIPO-294), for
   * the check after the install and the base verify; without it that check is not known.
   */
  readonly treeCheck?: (run: PartRun) => Promise<TreeCheck>;
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
      ...(typeof value.image === "string" ? { image: value.image } : {}),
      ...(Array.isArray(value.files) && value.files.every((file) => typeof file === "string")
        ? { files: value.files }
        : {}),
      ...(value.finished === true ? { finished: true } : {}),
    };
  } catch {
    return null;
  }
}

/** What keys a box run's in-box base result besides its start commit, from its record. */
export function baseKeyOfRecord(record: BoxRunRecord | null): BoxBaseKey | null {
  return record?.image === undefined ? null : { image: record.image, files: record.files ?? [] };
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
  /** Boxes `create` made and started, in which no session ran yet. */
  readonly #fresh = new Set<string>();
  /** The part queues read while a session runs (DIPO-272); null without `door`. */
  readonly #door: BoxDoor | null;

  constructor(deps: BoxWorkersDeps) {
    this.#deps = deps;
    this.#index = deps.indexDir;
    this.#web = new BoxWebRoute(async () => {
      const started = await deps.startWebRoute(await this.#networkOf());
      if (!started.ok) {
        throw new BoxError("box.routeFailed", `the box web route did not start: ${started.reason}`);
      }
      return started.route;
    });
    this.#model = new BoxWebRoute(async () => deps.startModelProxy(await this.#networkOf()));
    this.#door =
      deps.door === undefined
        ? null
        : new BoxDoor({
            ...deps.door,
            boxes: deps.boxes,
            clock: deps.code.clock,
            ...(deps.warn === undefined ? {} : { warn: deps.warn }),
            ...(deps.info === undefined ? {} : { info: deps.info }),
          });
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
      image: image.tag,
      files: base.description.files.map((file) => file.path).toSorted(),
    } satisfies BoxRunRecord);
    ensurePrivateDir(this.#index);
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
        // The registered office path: the maintainer's checkout, where files outside git live.
        source: input.git.mainWorktree,
        tmpRoot: this.#deps.tmpRoot,
      });
      try {
        await boxes.copyIn(name, `${staged.dir}/.`, BOX_WORKDIR);
      } finally {
        await staged.remove();
      }
      // The worker's one way to hand dipo a part (0021 W1, DIPO-272): dipo's own command.
      await installDipoPart({ boxes, tmpRoot: this.#deps.tmpRoot }, name);
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
    this.#fresh.add(name);
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
    // The part queue is read while the session runs (DIPO-272).
    this.#door?.start(input.runId, name, input.runDir);
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

  /**
   * Makes box `name` run with no earlier process in it: a stopped box starts; a running one stops
   * and starts again, since an earlier session's claude may have outlived its host, unless
   * `create` just made it. Throws `box.gone` when it does not exist.
   */
  async #running(name: string): Promise<void> {
    const fresh = this.#fresh.delete(name);
    const listed = (await this.#deps.boxes.list()).find((box) => box.name === name);
    if (listed === undefined) throw new BoxError("box.gone", `box ${name} does not exist.`);
    if (listed.state === "running") {
      if (fresh) return;
      this.#deps.info?.("restarting a running box before a new session", { box: name });
      await this.#deps.boxes.stop(name);
    }
    await this.#deps.boxes.start(name);
  }

  /** Copies the CA bundle alone into `BOX_DIPO_DIR`, for the install before any session. */
  async #copyCa(name: string, caFile: string): Promise<void> {
    const stage = await mkdtemp(join(this.#deps.tmpRoot, BOX_FILES_STAGE_PREFIX));
    try {
      await copyFile(caFile, join(stage, "safe-chain-ca.pem"));
      await this.#deps.boxes.copyIn(name, `${stage}/.`, BOX_DIPO_DIR);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
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
    const started = this.#finish(runId)
      .catch((error: unknown): BoxFinish => ({ kind: "failed", reason: messageOf(error) }))
      .finally(() => this.#finishing.delete(runId));
    this.#finishing.set(runId, started);
    return started;
  }

  async #finish(runId: string): Promise<BoxFinish> {
    const name = boxName(runId);
    this.#door?.stop(runId);
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
        try {
          if (failure !== null) this.#deps.holds.hold(this.#deps.adapter, [failure]);
        } catch (holdError) {
          this.#deps.warn?.("holding after a failed box run end failed", {
            run: runId,
            reason: messageOf(holdError),
          });
        }
      }
    }
    await this.#release(name);
    // A box that could not be deleted stays in the index, for the next pass.
    if (outcome.kind !== "failed") this.#forget(runId, name);
    return outcome;
  }

  /**
   * Reads the part queue of `runId`'s box now (DIPO-273 reads it before a story done); null when
   * no door of the run is read. Rejects with `box.doorFailed` when the box cannot be read.
   */
  readDoor(runId: string): Promise<DoorRead> | null {
    return this.#door?.read(runId) ?? null;
  }

  /**
   * What keys the run's in-box base result besides its start commit (DIPO-294): the image its box
   * was made from and the listed files copied in, from the run directory's record; null when the
   * record names no image.
   */
  baseKeyOf(runDir: string): BoxBaseKey | null {
    const record = readBoxRun(runDir);
    return record?.image === undefined ? null : { image: record.image, files: record.files ?? [] };
  }

  /**
   * The office's install at the start commit in the run's box (DIPO-294), before the base verify:
   * the box's web route started as a session gets it (the box runs, so the box network's address
   * exists on the Mac), the Safe-Chain CA bundle copied in, and each command list run in `/work`
   * with `env` plus the route's settings (`runBoxInstall`). Throws `box.failed` when an install
   * past its deadline could be ended neither inside the box nor by stopping it, and a `BoxError`
   * when the route does not start.
   */
  async install(input: {
    readonly runId: string;
    readonly commands: readonly (readonly string[])[];
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
  }): Promise<BoxInstallResult> {
    const box = boxName(input.runId);
    const web = await this.#web.acquire(box);
    await this.#copyCa(box, web.caFile);
    const result = await runBoxInstall(
      {
        boxes: this.#deps.boxes,
        clock: this.#deps.code.clock,
        ...(this.#deps.warn === undefined ? {} : { warn: this.#deps.warn }),
      },
      {
        box,
        commands: input.commands,
        env: {
          ...input.env,
          HTTPS_PROXY: web.url,
          HTTP_PROXY: web.url,
          NODE_EXTRA_CA_CERTS: BOX_CA_FILE,
        },
        timeoutMs: input.timeoutMs,
      },
    );
    if (!result.ok && result.ended === "failed") {
      throw new BoxError(
        "box.failed",
        "the install passed its deadline and could be ended neither inside the box nor by stopping it.",
      );
    }
    this.#deps.info?.("install in the box", { run: input.runId, box, ok: result.ok });
    return result;
  }

  /**
   * What the run's box `/work` holds besides the start commit (DIPO-294), checked after the
   * install and the base verify and before the worker: only files `.gitignore` covers may differ.
   * Not known without the tree check (`BoxWorkersDeps.treeCheck`).
   */
  changedSinceStart(input: {
    readonly runId: string;
    readonly office: OfficeId;
    readonly story: string;
    readonly branch: string;
    readonly startSha: string;
  }): Promise<TreeCheck> {
    const check = this.#deps.treeCheck;
    if (check === undefined) {
      return Promise.resolve({
        kind: "unknown",
        reason: "this daemon cannot compare the box's files",
      });
    }
    return check({ ...input, box: boxName(input.runId) });
  }

  /**
   * The office's verify at the start commit in the run's box (DIPO-294), before the worker's
   * first session: `commands` in `/work` with `env` and nothing of the Mac's, within `timeoutMs`
   * (`runBoxBaseVerify`). The launch waits for it. A verify past the deadline that neither a kill
   * in the box nor a box stop could end throws `box.failed`, so the launch fails and deletes the
   * box instead of starting a worker beside it. A box stopped meanwhile (a daemon stop) ends the
   * verify with it, and the result is not known.
   */
  async baseVerify(input: {
    readonly runId: string;
    readonly commands: readonly (readonly string[])[];
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
  }): Promise<BaseVerifyFacts> {
    const box = boxName(input.runId);
    const { facts, ended } = await runBoxBaseVerify(
      {
        boxes: this.#deps.boxes,
        clock: this.#deps.code.clock,
        ...(this.#deps.warn === undefined ? {} : { warn: this.#deps.warn }),
      },
      { box, commands: input.commands, env: input.env, timeoutMs: input.timeoutMs },
    );
    if (ended === "failed") {
      throw new BoxError(
        "box.failed",
        "the base verify passed its deadline and could be ended neither inside the box nor by stopping it.",
      );
    }
    this.#deps.info?.("base verify in the box", { run: input.runId, box, result: facts.kind });
    return facts;
  }

  /** Deletes the box of a run whose worker never ran (a failed launch); no token check. */
  async discard(runId: string): Promise<void> {
    const name = boxName(runId);
    this.#door?.stop(runId);
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
    try {
      rmSync(this.#indexFile(runId), { force: true });
    } catch (error) {
      this.#deps.warn?.("dropping a box from the index failed", {
        run: runId,
        reason: messageOf(error),
      });
    }
    if (runDir === undefined || !existsSync(runDir)) return;
    try {
      const record = readBoxRun(runDir);
      writeJson(join(runDir, BOX_RUN_FILE), {
        runId,
        office: record?.office ?? "",
        box: name,
        ...(record?.image === undefined ? {} : { image: record.image }),
        ...(record?.files === undefined ? {} : { files: record.files }),
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
  async finishEnded(
    ended: (runId: string) => boolean | null,
    options: { readonly listBoxes?: boolean } = {},
  ): Promise<string[]> {
    const runs = new Set(this.pending());
    // The second layer (daemon start): every dipo box the backend lists, in case the index lost
    // one. Only where boxes ran before, so a daemon that never made a box never calls the backend.
    if (options.listBoxes === true && existsSync(this.#index)) {
      try {
        for (const box of await this.#deps.boxes.list()) runs.add(box.runId);
      } catch (error) {
        this.#deps.warn?.("listing the boxes failed", { reason: messageOf(error) });
      }
    }
    const finished: string[] = [];
    for (const runId of runs) {
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
    this.#door?.close();
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
