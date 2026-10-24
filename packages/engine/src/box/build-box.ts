// The office image, built in a box (DIPO-281, from DIPO-286; 0021 sections 3 and 5). The
// maintainer's answer of 2026-10-23: the image is built inside a box on the host-only box network,
// with the same web route as a worker box (Safe-Chain for the registries, dipo's web proxy for the
// rest), and turned into the image with `container commit`. `container build` ran on Apple
// `container`'s default network, where an install script could reach the Mac, the local network
// and the registries directly; it is no longer used for the office image.
//
// One build (`ensureBoxImage`):
// 1. An image of this description that exists, with its copy of the box network tools, is reused.
// 2. Debian's slim base image is pulled on the Mac, and a build box made from it on the box
//    network, with nothing mounted, and started. The web route is acquired for it: it listens on
//    the box network's address on the Mac, which exists only while a box on it runs.
// 3. dipo's build folder goes in: the three scripts (`boxBuildScripts`) and the route's CA bundle.
// 4. The bootstrap script runs with the box's capabilities. It runs only programs of the base
//    image and no install script, and extracts the box network tools (`firewall.ts`).
// 5. The box firewall is set: the box reaches the web route's port on the Mac and nothing else,
//    not the Mac's other services, the local network, or a registry but through Safe-Chain.
// 6. The tools are streamed out of the box and extracted into dipo's tools folder of the image
//    (`netToolsDir`), with links refused; every later box of the image mounts them read-only.
// 7. Behind the firewall (DIPO-334): the system script as one of dipo's root steps, with the root
//    allow list (Debian's signed packages, the pinned Node.js tarball, the box user and its
//    folders); then the build script as the box user, so no npm install script of the package
//    managers or Claude Code can write `/etc`, `/usr`, `/opt` or the tools; then dipo's cleanup,
//    a root step, removes the build folder and the tools' copy.
// 8. The box is stopped and committed to the image's tag (an older image of the tag is deleted
//    first), whatever the build's result the route is released and the build box deleted.
//
// A cleanup that fails is reported (`onEvent`) and never hides the build's own failure. Two
// requests for one image share one build. A build box that a stopped daemon left behind is deleted
// at the next daemon start (`BoxWorkers.finishEnded`).

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Clock } from "@dipsaus-orchestrator/contract";

import { isCertificateBundle } from "../sandbox/safe-chain-proxy";
import { extractArchive, streamFromBox } from "./cache-extract";
import { BOX_NET_TOOLS_PATH, netToolsDir, resolveNetToolsMount } from "./firewall";
import {
  BUILD_BOOTSTRAP_SCRIPT,
  BUILD_DIR_IN_BOX,
  BUILD_PROXY_ENV,
  BUILD_STEPS_SCRIPT,
  BUILD_SYSTEM_SCRIPT,
  type BoxImageDescription,
  boxBuildScripts,
  boxImageTag,
  buildCleanupCommand,
} from "./image";
import {
  BOX_BUILD_CA_FILE,
  BOX_BUILD_TIMEOUT_MS,
  BoxError,
  BUILD_BOX_RUN_PREFIX,
  type BoxCallOptions,
  type BoxPort,
  boxName,
} from "./port";

/** The box calls a build makes. */
export type BuildBoxes = Pick<
  BoxPort,
  | "hasImage"
  | "pullImage"
  | "network"
  | "create"
  | "start"
  | "stop"
  | "delete"
  | "copyIn"
  | "exec"
  | "execLive"
  | "firewall"
  | "commit"
  | "deleteImage"
>;

/** The web route of the boxes (`BoxWebRoute` of `startBoxWebRoute`), as a build uses it. */
export interface BuildRoute {
  /** Starts the route for `box` when it is the first user; the box must be running. */
  acquire(box: string): Promise<{ readonly url: string; readonly caFile: string }>;
  release(box: string): Promise<void>;
}

/** A cleanup step of a build that failed: the route's release or the build box's delete. */
export interface BuildCleanupFailure {
  readonly kind: "buildCleanupFailed";
  readonly box: string;
  readonly step: "routeRelease" | "boxDelete" | "folderRemove";
  readonly reason: string;
}

export interface BoxImageDeps {
  readonly boxes: BuildBoxes;
  readonly route: BuildRoute;
  /** dipo's private folder for build folders, outside any repository. */
  readonly scratchRoot: string;
  /** dipo's root of the box network tools (`BOX_NET_TOOLS_DIR` in its state folder). */
  readonly toolsRoot: string;
  readonly clock: Clock;
  /** The build box's id; random by default. Told before the box exists. */
  readonly buildId?: () => string;
  /** Each build step's deadline; `BOX_BUILD_TIMEOUT_MS` by default. */
  readonly timeoutMs?: number;
  readonly onEvent?: (event: BuildCleanupFailure) => void;
  readonly options?: BoxCallOptions;
  /**
   * Tests only: runs once the build box's firewall is set and its tools are out, before the install
   * steps, with the box's name and the route's address, so a real-box test can try from inside it
   * what an install script could (DIPO-281). dipo never passes it.
   */
  readonly beforeInstall?: (box: string, routeUrl: string) => Promise<void>;
}

export interface BoxImageResult {
  readonly tag: string;
  /** False when an image of this description already existed, with its tools, and was reused. */
  readonly built: boolean;
  /** The host folder of the image's box network tools, which every box of it mounts. */
  readonly netTools: string;
}

/** The caps of the box network tools archive: a loader, three programs and their libraries. */
const TOOLS_ARCHIVE_LIMITS = {
  maxArchiveBytes: 256 * 1024 * 1024,
  maxEntries: 512,
  maxTotalBytes: 256 * 1024 * 1024,
} as const;
const TOOLS_ARCHIVE = "net-tools.tar";
/** How many lines of a failed step's output its error keeps. */
export const BUILD_ERROR_LINES = 40;

function buildFailed(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new BoxError("box.buildFailed", message, false, details);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The last lines of a step's output, for its error. */
function outputTail(result: { readonly stdout: string; readonly stderr: string }): string {
  return `${result.stderr}\n${result.stdout}`
    .trim()
    .split("\n")
    .slice(-BUILD_ERROR_LINES)
    .join("\n");
}

/** True when the tools folder of `tag` exists and holds the tools. */
async function toolsReady(toolsRoot: string, tag: string): Promise<boolean> {
  try {
    await resolveNetToolsMount(netToolsDir(toolsRoot, tag), toolsRoot);
    return true;
  } catch {
    return false;
  }
}

/** The port of the web route's URL, `http://<host>:<port>`. */
function routePort(url: string): number {
  const port = Number(new URL(url).port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    buildFailed(`the web route's address ${url} names no port.`, { url });
  }
  return port;
}

/**
 * Streams the tools out of the build box and extracts them into the tools folder of `tag`: a
 * fresh folder renamed into place, so a half-written one is never mounted.
 */
async function copyToolsOut(
  deps: BoxImageDeps,
  box: string,
  tag: string,
  work: string,
): Promise<string> {
  const folder = join(work, "tools-archive");
  await mkdir(folder, { mode: 0o700 });
  const archive = await streamFromBox({
    boxes: deps.boxes,
    box,
    command: ["tar", "-cf", "-", "-C", BOX_NET_TOOLS_PATH, "ld.so", "bin", "lib"],
    folder,
    name: TOOLS_ARCHIVE,
    maxBytes: TOOLS_ARCHIVE_LIMITS.maxArchiveBytes,
    timeoutMs: deps.timeoutMs ?? BOX_BUILD_TIMEOUT_MS,
    clock: deps.clock,
    code: "box.buildFailed",
    what: "the box network tools",
  });
  await mkdir(deps.toolsRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(deps.toolsRoot);
  const stage = await mkdtemp(join(root, ".stage-"));
  try {
    await extractArchive(folder, stage, {
      limits: TOOLS_ARCHIVE_LIMITS,
      code: "box.buildFailed",
      what: "the box network tools archive",
    });
    const dest = netToolsDir(root, tag);
    await rm(dest, { recursive: true, force: true });
    await rename(stage, dest);
    return await resolveNetToolsMount(dest, root);
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(archive, { force: true });
  }
}

/** Who a build step runs as: the box's capabilities, a root step, or the box user. */
type StepPrivilege = "full" | "root" | "user";

/** The name of the cleanup step in a failed step's error. */
const CLEANUP_STEP = "cleanup";

/** Runs one step of the build in the box; a non-zero exit fails the build with its output. */
async function step(
  deps: BoxImageDeps,
  box: string,
  scriptName: string,
  url: string,
  privilege: StepPrivilege,
): Promise<void> {
  const command: [string, ...string[]] =
    scriptName === CLEANUP_STEP
      ? buildCleanupCommand()
      : ["/bin/sh", `${BUILD_DIR_IN_BOX}/${scriptName}`];
  const result = await deps.boxes.exec(box, command, {
    env: { [BUILD_PROXY_ENV]: url },
    timeoutMs: deps.timeoutMs ?? BOX_BUILD_TIMEOUT_MS,
    ...(privilege === "full" ? { fullPrivilege: true } : {}),
    ...(privilege === "root" ? { rootStep: true } : {}),
  });
  if (result.code !== 0) {
    const tail = outputTail(result);
    buildFailed(`the image build's ${scriptName} failed (exit ${result.code}): ${tail}`, {
      script: scriptName,
      code: result.code,
      tail,
    });
  }
}

async function buildInBox(
  deps: BoxImageDeps,
  image: BoxImageDescription,
  tag: string,
): Promise<BoxImageResult> {
  const { boxes } = deps;
  const options = deps.options ?? {};
  const imageExists = await boxes.hasImage(tag, options);
  if (imageExists && (await toolsReady(deps.toolsRoot, tag))) {
    return { tag, built: false, netTools: netToolsDir(await realpath(deps.toolsRoot), tag) };
  }
  const scripts = boxBuildScripts(image);
  await boxes.pullImage(scripts.base, options);
  const network = await boxes.network(options);
  const id = deps.buildId?.() ?? randomUUID().replaceAll("-", "").slice(0, 16);
  const runId = `${BUILD_BOX_RUN_PREFIX}${id}`;
  const name = boxName(runId);
  await mkdir(deps.scratchRoot, { recursive: true, mode: 0o700 });
  const work = await realpath(await mkdtemp(join(deps.scratchRoot, "box-build-")));
  let routing = false;
  let failure: { readonly error: unknown } | null = null;
  let netTools = "";
  try {
    // Nothing of the Mac is mounted into a build box, and no tools yet: it is made from the base.
    await boxes.create({ runId, image: scripts.base, network }, options);
    await boxes.start(name, options);
    routing = true;
    const route = await deps.route.acquire(name);
    const ca = await readFile(route.caFile, "utf8").catch(() => "");
    if (!isCertificateBundle(ca)) {
      buildFailed("the web route's CA bundle is not PEM certificates.", { caFile: route.caFile });
    }
    const folder = join(work, "build");
    await mkdir(folder, { mode: 0o700 });
    await writeFile(join(folder, BUILD_BOOTSTRAP_SCRIPT), scripts.bootstrap, {
      flag: "wx",
      mode: 0o644,
    });
    await writeFile(join(folder, BUILD_SYSTEM_SCRIPT), scripts.system, {
      flag: "wx",
      mode: 0o644,
    });
    await writeFile(join(folder, BUILD_STEPS_SCRIPT), scripts.build, { flag: "wx", mode: 0o644 });
    await writeFile(join(folder, BOX_BUILD_CA_FILE), ca, { flag: "wx", mode: 0o644 });
    await boxes.copyIn(name, `${folder}/.`, BUILD_DIR_IN_BOX, options);
    // Before any install script: only the base image's programs run, with the box's capabilities.
    await step(deps, name, BUILD_BOOTSTRAP_SCRIPT, route.url, "full");
    await boxes.firewall(
      name,
      { hostAddress: network.hostAddress, ports: [routePort(route.url)] },
      options,
    );
    netTools = await copyToolsOut(deps, name, tag, work);
    await deps.beforeInstall?.(name, route.url);
    // Every install step behind the firewall: Debian's and Node.js as a root step with the root
    // allow list, npm's as the box user (DIPO-334), then the cleanup as a root step.
    await step(deps, name, BUILD_SYSTEM_SCRIPT, route.url, "root");
    await step(deps, name, BUILD_STEPS_SCRIPT, route.url, "user");
    await step(deps, name, CLEANUP_STEP, route.url, "root");
    await boxes.stop(name, options);
    if (imageExists) await boxes.deleteImage(tag, options);
    await boxes.commit(name, tag, options);
  } catch (error) {
    failure = { error };
  }
  const cleanup: BuildCleanupFailure[] = [];
  const failed = (which: BuildCleanupFailure["step"]) => (error: unknown) =>
    cleanup.push({ kind: "buildCleanupFailed", box: name, step: which, reason: messageOf(error) });
  if (routing) await deps.route.release(name).catch(failed("routeRelease"));
  await boxes.delete(name, options).catch(failed("boxDelete"));
  await rm(work, { recursive: true, force: true }).catch(failed("folderRemove"));
  for (const event of cleanup) deps.onEvent?.(event);
  if (failure !== null) {
    if (failure.error instanceof BoxError) throw failure.error;
    buildFailed(`the image build failed: ${messageOf(failure.error)}`);
  }
  return { tag, built: true, netTools };
}

/** Builds in flight, by tag: a second request for the same image waits for the first. */
const inFlight = new Map<string, Promise<BoxImageResult>>();

/**
 * The office image of `image`: reused when it exists with its box network tools, otherwise built
 * in a build box on the box network and committed (file comment).
 */
export function ensureBoxImage(
  deps: BoxImageDeps,
  image: BoxImageDescription,
): Promise<BoxImageResult> {
  const tag = boxImageTag(image);
  const pending = inFlight.get(tag);
  if (pending !== undefined) return pending;
  const started = buildInBox(deps, image, tag).finally(() => inFlight.delete(tag));
  inFlight.set(tag, started);
  return started;
}
