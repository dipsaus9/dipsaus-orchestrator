// The one argument builder of the Apple `container` backend (DIPO-265, 0021 sections 2, 3 and 5).
// Every `container` argv dipo runs comes from here, so the rules hold in one place:
// - a box joins only dipo's host-only network, by name and mode; any other network is refused;
// - the only mount is the office package cache, always read-only, at a fixed path in the box;
// - never `--volume`, another `--mount`, `--ssh`, `--publish`, `--publish-socket` or
//   `--virtualization`;
// - `--memory` and `--cpus` are the Mac's total memory and CPU count (decision 16: no limits).
// Inputs that could be read as another option or split into another mount are refused here.
// Pure: no I/O.

import { posix } from "node:path";

import {
  BOX_LABEL,
  BOX_PACKAGE_CACHE_PATH,
  BoxError,
  type BoxNetwork,
  boxName,
  runIdOfBox,
} from "./port";

/** The network dipo prepares for its boxes. */
export const BOX_NETWORK_NAME = "dipo-boxes";
/** The value of the `dipo` label on that network. */
export const BOX_NETWORK_LABEL_VALUE = "network";
/** The box's main process: it only keeps the box running; work runs through `exec`. */
export const BOX_KEEPALIVE: readonly [string, ...string[]] = ["tail", "-f", "/dev/null"];

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

/**
 * The read-only mount of the office package cache, the only mount a box gets. Checked as text
 * only: DIPO-267 will also require the path, resolved with realpath, to lie under dipo's own
 * cache root, so a symlink cannot point the mount elsewhere.
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
 * box's own command, never an option of `container`.
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
  const [entrypoint, ...keepalive] = BOX_KEEPALIVE;
  return [
    "create",
    "--name",
    name,
    "--label",
    `${BOX_LABEL}=${input.runId}`,
    "--network",
    BOX_NETWORK_NAME,
    ...resourceArgs(input.host),
    ...(input.packageCache === undefined
      ? []
      : ["--mount", cacheMount(input.packageCache, input.home)]),
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
 * Runs a command in a box. The box name ends `container`'s options; the command follows it and
 * may not start with `-`, so it is never read as one.
 */
export function execArgs(input: ExecInput): string[] {
  const name = checkedBoxName(input.name);
  if (input.command[0].startsWith("-") || input.command[0].length === 0) {
    refuse("a box command may not start with `-` or be empty.", { command: input.command[0] });
  }
  return [
    "exec",
    ...(input.interactive === true ? ["--interactive"] : []),
    ...(input.cwd === undefined ? [] : ["--workdir", absolutePath(input.cwd, "working directory")]),
    ...envArgs(input.env),
    name,
    ...input.command,
  ];
}

/** One reading of a box's resource use, as JSON. */
export function statsArgs(name: string): string[] {
  return ["stats", "--no-stream", "--format", "json", checkedBoxName(name)];
}

/** Every box, running or stopped, as JSON. */
export function listArgs(): string[] {
  return ["list", "--all", "--format", "json"];
}
