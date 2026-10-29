// The one argument builder of the Apple `container` backend (DIPO-265, 0021 sections 2, 3 and 5).
// Every `container` argv dipo runs comes from here, so the rules hold in one place:
// - a box joins only dipo's host-only network, by name and mode; any other network is refused;
// - the only mounts are the office package cache and the box network tools of the box's image
//   (DIPO-281), both always read-only, each at a fixed path in the box;
// - never `--volume`, another `--mount`, `--ssh`, `--publish`, `--publish-socket` or
//   `--virtualization`;
// - `--memory` and `--cpus` are the Mac's total memory and CPU count (decision 16: no limits);
// - every box but a build box (DIPO-281) keeps itself running with the mounted `tail`, and every
//   command in it runs contained (`firewall.ts`) as the box user (DIPO-334): only the box
//   firewall's own command, and a build box's first step, run with the box's capabilities, and
//   only dipo's root steps run as root: a build box's with the build box's allow list, and in every
//   other box only `isRootStep`, with the smaller allow list of the fixed steps (DIPO-336);
// - an image is made only by committing a build box, and pulled only by a reference that is no
//   option.
// Inputs that could be read as another option or split into another mount are refused here.
// Pure: no I/O.

import { posix } from "node:path";

import {
  BOX_NET_TOOLS_PATH,
  buildRootStepCommand,
  CONTAINED_KEEPALIVE,
  containedCommand,
  isFirewallCommand,
  rootStepCommand,
} from "./firewall";
import {
  BOX_IMAGE_REPOSITORY,
  BOX_LABEL,
  BOX_PACKAGE_CACHE_PATH,
  BoxError,
  BUILD_BOX_RUN_PREFIX,
  BOX_NAME_PREFIX,
  type BoxNetwork,
  boxName,
  runIdOfBox,
  TEST_BOX_RUN_PREFIX,
} from "./port";
import { BOX_USER_ENV, isRootStep } from "./user";

/** The network dipo prepares for its boxes. */
export const BOX_NETWORK_NAME = "dipo-boxes";
/** The value of the `dipo` label on that network. */
export const BOX_NETWORK_LABEL_VALUE = "network";
/**
 * A build box's main process: it only keeps the box running; work runs through `exec`. Every
 * other box runs the mounted `tail` instead (`CONTAINED_KEEPALIVE`).
 */
export const BOX_KEEPALIVE: readonly [string, ...string[]] = ["tail", "-f", "/dev/null"];
/** The Linux capability a box is made with so its firewall can be set (DIPO-281). */
export const BOX_FIREWALL_CAPABILITY = "CAP_NET_ADMIN";

/** The Mac's resources a box may use, all of them (0021 decision 16). */
export interface HostResources {
  readonly memoryBytes: number;
  readonly cpus: number;
}

/** The inputs of one `container create`. */
export interface CreateInput {
  readonly runId: string;
  readonly image: string;
  /**
   * Only the name and mode are read. The name must be `BOX_NETWORK_NAME`, the network dipo made
   * host-only; the mode is the caller's claim and must be `hostOnly` as well.
   */
  readonly network: Pick<BoxNetwork, "name"> & { readonly mode: string };
  readonly packageCache?: string;
  /** The box network tools folder (DIPO-281); required for every box but a build box. */
  readonly netTools?: string;
  readonly host: HostResources;
  /** The maintainer's home folder: the cache may be neither it nor a folder above it. */
  readonly home: string;
}

export interface ExecInput {
  readonly name: string;
  readonly command: readonly [string, ...string[]];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Keeps stdin open for a long-running command. */
  readonly interactive?: boolean;
  /** Gives the command a terminal (`dipo test shell`, DIPO-309); only with `interactive`. */
  readonly tty?: boolean;
  /**
   * Runs `command` with the box's capabilities, not contained: only for a build box, or for the
   * box firewall's own command (`isFirewallCommand`).
   */
  readonly fullPrivilege?: boolean;
  /**
   * Runs `command` as one of dipo's root steps (DIPO-334): any in a build box, with the build
   * box's allow list (`buildRootStepCommand`); only `isRootStep` in every other box, with the
   * fixed steps' (`rootStepCommand`, DIPO-336).
   */
  readonly rootStep?: boolean;
}

const MIB = 1024 * 1024;
/** An image reference: registry, path, tag and digest characters only. */
const IMAGE = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/;
/** An environment variable name; a bare name would make `container` copy the host's value. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// oxlint-disable-next-line no-control-regex -- control characters are what this refuses
const CONTROL = /[\u0000-\u001f\u007f]/;

function refuse(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new BoxError("box.refused", message, false, details);
}

/** An absolute path with no control character; `what` names it in the refusal. */
function absolutePath(path: string, what: string): string {
  if (!path.startsWith("/") || CONTROL.test(path)) {
    refuse(`${what} must be an absolute path without control characters.`, { [what]: path });
  }
  return path;
}

/** A host path `container cp` cannot mistake for a box path (`<box>:<path>`). */
function hostPath(path: string): string {
  absolutePath(path, "host path");
  if (path.includes(":")) refuse("a host path may not hold a colon.", { path });
  return path;
}

/** A dipo box name (`dipo-<run id>`); refuses any other name. */
export function checkedBoxName(name: string): string {
  const runId = runIdOfBox(name);
  if (runId === null || boxName(runId) !== name) {
    refuse(`${JSON.stringify(name)} is not a dipo box name.`, { name });
  }
  return name;
}

/** True when `runId` is a build box's (`BUILD_BOX_RUN_PREFIX`, DIPO-281). */
export function isBuildBoxRunId(runId: string): boolean {
  return runId.startsWith(BUILD_BOX_RUN_PREFIX) && runId.length > BUILD_BOX_RUN_PREFIX.length;
}

/** True when `name` is a build box's name. */
export function isBuildBox(name: string): boolean {
  const runId = runIdOfBox(name);
  return runId !== null && isBuildBoxRunId(runId);
}

/**
 * The read-only mount of the office package cache, the only mount a box gets. Checked as text
 * here; the backend first resolves the path with realpath and requires it under dipo's own cache
 * root (`resolvePackageCacheMount`, DIPO-267), so a symlink cannot point the mount elsewhere.
 */
function cacheMount(path: string, home: string): string {
  absolutePath(path, "package cache");
  // `--mount` splits on commas and `=`; either in the path would add directives.
  if (/[,=]/.test(path)) refuse("the package cache path may not hold a comma or `=`.", { path });
  if (path.split("/").some((segment) => segment === "." || segment === "..")) {
    refuse("the package cache path may not hold `.` or `..` segments.", { path });
  }
  if (path === "/" || posix.normalize(path) !== path || path.endsWith("/")) {
    refuse("the package cache path must be a normalised folder below `/`.", { path });
  }
  const homeFolder = posix.normalize(`${absolutePath(home, "home folder")}/`);
  if (homeFolder.startsWith(`${path}/`)) {
    refuse("the package cache may not be the home folder or a folder above it.", { path, home });
  }
  return `type=bind,source=${path},target=${BOX_PACKAGE_CACHE_PATH},readonly`;
}

/**
 * The read-only mount of the box network tools (DIPO-281). Checked as text here, as the cache
 * is; the backend first resolves the path with realpath and requires it under dipo's tools root
 * and holding the tools (`resolveNetToolsMount`).
 */
function netToolsMount(path: string, home: string): string {
  absolutePath(path, "box network tools");
  if (/[,=]/.test(path))
    refuse("the box network tools path may not hold a comma or `=`.", { path });
  if (
    path === "/" ||
    posix.normalize(path) !== path ||
    path.endsWith("/") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    refuse("the box network tools path must be a normalised folder below `/`.", { path });
  }
  const homeFolder = posix.normalize(`${absolutePath(home, "home folder")}/`);
  if (homeFolder.startsWith(`${path}/`)) {
    refuse("the box network tools may not be the home folder or a folder above it.", {
      path,
      home,
    });
  }
  return `type=bind,source=${path},target=${BOX_NET_TOOLS_PATH},readonly`;
}

function resourceArgs(host: HostResources): string[] {
  const mib = Math.floor(host.memoryBytes / MIB);
  if (!Number.isSafeInteger(mib) || mib < 1) {
    refuse("the Mac's total memory is not a usable size.", { memoryBytes: host.memoryBytes });
  }
  if (!Number.isSafeInteger(host.cpus) || host.cpus < 1) {
    refuse("the Mac's CPU count is not a usable number.", { cpus: host.cpus });
  }
  return ["--memory", `${mib}M`, "--cpus", String(host.cpus)];
}

function envArgs(env: Readonly<Record<string, string>> | undefined): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!ENV_NAME.test(key)) refuse(`${JSON.stringify(key)} is not a variable name.`, { key });
    args.push("--env", `${key}=${value}`);
  }
  return args;
}

/** `container --version`. */
export function versionArgs(): string[] {
  return ["--version"];
}

/** `container system status`, as JSON. */
export function systemStatusArgs(): string[] {
  return ["system", "status", "--format", "json"];
}

/** Every network, as JSON. */
export function networkListArgs(): string[] {
  return ["network", "list", "--format", "json"];
}

/** Creates dipo's box network: host-only (`--internal`), labelled. */
export function networkCreateArgs(): string[] {
  return [
    "network",
    "create",
    "--internal",
    "--label",
    `${BOX_LABEL}=${BOX_NETWORK_LABEL_VALUE}`,
    BOX_NETWORK_NAME,
  ];
}

/**
 * Creates a stopped box. The image and its arguments come last: what follows the image is the
 * box's own command, never an option of `container`. A build box (DIPO-281) gets no mount and
 * keeps itself running with the image's `tail`; every other box must get the box network tools,
 * mounted read-only, and keeps itself running with the mounted `tail`. Every box gets the one
 * capability its firewall needs, which no contained command keeps.
 */
export function createArgs(input: CreateInput): string[] {
  const name = boxName(input.runId);
  // The mode is the caller's word; only the name ties the box to the network dipo made with
  // `--internal`. Any other network, such as `default` (NAT), is refused whatever mode it claims.
  if (input.network.name !== BOX_NETWORK_NAME) {
    refuse(`network ${input.network.name} is not dipo's host-only box network.`, {
      network: input.network.name,
      mode: input.network.mode,
    });
  }
  if (input.network.mode !== "hostOnly") {
    refuse(`network ${input.network.name} is ${input.network.mode}, not host-only.`, {
      network: input.network.name,
      mode: input.network.mode,
    });
  }
  if (!IMAGE.test(input.image))
    refuse("the image is not an image reference.", { image: input.image });
  const build = isBuildBoxRunId(input.runId);
  if (build && (input.packageCache !== undefined || input.netTools !== undefined)) {
    refuse("a build box gets no mount.", { runId: input.runId });
  }
  if (!build && input.netTools === undefined) {
    refuse("a box needs the box network tools of its image.", { runId: input.runId });
  }
  const [entrypoint, ...keepalive] = build ? BOX_KEEPALIVE : CONTAINED_KEEPALIVE;
  return [
    "create",
    "--name",
    name,
    "--label",
    `${BOX_LABEL}=${input.runId}`,
    "--network",
    BOX_NETWORK_NAME,
    ...resourceArgs(input.host),
    "--cap-add",
    BOX_FIREWALL_CAPABILITY,
    ...(input.packageCache === undefined
      ? []
      : ["--mount", cacheMount(input.packageCache, input.home)]),
    ...(input.netTools === undefined ? [] : ["--mount", netToolsMount(input.netTools, input.home)]),
    "--entrypoint",
    entrypoint,
    input.image,
    ...keepalive,
  ];
}

export function startArgs(name: string): string[] {
  return ["start", checkedBoxName(name)];
}

export function stopArgs(name: string): string[] {
  return ["stop", checkedBoxName(name)];
}

/** Deletes a box, also a running one. */
export function deleteArgs(name: string): string[] {
  return ["delete", "--force", checkedBoxName(name)];
}

/** Copies the host path `from` into the box at `to`. */
export function copyInArgs(name: string, from: string, to: string): string[] {
  return ["copy", hostPath(from), `${checkedBoxName(name)}:${absolutePath(to, "box path")}`];
}

/** Copies `from` in the box to the host path `to`. */
export function copyOutArgs(name: string, from: string, to: string): string[] {
  return ["copy", `${checkedBoxName(name)}:${absolutePath(from, "box path")}`, hostPath(to)];
}

/**
 * Writes box `name`'s whole filesystem as a tar archive to the host path `to`. The host side
 * makes it; no program in the box takes part.
 */
export function exportArgs(name: string, to: string): string[] {
  return ["export", "--output", hostPath(to), checkedBoxName(name)];
}

/**
 * Who `input`'s command runs as, refused unless the box may run it so: a root step of a build box
 * with the build box's allow list, any other with the fixed steps' (DIPO-336).
 */
function privilegeOf(input: ExecInput, name: string): "full" | "buildRoot" | "root" | "user" {
  if (input.fullPrivilege === true && input.rootStep === true) {
    refuse("a box command is a root step or runs with the box's capabilities, not both.", { name });
  }
  if (input.fullPrivilege === true) {
    if (!isBuildBox(name) && !isFirewallCommand(input.command)) {
      refuse("only a build box or the box firewall runs a command with the box's capabilities.", {
        name,
        command: input.command[0],
      });
    }
    return "full";
  }
  if (input.rootStep === true) {
    if (isBuildBox(name)) return "buildRoot";
    if (!isRootStep(input.command)) {
      refuse("only a build box or dipo's fixed root steps run a command as root.", {
        name,
        command: input.command[0],
      });
    }
    // The tools' loader runs as the box's root before setpriv drops anything, so no variable
    // (`LD_PRELOAD`, `LD_LIBRARY_PATH`) and no working directory of the caller's reaches it.
    if (input.env !== undefined || input.cwd !== undefined) {
      refuse("a fixed root step takes no environment and no working directory.", {
        name,
        command: input.command[0],
      });
    }
    return "root";
  }
  return "user";
}

/**
 * Runs a command in a box. The box name ends `container`'s options; the command follows it and
 * may not start with `-`, so it is never read as one. The command runs contained as the box user
 * (`containedCommand`, DIPO-281 and DIPO-334) unless `fullPrivilege` is set, which only a build
 * box and the box firewall's own command may, or `rootStep`, which a build box and dipo's fixed
 * root steps may.
 */
export function execArgs(input: ExecInput): string[] {
  const name = checkedBoxName(input.name);
  if (input.command[0].startsWith("-") || input.command[0].length === 0) {
    refuse("a box command may not start with `-` or be empty.", { command: input.command[0] });
  }
  const privilege = privilegeOf(input, name);
  if (privilege === "user" && input.command[0].includes("=")) {
    // The box user's `env` would read it as a variable, not as the program.
    refuse("a box command's program may not hold `=`.", { command: input.command[0] });
  }
  const command =
    privilege === "full"
      ? input.command
      : privilege === "buildRoot"
        ? buildRootStepCommand(input.command)
        : privilege === "root"
          ? rootStepCommand(input.command)
          : containedCommand(input.command, input.env ?? {});
  return [
    "exec",
    ...(input.interactive === true ? ["--interactive"] : []),
    ...(input.interactive === true && input.tty === true ? ["--tty"] : []),
    ...(input.cwd === undefined ? [] : ["--workdir", absolutePath(input.cwd, "working directory")]),
    // The box user's home and PATH unless the command names its own (DIPO-334).
    ...envArgs(privilege === "user" ? { ...BOX_USER_ENV, ...input.env } : input.env),
    name,
    ...command,
  ];
}

/** The test box shell (DIPO-309): bash in `/work` as the box user, with a terminal. */
export const TEST_SHELL_COMMAND: readonly [string, ...string[]] = ["/bin/bash", "-l"];

/**
 * The `container` arguments of `dipo test shell`: an interactive shell with a terminal in the test
 * box `name`, run contained as the box user in `/work`, like every command dipo starts in a box.
 * Refuses a name that is not a test box's.
 */
export function testShellArgs(name: string): string[] {
  const box = checkedBoxName(name);
  if (!box.startsWith(`${BOX_NAME_PREFIX}${TEST_BOX_RUN_PREFIX}`)) {
    refuse(`${JSON.stringify(name)} is not a test box.`, { name });
  }
  return execArgs({
    name: box,
    command: TEST_SHELL_COMMAND,
    cwd: "/work",
    interactive: true,
    tty: true,
  });
}

/** One reading of a box's resource use, as JSON. */
export function statsArgs(name: string): string[] {
  return ["stats", "--no-stream", "--format", "json", checkedBoxName(name)];
}

/** Every box, running or stopped, as JSON. */
export function listArgs(): string[] {
  return ["list", "--all", "--format", "json"];
}

/** A box image tag: dipo's repository and a sha256 of the description (DIPO-266). */
const IMAGE_TAG = new RegExp(`^${BOX_IMAGE_REPOSITORY}:[0-9a-f]{64}$`);

/** A box image tag dipo made; refuses any other image name. */
function checkedImageTag(tag: string): string {
  if (!IMAGE_TAG.test(tag)) refuse(`${JSON.stringify(tag)} is not a dipo box image tag.`, { tag });
  return tag;
}

/** Inspects one box image; exits 0 only when it exists. */
export function imageInspectArgs(tag: string): string[] {
  return ["image", "inspect", checkedImageTag(tag)];
}

/** Deletes one box image, so a build can make it again (DIPO-281). */
export function imageDeleteArgs(tag: string): string[] {
  return ["image", "delete", checkedImageTag(tag)];
}

/** The base image of a build: Debian's slim image of one release (DIPO-266, DIPO-281). */
const BASE_IMAGE = /^docker\.io\/library\/debian:[a-z0-9][a-z0-9.]*-slim$/;

/** Pulls the base image of a build (DIPO-281): only Debian's slim image of a release. */
export function imagePullArgs(reference: string): string[] {
  if (!BASE_IMAGE.test(reference)) {
    refuse(`${JSON.stringify(reference)} is not the base image of a box build.`, { reference });
  }
  return ["image", "pull", "--progress", "none", reference];
}

/**
 * Makes the box image `tag` from the files of the build box `name` (DIPO-281): the only way dipo
 * makes an image. Any other box is refused.
 */
export function commitArgs(name: string, tag: string): string[] {
  const box = checkedBoxName(name);
  if (!isBuildBox(box)) refuse(`${box} is no build box, so it cannot become an image.`, { name });
  return ["commit", box, checkedImageTag(tag)];
}
