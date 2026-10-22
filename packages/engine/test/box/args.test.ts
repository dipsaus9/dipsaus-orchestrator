// The one argument builder of the Apple `container` backend (DIPO-265, 0021 sections 2, 3 and 5,
// decision 16), over every input: every builder, every input combination, valid or refused. A box
// gets only dipo's host-only network, at most one mount (the package cache, read-only, at its
// fixed path) and the Mac's total memory and CPU count. Each builder may emit only the option
// flags listed for it below; any other flag, short or combined spellings included, fails.

import { describe, expect, it } from "bun:test";

import * as builders from "../../src/box/apple-args";
import {
  BOX_KEEPALIVE,
  BOX_NETWORK_NAME,
  type CreateInput,
  createArgs,
  execArgs,
  type HostResources,
} from "../../src/box/apple-args";
import { BOX_PACKAGE_CACHE_PATH, BoxError } from "../../src/box/port";

/** What one builder's argv may hold: its subcommand words, its option flags and their values. */
interface Shape {
  readonly words: readonly string[];
  /** Each allowed flag, exactly as spelled, with the number of values it takes. */
  readonly flags: Readonly<Record<string, 0 | 1>>;
  /** Positionals after the options. */
  readonly positionals: number;
  /**
   * True when what follows the last positional is the box's own command (`create`'s image
   * arguments, `exec`'s command), passed through and never read as an option of `container`.
   */
  readonly passthrough?: boolean;
}

const SHAPES: Readonly<Record<string, Shape>> = {
  versionArgs: { words: [], flags: { "--version": 0 }, positionals: 0 },
  systemStatusArgs: { words: ["system", "status"], flags: { "--format": 1 }, positionals: 0 },
  networkListArgs: { words: ["network", "list"], flags: { "--format": 1 }, positionals: 0 },
  networkCreateArgs: {
    words: ["network", "create"],
    flags: { "--internal": 0, "--label": 1 },
    positionals: 1,
  },
  listArgs: { words: ["list"], flags: { "--all": 0, "--format": 1 }, positionals: 0 },
  // DIPO-271: the builder starts before the build proxy finds its network's address.
  builderStartArgs: { words: ["builder", "start"], flags: {}, positionals: 0 },
  // DIPO-298: the builder's state is read before a build, and a builder dipo started is stopped.
  builderStatusArgs: { words: ["builder", "status"], flags: { "--format": 1 }, positionals: 0 },
  builderStopArgs: { words: ["builder", "stop"], flags: {}, positionals: 0 },
  createArgs: {
    words: ["create"],
    flags: {
      "--name": 1,
      "--label": 1,
      "--network": 1,
      "--memory": 1,
      "--cpus": 1,
      "--mount": 1,
      "--entrypoint": 1,
    },
    positionals: 1,
    passthrough: true,
  },
  startArgs: { words: ["start"], flags: {}, positionals: 1 },
  stopArgs: { words: ["stop"], flags: {}, positionals: 1 },
  deleteArgs: { words: ["delete"], flags: { "--force": 0 }, positionals: 1 },
  statsArgs: { words: ["stats"], flags: { "--no-stream": 0, "--format": 1 }, positionals: 1 },
  copyInArgs: { words: ["copy"], flags: {}, positionals: 2 },
  copyOutArgs: { words: ["copy"], flags: {}, positionals: 2 },
  exportArgs: { words: ["export"], flags: { "--output": 1 }, positionals: 1 },
  execArgs: {
    words: ["exec"],
    flags: { "--interactive": 0, "--workdir": 1, "--env": 1 },
    positionals: 1,
    passthrough: true,
  },
  imageInspectArgs: { words: ["image", "inspect"], flags: {}, positionals: 1 },
  buildArgs: {
    words: ["build"],
    flags: { "--file": 1, "--tag": 1, "--label": 1, "--build-arg": 1, "--progress": 1 },
    positionals: 1,
  },
};

/**
 * The option flags of `args` read against `shape`, in order, each with its value. Throws on a
 * flag the shape does not list (so `-v`, `-it`, `--volume=x` all fail), on a missing value, on a
 * wrong subcommand, and on positionals the shape does not expect.
 */
function readFlags(args: readonly string[], shape: Shape): [string, string | null][] {
  if (shape.words.some((word, at) => args[at] !== word)) {
    throw new Error(`expected ${shape.words.join(" ")}: ${args.join(" ")}`);
  }
  const flags: [string, string | null][] = [];
  let positionals = 0;
  let at = shape.words.length;
  for (; at < args.length && positionals < shape.positionals; at += 1) {
    const arg = args[at]!;
    if (!arg.startsWith("-")) {
      positionals += 1;
      continue;
    }
    const arity = shape.flags[arg];
    if (arity === undefined) throw new Error(`flag ${arg} is not allowed: ${args.join(" ")}`);
    if (arity === 0) {
      flags.push([arg, null]);
      continue;
    }
    const value = args[at + 1];
    if (value === undefined) throw new Error(`flag ${arg} has no value: ${args.join(" ")}`);
    flags.push([arg, value]);
    at += 1;
  }
  if (shape.positionals === 0) {
    for (; at < args.length; at += 1) {
      const arity = shape.flags[args[at]!];
      if (arity === undefined) throw new Error(`${args[at]} is not allowed: ${args.join(" ")}`);
      flags.push([args[at]!, arity === 1 ? (args[++at] ?? "") : null]);
    }
  }
  if (positionals !== shape.positionals) {
    throw new Error(`expected ${shape.positionals} positionals: ${args.join(" ")}`);
  }
  if (shape.passthrough !== true && at !== args.length) {
    throw new Error(`unexpected trailing arguments: ${args.join(" ")}`);
  }
  return flags;
}

function mounts(flags: readonly [string, string | null][]): (string | null)[] {
  return flags.filter(([flag]) => flag === "--mount").map(([, value]) => value);
}

function refused(build: () => unknown): BoxError {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(BoxError);
    expect((error as BoxError).code).toBe("box.refused");
    return error as BoxError;
  }
  throw new Error("expected the builder to refuse");
}

const HOME = "/Users/someone";
const RUN_IDS = ["run_01J9ZK5Q8W3V4X6Y7Z00000001", "run_01JAAAAAAAAAAAAAAAAAAAAAAA", "t1"];
const IMAGES = [
  "docker.io/library/alpine:3.20",
  "dipo-office-image:latest",
  "ghcr.io/example/box@sha256:0123456789abcdef",
];
/** Each package cache input and whether the builder accepts it. */
const CACHES: readonly [string | undefined, boolean][] = [
  [undefined, true],
  [`${HOME}/Library/Caches/dipo/offices/off_1/packages`, true],
  ["/tmp/dipo cache with spaces", true],
  [`${HOME}/.dipo-cache`, true],
  ["relative/cache", false],
  ["", false],
  ["/", false],
  [HOME, false],
  [`${HOME}/`, false],
  ["/Users", false],
  [`${HOME}/cache/`, false],
  [`${HOME}//cache`, false],
  [`${HOME}/./cache`, false],
  [`${HOME}/cache/..`, false],
  [`${HOME}/../other/cache`, false],
  ["/cache,source=/Users/someone", false],
  ["/cache,target=/etc", false],
  ["/cache=x", false],
  ["/cache\nreadonly", false],
];
const HOSTS: HostResources[] = [
  { memoryBytes: 8 * 1024 ** 3, cpus: 8 },
  { memoryBytes: 64 * 1024 ** 3 + 12_345, cpus: 14 },
  { memoryBytes: 1024 ** 2, cpus: 1 },
];
/** Each network input and whether the builder accepts it: only dipo's network, host-only. */
const NETWORKS: readonly [{ name: string; mode: string }, boolean][] = [
  [{ name: BOX_NETWORK_NAME, mode: "hostOnly" }, true],
  [{ name: "default", mode: "hostOnly" }, false],
  [{ name: "default", mode: "nat" }, false],
  [{ name: BOX_NETWORK_NAME, mode: "nat" }, false],
  [{ name: BOX_NETWORK_NAME, mode: "HOSTONLY" }, false],
  [{ name: BOX_NETWORK_NAME, mode: "" }, false],
  [{ name: "probe-internal", mode: "hostOnly" }, false],
  [{ name: `${BOX_NETWORK_NAME},alias=x`, mode: "hostOnly" }, false],
  [{ name: "--ssh", mode: "hostOnly" }, false],
];

/** Every create input above, with whether the builder must accept it. */
function createCases(): [CreateInput, boolean][] {
  const cases: [CreateInput, boolean][] = [];
  for (const runId of RUN_IDS)
    for (const image of IMAGES)
      for (const [packageCache, cacheOk] of CACHES)
        for (const host of HOSTS)
          for (const [network, networkOk] of NETWORKS)
            cases.push([
              {
                runId,
                image,
                network,
                host,
                home: HOME,
                ...(packageCache === undefined ? {} : { packageCache }),
              },
              cacheOk && networkOk,
            ]);
  return cases;
}

const VALID: CreateInput = {
  runId: RUN_IDS[0]!,
  image: IMAGES[0]!,
  network: { name: BOX_NETWORK_NAME, mode: "hostOnly" },
  host: HOSTS[0]!,
  home: HOME,
};

const NAMES = RUN_IDS.map((runId) => `dipo-${runId}`);
const HOST_PATHS = ["/tmp/d265/in", "/Users/someone/code copy/a.txt"];
const BOX_PATHS = ["/work", "/work/src/index.ts", "/dipo/out:part"];
const COMMANDS: (readonly [string, ...string[]])[] = [
  ["sh", "-c", "echo ok"],
  ["bun", "run", "verify"],
  ["ls", "-v", "--volume", "--ssh", "-p", "--publish", "--virtualization"],
];
/** Box image tags and build inputs (DIPO-266). */
const TAGS = [`dipo-box:${"0".repeat(64)}`, `dipo-box:${"ab12".repeat(16)}`];
const CONTEXTS = ["/tmp/d266/box-build-x1", "/Users/someone/Library/Caches/dipo/box build"];
const PROXIES = ["http://192.0.2.1:3128", "http://[2001:db8::1]:8080", "http://proxy.example:1"];
const ENVS = [undefined, {}, { HTTPS_PROXY: "http://proxy:1", NO_PROXY: "a,b" }];
const CWDS = [undefined, "/work"];

/** Every argv the builders make for the accepted inputs above, by builder name. */
function everyArgv(): Map<string, string[][]> {
  const all = new Map<string, string[][]>();
  const add = (builder: string, args: string[]) => {
    all.set(builder, [...(all.get(builder) ?? []), args]);
  };
  add("versionArgs", builders.versionArgs());
  add("systemStatusArgs", builders.systemStatusArgs());
  add("networkListArgs", builders.networkListArgs());
  add("networkCreateArgs", builders.networkCreateArgs());
  add("listArgs", builders.listArgs());
  add("builderStartArgs", builders.builderStartArgs());
  add("builderStatusArgs", builders.builderStatusArgs());
  add("builderStopArgs", builders.builderStopArgs());
  for (const tag of TAGS) {
    add("imageInspectArgs", builders.imageInspectArgs(tag));
    for (const contextDir of CONTEXTS)
      for (const proxyUrl of PROXIES)
        add("buildArgs", builders.buildArgs({ tag, contextDir, proxyUrl }));
  }
  for (const [input, ok] of createCases()) if (ok) add("createArgs", builders.createArgs(input));
  for (const name of NAMES) {
    add("startArgs", builders.startArgs(name));
    add("stopArgs", builders.stopArgs(name));
    add("deleteArgs", builders.deleteArgs(name));
    add("statsArgs", builders.statsArgs(name));
    for (const host of HOST_PATHS) add("exportArgs", builders.exportArgs(name, host));
    for (const host of HOST_PATHS)
      for (const box of BOX_PATHS) {
        add("copyInArgs", builders.copyInArgs(name, host, box));
        add("copyOutArgs", builders.copyOutArgs(name, box, host));
      }
    for (const command of COMMANDS)
      for (const env of ENVS)
        for (const cwd of CWDS)
          for (const interactive of [false, true])
            add(
              "execArgs",
              builders.execArgs({
                name,
                command,
                interactive,
                ...(env === undefined ? {} : { env }),
                ...(cwd === undefined ? {} : { cwd }),
              }),
            );
  }
  return all;
}

describe("the Apple container argument builder", () => {
  it("has an allowed shape for every builder it exports, and covers each one", () => {
    const exported = Object.entries(builders)
      .filter(([name, value]) => typeof value === "function" && name.endsWith("Args"))
      .map(([name]) => name)
      .toSorted();
    expect(Object.keys(SHAPES).toSorted()).toEqual(exported);
    expect([...everyArgv().keys()].toSorted()).toEqual(exported);
  });

  it("refuses, in the flag check itself, every flag a shape does not list", () => {
    const exec = SHAPES["execArgs"]!;
    for (const bad of [
      ["exec", "-v", "/:/host", "dipo-t1", "sh"],
      ["exec", "--volume", "/:/host", "dipo-t1", "sh"],
      ["exec", "--volume=/:/host", "dipo-t1", "sh"],
      ["exec", "-it", "dipo-t1", "sh"],
      ["exec", "-i", "dipo-t1", "sh"],
      ["exec", "--ssh", "dipo-t1", "sh"],
      ["exec", "--env=A=1", "dipo-t1", "sh"],
    ]) {
      expect(() => readFlags(bad, exec)).toThrow();
    }
    const create = SHAPES["createArgs"]!;
    for (const flag of ["--publish", "-p", "--publish-socket", "--virtualization", "--rosetta"]) {
      expect(() => readFlags(["create", flag, "x", "alpine"], create)).toThrow();
    }
    expect(() => readFlags(["list", "--all", "-q"], SHAPES["listArgs"]!)).toThrow();
  });

  it("emits only the flags each builder may, for every input", () => {
    for (const [builder, argvs] of everyArgv()) {
      const shape = SHAPES[builder]!;
      for (const args of argvs) {
        const flags = readFlags(args, shape);
        if (builder !== "createArgs") expect(mounts(flags)).toEqual([]);
        else expect(mounts(flags).length).toBeLessThanOrEqual(1);
      }
    }
  });

  it("accepts a create input only with dipo's host-only network and a plain cache folder", () => {
    for (const [input, ok] of createCases()) {
      if (!ok) {
        refused(() => createArgs(input));
        continue;
      }
      const args = createArgs(input);
      const flags = readFlags(args, SHAPES["createArgs"]!);
      const once = (flag: string) => flags.filter(([name]) => name === flag).map(([, v]) => v);
      expect(once("--name")).toEqual([`dipo-${input.runId}`]);
      expect(once("--label")).toEqual([`dipo=${input.runId}`]);
      expect(once("--network")).toEqual([BOX_NETWORK_NAME]);
      expect(once("--memory")).toEqual([`${Math.floor(input.host.memoryBytes / 1024 ** 2)}M`]);
      expect(once("--cpus")).toEqual([String(input.host.cpus)]);
      expect(once("--entrypoint")).toEqual([BOX_KEEPALIVE[0]]);
      expect(mounts(flags)).toEqual(
        input.packageCache === undefined
          ? []
          : [`type=bind,source=${input.packageCache},target=${BOX_PACKAGE_CACHE_PATH},readonly`],
      );
      expect(args.slice(-BOX_KEEPALIVE.length)).toEqual([input.image, ...BOX_KEEPALIVE.slice(1)]);
    }
  });

  it("refuses the default NAT network even when the caller claims it is host-only", () => {
    const error = refused(() =>
      createArgs({ ...VALID, network: { name: "default", mode: "hostOnly" } }),
    );
    expect(error.details).toEqual({ network: "default", mode: "hostOnly" });
    for (const name of ["default", "bridge", "dipo-boxes-2", "Dipo-Boxes", "", "dipo-boxes "]) {
      refused(() => createArgs({ ...VALID, network: { name, mode: "hostOnly" } }));
    }
    for (const mode of ["nat", "bridge", "host", "", "HOSTONLY"]) {
      const modeError = refused(() =>
        createArgs({ ...VALID, network: { name: BOX_NETWORK_NAME, mode } }),
      );
      expect(modeError.details).toEqual({ network: BOX_NETWORK_NAME, mode });
    }
  });

  it("refuses a package cache that is the home folder, above it, or not normalised", () => {
    for (const home of [HOME, `${HOME}/`, "/Users/someone/../someone"]) {
      for (const packageCache of [HOME, "/Users", "/"]) {
        refused(() => createArgs({ ...VALID, home, packageCache }));
      }
    }
    refused(() => createArgs({ ...VALID, home: "relative", packageCache: "/tmp/cache" }));
    expect(
      mounts(readFlags(createArgs({ ...VALID, packageCache: `${HOME}x` }), SHAPES["createArgs"]!)),
    ).toHaveLength(1);
  });

  it("keeps a package cache path with a space whole in its one --mount element (DIPO-295)", () => {
    // dipo's state folder on macOS lies under a folder name with a space.
    const packageCache = "/Users/someone/Library/Application Support/dipo/package-cache/off_1/key";
    const args = createArgs({ ...VALID, packageCache });
    expect(mounts(readFlags(args, SHAPES["createArgs"]!))).toEqual([
      `type=bind,source=${packageCache},target=${BOX_PACKAGE_CACHE_PATH},readonly`,
    ]);
    expect(args).toContain(
      `type=bind,source=${packageCache},target=${BOX_PACKAGE_CACHE_PATH},readonly`,
    );
  });

  it("refuses inputs that could be read as an option of container", () => {
    for (const image of ["--ssh", "-v", " alpine", "alpine latest", ""]) {
      refused(() => createArgs({ ...VALID, image }));
    }
    for (const runId of ["", "-x", "a/b", "a:b", "x".repeat(60)]) {
      refused(() => createArgs({ ...VALID, runId }));
    }
    for (const host of [
      { memoryBytes: 0, cpus: 8 },
      { memoryBytes: 8 * 1024 ** 3, cpus: 0 },
      { memoryBytes: Number.NaN, cpus: 8 },
      { memoryBytes: 8 * 1024 ** 3, cpus: 1.5 },
    ]) {
      refused(() => createArgs({ ...VALID, host }));
    }
    const name = NAMES[0]!;
    for (const command of [["--volume=/:/host"], ["-v"], [""]] as [string][]) {
      refused(() => execArgs({ name, command }));
    }
    refused(() => execArgs({ name, command: ["sh"], env: { HOME: "/root", "BAD KEY": "x" } }));
    refused(() => execArgs({ name, command: ["sh"], env: { "": "x" } }));
    refused(() => execArgs({ name, command: ["sh"], cwd: "work" }));
    for (const other of ["probe-box", "dipo-", "dipo-a/b", "--all", "dipo--ssh"]) {
      refused(() => builders.startArgs(other));
      refused(() => builders.stopArgs(other));
      refused(() => builders.deleteArgs(other));
      refused(() => builders.statsArgs(other));
      refused(() => execArgs({ name: other, command: ["sh"] }));
      refused(() => builders.copyInArgs(other, "/tmp/a", "/work"));
      refused(() => builders.exportArgs(other, "/tmp/a.tar"));
    }
    for (const host of ["relative", "/tmp/a:b", "--ssh", "/tmp/a\u0000"]) {
      refused(() => builders.copyInArgs(name, host, "/work"));
      refused(() => builders.copyOutArgs(name, "/work", host));
      refused(() => builders.exportArgs(name, host));
    }
    for (const box of ["work", "", "/work\u0007"]) {
      refused(() => builders.copyInArgs(name, "/tmp/a", box));
      refused(() => builders.copyOutArgs(name, box, "/tmp/a"));
    }
  });

  it("passes every environment variable as KEY=VALUE, never a bare name the host would fill", () => {
    const args = execArgs({
      name: NAMES[0]!,
      command: ["env"],
      env: { A: "1", EMPTY: "", WITH_EQ: "x=y" },
    });
    expect(args).toEqual([
      "exec",
      "--env",
      "A=1",
      "--env",
      "EMPTY=",
      "--env",
      "WITH_EQ=x=y",
      NAMES[0]!,
      "env",
    ]);
  });

  it("exports a box's filesystem to a host file only", () => {
    expect(builders.exportArgs(NAMES[0]!, "/tmp/d269/dipo-token-check-x/box.tar")).toEqual([
      "export",
      "--output",
      "/tmp/d269/dipo-token-check-x/box.tar",
      NAMES[0]!,
    ]);
  });

  it("makes the network host-only and labelled", () => {
    expect(builders.networkCreateArgs()).toEqual([
      "network",
      "create",
      "--internal",
      "--label",
      "dipo=network",
      BOX_NETWORK_NAME,
    ]);
  });

  it("builds only dipo's own build file, with the proxy as the one build argument", () => {
    const tag = TAGS[0]!;
    expect(builders.buildArgs({ tag, contextDir: CONTEXTS[0]!, proxyUrl: PROXIES[0]! })).toEqual([
      "build",
      "--file",
      `${CONTEXTS[0]!}/Containerfile`,
      "--tag",
      tag,
      "--label",
      "dipo=image",
      "--build-arg",
      `DIPO_PROXY=${PROXIES[0]!}`,
      "--progress",
      "plain",
      CONTEXTS[0]!,
    ]);
    for (const shape of ["--ssh", "--secret", "--output", "-o", "--no-cache", "-f"]) {
      expect(() => readFlags(["build", shape, "x", "/tmp/ctx"], SHAPES["buildArgs"]!)).toThrow();
    }
  });

  it("refuses a build or inspect of anything but a dipo box image tag", () => {
    const input = { tag: TAGS[0]!, contextDir: CONTEXTS[0]!, proxyUrl: PROXIES[0]! };
    for (const tag of [
      "alpine",
      "dipo-box:latest",
      `dipo-box:${"0".repeat(63)}`,
      `dipo-box:${"A".repeat(64)}`,
      `other:${"0".repeat(64)}`,
      "--ssh",
    ]) {
      refused(() => builders.buildArgs({ ...input, tag }));
      refused(() => builders.imageInspectArgs(tag));
    }
    for (const contextDir of [
      "relative",
      "/",
      "/tmp/a/",
      "/tmp/a/../b",
      "/tmp/a:b",
      "/tmp/\u0007",
    ]) {
      refused(() => builders.buildArgs({ ...input, contextDir }));
    }
    for (const proxyUrl of [
      "https://192.0.2.1:3128",
      "http://user:pw@192.0.2.1:3128",
      "http://192.0.2.1",
      "http://192.0.2.1:3128/path",
      "http://192.0.2.1:3128 --ssh",
      "",
    ]) {
      refused(() => builders.buildArgs({ ...input, proxyUrl }));
    }
  });
});
