// The office package cache (0021 section 5 and decision 13, DIPO-267): one per office, filled by
// dipo from the lockfile through Safe-Chain, and read-only inside the boxes.
//
// - The lockfile, and the `package.json` files a frozen install checks it against, are read from
//   the base branch's git objects (`readBaseLockfile`), never from a story's checkout, so a story
//   cannot change what the next box gets. `checkFillInput` refuses what is not a registry package
//   or leaves the project before any box starts.
// - No package manager runs on the Mac. The fill runs in a short-lived fill box, `dipo-fill-<id>`:
//   the office image (DIPO-266, with the toolchain, no git and no keys), on the host-only box
//   network, with no package cache mounted. Its only way out is the web route (DIPO-268), acquired
//   once the box runs, so the registries are reached only through the web proxy and Safe-Chain.
//   Only the lockfile and the manifests are copied in; the install runs with lifecycle scripts
//   off, into the manager's cache inside the box. The cache is copied out into a `.fill-*` folder
//   on the Mac and the fill box is deleted, also on failure. Every box call has a deadline.
// - The cache leaves the fill box as one tar archive, its size checked in the box first:
//   `container copy` moves only that file, into a fresh folder, and `extractCacheArchive` unpacks
//   it on the Mac, taking only files and folders (no links) within its caps. The unpacked tree is
//   then walked with lstat (`checkCopiedTree`) as a second check.
// - A fill box that could not be deleted, or a route that could not be released, is reported
//   through `onEvent` and in the details of the fill's error.
// - The cache shape is the manager's own, so a box installs from it as from any cache: Bun's
//   install cache (`BUN_INSTALL_CACHE_DIR`), npm's cache (`_cacache`) and pnpm's store. Each lies in
//   a folder named after its manager inside one generation folder, the folder a box mounts
//   read-only at `BOX_PACKAGE_CACHE_PATH` (`boxCacheInstall`).
// - One generation per cache key: a sha256 of the lockfile's name and text, the in-box manager's
//   version and the cache format. The generation folder is named by the key and holds a stamp
//   (`PACKAGE_CACHE_STAMP`) with the lockfile's sha256, written last. An unchanged lockfile reuses
//   its generation; a changed one fills a new generation before the next box starts. A generation
//   is renamed into place only when the fill succeeded, so a box never mounts a half-filled cache,
//   and a box still running on an older generation keeps it unchanged.
// - Any failure refuses the box with a coded `BoxError`: `box.cacheUnsupported`,
//   `box.cacheFillFailed` or `box.cacheOutsideRoot`. `createBoxWithPackageCache` never creates a
//   box without its cache.
// - Before a box is created, the cache path is resolved with realpath and refused unless it lies
//   under dipo's own cache root (`resolvePackageCacheMount`), so a symlink cannot point the
//   read-only mount anywhere else. The root must be this user's and writable by no one else.
// - A worker's own installs use the package manager's default cache in the box's own filesystem,
//   through the web route and Safe-Chain; nothing in the worker's environment names the cache.

import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, posix } from "node:path";

import type { OfficeGit } from "../git/office";
import { isCertificateBundle } from "../sandbox/safe-chain-proxy";
import { LOCKFILES, PNPM_WORKSPACE, ROOT_MANIFEST } from "../scan/detect/manifest";
import {
  type BaseLockfile,
  type CacheManager,
  checkFillInput,
  isProjectPath,
  type ProjectFile,
} from "./cache-input";
import {
  CACHE_ARCHIVE_LIMITS,
  type CacheArchiveLimits,
  extractCacheArchive,
} from "./cache-extract";
import { baseCommit, type BoxToolchain, filesAt } from "./image";
import {
  BOX_PACKAGE_CACHE_PATH,
  BoxError,
  type BoxCallOptions,
  type BoxPort,
  type BoxSpec,
  boxName,
} from "./port";

export type { BaseLockfile, CacheManager, ProjectFile } from "./cache-input";

/** The lockfiles dipo fills a cache from, in the scan's order (0013 section 3). */
export const CACHE_LOCKFILES: Readonly<Record<string, CacheManager>> = {
  "bun.lock": "bun",
  "pnpm-lock.yaml": "pnpm",
  "package-lock.json": "npm",
};

/** The stamp in each generation folder, written last: what the generation was filled from. */
export const PACKAGE_CACHE_STAMP = "dipo-cache.json";
/** Bumped when the cache layout changes, so every office refills. */
export const PACKAGE_CACHE_FORMAT = 2;
/** The deadline of the install in the fill box: a cold cache downloads every package. */
export const PACKAGE_CACHE_FILL_TIMEOUT_MS = 20 * 60_000;
/** The deadline of copying the filled cache out of the fill box. */
export const PACKAGE_CACHE_COPY_TIMEOUT_MS = 10 * 60_000;
/** The most `package.json` files a fill copies from the base commit. */
export const PACKAGE_CACHE_MAX_MANIFESTS = 2_000;
/** The tar archive the fill box packs its cache into, in the box and in the `.fill-*` folder. */
export const FILL_ARCHIVE = "cache.tar";
/** Where the fill works inside the fill box. */
export const FILL_BOX_DIR = "/tmp/dipo-fill";
/** The fill box's run id prefix: its box is `dipo-fill-<id>`. */
export const FILL_BOX_RUN_PREFIX = "fill-";
/** How much of a failed fill's output its error keeps. */
const FAILED_OUTPUT_CHARS = 4_000;

function unsupported(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new BoxError("box.cacheUnsupported", message, false, details);
}

function fillFailed(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new BoxError("box.cacheFillFailed", message, false, details);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      if (type !== "blob" || (mode !== "100644" && mode !== "100755") || !isProjectPath(path)) {
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
    const files: ProjectFile[] = [];
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
 * The version of `manager` in the office image: Bun's and pnpm's own, npm's by the Node.js release
 * it comes with. Null when the image has no such manager.
 */
export function managerVersion(manager: CacheManager, toolchain: BoxToolchain): string | null {
  if (manager === "npm") return `node-${toolchain.node}`;
  return toolchain[manager] ?? null;
}

/**
 * The cache key of a lockfile: what names its generation folder. It changes when the lockfile's
 * name or text, the in-box manager's version or the cache format changes, and nothing else.
 */
export function packageCacheKey(
  lockfile: BaseLockfile["lockfile"],
  version: string | null,
): string {
  return sha256(
    JSON.stringify({
      format: PACKAGE_CACHE_FORMAT,
      lockfile: lockfile === null ? null : lockfile.name,
      lockfileSha256: lockfile === null ? null : lockfileHash(lockfile.text),
      managerVersion: lockfile === null ? null : version,
    }),
  );
}

/** The stamp of a filled generation. */
export interface PackageCacheStamp {
  readonly format: number;
  readonly key: string;
  readonly manager: CacheManager | null;
  readonly managerVersion: string | null;
  readonly lockfile: string | null;
  readonly lockfileSha256: string | null;
  readonly commit: string;
}

/** The web route of the boxes (`BoxWebRoute` of `startBoxWebRoute`), as the fill uses it. */
export interface FillRoute {
  /** Starts the route for `box` when it is the first user; the box must be running. */
  acquire(box: string): Promise<{ readonly url: string; readonly caFile: string }>;
  release(box: string): Promise<void>;
}

/** The box calls a fill makes. */
export type FillBoxes = Pick<
  BoxPort,
  "network" | "create" | "start" | "delete" | "exec" | "copyIn" | "copyOut"
>;

/** The office image the fill box runs (`ensureBoxImage` of `readBaseBox`'s description). */
export interface PackageCacheImage {
  readonly tag: string;
  readonly toolchain: BoxToolchain;
}

export interface PackageCacheRequest {
  /** dipo's own cache root for the office, under dipo's data folder; made 0700 when missing. */
  readonly root: string;
  readonly source: BaseLockfile;
  readonly boxes: FillBoxes;
  readonly image: PackageCacheImage;
  readonly route: FillRoute;
  /** The fill box's id; random by default. */
  readonly fillId?: () => string;
  /** The install's deadline; `PACKAGE_CACHE_FILL_TIMEOUT_MS` by default. */
  readonly timeoutMs?: number;
  /** Reports a fill box that could not be deleted or a route that could not be released. */
  readonly onEvent?: (event: PackageCacheEvent) => void;
  /** Overrides the caps of the cache archive (`CACHE_ARCHIVE_LIMITS`). */
  readonly archiveLimits?: Partial<CacheArchiveLimits>;
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

/** The install a fill box runs: scripts off, into the manager's cache in the box. */
export interface FillInstall {
  readonly command: readonly [string, ...string[]];
  readonly env: Readonly<Record<string, string>>;
  /** The cache folder in the fill box. */
  readonly cacheDir: string;
  /** The tar archive of that folder in the fill box, the one file copied out. */
  readonly archive: string;
  /** Packs the cache folder into `archive`; hard links are stored as files. */
  readonly pack: readonly [string, ...string[]];
}

/** The fill install of `manager`, through the web route at `proxyUrl`. */
export function fillInstall(manager: CacheManager, proxyUrl: string): FillInstall {
  const cacheDir = `${FILL_BOX_DIR}/cache/${manager}`;
  const caFile = `${FILL_BOX_DIR}/ca.pem`;
  const archive = `${FILL_BOX_DIR}/${FILL_ARCHIVE}`;
  const packing = {
    cacheDir,
    archive,
    pack: ["tar", "--hard-dereference", "-C", `${FILL_BOX_DIR}/cache`, "-cf", archive, manager] as [
      string,
      ...string[],
    ],
  };
  const env = {
    https_proxy: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    NODE_EXTRA_CA_CERTS: caFile,
    npm_config_https_proxy: proxyUrl,
    npm_config_ignore_scripts: "true",
    pnpm_config_ignore_scripts: "true",
    npm_config_update_notifier: "false",
    DO_NOT_TRACK: "1",
  };
  switch (manager) {
    case "bun":
      return {
        command: [
          "bun",
          "install",
          "--frozen-lockfile",
          "--ignore-scripts",
          `--cache-dir=${cacheDir}`,
          `--cafile=${caFile}`,
        ],
        env,
        ...packing,
      };
    case "npm":
      return {
        command: [
          "npm",
          "ci",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          `--cache=${cacheDir}`,
        ],
        env,
        ...packing,
      };
    case "pnpm":
      // `pnpm fetch` reads only the lockfile and runs no scripts.
      return { command: ["pnpm", "fetch", `--store-dir=${cacheDir}`], env, ...packing };
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

/**
 * Makes the cache root (0700) when missing and returns its real path. Refuses a root that is not a
 * folder, not this user's, or writable by its group or others.
 */
async function realRoot(root: string): Promise<string> {
  if (!root.startsWith("/")) {
    fillFailed("the package cache root must be an absolute path.", { root });
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const real = await realpath(root);
  const info = await lstat(real);
  if (!info.isDirectory()) fillFailed("the package cache root is not a folder.", { root });
  const uid = process.getuid?.() ?? info.uid;
  if (info.uid !== uid || (info.mode & 0o022) !== 0) {
    fillFailed("the package cache root must be this user's and writable by no one else.", {
      root,
      mode: (info.mode & 0o777).toString(8),
    });
  }
  return real;
}

/** The refusal of a copied-out cache that holds `path`. */
function copiedTreeError(path: string, why: string): BoxError {
  return new BoxError(
    "box.cacheFillFailed",
    `the copied package cache holds ${path}, ${why}.`,
    false,
    { path },
  );
}

/**
 * Walks a copied-out cache with lstat: only files, folders and symlinks that are relative and
 * resolve, with realpath, inside `base`. Refuses anything else with `box.cacheFillFailed`.
 */
export async function checkCopiedTree(base: string): Promise<void> {
  const realBase = await realpath(base);
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir)) {
      const path = join(dir, entry);
      const info = await lstat(path);
      if (info.isDirectory()) await walk(path);
      else if (info.isSymbolicLink()) {
        const target = await readlink(path);
        if (isAbsolute(target))
          throw copiedTreeError(path, `a symlink to the absolute path ${target}`);
        const resolved = await realpath(path).catch(() => null);
        if (resolved === null) throw copiedTreeError(path, "a symlink that resolves to nothing");
        if (resolved !== realBase && !resolved.startsWith(`${realBase}/`)) {
          throw copiedTreeError(path, "a symlink that resolves outside the cache");
        }
      } else if (!info.isFile())
        throw copiedTreeError(path, "neither a file, a folder nor a symlink");
    }
  };
  await walk(realBase);
}

/** A clean-up step of a fill box that failed: the box may be left, or the route held. */
export interface FillCleanupFailure {
  readonly step: "routeRelease" | "boxDelete";
  readonly reason: string;
}

/** What a fill reports besides its result. */
export type PackageCacheEvent = {
  readonly kind: "fillCleanupFailed";
  /** The fill box, `dipo-fill-<id>`; after a failed `boxDelete` it may still exist. */
  readonly box: string;
} & FillCleanupFailure;

/** `failure` with the failed clean-up steps in its details, so a left fill box is visible. */
function withCleanup(failure: unknown, cleanup: readonly FillCleanupFailure[]): unknown {
  if (cleanup.length === 0) return failure;
  if (failure instanceof BoxError) {
    return new BoxError(failure.code, failure.message, failure.retryable, {
      ...failure.details,
      cleanup,
    });
  }
  return new BoxError(
    "box.cacheFillFailed",
    `the package cache could not be filled: ${messageOf(failure)}`,
    false,
    { cleanup },
  );
}

/** The fresh folder in `<work>` the archive is copied into, and nothing else. */
const ARCHIVE_FOLDER = "archive";

/** The caps of the request's cache archive: dipo's, with any the request names. */
function archiveLimits(request: PackageCacheRequest): CacheArchiveLimits {
  return { ...CACHE_ARCHIVE_LIMITS, ...request.archiveLimits };
}

/**
 * Runs the fill in a fill box and copies the manager's cache out as one tar archive, to
 * `<work>/ARCHIVE_FOLDER/FILL_ARCHIVE`; `extractCacheArchive` unpacks it on the Mac.
 */
async function fillInBox(
  request: PackageCacheRequest,
  manager: CacheManager,
  files: readonly ProjectFile[],
  work: string,
): Promise<void> {
  const { boxes } = request;
  const project = join(work, "project");
  await mkdir(project, { mode: 0o700 });
  for (const file of files) {
    const to = join(project, file.path);
    await mkdir(dirname(to), { recursive: true, mode: 0o755 });
    await writeFile(to, file.text, { flag: "wx", mode: 0o644 });
  }
  const id = request.fillId?.() ?? randomUUID().replaceAll("-", "").slice(0, 16);
  const name = boxName(`${FILL_BOX_RUN_PREFIX}${id}`);
  const network = await boxes.network();
  let routing = false;
  let failure: { readonly error: unknown } | null = null;
  try {
    // No package cache is mounted into the fill box.
    await boxes.create({ runId: `${FILL_BOX_RUN_PREFIX}${id}`, image: request.image.tag, network });
    await boxes.start(name);
    // The route listens on the box network's host address, which exists only while a box runs.
    // It is released whatever `acquire` did, so a reference it took before failing is dropped.
    routing = true;
    const route = await request.route.acquire(name);
    const ca = await readFile(route.caFile, "utf8").catch(() => "");
    if (!isCertificateBundle(ca)) {
      fillFailed("the web route's CA bundle is not PEM certificates.", { caFile: route.caFile });
    }
    const caFile = join(work, "ca.pem");
    await writeFile(caFile, ca, { flag: "wx", mode: 0o644 });
    const made = await boxes.exec(name, ["mkdir", "-p", `${FILL_BOX_DIR}/cache`]);
    if (made.code !== 0) fillFailed("the fill box could not make its work folder.", { ...made });
    await boxes.copyIn(name, project, `${FILL_BOX_DIR}/project`);
    await boxes.copyIn(name, caFile, `${FILL_BOX_DIR}/ca.pem`);
    const install = fillInstall(manager, route.url);
    const result = await boxes.exec(name, install.command, {
      cwd: `${FILL_BOX_DIR}/project`,
      env: install.env,
      timeoutMs: request.timeoutMs ?? PACKAGE_CACHE_FILL_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      const output = `${result.stdout}${result.stderr}`.trim().slice(-FAILED_OUTPUT_CHARS);
      fillFailed(
        `${manager} could not fill the package cache in the fill box (exit ${result.code}): ${output}`,
        { manager, code: result.code, output },
      );
    }
    const packed = await boxes.exec(name, install.pack, {
      timeoutMs: PACKAGE_CACHE_COPY_TIMEOUT_MS,
    });
    if (packed.code !== 0) {
      fillFailed(`the fill box could not pack its ${manager} cache: ${packed.stderr.trim()}`, {
        manager,
        code: packed.code,
      });
    }
    const limit = archiveLimits(request).maxArchiveBytes;
    const sized = await boxes.exec(name, ["stat", "-c", "%s", install.archive]);
    const size = /^\d+$/.test(sized.stdout.trim()) ? Number(sized.stdout.trim()) : Number.NaN;
    if (sized.code !== 0 || !Number.isSafeInteger(size)) {
      fillFailed("the fill box could not tell the size of its cache archive.", { ...sized });
    }
    if (size > limit) {
      fillFailed(`the cache archive is ${size} bytes, more than ${limit}.`, { size, limit });
    }
    // One file crosses to the Mac, into a fresh folder; `extractCacheArchive` checks it is a
    // regular file before it reads it.
    await mkdir(join(work, ARCHIVE_FOLDER), { mode: 0o700 });
    await boxes.copyOut(name, install.archive, join(work, ARCHIVE_FOLDER, FILL_ARCHIVE), {
      timeoutMs: PACKAGE_CACHE_COPY_TIMEOUT_MS,
    });
  } catch (error) {
    failure = { error };
  }
  const cleanup: FillCleanupFailure[] = [];
  if (routing) {
    await request.route
      .release(name)
      .catch((error: unknown) => cleanup.push({ step: "routeRelease", reason: messageOf(error) }));
  }
  await boxes
    .delete(name)
    .catch((error: unknown) => cleanup.push({ step: "boxDelete", reason: messageOf(error) }));
  for (const step of cleanup) request.onEvent?.({ kind: "fillCleanupFailed", box: name, ...step });
  if (failure !== null) throw withCleanup(failure.error, cleanup);
}

/** Fills generation `key` in a temporary folder and renames it into place. */
async function fill(
  request: PackageCacheRequest,
  files: readonly ProjectFile[],
  root: string,
  key: string,
  version: string | null,
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
      const hostCache = join(cacheOut, lockfile.manager);
      await fillInBox(request, lockfile.manager, files, work);
      await extractCacheArchive(join(work, ARCHIVE_FOLDER), cacheOut, archiveLimits(request));
      if (!(await lstat(hostCache).catch(() => null))?.isDirectory()) {
        fillFailed(`${lockfile.manager} left no package cache to copy out.`, {
          manager: lockfile.manager,
        });
      }
      await checkCopiedTree(cacheOut);
    }
    const lockfileSha256 = lockfile === null ? null : lockfileHash(lockfile.text);
    const stamp: PackageCacheStamp = {
      format: PACKAGE_CACHE_FORMAT,
      key,
      manager: lockfile?.manager ?? null,
      managerVersion: version,
      lockfile: lockfile?.name ?? null,
      lockfileSha256,
      commit: source.commit,
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

/** Fills in flight, by root and key: a second box start waits for the first fill. */
const filling = new Map<string, Promise<PackageCache>>();

/**
 * The office's package cache for `request.source`: its generation reused when the lockfile did
 * not change, filled in a fill box otherwise. The input checks run first, before any box. Any
 * failure is a `BoxError` coded `box.cacheUnsupported` or `box.cacheFillFailed`; nothing
 * half-filled is left to mount.
 */
export function ensurePackageCache(request: PackageCacheRequest): Promise<PackageCache> {
  const { lockfile } = request.source;
  let files: readonly ProjectFile[];
  let version: string | null = null;
  try {
    files = checkFillInput(request.source);
    if (lockfile !== null) {
      version = managerVersion(lockfile.manager, request.image.toolchain);
      if (version === null) {
        unsupported(`the office image has no ${lockfile.manager} to fill the cache with.`, {
          manager: lockfile.manager,
        });
      }
    }
  } catch (error) {
    return Promise.reject(error);
  }
  const key = packageCacheKey(lockfile, version);
  // Registered before the first await, so two box starts never fill one generation twice.
  const id = `${request.root}\0${key}`;
  const pending = filling.get(id);
  if (pending !== undefined) return pending;
  const started = reuseOrFill(request, files, key, version)
    .catch((error: unknown) => {
      if (error instanceof BoxError && error.code.startsWith("box.cache")) throw error;
      fillFailed(`the package cache could not be filled: ${messageOf(error)}`, {
        key,
        ...(error instanceof BoxError ? { cause: error.code } : {}),
      });
    })
    .finally(() => filling.delete(id));
  filling.set(id, started);
  return started;
}

async function reuseOrFill(
  request: PackageCacheRequest,
  files: readonly ProjectFile[],
  key: string,
  version: string | null,
): Promise<PackageCache> {
  const root = await realRoot(request.root);
  const dir = join(root, key);
  const stamp = await readStamp(dir, key);
  if (stamp === null) return fill(request, files, root, key, version);
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
  /** Makes the fill box when the cache needs filling, and the box itself. */
  readonly boxes: FillBoxes;
  readonly spec: Omit<BoxSpec, "packageCache">;
  /** Reads the base lockfile; `readBaseLockfile` of the office git. */
  readonly readSource: () => Promise<BaseLockfile>;
  readonly cache: Omit<PackageCacheRequest, "source" | "boxes">;
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
  const cache = await ensurePackageCache({ ...request.cache, source, boxes: request.boxes });
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
 * installs of the worker use the manager's default cache in the box. pnpm writes to its store
 * only for new packages and for its side-effects cache; offline there are no new packages, and
 * the side-effects cache is set read-only (both setting prefixes: pnpm 10 reads `npm_config_`,
 * pnpm 11 `pnpm_config_`).
 */
export function boxCacheInstall(manager: CacheManager): BoxCacheInstall {
  const cache = posix.join(BOX_PACKAGE_CACHE_PATH, manager);
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
        env: {
          npm_config_side_effects_cache_readonly: "true",
          pnpm_config_side_effects_cache_readonly: "true",
        },
      };
  }
}
