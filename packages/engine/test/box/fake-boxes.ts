// An in-memory box backend for the box worker tests (DIPO-271): every call is logged in order, a
// box has a state and the folder listings copied into it, and the client commands are the real
// Apple `container` argv, so a plan built on it is what the worker host would run. A killed
// `container exec` client leaves its process running in the box, as the real one does: only a
// stop or a delete of the box ends it.

import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { AppleContainerBoxes } from "../../src/box/apple-container";
import { BOX_NETWORK_NAME } from "../../src/box/apple-args";
import {
  BoxError,
  type BoxBuildNetwork,
  type BoxCheck,
  type BoxClientCommand,
  type BoxExecOptions,
  type BoxExecResult,
  type BoxImageBuild,
  type BoxInfo,
  type BoxNetwork,
  type BoxPort,
  type BoxProcess,
  type BoxSpec,
  boxName,
} from "../../src/box/port";
import { TOKEN_CHECK_ENV_COMMAND } from "../../src/box/token-check";

/** The container program the client commands name. */
export const FAKE_CONTAINER = "/usr/local/bin/container";
/** The client environment of the fake backend. */
export const FAKE_CLIENT_ENV = { PATH: "/usr/bin:/bin", HOME: "/Users/maintainer" };
/** Documentation addresses (RFC 5737) for the two networks. */
export const BOX_HOST_ADDRESS = "192.0.2.10";
export const BUILD_HOST_ADDRESS = "192.0.2.20";

export interface FakeBoxState {
  readonly name: string;
  readonly runId: string;
  readonly spec: BoxSpec;
  state: "running" | "stopped";
  /** Every folder copied in: the box path and the copied folder's listing at that moment. */
  readonly copies: { readonly to: string; readonly listing: readonly string[] }[];
  /** True while a worker process runs in the box (an exec the host started). */
  workerRunning: boolean;
}

/** The relative paths under `dir`, folders ending in `/`, sorted. */
export function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      const rel = relative(dir, path);
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        walk(path);
      } else {
        out.push(rel);
      }
    }
  };
  walk(dir);
  return out.toSorted();
}

export interface FakeBoxesOptions {
  /** A shared log the test also writes to (the proxies' starts), for the order of events. */
  readonly log?: string[];
  readonly check?: BoxCheck;
  /** Images that already exist. */
  readonly images?: readonly string[];
  /** What the box's environment shows the post-run check. */
  readonly envText?: string;
  /** The bytes the host-made export holds. */
  readonly exportText?: string;
  /** Fails `start` with this error. */
  readonly startFails?: Error;
  /** The image builder runs before the first build. */
  readonly builderRunning?: boolean;
}

export class FakeBoxes implements BoxPort {
  readonly id = "fake";
  readonly log: string[];
  readonly boxes = new Map<string, FakeBoxState>();
  readonly images: Set<string>;
  readonly builds: BoxImageBuild[] = [];
  /** Whether the image builder runs: `buildNetwork` starts it, `stopBuilder` stops it. */
  builder: boolean;
  readonly #options: FakeBoxesOptions;
  readonly #client = new AppleContainerBoxes({
    spawn: () => {
      throw new Error("the fake backend starts no process");
    },
    clock: new ManualClock(),
    cli: FAKE_CONTAINER,
    env: FAKE_CLIENT_ENV,
  });

  constructor(options: FakeBoxesOptions = {}) {
    this.#options = options;
    this.log = options.log ?? [];
    this.images = new Set(options.images ?? []);
    this.builder = options.builderRunning ?? false;
  }

  #box(name: string): FakeBoxState {
    const box = this.boxes.get(name);
    if (box === undefined) throw new BoxError("box.failed", `no box ${name}`);
    return box;
  }

  async check(): Promise<BoxCheck> {
    this.log.push("check");
    return this.#options.check ?? { ok: true, version: "1.6.0" };
  }

  async network(): Promise<BoxNetwork> {
    this.log.push("network");
    return { name: BOX_NETWORK_NAME, mode: "hostOnly", hostAddress: BOX_HOST_ADDRESS };
  }

  async buildNetwork(): Promise<BoxBuildNetwork> {
    this.log.push("build network");
    this.builder = true;
    return { name: "default", hostAddress: BUILD_HOST_ADDRESS };
  }

  async builderRunning(): Promise<boolean> {
    this.log.push(`builder status ${this.builder ? "running" : "stopped"}`);
    return this.builder;
  }

  async stopBuilder(): Promise<void> {
    this.log.push("stop builder");
    this.builder = false;
  }

  async create(spec: BoxSpec): Promise<string> {
    const name = boxName(spec.runId);
    this.log.push(`create ${name}`);
    this.boxes.set(name, {
      name,
      runId: spec.runId,
      spec,
      state: "stopped",
      copies: [],
      workerRunning: false,
    });
    return name;
  }

  async start(name: string): Promise<void> {
    this.log.push(`start ${name}`);
    if (this.#options.startFails !== undefined) throw this.#options.startFails;
    this.#box(name).state = "running";
  }

  async stop(name: string): Promise<void> {
    this.log.push(`stop ${name}`);
    const box = this.#box(name);
    box.state = "stopped";
    box.workerRunning = false;
  }

  async delete(name: string): Promise<void> {
    this.log.push(`delete ${name}`);
    this.boxes.delete(name);
  }

  async copyIn(name: string, from: string, to: string): Promise<void> {
    this.log.push(`copy in ${name} ${to}`);
    const box = this.#box(name);
    if (box.state !== "running") throw new BoxError("box.failed", `${name} is not running`);
    const dir = from.endsWith("/.") ? from.slice(0, -2) : from;
    box.copies.push({ to, listing: statSync(dir).isDirectory() ? listing(dir) : [from] });
  }

  async copyOut(): Promise<void> {
    throw new Error("not used");
  }

  async exportFiles(name: string, to: string): Promise<void> {
    this.log.push(`export ${name}`);
    this.#box(name);
    writeFileSync(to, (this.#options.exportText ?? "") + "x".repeat(2048));
  }

  async exec(
    name: string,
    command: readonly [string, ...string[]],
    _options?: BoxExecOptions,
  ): Promise<BoxExecResult> {
    this.log.push(`exec ${name} ${command[0]}`);
    const box = this.#box(name);
    if (box.state !== "running") throw new BoxError("box.failed", `${name} is not running`);
    if (command.join(" ") === TOKEN_CHECK_ENV_COMMAND.join(" ")) {
      return {
        code: 0,
        stdout: this.#options.envText ?? "PATH=/usr/bin\nHOME=/root\n",
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  }

  execLive(): BoxProcess {
    throw new Error("the worker host runs the live exec, not the backend");
  }

  execLiveCommand(
    name: string,
    command: readonly [string, ...string[]],
    options?: Omit<BoxExecOptions, "timeoutMs">,
  ): BoxClientCommand {
    return this.#client.execLiveCommand(name, command, options);
  }

  stopCommand(name: string): BoxClientCommand {
    return this.#client.stopCommand(name);
  }

  async memory(): Promise<null> {
    return null;
  }

  async list(): Promise<BoxInfo[]> {
    this.log.push("list");
    return [...this.boxes.values()].map((box) => ({
      name: box.name,
      runId: box.runId,
      state: box.state,
    }));
  }

  async hasImage(tag: string): Promise<boolean> {
    this.log.push(`has image ${tag.slice(0, 16)}`);
    return this.images.has(tag);
  }

  async buildImage(build: BoxImageBuild): Promise<void> {
    this.log.push(`build ${build.tag.slice(0, 16)} through ${build.proxyUrl}`);
    this.builds.push(build);
    this.images.add(build.tag);
  }
}
