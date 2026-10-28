// The box of a box worker's run (DIPO-271, 0021 sections 1 to 6): one box per story run, made at
// the launch and used by every developer session of the run. It lives from claim to merge
// (DIPO-278): stopped, with its files, while the story waits, and deleted when the claim ends.
// `lifetime.ts` decides when, and rebuilds a box that was lost.
//
// - `create` (the launch's setup): the start check, the office image built from the base branch's
//   box block (`ensureBoxImage`: in a build box on the box network, through the boxes' web route,
//   behind the box firewall, and committed; DIPO-281), the host-only box network, the box with
//   nothing of the Mac mounted but the office package cache and the image's box network tools
//   (read-only, DIPO-281), started, and the code copied in (`stageBoxCode`: the start commit from git's objects plus the
//   listed files from the office's main checkout, never `.git`), the box's own local repository
//   made from it (`initBoxRepository`, DIPO-346), and dipo's `dipo-part` command installed
//   (`installDipoPart`, DIPO-272).
// - The package cache (DIPO-295, with `packageCache`): before the box is made, the office's cache
//   is reused when its key (the base lockfile and the image's manager version) matches, or filled
//   in a fill box (`ensurePackageCache`) through this daemon's web route; a reuse makes no fill
//   box. Two runs of one office that need the same fill share it. The box mounts the generation
//   read-only. A fill that fails or times out, or a lockfile the cache does not support, never
//   stops the run: the box is made without a cache and `create` returns the reason, which the
//   launch shows in a notice, also when the backend refuses to make the box with the mount. The
//   full error goes to the daemon's log only.
// - `session` (each developer session): the box running again, dipo's web route and model proxy
//   for the box network (both started only once a box on it runs, because the network's address
//   exists on the Mac only then), the box firewall set to exactly the ports of those two (DIPO-281,
//   `firewall.ts`), and dipo's files copied to `BOX_DIPO_DIR`: the system file and the Safe-Chain
//   CA bundle. The box's web route address names the box by its own proxy password, which reaches
//   the local ports of the Mac its office lists (`box.localPorts`, DIPO-282) and no other. A box that already runs when a session starts may still hold an
//   earlier session's claude (a host killed with SIGKILL, or one that crashed, never ran its stop
//   command), so it is stopped and started again first; only a box `create` just made is not. It returns how the worker host runs a command in the box and stops it.
//   With `door`, the box's part queue is read while the session runs (`BoxDoor`, DIPO-272).
// - `rest` (the story waits, DIPO-278): the box stopped and started again (so no earlier claude
//   outlives its host into the check), the post-run token check, then the box stopped with its
//   files and its routes released; the record says it rests until the next session. A session
//   and a rest of one run never overlap: a session waits for a rest in flight, and a rest that
//   finds a session started since it began (a per-run session epoch, read again after the check)
//   or one still starting stops nothing, releases nothing and marks nothing. A pass waits for a
//   rest at most `BOX_FINISH_WAIT_MS` too; the rest goes on.
// - `finish` (the claim ended: merge, drop, discard): the post-run token check, unless the box
//   rests already (`checkBoxAfterRun`, which holds the adapter when the token is found or the
//   check cannot finish), then the box deleted and its routes released. `discard` deletes a box
//   whose worker never ran, without the check.
// - `finishEnded` finishes the box of every run whose claim ended, and rests every waiting one
//   (after an exit, on the daemon's minute tick and at daemon start; at daemon start also every
//   dipo box the backend lists), and `close` stops every box at daemon stop, which ends the
//   worker inside it. Its passes run one after another, so two callers at
//   once (an exit decision and the end of its ingestion) finish and report each run once
//   (DIPO-307); a run whose finish failed is not reported as finished. A pass waits for one run's
//   finish at most `BOX_FINISH_WAIT_MS`, so a finish that hangs cannot hold the passes after it
//   (the daemon-start sweep among them); the finish goes on, and a later pass waits for it again. At daemon start it also
//   deletes the fill, build and Safe-Chain boxes (`dipo-fill-*`, `dipo-build-*`,
//   `dipo-safe-chain-*`, DIPO-343) a stopped daemon left, never one this daemon uses now; the index folder is made before the first fill, so the backend is asked
//   after a crash in the first box run's fill too.
// - Before the worker's first session (the launch, after `create`; DIPO-294): `install` runs the
//   office's install in the box at the start commit with the box's web route and the Safe-Chain CA
//   bundle, as a session gets them (`runBoxInstall`); with a mounted cache first with
//   `boxCacheEnv`, and when that install fails (not at its deadline, nor with the box stopped)
//   once more without the cache, with the reason in the result. `changedSinceStart` compares
//   `/work` with the start commit on dipo's own copy (`BoxWorkersDeps.treeCheck`), never by
//   running git or any tool on the box's files.
//
// Two records: the run directory's `BOX_RUN_FILE` says the run is a box worker's, so every later
// session of the run plans in its box; the index folder in dipo's state folder holds one file per
// box not yet finished, so a daemon after a restart finds them, and a daemon that never ran a box
// never calls the backend for `finishEnded` or `close`. Nothing here names a worker CLI.

import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import type { OfficeGit } from "../git/office";
import { ensurePrivateDir } from "../platform/paths";
import { type AdapterHolds, holdMessage } from "../workers/hold";
import { ensureBoxImage } from "./build-box";
import {
  type BaseLockfile,
  boxCacheEnv,
  type CacheManager,
  cacheSkipReason,
  ensurePackageCache,
  FILL_BOX_RUN_PREFIX,
  type PackageCache,
  type PackageCacheRequest,
  readBaseLockfile,
} from "./cache";
import { initBoxRepository } from "./box-git";
import { BOX_DIPO_DIR, BOX_WORKDIR, type BoxCodeDeps, stageBoxCode } from "./code";
import { BoxDoor, type BoxDoorDeps, type DoorRead, installDipoPart } from "./door";
import { BOX_IMAGE_ENV, type BaseBox, type BoxImageDescription, type BoxToolchain } from "./image";
import { boxModelEnvironment, type RunningModelProxy } from "./model-proxy";
import {
  BoxError,
  BUILD_BOX_RUN_PREFIX,
  type BoxClientCommand,
  type BoxNetwork,
  type BoxPort,
  boxName,
  runIdOfBox,
  TEST_BOX_RUN_PREFIX,
} from "./port";
import type { PartRun, StartTreeCheck } from "./parts";
import { type BoxTokenCheck, checkBoxAfterRun, tokenCheckFailure } from "./token-check";
import { copyInAsUser } from "./user";
import { SAFE_CHAIN_BOX_RUN_PREFIX } from "./safe-chain";
import { type BoxInstallResult, type BoxVerifyResult, runBoxInstall, runBoxVerify } from "./verify";
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
/**
 * How long a `finishEnded` pass waits for one run's finish: the token check's export deadline
 * (`TOKEN_CHECK_EXPORT_TIMEOUT_MS`) plus room for the other box calls, each with its own deadline.
 */
export const BOX_FINISH_WAIT_MS = 15 * 60_000;

/**
 * How long a session waits for a rest of its run that is in flight (DIPO-278): as long as a pass
 * waits for one, so a hung backend call cannot hold the session for ever. Past it the session is
 * refused (`BOX_REST_WAIT_CODE`) as a box that could not be made ready.
 */
export const BOX_SESSION_REST_WAIT_MS = BOX_FINISH_WAIT_MS;

/** The `BoxError` code of a session that waited past `BOX_SESSION_REST_WAIT_MS` for a rest. */
export const BOX_REST_WAIT_CODE = "box.restPending";

type Log = (message: string, fields: Readonly<Record<string, unknown>>) => void;

/** The run directory's record. */
export interface BoxRunRecord {
  readonly runId: string;
  readonly office: string;
  readonly box: string;
  /**
   * The files outside git the base branch's box block listed (`box.files`) when the box was made,
   * repo-relative (DIPO-290): what every part of the run leaves out, whatever the base config says
   * later. Absent in a record written before it was kept.
   */
  readonly files?: readonly string[];
  /**
   * The local ports of the Mac the base branch's box block listed (`box.localPorts`) when the box
   * was made (DIPO-282): the only ones the box reaches, through the web route. Absent: none.
   */
  readonly localPorts?: readonly number[];
  /** Set once the run ended and its box was deleted. */
  readonly finished?: boolean;
  /**
   * Set when the box was stopped while its story waits (DIPO-278), after the post-run token check
   * of its last session; a new session clears it. A stopped box with it set needs no check before
   * it is stopped or deleted again.
   */
  readonly waiting?: boolean;
}

/** What `has` found of a run's box (DIPO-278). */
export type BoxPresence =
  /** The record says the box lives and the backend lists it. */
  | "ready"
  /** The run had a box, but it was deleted or the backend lost it. */
  | "gone"
  /** The run never had a box (a run from before every run was a box run). */
  | "none";

/** What `rest` did with the box of a run that waits (DIPO-278). */
export type BoxRest =
  | { readonly kind: "stopped"; readonly check: BoxTokenCheck }
  /** Already stopped and checked after its last session: nothing to do. */
  | { readonly kind: "resting" }
  /**
   * A session of the run started before the stop (during the check, or before the rest began):
   * the box keeps running with its routes, and the next stop checks it again.
   */
  | { readonly kind: "skipped" }
  | { readonly kind: "gone" }
  | { readonly kind: "failed"; readonly reason: string };

/** Options of a `finishEnded` pass. */
export interface BoxPassOptions {
  /** Also every dipo box the backend lists (daemon start). */
  readonly listBoxes?: boolean;
  /**
   * The run directory of a run a loaded office knows, or null: a listed box the index lost gets
   * its index entry again, so its rest and finish find the run's record.
   */
  readonly runDirOf?: (runId: string) => string | null;
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

/** How the box workers fill and reuse each office's package cache (DIPO-295). */
export interface BoxPackageCacheDeps {
  /**
   * dipo's package cache root of `office`, in dipo's state folder (`officePackageCacheRoot`);
   * made 0700 when missing.
   */
  readonly root: (office: OfficeId) => string;
  /** Reads the lockfile from the base branch's git objects; `readBaseLockfile` by default. */
  readonly readSource?: (git: OfficeGit) => Promise<BaseLockfile>;
  /** Fills or reuses the cache; `ensurePackageCache` by default. */
  readonly ensure?: (request: PackageCacheRequest) => Promise<PackageCache>;
  /** The fill install's deadline; `PACKAGE_CACHE_FILL_TIMEOUT_MS` by default. */
  readonly timeoutMs?: number;
  /** The fill box's id; random by default. */
  readonly fillId?: () => string;
}

/** What a new box got of the office package cache (DIPO-295). */
export type BoxCacheUse =
  /** This daemon fills no cache. */
  | { readonly kind: "off" }
  /** The generation is mounted read-only; `filled` is false when it was reused. */
  | {
      readonly kind: "mounted";
      readonly path: string;
      readonly manager: CacheManager | null;
      readonly filled: boolean;
    }
  /** The box runs without a cache, for `reason` (no box output in it). */
  | { readonly kind: "skipped"; readonly reason: string };

/** The box `create` made, and what it got of the package cache. */
export interface BoxMade {
  readonly name: string;
  readonly cache: BoxCacheUse;
}

/** What `install` did: `runBoxInstall`'s result, and why the cache was left out, if it was. */
export type BoxWorkerInstall = BoxInstallResult & {
  /**
   * Set when the install from the mounted cache failed and dipo ran it again without the cache:
   * that install's reason.
   */
  readonly cacheFallback?: string;
};

export interface BoxWorkersDeps {
  readonly boxes: BoxPort;
  /**
   * Starts dipo's web route (the web proxy, and Safe-Chain in its own box behind it, DIPO-343) on
   * the box network. `ids` names the Safe-Chain box and its image's build box before they exist,
   * so a daemon-start sweep leaves them alone (`startBoxWebRoute`'s `boxId` and `buildId`).
   */
  readonly startWebRoute: (network: BoxNetwork, ids: RouteBoxIds) => Promise<BoxWebRouteStart>;
  /** Starts the model proxy on the box network's host address; it reads the token at start. */
  readonly startModelProxy: (
    network: Pick<BoxNetwork, "hostAddress">,
  ) => Promise<RunningModelProxy>;
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
   * dipo's root of the box network tools (DIPO-281): each image's copy, which every box of it
   * mounts read-only; `join(<state>, BOX_NET_TOOLS_DIR)` in the daemon.
   */
  readonly netToolsRoot: string;
  /**
   * The office package cache (DIPO-267, DIPO-295): filled or reused before each box is made and
   * mounted read-only. Without it no box gets a cache.
   */
  readonly packageCache?: BoxPackageCacheDeps;
  /**
   * The box door (DIPO-272): with it, dipo reads each box's part queue while a session runs and
   * hands each part to `onPart` (DIPO-273 delivers it). Without it no queue is read; `dipo-part` is
   * installed in every box either way.
   */
  readonly door?: Pick<BoxDoorDeps, "onPart" | "onRefused" | "pollMs" | "live">;
  /**
   * Compares a box's `/work` with the start commit on dipo's own copy
   * (`BoxParts.changedSinceStart`, DIPO-294), for the check after the install; without it that
   * check is not known, which stops the launch.
   */
  readonly treeCheck?: (run: PartRun) => Promise<StartTreeCheck>;
  /** Overrides `BOX_FINISH_WAIT_MS`. */
  readonly finishWaitMs?: number;
  /** Overrides `BOX_SESSION_REST_WAIT_MS`. */
  readonly sessionRestWaitMs?: number;
  readonly warn?: Log;
  readonly info?: Log;
}

/** The ids of the boxes a web route start makes (DIPO-343), each told before its box exists. */
export interface RouteBoxIds {
  readonly boxId: () => string;
  readonly buildId: () => string;
}

/** `finishEnded`'s answer for a run that waits with its claim live: stop its box, keep it. */
export const BOX_WAITING = "waiting";

/**
 * What `finishEnded` asks of each run: true when its claim ended and its worker hosts exited (the
 * box is deleted), `BOX_WAITING` when the run ended with its claim live and its hosts exited (the box
 * stops), false while it goes on, null when no loaded office knows it (left alone).
 */
export type BoxEnded = boolean | typeof BOX_WAITING | null;

/** What `finish` did. */
export type BoxFinish =
  | { readonly kind: "checked"; readonly check: BoxTokenCheck }
  /** Deleted with no check: it was stopped and checked after its last session (DIPO-278). */
  | { readonly kind: "deleted" }
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
    const value = JSON.parse(text) as Partial<Record<keyof BoxRunRecord, unknown>>;
    if (typeof value.runId !== "string" || typeof value.box !== "string") return null;
    const files =
      Array.isArray(value.files) && value.files.every((file) => typeof file === "string")
        ? (value.files as string[])
        : undefined;
    const localPorts =
      Array.isArray(value.localPorts) &&
      value.localPorts.every((port) => Number.isInteger(port) && port >= 1 && port <= 65_535)
        ? (value.localPorts as number[])
        : undefined;
    return {
      runId: value.runId,
      office: typeof value.office === "string" ? value.office : "",
      box: value.box,
      ...(files === undefined ? {} : { files }),
      ...(localPorts === undefined ? {} : { localPorts }),
      ...(value.finished === true ? { finished: true } : {}),
      ...(value.waiting === true ? { waiting: true } : {}),
    };
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/** The port of a route's URL, `http://[user:password@]<host>:<port>`. */
function portOf(url: string): number {
  const port = Number(new URL(url).port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new BoxError("box.routeFailed", `the web route's address ${url} names no port.`);
  }
  return port;
}

/** A wait as people read it: whole minutes, or seconds below a minute. */
function waitText(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`;
}

/** Rewrites the run directory's record with `waiting` set or cleared; no record, no write. */
function markWaiting(runDir: string, waiting: boolean): void {
  const record = readBoxRun(runDir);
  if (record === null || (record.waiting === true) === waiting) return;
  writeJson(join(runDir, BOX_RUN_FILE), {
    runId: record.runId,
    office: record.office,
    box: record.box,
    ...(record.files === undefined ? {} : { files: record.files }),
    ...(record.localPorts === undefined ? {} : { localPorts: record.localPorts }),
    ...(record.finished === true ? { finished: true } : {}),
    ...(waiting ? { waiting: true } : {}),
  } satisfies BoxRunRecord);
}

export class BoxWorkers {
  readonly #deps: BoxWorkersDeps;
  readonly #index: string;
  #network: BoxNetwork | null = null;
  readonly #web: BoxWebRoute<RunningBoxWebRoute>;
  readonly #model: BoxWebRoute<RunningModelProxy>;
  /** Finishes in flight, by run id. */
  readonly #finishing = new Map<string, Promise<BoxFinish>>();
  /** Stops of waiting runs in flight, by run id (DIPO-278). */
  readonly #resting = new Map<string, Promise<BoxRest>>();
  /** Per run, how many sessions started here: a rest that sees it change stops nothing. */
  readonly #epochs = new Map<string, number>();
  /** Per run, the sessions whose box is being made ready now. */
  readonly #starting = new Map<string, number>();
  /** Boxes `create` made and started, in which no session ran yet. */
  readonly #fresh = new Set<string>();
  /** The part queues read while a session runs (DIPO-272); null without `door`. */
  readonly #door: BoxDoor | null;
  /** The manager of the cache each box `create` mounted, by run id, for its install. */
  readonly #cached = new Map<string, CacheManager>();
  /** The fill boxes and build boxes (DIPO-281) of the fills and builds in flight here, by name. */
  readonly #filling = new Set<string>();
  /** The one admission of each test box on the web route (DIPO-309, `#admit`). */
  readonly #admitted = new Map<
    string,
    { readonly route: RunningBoxWebRoute; readonly proxy: string }
  >();
  /** The `finishEnded` pass that runs or ran last; the next waits for it. */
  #pass: Promise<unknown> = Promise.resolve();

  constructor(deps: BoxWorkersDeps) {
    this.#deps = deps;
    this.#index = deps.indexDir;
    this.#web = new BoxWebRoute(() => this.#startWebRoute());
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

  /**
   * Starts the web route with the Safe-Chain box behind it (DIPO-343). The index folder is made
   * first, so a daemon that crashes with a Safe-Chain box running asks the backend at its next
   * start; the route's boxes are known by name before they exist, so that sweep leaves a running
   * route's alone, and the Safe-Chain box is forgotten again when the route stops.
   */
  async #startWebRoute(): Promise<RunningBoxWebRoute> {
    ensurePrivateDir(this.#index);
    const named: string[] = [];
    const id = (prefix: string) => () => {
      const value = randomUUID().replaceAll("-", "").slice(0, 16);
      const name = boxName(`${prefix}${value}`);
      named.push(name);
      this.#filling.add(name);
      return value;
    };
    const forget = () => {
      for (const name of named) this.#filling.delete(name);
    };
    let started: BoxWebRouteStart;
    try {
      started = await this.#deps.startWebRoute(await this.#networkOf(), {
        boxId: id(SAFE_CHAIN_BOX_RUN_PREFIX),
        buildId: id(BUILD_BOX_RUN_PREFIX),
      });
    } catch (error) {
      forget();
      throw error;
    }
    if (!started.ok) {
      forget();
      throw new BoxError("box.routeFailed", `the box web route did not start: ${started.reason}`);
    }
    const route = started.route;
    return {
      ...route,
      stop: async () => {
        try {
          await route.stop();
        } finally {
          forget();
        }
      },
    };
  }

  /** True when the run of `runDir` runs its developer in a box. */
  isBoxRun(runDir: string): boolean {
    return existsSync(join(runDir, BOX_RUN_FILE));
  }

  /**
   * Whether the run of `runDir` still has its box (DIPO-278): `ready` when its record says the box
   * lives and the backend lists it, `gone` when it was deleted or lost, `none` without a record.
   */
  async has(runId: string, runDir: string): Promise<BoxPresence> {
    const record = readBoxRun(runDir);
    if (record === null || record.runId !== runId) return "none";
    if (record.finished === true) return "gone";
    const listed = await this.#deps.boxes.list();
    return listed.some((box) => box.name === record.box) ? "ready" : "gone";
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

  /**
   * The box network's host address once this daemon prepared the network, else null (DIPO-281):
   * the live source the web guard and the reviewer's web proxy read, for each check, to refuse the
   * box network. The address exists on the Mac only while a box on it runs, and every box here
   * runs only after the network was prepared, so null while no box ran here is no gap.
   */
  get hostAddress(): string | null {
    return this.#network?.hostAddress ?? null;
  }

  /** The local ports of the Mac the box of `runDir`'s record may reach (DIPO-282); none without. */
  #localPorts(runDir: string | undefined): readonly number[] {
    return runDir === undefined ? [] : (readBoxRun(runDir)?.localPorts ?? []);
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
   * The office's package cache for a new box (DIPO-295; see the file comment): reused or filled,
   * or skipped with the reason. Never rejects.
   */
  async #packageCache(
    office: OfficeId,
    runId: string,
    git: OfficeGit,
    image: { readonly tag: string; readonly toolchain: BoxToolchain; readonly netTools: string },
  ): Promise<BoxCacheUse> {
    const deps = this.#deps.packageCache;
    if (deps === undefined) return { kind: "off" };
    // The fill box's name is known here, so the sweep at daemon start leaves it alone.
    let filling: string | null = null;
    const fillId = (): string => {
      const id = deps.fillId?.() ?? randomUUID().replaceAll("-", "").slice(0, 16);
      filling = boxName(`${FILL_BOX_RUN_PREFIX}${id}`);
      this.#filling.add(filling);
      return id;
    };
    try {
      const source = await (deps.readSource ?? readBaseLockfile)(git);
      const cache = await (deps.ensure ?? ensurePackageCache)({
        root: deps.root(office),
        source,
        boxes: this.#deps.boxes,
        image,
        // The fill box reaches the registries only through this daemon's web route.
        route: {
          acquire: (box) => this.#web.acquire(box),
          release: (box) => this.#web.release(box),
        },
        clock: this.#deps.code.clock,
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
        fillId,
        onEvent: (event) =>
          this.#deps.warn?.("a fill box was not cleaned up", {
            run: runId,
            box: event.box,
            step: event.step,
            reason: event.reason,
          }),
      });
      this.#deps.info?.(cache.filled ? "package cache filled" : "package cache reused", {
        run: runId,
        key: cache.key,
        manager: cache.manager,
      });
      return { kind: "mounted", path: cache.path, manager: cache.manager, filled: cache.filled };
    } catch (error) {
      const reason = cacheSkipReason(error);
      this.#deps.warn?.("the box runs without the package cache", {
        run: runId,
        reason,
        code: error instanceof BoxError ? error.code : "error",
        message: messageOf(error),
      });
      return { kind: "skipped", reason };
    } finally {
      if (filling !== null) this.#filling.delete(filling);
    }
  }

  /**
   * The office image of `image` for run `runId`'s box (DIPO-281): reused, or built in a build box
   * through this daemon's web route (`ensureBoxImage`). The build box's name is known before it
   * exists, so the sweep at daemon start leaves it alone.
   */
  async #image(
    runId: string,
    image: BoxImageDescription,
  ): Promise<Awaited<ReturnType<typeof ensureBoxImage>>> {
    let building: string | null = null;
    try {
      return await ensureBoxImage(
        {
          boxes: this.#deps.boxes,
          route: {
            acquire: (box) => this.#web.acquire(box),
            release: (box) => this.#web.release(box),
          },
          scratchRoot: this.#deps.scratchRoot,
          toolsRoot: this.#deps.netToolsRoot,
          clock: this.#deps.code.clock,
          buildId: () => {
            const id = randomUUID().replaceAll("-", "").slice(0, 16);
            building = boxName(`${BUILD_BOX_RUN_PREFIX}${id}`);
            this.#filling.add(building);
            return id;
          },
          onEvent: (event) =>
            this.#deps.warn?.("a build box was not cleaned up", {
              run: runId,
              box: event.box,
              step: event.step,
              reason: event.reason,
            }),
        },
        image,
      );
    } finally {
      if (building !== null) this.#filling.delete(building);
    }
  }

  /**
   * Makes the run's box (the launch's setup): image, network, the package cache, the box started
   * and the code copied in. Throws a `BoxError` when it cannot; a box it made is deleted again
   * then. A package cache that cannot be had never throws: the box is made without one.
   */
  async create(input: {
    readonly office: OfficeId;
    readonly runId: string;
    readonly runDir: string;
    readonly git: OfficeGit;
    readonly startCommit: string;
    /**
     * The tree the code is copied from instead of the start commit (DIPO-278): a lost box is
     * rebuilt from the delivered parts (`deliveredCode` in `lifetime.ts`).
     */
    readonly code?: string;
  }): Promise<BoxMade> {
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
    const image = await this.#image(input.runId, base.description.image);
    const network = await this.#networkOf();
    const name = boxName(input.runId);
    // Before the fill: a daemon that crashes in the first fill asks the backend at its next start.
    ensurePrivateDir(this.#index);
    let cache = await this.#packageCache(input.office, input.runId, input.git, {
      tag: image.tag,
      toolchain: base.description.image.toolchain,
      netTools: image.netTools,
    });
    // Recorded before the box exists, so a crash in between leaves a box dipo knows to clean up;
    // with the listed files the box gets, which decide what every part leaves out (DIPO-290).
    writeJson(join(input.runDir, BOX_RUN_FILE), {
      runId: input.runId,
      office: input.office,
      box: name,
      files: base.description.files.map((file) => file.path),
      localPorts: base.description.localPorts,
    } satisfies BoxRunRecord);
    writeJson(this.#indexFile(input.runId), { runDir: input.runDir });
    try {
      const spec = { runId: input.runId, image: image.tag, network, netTools: image.netTools };
      if (cache.kind === "mounted") {
        try {
          await boxes.create({ ...spec, packageCache: cache.path });
        } catch (error) {
          // The mount is the only part a box without a cache lacks; the run goes on without it.
          const code = codeOf(error);
          this.#deps.warn?.("the box could not be made with the package cache mounted", {
            run: input.runId,
            code,
            message: messageOf(error),
          });
          await boxes.delete(name).catch(() => undefined);
          cache = {
            kind: "skipped",
            reason: `the box could not be made with the package cache mounted (${code})`,
          };
          await boxes.create(spec);
        }
      } else {
        await boxes.create(spec);
      }
      await boxes.start(name);
      const staged = await stageBoxCode(this.#deps.code, {
        git: input.git,
        commit: input.code ?? input.startCommit,
        files: base.description.files,
        // The registered office path: the maintainer's checkout, where files outside git live.
        source: input.git.mainWorktree,
        tmpRoot: this.#deps.tmpRoot,
      });
      try {
        // The box user's own copy (DIPO-334): `/work` is the worker's to write.
        await copyInAsUser(boxes, name, staged.dir, BOX_WORKDIR);
      } finally {
        await staged.remove();
      }
      // The box's own local repository of what was copied in (0008, DIPO-346), as the box user.
      await initBoxRepository(boxes, name);
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
    if (cache.kind === "mounted" && cache.manager !== null) {
      this.#cached.set(input.runId, cache.manager);
    }
    this.#deps.info?.("box ready", {
      run: input.runId,
      box: name,
      image: image.tag,
      packageCache: cache.kind,
    });
    return { name, cache };
  }

  /**
   * The box of the run's next developer session: running, with its routes, and dipo's files
   * copied in. Throws a `BoxError`: `box.gone` when the run has no box any more.
   *
   * Every caller opens the run first (DIPO-278): the launcher starts a new run, and each
   * `RunResumer.next` follows a `reopen` (a resume, a review or fix round) or runs inside a run
   * that never ended (a restart), so a pass sees the run working, never waiting, while its session
   * starts. A rest already in flight is waited for, at most `BOX_SESSION_REST_WAIT_MS`; past it
   * the session is refused with `BOX_REST_WAIT_CODE`.
   */
  async session(input: {
    readonly runId: string;
    readonly runDir: string;
    readonly systemFile: string;
  }): Promise<BoxSession> {
    const { runId } = input;
    // A rest in flight sees the new epoch after its check and leaves the box running (DIPO-278).
    this.#epochs.set(runId, (this.#epochs.get(runId) ?? 0) + 1);
    this.#starting.set(runId, (this.#starting.get(runId) ?? 0) + 1);
    try {
      await this.#restDone(runId);
      return await this.#session(input);
    } finally {
      const left = (this.#starting.get(runId) ?? 1) - 1;
      if (left > 0) this.#starting.set(runId, left);
      else this.#starting.delete(runId);
    }
  }

  /**
   * Waits for a rest of `runId` in flight, if any, at most `BOX_SESSION_REST_WAIT_MS`. Throws a
   * `BoxError` (`BOX_REST_WAIT_CODE`) once that passed; the rest itself goes on.
   */
  async #restDone(runId: string): Promise<void> {
    const resting = this.#resting.get(runId);
    if (resting === undefined) return;
    const waitMs = this.#deps.sessionRestWaitMs ?? BOX_SESSION_REST_WAIT_MS;
    const ended = await this.#within(resting, runId, "session", waitMs);
    if (ended === null) {
      throw new BoxError(
        BOX_REST_WAIT_CODE,
        `the box of run ${runId} is still being checked and stopped after ${waitText(waitMs)}; the session did not start. Name the story again later.`,
      );
    }
  }

  /**
   * The run's box running with no earlier process in it, before its next developer session
   * (DIPO-324): dipo copies the merges it committed on the story branch outside the box into it
   * then, behind the box firewall set to the web route (DIPO-281). The session that follows finds
   * it running and fresh, so it does not start it again.
   * Throws a `BoxError` as `session` does.
   */
  async awake(input: { readonly runId: string; readonly runDir: string }): Promise<string> {
    const { runId } = input;
    this.#epochs.set(runId, (this.#epochs.get(runId) ?? 0) + 1);
    this.#starting.set(runId, (this.#starting.get(runId) ?? 0) + 1);
    try {
      await this.#restDone(runId);
      const record = readBoxRun(input.runDir);
      if (record === null || record.runId !== runId || record.finished === true) {
        throw new BoxError("box.gone", `run ${runId} has no box to copy into.`);
      }
      await this.#running(record.box);
      // Before anything is copied in (DIPO-281): the box reaches the web route on the Mac, no more.
      // The route is the session's too; a rest or finish releases it with the box's others.
      const web = await this.#web.acquire(record.box);
      const network = await this.#networkOf();
      await this.#deps.boxes.firewall(record.box, {
        hostAddress: network.hostAddress,
        ports: [portOf(web.url)],
      });
      // No claude ran in it since it started: the session need not start it again.
      this.#fresh.add(record.box);
      return record.box;
    } finally {
      const left = (this.#starting.get(runId) ?? 1) - 1;
      if (left > 0) this.#starting.set(runId, left);
      else this.#starting.delete(runId);
    }
  }

  async #session(input: {
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
        `the box of run ${input.runId} was deleted; the run's next session rebuilds it.`,
      );
    }
    const name = record.box;
    const { boxes } = this.#deps;
    await this.#running(name);
    // A session runs in it now: the next stop checks it for the token again (DIPO-278).
    markWaiting(input.runDir, false);
    // The routes only now: the box network's address exists on the Mac once a box on it runs.
    const web = await this.#web.acquire(name);
    const model = await this.#model.acquire(name);
    // Before anything of the worker's runs: the box reaches these two ports on the Mac, no more.
    const network = await this.#networkOf();
    await boxes.firewall(name, {
      hostAddress: network.hostAddress,
      ports: [portOf(web.url), model.port],
    });
    await this.#copyDipoFiles(name, input.systemFile, web.caFile);
    // The part queue is read while the session runs (DIPO-272).
    this.#door?.start(input.runId, name, input.runDir);
    const proxy = web.admit(name, record.localPorts ?? []);
    const env = {
      ...BOX_IMAGE_ENV,
      ...boxModelEnvironment(model),
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
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

  /**
   * Copies the CA bundle, and the system file when given, into `BOX_DIPO_DIR` through a stage of
   * dipo's.
   */
  async #copyDipoFiles(name: string, systemFile: string | null, caFile: string): Promise<void> {
    const stage = await mkdtemp(join(this.#deps.tmpRoot, BOX_FILES_STAGE_PREFIX));
    try {
      if (systemFile !== null) await copyFile(systemFile, join(stage, "system.md"));
      await copyFile(caFile, join(stage, "safe-chain-ca.pem"));
      // Root's in the box, in root's `BOX_DIPO_DIR`: the box user reads them and cannot change
      // them (DIPO-334).
      await chmod(stage, 0o755);
      for (const file of [...(systemFile === null ? [] : ["system.md"]), "safe-chain-ca.pem"]) {
        await chmod(join(stage, file), 0o644);
      }
      await this.#deps.boxes.copyIn(name, `${stage}/.`, BOX_DIPO_DIR);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  /**
   * The end of a box run's box (its claim ended: merge, drop, discard): the post-run token check
   * unless the box was stopped and checked after its last session (`BoxRunRecord.waiting`), then
   * the box deleted and its routes released. Never rejects; once per run (a second call waits for
   * the first).
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
    // A rest in flight ends first, as for a session: its mark is read after it (DIPO-278).
    await this.#resting.get(runId);
    const runDir = this.#runDirOf(runId);
    // Read only after the box is listed as stopped: a session clears the mark before any worker
    // runs in its box, so a mark still set then means no session ran since the last check; one
    // that cleared it gets a fresh token check before its box is deleted.
    const rested = (): boolean => runDir !== undefined && readBoxRun(runDir)?.waiting === true;
    const outcome = await this.#checked(runId, name, { skipCheck: rested }, (box) =>
      this.#deps.boxes.delete(box),
    );
    await this.#release(name);
    // A box that could not be deleted stays in the index, for the next pass.
    if (outcome.kind !== "failed") this.#forget(runId, name);
    return outcome;
  }

  /**
   * Stops the box of a run whose story waits (DIPO-278; 0021 section 6): for a review, an answer,
   * a resume, CI or the maintainer. The post-run token check runs first, as at the end of a box
   * run, then the box stops with its files kept and its routes are released; the record says it
   * rests, so later passes leave it alone until the next session clears that. Never rejects; once
   * per run at a time, and never while the run's box is being finished.
   */
  rest(runId: string): Promise<BoxRest> {
    const pending = this.#resting.get(runId);
    if (pending !== undefined) return pending;
    const started = this.#rest(runId)
      .catch((error: unknown): BoxRest => ({ kind: "failed", reason: messageOf(error) }))
      .finally(() => this.#resting.delete(runId));
    this.#resting.set(runId, started);
    return started;
  }

  async #rest(runId: string): Promise<BoxRest> {
    const name = boxName(runId);
    const runDir = this.#runDirOf(runId);
    const record = runDir === undefined ? null : readBoxRun(runDir);
    if (record?.waiting === true) return { kind: "resting" };
    // A session that is making the box ready now keeps it; its run is not waiting any more.
    if (this.#starting.has(runId)) return { kind: "skipped" };
    this.#door?.stop(runId);
    const epoch = this.#epochs.get(runId) ?? 0;
    const moved = (): boolean => (this.#epochs.get(runId) ?? 0) !== epoch;
    // The box restarts first, as before a session, so no earlier claude runs during the check.
    const outcome = await this.#checked(runId, name, { restart: true }, async (box) => {
      // A session started during the check: it keeps the box running, with its routes.
      if (!moved()) await this.#deps.boxes.stop(box);
    });
    // No stop, release or mark for a session that started meanwhile; it waited for this rest.
    if (moved()) {
      this.#deps.info?.("a session started while the box was checked; it keeps running", {
        run: runId,
        box: name,
      });
      return { kind: "skipped" };
    }
    await this.#release(name);
    if (outcome.kind === "checked") {
      if (runDir !== undefined) markWaiting(runDir, true);
      this.#deps.info?.("box stopped while its story waits", { run: runId, box: name });
      return { kind: "stopped", check: outcome.check };
    }
    if (outcome.kind === "gone") return { kind: "gone" };
    return { kind: "failed", reason: outcome.kind === "failed" ? outcome.reason : "unknown" };
  }

  /**
   * The post-run token check of box `name`, then `then(name)` (delete or stop): `gone` when the
   * backend has no such box. When `skipCheck` says so, read after the listing, a stopped box gets no check. With `restart` a running
   * box is stopped and started again before the check, as `#running` does before a session, so
   * an earlier session's claude that outlived its host is gone first. A box whose check could
   * not even start holds the adapter, as a failed check does; only the error's code goes into the
   * hold, never a message that may quote the box.
   */
  async #checked(
    runId: string,
    name: string,
    how: { readonly skipCheck?: () => boolean; readonly restart?: boolean },
    then: (name: string) => Promise<void>,
  ): Promise<BoxFinish> {
    const { boxes } = this.#deps;
    let exists = false;
    let checked = false;
    try {
      const listed = (await boxes.list()).find((box) => box.name === name);
      if (listed === undefined) return { kind: "gone" };
      exists = true;
      if (listed.state !== "running" && how.skipCheck?.() === true) {
        checked = true;
        await then(name);
        return { kind: "deleted" };
      }
      // The check reads the environment of the running box, so a stopped box starts first.
      if (how.restart === true && listed.state === "running") await boxes.stop(name);
      if (how.restart === true || listed.state !== "running") await boxes.start(name);
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
      await then(name);
      return { kind: "checked", check: result };
    } catch (error) {
      const reason = messageOf(error);
      this.#deps.warn?.("the end of a box run failed", { run: runId, box: name, reason });
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
      return { kind: "failed", reason };
    }
  }

  /**
   * Reads the part queue of `runId`'s box now (DIPO-273 reads it before a story done); null when
   * no door of the run is read. Rejects with `box.doorFailed` when the box cannot be read.
   */
  readDoor(runId: string): Promise<DoorRead> | null {
    return this.#door?.read(runId) ?? null;
  }

  /**
   * The office's install at the start commit in the run's box (DIPO-294), after `create` and
   * before the worker's first session: dipo's web route acquired for the box (the box runs, so
   * the box network's address exists on the Mac), the Safe-Chain CA bundle copied in, and each
   * command list run in `/work` with `env` plus the route's HTTPS_PROXY, HTTP_PROXY and
   * NODE_EXTRA_CA_CERTS, exactly as a session gets them, within `timeoutMs` (`runBoxInstall`).
   * With a package cache mounted (DIPO-295), the install first gets `boxCacheEnv`, so it takes the
   * cached packages; when that install fails, but not at its deadline or with the box stopped, it
   * runs once more without
   * the cache, through the web route only, and `cacheFallback` says why. The session later uses
   * the same route. A failure is a result, logged with the cleaned tail of the box's output; a
   * route that does not start throws its `BoxError`.
   */
  async install(input: {
    readonly runId: string;
    readonly commands: readonly (readonly string[])[];
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
  }): Promise<BoxWorkerInstall> {
    const box = boxName(input.runId);
    const web = await this.#web.acquire(box);
    // Before the install's first script: the box reaches the web route on the Mac, no more.
    const network = await this.#networkOf();
    await this.#deps.boxes.firewall(box, {
      hostAddress: network.hostAddress,
      ports: [portOf(web.url)],
    });
    await this.#copyDipoFiles(box, null, web.caFile);
    const proxy = this.#admit(web, box, this.#localPorts(this.#runDirOf(input.runId)));
    const run = (cacheEnv: Readonly<Record<string, string>>): Promise<BoxInstallResult> =>
      runBoxInstall(
        {
          boxes: this.#deps.boxes,
          clock: this.#deps.code.clock,
          ...(this.#deps.warn === undefined ? {} : { warn: this.#deps.warn }),
        },
        {
          box,
          commands: input.commands,
          env: {
            ...BOX_IMAGE_ENV,
            ...input.env,
            ...cacheEnv,
            HTTPS_PROXY: proxy,
            HTTP_PROXY: proxy,
            NODE_EXTRA_CA_CERTS: BOX_CA_FILE,
          },
          timeoutMs: input.timeoutMs,
        },
      );
    const manager = this.#cached.get(input.runId);
    let result: BoxWorkerInstall = await run(manager === undefined ? {} : boxCacheEnv(manager));
    // A second try only helps in a box that still runs and was not ended at the deadline.
    if (
      manager !== undefined &&
      !result.ok &&
      result.ended === null &&
      result.boxStopped !== true
    ) {
      this.#deps.warn?.("the install from the package cache failed; running it without the cache", {
        run: input.runId,
        box,
        reason: result.reason,
        output: result.output,
      });
      result = { ...(await run({})), cacheFallback: result.reason };
    }
    if (result.ok) {
      this.#deps.info?.("the install in the box passed", {
        run: input.runId,
        box,
        packageCache: manager !== undefined && result.cacheFallback === undefined,
      });
    } else {
      this.#deps.warn?.("the install in the box failed", {
        run: input.runId,
        box,
        reason: result.reason,
        ended: result.ended,
        output: result.output,
      });
    }
    return result;
  }

  /**
   * The web route of box `runId` (DIPO-309: a test box's setup and `dev`): acquired for the box,
   * the box firewall set to that route's port only, the Safe-Chain CA bundle copied in; returns
   * the environment the box's commands get, as an install does (a test box keeps its one
   * admission, `#admit`). Throws a `BoxError` when the route does not start or the firewall cannot
   * be set.
   */
  async route(runId: string): Promise<Readonly<Record<string, string>>> {
    const box = boxName(runId);
    const web = await this.#web.acquire(box);
    await this.#firewall(box, web, null);
    await this.#copyDipoFiles(box, null, web.caFile);
    const proxy = this.#admit(web, box, this.#localPorts(this.#runDirOf(runId)));
    return {
      ...BOX_IMAGE_ENV,
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      NODE_EXTRA_CA_CERTS: BOX_CA_FILE,
    };
  }

  /**
   * The way into test box `runId` (DIPO-309): its firewall set again to the web route's port plus,
   * coming in, the Mac's address on the box network on `ports` only (`firewall.ts`, `inbound`).
   * Nothing else changes: no admission, no file. Refuses any box but a test box, so no developer or
   * reviewer box ever answers the Mac.
   */
  async inbound(runId: string, ports: readonly number[]): Promise<void> {
    if (!runId.startsWith(TEST_BOX_RUN_PREFIX)) {
      throw new BoxError(
        "box.refused",
        `only a test box answers the Mac; ${runId} is none.`,
        false,
        {
          runId,
        },
      );
    }
    const box = boxName(runId);
    await this.#firewall(box, await this.#web.acquire(box), ports);
  }

  /** Sets the firewall of `box`: the web route's port out, and `inbound` in when given. */
  async #firewall(
    box: string,
    web: RunningBoxWebRoute,
    inbound: readonly number[] | null,
  ): Promise<void> {
    const network = await this.#networkOf();
    await this.#deps.boxes.firewall(box, {
      hostAddress: network.hostAddress,
      ports: [portOf(web.url)],
      ...(inbound === null ? {} : { inbound }),
    });
  }

  /**
   * The office's verify in the run's box at done (0002, DIPO-346): each command list as the box
   * user, in `/work` or the folder below it `cwd` names, with `env` plus the box's web route and
   * the CA bundle, as a session gets them, within `timeoutMs` each (`runBoxVerify`). The
   * developer's session runs, so its box firewall and dipo's files are in place and stay as they
   * are. Never throws; a box that cannot run it is a `failed` result. A test box's `setup`
   * (DIPO-309) runs the same way, with `step` naming it in the log.
   */
  async verify(input: {
    readonly runId: string;
    readonly commands: readonly (readonly string[])[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly step?: "verify" | "setup";
  }): Promise<BoxVerifyResult> {
    const box = boxName(input.runId);
    let proxy: string;
    try {
      const web = await this.#web.acquire(box);
      proxy = this.#admit(web, box, this.#localPorts(this.#runDirOf(input.runId)));
    } catch (error) {
      return { kind: "failed", reason: `the box's web route is not there (${codeOf(error)})` };
    }
    const result = await runBoxVerify(
      {
        boxes: this.#deps.boxes,
        clock: this.#deps.code.clock,
        ...(this.#deps.warn === undefined ? {} : { warn: this.#deps.warn }),
      },
      {
        box,
        commands: input.commands,
        cwd: input.cwd,
        env: {
          ...BOX_IMAGE_ENV,
          ...input.env,
          HTTPS_PROXY: proxy,
          HTTP_PROXY: proxy,
          NODE_EXTRA_CA_CERTS: BOX_CA_FILE,
        },
        timeoutMs: input.timeoutMs,
      },
    );
    const fields = { run: input.runId, box, kind: result.kind };
    const step = input.step ?? "verify";
    if (result.kind === "red") {
      this.#deps.warn?.(`the ${step} in the box is red`, { ...fields, command: result.command });
    } else if (result.kind === "failed") {
      this.#deps.warn?.(`the ${step} in the box could not run`, {
        ...fields,
        reason: result.reason,
      });
    } else {
      this.#deps.info?.(`the ${step} in the box ran`, fields);
    }
    return result;
  }

  /**
   * What the run's box `/work` holds besides the start commit (DIPO-294), checked after the
   * install and before the worker: compared on dipo's own copy (`BoxWorkersDeps.treeCheck`); not
   * known without it. The run directory goes with it, so the check reads the listed files `create`
   * recorded (DIPO-290).
   */
  changedSinceStart(input: Omit<PartRun, "box" | "runDir">): Promise<StartTreeCheck> {
    const check = this.#deps.treeCheck;
    if (check === undefined) {
      return Promise.resolve({
        kind: "unknown",
        reason: "this daemon cannot compare the box's files with the start commit",
      });
    }
    const runDir = this.#runDirOf(input.runId);
    return check({
      ...input,
      box: boxName(input.runId),
      ...(runDir === undefined ? {} : { runDir }),
    });
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

  /**
   * The proxy URL of `box` on the web route `web`. A test box (DIPO-309) is admitted once per route:
   * its install, its setup and its `dev` share one password, since each admission ends the one
   * before and `dev` keeps running with the URL it started with. Every other box is admitted again.
   */
  #admit(web: RunningBoxWebRoute, box: string, ports: readonly number[]): string {
    const test = runIdOfBox(box)?.startsWith(TEST_BOX_RUN_PREFIX) === true;
    const kept = test ? this.#admitted.get(box) : undefined;
    if (kept !== undefined && kept.route === web) return kept.proxy;
    const proxy = web.admit(box, ports);
    if (test) this.#admitted.set(box, { route: web, proxy });
    return proxy;
  }

  async #release(name: string): Promise<void> {
    this.#admitted.delete(name);
    await this.#web.release(name).catch(() => undefined);
    await this.#model.release(name).catch(() => undefined);
  }

  /** Marks the run's record finished and drops it from the index. */
  #forget(runId: string, name: string): void {
    this.#cached.delete(runId);
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
        ...(record?.files === undefined ? {} : { files: record.files }),
        ...(record?.localPorts === undefined ? {} : { localPorts: record.localPorts }),
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
   * Finishes the box of every indexed run whose claim ended (`ended` says true: merge, drop or
   * discard, its worker hosts exited), and stops the box of every run that waits (`BOX_WAITING`,
   * DIPO-278); false is a run still going, null a run no loaded office knows (left alone).
   * With `listBoxes` (daemon start) also every box the backend lists, and the fill boxes a stopped daemon left are deleted. A pass waits for the one before it, so each run is
   * finished and reported by one pass. Never rejects; resolves to the run ids it finished, without
   * those whose finish failed (they stay in the index for the next pass).
   */
  finishEnded(ended: (runId: string) => BoxEnded, options: BoxPassOptions = {}): Promise<string[]> {
    const pass = this.#pass.then(() => this.#finishEndedPass(ended, options));
    this.#pass = pass.catch(() => undefined);
    return pass;
  }

  async #finishEndedPass(
    ended: (runId: string) => BoxEnded,
    options: BoxPassOptions,
  ): Promise<string[]> {
    const runs = new Set(this.pending());
    // The second layer (daemon start): every dipo box the backend lists, in case the index lost
    // one. Only where boxes ran before, so a daemon that never made a box never calls the backend.
    if (options.listBoxes === true && existsSync(this.#index)) {
      const fills: string[] = [];
      try {
        for (const box of await this.#deps.boxes.list()) {
          if (
            box.runId.startsWith(FILL_BOX_RUN_PREFIX) ||
            box.runId.startsWith(BUILD_BOX_RUN_PREFIX) ||
            box.runId.startsWith(SAFE_CHAIN_BOX_RUN_PREFIX)
          ) {
            fills.push(box.name);
          } else {
            runs.add(box.runId);
            this.#indexAgain(box.runId, ended, options.runDirOf);
          }
        }
      } catch (error) {
        this.#deps.warn?.("listing the boxes failed", { reason: messageOf(error) });
      }
      await this.#deleteLeftFills(fills);
    }
    const finished: string[] = [];
    for (const runId of runs) {
      const state = ended(runId);
      if (state === BOX_WAITING) {
        // The story waits: its box stops, files kept, until its next session (DIPO-278).
        if (!this.#finishing.has(runId)) await this.#within(this.rest(runId), runId, "stop");
        continue;
      }
      if (state !== true) continue;
      const outcome = await this.#within(this.finish(runId), runId, "end");
      if (outcome !== null && outcome.kind !== "failed") finished.push(runId);
    }
    return finished;
  }

  /**
   * `work` (a `finish` or a `rest`), or null once `BOX_FINISH_WAIT_MS` passed; the work itself goes
   * on then, and a later pass waits for it again.
   */
  async #within<T>(
    work: Promise<T>,
    runId: string,
    what: "end" | "stop" | "session",
    waitMs: number = this.#deps.finishWaitMs ?? BOX_FINISH_WAIT_MS,
  ): Promise<T | null> {
    const { clock } = this.#deps.code;
    let timer: ReturnType<typeof clock.setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = clock.setTimeout(() => resolve(null), waitMs);
    });
    try {
      const outcome = await Promise.race([work, late]);
      if (outcome === null) {
        const message =
          what === "end"
            ? "the end of a box run did not finish in time; a later pass waits again"
            : what === "stop"
              ? "the stop of a waiting box did not finish in time; a later pass waits again"
              : "a session waited too long for the stop of its box; it is refused";
        this.#deps.warn?.(message, { run: runId, waitMs });
      }
      return outcome;
    } finally {
      if (timer !== undefined) clock.clearTimeout(timer);
    }
  }

  /**
   * Writes the index entry of a listed box again when the index lost it and an office knows its
   * run, and the run directory's record names the run. Never throws.
   */
  #indexAgain(
    runId: string,
    ended: (runId: string) => BoxEnded,
    runDirOf: BoxPassOptions["runDirOf"],
  ): void {
    if (runDirOf === undefined || existsSync(this.#indexFile(runId))) return;
    try {
      if (ended(runId) === null) return;
      const runDir = runDirOf(runId);
      if (runDir === null || readBoxRun(runDir)?.runId !== runId) return;
      writeJson(this.#indexFile(runId), { runDir });
      this.#deps.info?.("wrote the index entry of a listed box again", { run: runId });
    } catch (error) {
      this.#deps.warn?.("writing the index entry of a listed box failed", {
        run: runId,
        reason: messageOf(error),
      });
    }
  }

  /**
   * Deletes the listed fill boxes and build boxes no fill or build here uses: a stopped daemon
   * left them mid-fill or mid-build.
   */
  async #deleteLeftFills(fills: readonly string[]): Promise<void> {
    for (const name of fills) {
      if (this.#filling.has(name)) continue;
      try {
        await this.#deps.boxes.delete(name);
        this.#deps.info?.("deleted a fill box a stopped daemon left", { box: name });
      } catch (error) {
        this.#deps.warn?.("deleting a fill box a stopped daemon left failed", {
          box: name,
          reason: messageOf(error),
        });
      }
    }
  }

  /**
   * Daemon stop: stops every indexed box that runs, which ends the worker inside it (its host
   * then records the exit), and stops the routes. The boxes keep their files for the run's next
   * session. A test box keeps running (DIPO-309): its product serves the open test, which the next
   * daemon takes up again. Never rejects.
   */
  async close(): Promise<void> {
    this.#door?.close();
    const pending = new Set(
      this.pending()
        .filter((runId) => !runId.startsWith(TEST_BOX_RUN_PREFIX))
        .map((runId) => boxName(runId)),
    );
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
