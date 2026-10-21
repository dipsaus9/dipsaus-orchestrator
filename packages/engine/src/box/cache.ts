// The office package cache (0021 section 5 and decision 13, DIPO-267): one per office, filled by
// dipo from the lockfile through Safe-Chain, outside any box, and read-only inside the boxes.
//
// - The lockfile, and the `package.json` files a frozen install checks it against, are read from
//   the base branch's git objects (`readBaseLockfile`), never from a story's checkout, so a story
//   cannot change what the next box gets. The repository's `.npmrc` and `bunfig.toml` are never
//   read: the fill runs in a folder holding only what dipo wrote there.
// - The fill runs the office's package manager on the Mac with its install scripts off, its home
//   and temp folders in that folder, and the network only through dipo's Safe-Chain proxy
//   (`PackageCacheProxy`). It fetches the packages of the box's platform (Linux on the Mac's CPU).
// - The cache shape is the package manager's own, so a box installs from it as from any cache:
//   Bun's install cache (`BUN_INSTALL_CACHE_DIR`), npm's cache (`_cacache`) and pnpm's store. Each
//   lies in a folder named after its manager inside one generation folder, the folder a box
//   mounts read-only at `BOX_PACKAGE_CACHE_PATH` (`boxCacheInstall`).
// - One generation per cache key: a sha256 of the lockfile's name and text and the box platform.
//   The generation folder is named by the key and holds a stamp (`PACKAGE_CACHE_STAMP`) with the
//   lockfile's sha256, written last. A lockfile that did not change reuses its generation; a
//   changed one fills a new generation before the next box starts. A generation is filled in a
//   temporary folder and renamed into place only when the fill succeeded, so a box never mounts a
//   half-filled cache, and a box still running on an older generation keeps it unchanged.
// - Any failure refuses the box with a coded `BoxError`: `box.cacheUnsupported`,
//   `box.cacheFillFailed` or `box.cacheOutsideRoot`. `createBoxWithPackageCache` never creates a
//   box without its cache.
// - Before a box is created, the cache path is resolved with realpath and refused unless it lies
//   under dipo's own cache root (`resolvePackageCacheMount`), so a symlink cannot point the
//   read-only mount anywhere else.
// - A worker's own installs use the package manager's default cache in the box's own filesystem,
//   through the web route and Safe-Chain; nothing in the worker's environment names the cache.

import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ChildProcess, Clock, Spawn, TimerHandle } from "@dipsaus-orchestrator/contract";

import type { OfficeGit } from "../git/office";
import { isCertificateBundle } from "../sandbox/safe-chain-proxy";
import { LOCKFILES, PNPM_WORKSPACE, ROOT_MANIFEST } from "../scan/detect/manifest";
import { baseCommit, filesAt } from "./image";
import {
  BOX_PACKAGE_CACHE_PATH,
  BoxError,
  type BoxCallOptions,
  type BoxPort,
  type BoxSpec,
} from "./port";

/** The package managers whose cache dipo fills. */
export type CacheManager = "bun" | "npm" | "pnpm";

/** The lockfiles dipo fills a cache from, in the scan's order (0013 section 3). */
export const CACHE_LOCKFILES: Readonly<Record<string, CacheManager>> = {
  "bun.lock": "bun",
  "pnpm-lock.yaml": "pnpm",
  "package-lock.json": "npm",
};

/** The stamp in each generation folder, written last: what the generation was filled from. */
export const PACKAGE_CACHE_STAMP = "dipo-cache.json";
/** Bumped when the cache layout changes, so every office refills. */
export const PACKAGE_CACHE_FORMAT = 1;
/** The deadline of one fill: a cold cache downloads every package of the lockfile. */
export const PACKAGE_CACHE_FILL_TIMEOUT_MS = 20 * 60_000;
/** The most `package.json` files a fill copies from the base commit. */
export const PACKAGE_CACHE_MAX_MANIFESTS = 2_000;
/** How much of a failed fill's output its error keeps. */
const FAILED_OUTPUT_CHARS = 4_000;

/** The platform of the boxes, whose packages the fill fetches. */
export interface PackageCacheTarget {
  readonly os: "linux";
  readonly cpu: "arm64" | "x64";
}

/** The boxes' platform: Linux on the Mac's own CPU. */
export function boxCacheTarget(arch: string = process.arch): PackageCacheTarget {
  return { os: "linux", cpu: arch === "x64" ? "x64" : "arm64" };
}

/** The lockfile and the project files a frozen install needs, as committed on the base. */
export interface BaseLockfile {
  /** The base commit everything was read from. */
  readonly commit: string;
  /** Null when the base has no lockfile: the cache is empty. */
  readonly lockfile: {
    readonly name: string;
    readonly manager: CacheManager;
    readonly text: string;
  } | null;
  /** Every `package.json` (outside `node_modules`) and, for pnpm, `pnpm-workspace.yaml`. */
  readonly files: readonly { readonly path: string; readonly text: string }[];
}

function unsupported(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new BoxError("box.cacheUnsupported", message, false, details);
}

function fillFailed(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new BoxError("box.cacheFillFailed", message, false, details);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A repository path dipo may write into its fill folder: relative, no `.`, `..` or empty part. */
function safeRelative(path: string): boolean {
  return (
    !path.startsWith("/") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
    !path.includes("\0")
  );
}

/**
 * Reads the lockfile and the `package.json` files from `<remote>/<base>` in git's objects, never a
 * checkout, the way `readBaseBox` reads the box. Refuses with `box.cacheUnsupported` a base whose
 * lockfile dipo cannot fill from: lockfiles of more than one package manager, `yarn.lock`, or only
 * Bun's binary `bun.lockb`. Runs one queue item of the office git.
 */
export function readBaseLockfile(git: OfficeGit): Promise<BaseLockfile> {
  return git.run(async (session) => {
    const { commit } = await baseCommit(git, session);
    const names = LOCKFILES.map(([name]) => name);
    const roots = await filesAt(session, commit, [...names, PNPM_WORKSPACE]);
    const present = LOCKFILES.filter(([name]) => roots.has(name));
    const managers = new Set(present.map(([, manager]) => manager));
    if (managers.size === 0) return { commit, lockfile: null, files: [] };
    if (managers.size > 1) {
      unsupported(
        `the base has lockfiles of more than one package manager (${present.map(([name]) => name).join(", ")}); keep one.`,
        { lockfiles: present.map(([name]) => name) },
      );
    }
    const name = present
      .map(([lockfile]) => lockfile)
      .find((found) => Object.hasOwn(CACHE_LOCKFILES, found));
    if (name === undefined) {
      unsupported(
        `dipo cannot fill a package cache from ${present.map(([found]) => found).join(", ")}; use bun.lock, pnpm-lock.yaml or package-lock.json.`,
        { lockfiles: present.map(([found]) => found) },
      );
    }
    const text = roots.get(name)?.text;
    if (text === undefined) unsupported(`${name} on the base is not a regular file.`, { name });
    const manager = CACHE_LOCKFILES[name]!;

    const listed = await session.ok(session.repository, [
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      commit,
    ]);
    const manifests: string[] = [];
    for (const entry of listed.split("\0")) {
      const tab = entry.indexOf("\t");
      if (tab < 0) continue;
      const path = entry.slice(tab + 1);
      const parts = path.split("/");
      if (parts.at(-1) !== ROOT_MANIFEST || parts.includes("node_modules")) continue;
      const [mode, type] = entry.slice(0, tab).split(" ");
      if (type !== "blob" || (mode !== "100644" && mode !== "100755") || !safeRelative(path)) {
        continue;
      }
      manifests.push(path);
    }
    if (manifests.length > PACKAGE_CACHE_MAX_MANIFESTS) {
      unsupported(
        `the base has ${manifests.length} package.json files; dipo fills a cache for at most ${PACKAGE_CACHE_MAX_MANIFESTS}.`,
        { manifests: manifests.length },
      );
    }
    const wanted = manager === "pnpm" ? [...manifests, PNPM_WORKSPACE] : manifests;
    const read = await filesAt(session, commit, wanted);
    const files: { path: string; text: string }[] = [];
    for (const path of wanted) {
      const file = read.get(path)?.text;
      if (file !== undefined) files.push({ path, text: file });
    }
    return { commit, lockfile: { name, manager, text }, files };
  });
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The sha256 of a lockfile's text, kept in the stamp of its generation. */
export function lockfileHash(text: string): string {
  return sha256(text);
}

/**
 * The cache key of a lockfile for a box platform: what names its generation folder. It changes
 * when the lockfile's name or text, the platform or the cache format changes, and nothing else.
 */
export function packageCacheKey(
  lockfile: BaseLockfile["lockfile"],
  target: PackageCacheTarget,
): string {
  return sha256(
    JSON.stringify({
      format: PACKAGE_CACHE_FORMAT,
      lockfile: lockfile === null ? null : lockfile.name,
      lockfileSha256: lockfile === null ? null : lockfileHash(lockfile.text),
      os: target.os,
      cpu: target.cpu,
    }),
  );
}

/** The stamp of a filled generation. */
export interface PackageCacheStamp {
  readonly format: number;
  readonly key: string;
  readonly manager: CacheManager | null;
  readonly lockfile: string | null;
  readonly lockfileSha256: string | null;
  readonly commit: string;
  readonly target: PackageCacheTarget;
}

/** dipo's Safe-Chain proxy, the fill's only way to the registries. */
export interface PackageCacheProxy {
  /** `http://<host>:<port>` on the Mac, as `startSafeChainProxy` opened it. */
  readonly url: string;
  /** Safe-Chain's CA bundle (PEM certificates only). */
  readonly caFile: string;
}

export interface PackageCacheRequest {
  /** dipo's own cache root for the office, under dipo's data folder; made 0700 when missing. */
  readonly root: string;
  readonly source: BaseLockfile;
  readonly proxy: PackageCacheProxy;
  /** The package manager programs on the Mac, as absolute paths. */
  readonly tools: Readonly<Partial<Record<CacheManager, string>>>;
  /** The PATH of a fill (npm and pnpm find `node` on it); nothing else of dipo's environment. */
  readonly path: string;
  readonly spawn: Spawn;
  readonly clock: Clock;
  /** Defaults to `boxCacheTarget()`. */
  readonly target?: PackageCacheTarget;
  /** Defaults to `PACKAGE_CACHE_FILL_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** A filled generation, ready to mount. */
export interface PackageCache {
  /** The generation folder, resolved with realpath, under the root. */
  readonly path: string;
  readonly key: string;
  readonly manager: CacheManager | null;
  readonly lockfileSha256: string | null;
  /** False when the generation of this lockfile already existed and was reused. */
  readonly filled: boolean;
}

const PROXY_URL = /^http:\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\]):\d{1,5}$/;

/** The fill command of one manager, writing its cache to `cacheDir`. */
export function fillCommand(input: {
  readonly manager: CacheManager;
  readonly tool: string;
  readonly cacheDir: string;
  readonly caFile: string;
  readonly proxyUrl: string;
  readonly target: PackageCacheTarget;
}): readonly [string, ...string[]] {
  const { tool, cacheDir, caFile, proxyUrl, target } = input;
  switch (input.manager) {
    case "bun":
      return [
        tool,
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        `--cache-dir=${cacheDir}`,
        `--cafile=${caFile}`,
        `--os=${target.os}`,
        `--cpu=${target.cpu}`,
      ];
    case "npm":
      return [
        tool,
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `--cache=${cacheDir}`,
        `--cafile=${caFile}`,
        `--https-proxy=${proxyUrl}`,
        `--proxy=${proxyUrl}`,
        `--os=${target.os}`,
        `--cpu=${target.cpu}`,
      ];
    case "pnpm":
      // `pnpm fetch` reads only the lockfile and runs no scripts.
      return [tool, "fetch", `--store-dir=${cacheDir}`];
  }
}

/** The fill's whole environment: its own home and temp folders, the proxy, the CA. */
export function fillEnvironment(input: {
  readonly path: string;
  readonly home: string;
  readonly tmp: string;
  readonly caFile: string;
  readonly proxyUrl: string;
}): Record<string, string> {
  return {
    PATH: input.path,
    HOME: input.home,
    TMPDIR: input.tmp,
    HTTPS_PROXY: input.proxyUrl,
    HTTP_PROXY: input.proxyUrl,
    https_proxy: input.proxyUrl,
    http_proxy: input.proxyUrl,
    NODE_EXTRA_CA_CERTS: input.caFile,
    npm_config_cafile: input.caFile,
    npm_config_https_proxy: input.proxyUrl,
    npm_config_proxy: input.proxyUrl,
    npm_config_ignore_scripts: "true",
    npm_config_update_notifier: "false",
    DO_NOT_TRACK: "1",
  };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

/** Runs the fill to its end, killed and failed at its deadline. */
async function runFill(
  child: ChildProcess,
  clock: Clock,
  timeoutMs: number,
): Promise<{ code: number | null; output: string }> {
  let timer: TimerHandle | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = clock.setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new BoxError(
          "box.cacheFillFailed",
          `the package cache fill did not finish within ${Math.round(timeoutMs / 1000)} s and was killed.`,
          false,
          { timeoutMs },
        ),
      );
    }, timeoutMs);
  });
  const finished = Promise.all([readAll(child.stdout), readAll(child.stderr), child.exited]).then(
    ([stdout, stderr, exit]) => ({ code: exit.code, output: `${stdout}${stderr}` }),
  );
  try {
    return await Promise.race([finished, timedOut]);
  } finally {
    if (timer !== undefined) clock.clearTimeout(timer);
  }
}

/** The generation's stamp when it is a complete fill of `key`; null otherwise. */
async function readStamp(dir: string, key: string): Promise<PackageCacheStamp | null> {
  try {
    const info = await lstat(dir);
    if (!info.isDirectory()) return null;
    const stamp = JSON.parse(await readFile(join(dir, PACKAGE_CACHE_STAMP), "utf8")) as unknown;
    if (typeof stamp !== "object" || stamp === null) return null;
    const read = stamp as Partial<PackageCacheStamp>;
    return read.format === PACKAGE_CACHE_FORMAT && read.key === key
      ? (read as PackageCacheStamp)
      : null;
  } catch {
    return null;
  }
}

/** Makes the cache root (0700) when missing and returns its real path; refuses anything else. */
async function realRoot(root: string): Promise<string> {
  if (!root.startsWith("/"))
    fillFailed("the package cache root must be an absolute path.", { root });
  await mkdir(root, { recursive: true, mode: 0o700 });
  const real = await realpath(root);
  if (!(await lstat(real)).isDirectory()) {
    fillFailed("the package cache root is not a folder.", { root });
  }
  return real;
}

/** Fills generation `key` in a temporary folder and renames it into place. */
async function fill(
  request: PackageCacheRequest,
  root: string,
  key: string,
  target: PackageCacheTarget,
): Promise<PackageCache> {
  const { source } = request;
  const lockfile = source.lockfile;
  const dir = join(root, key);
  // A generation without its stamp is a leftover; it is filled again from nothing.
  await rm(dir, { recursive: true, force: true });
  const work = await mkdtemp(join(root, ".fill-"));
  try {
    const cacheOut = join(work, "cache");
    // Readable to any user in the box; the box mounts it read-only.
    await mkdir(cacheOut, { mode: 0o755 });
    if (lockfile !== null) {
      const tool = request.tools[lockfile.manager];
      if (tool === undefined || !tool.startsWith("/")) {
        fillFailed(`no ${lockfile.manager} program to fill the package cache with.`, {
          manager: lockfile.manager,
        });
      }
      if (!PROXY_URL.test(request.proxy.url)) {
        fillFailed("the Safe-Chain proxy must be http://<host>:<port>.", {
          proxyUrl: request.proxy.url,
        });
      }
      const ca = await readFile(request.proxy.caFile, "utf8").catch(() => "");
      if (!isCertificateBundle(ca)) {
        fillFailed("the Safe-Chain CA bundle is not PEM certificates.", {
          caFile: request.proxy.caFile,
        });
      }
      const project = join(work, "project");
      const home = join(work, "home");
      const tmp = join(work, "tmp");
      for (const folder of [project, home, tmp]) await mkdir(folder, { mode: 0o700 });
      const caFile = join(work, "ca.pem");
      await writeFile(caFile, ca, { flag: "wx", mode: 0o600 });
      // Only the lockfile and the manifests: never the repository's .npmrc or bunfig.toml.
      for (const file of [{ path: lockfile.name, text: lockfile.text }, ...source.files]) {
        if (!safeRelative(file.path))
          fillFailed("a project file path is not safe.", { path: file.path });
        const to = join(project, file.path);
        await mkdir(dirname(to), { recursive: true, mode: 0o700 });
        await writeFile(to, file.text, { flag: "wx", mode: 0o600 });
      }
      const cacheDir = join(cacheOut, lockfile.manager);
      const cmd = fillCommand({
        manager: lockfile.manager,
        tool,
        cacheDir,
        caFile,
        proxyUrl: request.proxy.url,
        target,
      });
      let child: ChildProcess;
      try {
        child = request.spawn({
          cmd,
          cwd: project,
          env: fillEnvironment({
            path: request.path,
            home,
            tmp,
            caFile,
            proxyUrl: request.proxy.url,
          }),
        });
      } catch (error) {
        fillFailed(`${lockfile.manager} could not be started to fill the package cache.`, {
          error: messageOf(error),
        });
      }
      const result = await runFill(
        child,
        request.clock,
        request.timeoutMs ?? PACKAGE_CACHE_FILL_TIMEOUT_MS,
      );
      if (result.code !== 0) {
        const output = result.output.trim().slice(-FAILED_OUTPUT_CHARS);
        fillFailed(
          `${lockfile.manager} could not fill the package cache from ${lockfile.name} (exit ${result.code}): ${output}`,
          { manager: lockfile.manager, code: result.code, output },
        );
      }
      if (!(await lstat(cacheDir).catch(() => null))?.isDirectory()) {
        fillFailed(`${lockfile.manager} wrote no package cache.`, { manager: lockfile.manager });
      }
    }
    const lockfileSha256 = lockfile === null ? null : lockfileHash(lockfile.text);
    const stamp: PackageCacheStamp = {
      format: PACKAGE_CACHE_FORMAT,
      key,
      manager: lockfile?.manager ?? null,
      lockfile: lockfile?.name ?? null,
      lockfileSha256,
      commit: source.commit,
      target,
    };
    await writeFile(join(cacheOut, PACKAGE_CACHE_STAMP), `${JSON.stringify(stamp, null, 2)}\n`, {
      flag: "wx",
      mode: 0o644,
    });
    await rename(cacheOut, dir);
    return {
      path: await realpath(dir),
      key,
      manager: stamp.manager,
      lockfileSha256,
      filled: true,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Fills in flight, by generation folder: a second box start waits for the first fill. */
const filling = new Map<string, Promise<PackageCache>>();

/**
 * The office's package cache for `request.source`: its generation reused when the lockfile did
 * not change, filled through the Safe-Chain proxy otherwise. Any failure is a `BoxError` coded
 * `box.cacheFillFailed` (or `box.cacheUnsupported`); nothing half-filled is left to mount.
 */
export function ensurePackageCache(request: PackageCacheRequest): Promise<PackageCache> {
  const target = request.target ?? boxCacheTarget();
  const key = packageCacheKey(request.source.lockfile, target);
  // Registered before the first await, so two box starts never fill one generation twice.
  const id = `${request.root}\0${key}`;
  const pending = filling.get(id);
  if (pending !== undefined) return pending;
  const started = reuseOrFill(request, key, target)
    .catch((error: unknown) => {
      if (error instanceof BoxError) throw error;
      fillFailed(`the package cache could not be filled: ${messageOf(error)}`, { key });
    })
    .finally(() => filling.delete(id));
  filling.set(id, started);
  return started;
}

async function reuseOrFill(
  request: PackageCacheRequest,
  key: string,
  target: PackageCacheTarget,
): Promise<PackageCache> {
  const root = await realRoot(request.root);
  const dir = join(root, key);
  const stamp = await readStamp(dir, key);
  if (stamp === null) return fill(request, root, key, target);
  return {
    path: await realpath(dir),
    key,
    manager: stamp.manager,
    lockfileSha256: stamp.lockfileSha256,
    filled: false,
  };
}

/**
 * The real path of the package cache a box mounts: `path` resolved with realpath, refused with
 * `box.cacheOutsideRoot` unless it is a folder below dipo's own cache root `root` (also resolved).
 * A symlink inside the root that points out of it is refused.
 */
export async function resolvePackageCacheMount(path: string, root: string): Promise<string> {
  const refuse = (message: string): never => {
    throw new BoxError("box.cacheOutsideRoot", message, false, { path, root });
  };
  if (!path.startsWith("/") || !root.startsWith("/")) {
    refuse("the package cache and its root must be absolute paths.");
  }
  const realCacheRoot = await realpath(root).catch(() =>
    refuse("the package cache root is missing."),
  );
  const real = await realpath(path).catch(() => refuse("the package cache is missing."));
  if (!real.startsWith(`${realCacheRoot}/`)) {
    refuse(`the package cache resolves to ${real}, which is not under dipo's cache root.`);
  }
  const info = await lstat(real).catch(() => null);
  if (info === null || !info.isDirectory()) refuse("the package cache is not a folder.");
  return real;
}

/** What creating a box with its cache needs; the spec's `packageCache` comes from the fill. */
export interface BoxWithCacheRequest {
  readonly boxes: Pick<BoxPort, "create">;
  readonly spec: Omit<BoxSpec, "packageCache">;
  /** Reads the base lockfile; `readBaseLockfile` of the office git. */
  readonly readSource: () => Promise<BaseLockfile>;
  readonly cache: Omit<PackageCacheRequest, "source">;
  readonly options?: BoxCallOptions;
}

/**
 * Creates a box with the office package cache mounted read-only. The cache is refreshed first
 * when the base lockfile changed, and its path is checked under the cache root; when either
 * fails the box is refused with that coded reason and never created.
 */
export async function createBoxWithPackageCache(
  request: BoxWithCacheRequest,
): Promise<{ readonly name: string; readonly cache: PackageCache }> {
  let source: BaseLockfile;
  try {
    source = await request.readSource();
  } catch (error) {
    if (error instanceof BoxError) throw error;
    fillFailed(`the base lockfile could not be read: ${messageOf(error)}`);
  }
  const cache = await ensurePackageCache({ ...request.cache, source });
  const packageCache = await resolvePackageCacheMount(cache.path, request.cache.root);
  const name = await request.boxes.create({ ...request.spec, packageCache }, request.options);
  return { name, cache };
}

/** The install a box runs at its start, from the read-only cache, into its own filesystem. */
export interface BoxCacheInstall {
  readonly command: readonly [string, ...string[]];
  /** Set for this command only; a worker's environment never names the cache. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The box's start install of `manager`: offline, from the read-only cache, copying files into the
 * box's own `node_modules` (a link into a read-only mount would leave packages read-only). Later
 * installs of the worker use the manager's default cache in the box.
 */
export function boxCacheInstall(manager: CacheManager): BoxCacheInstall {
  const cache = `${BOX_PACKAGE_CACHE_PATH}/${manager}`;
  switch (manager) {
    case "bun":
      return {
        command: ["bun", "install", "--frozen-lockfile", "--offline", "--backend=copyfile"],
        env: { BUN_INSTALL_CACHE_DIR: cache },
      };
    case "npm":
      return {
        command: [
          "npm",
          "ci",
          "--offline",
          "--no-audit",
          "--no-fund",
          `--cache=${cache}`,
          "--logs-dir=/tmp/dipo-npm-logs",
        ],
        env: { npm_config_update_notifier: "false" },
      };
    case "pnpm":
      return {
        command: [
          "pnpm",
          "install",
          "--frozen-lockfile",
          "--offline",
          `--store-dir=${cache}`,
          "--package-import-method=copy",
        ],
        env: {},
      };
  }
}
