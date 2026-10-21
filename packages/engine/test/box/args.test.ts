// The one argument builder of the Apple `container` backend (DIPO-265, 0021 sections 2, 3 and 5,
// decision 16), over every input: every builder, every valid input combination and every refused
// one. A box gets only a host-only network, at most one mount (the package cache, read-only, at
// its fixed path), never another mount, SSH, published port or socket, or virtualization, and the
// Mac's total memory and CPU count.

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

/** Options `container` must never get from dipo, in every spelling the 1.6.0 help lists. */
const FORBIDDEN = new Set([
  "-v",
  "--volume",
  "--ssh",
  "-p",
  "--publish",
  "--publish-socket",
  "--virtualization",
]);

/** The flags of `container`'s own options in `args`: the box command after `tail` is not one. */
function forbiddenIn(args: readonly string[]): string[] {
  return args.filter(
    (arg) => FORBIDDEN.has(arg) || [...FORBIDDEN].some((f) => arg.startsWith(`${f}=`)),
  );
}

function mounts(args: readonly string[]): string[] {
  const found: string[] = [];
  args.forEach((arg, at) => {
    if (arg === "--mount") found.push(args[at + 1] ?? "");
    else if (arg.startsWith("--mount=")) found.push(arg.slice("--mount=".length));
  });
  return found;
}

function valueOf(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at < 0 ? undefined : args[at + 1];
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

const RUN_IDS = ["run_01J9ZK5Q8W3V4X6Y7Z00000001", "run_01JAAAAAAAAAAAAAAAAAAAAAAA", "t1"];
const IMAGES = [
  "docker.io/library/alpine:3.20",
  "dipo-office-image:latest",
  "ghcr.io/example/box@sha256:0123456789abcdef",
];
const CACHES = [
  undefined,
  "/Users/someone/Library/Caches/dipo/offices/off_1/packages",
  "/tmp/dipo cache with spaces",
];
const HOSTS: HostResources[] = [
  { memoryBytes: 8 * 1024 ** 3, cpus: 8 },
  { memoryBytes: 64 * 1024 ** 3 + 12_345, cpus: 14 },
  { memoryBytes: 1024 ** 2, cpus: 1 },
];
const NETWORK = { name: BOX_NETWORK_NAME, mode: "hostOnly" };

function createInputs(): CreateInput[] {
  const inputs: CreateInput[] = [];
  for (const runId of RUN_IDS)
    for (const image of IMAGES)
      for (const packageCache of CACHES)
        for (const host of HOSTS)
          inputs.push({
            runId,
            image,
            network: NETWORK,
            host,
            ...(packageCache === undefined ? {} : { packageCache }),
          });
  return inputs;
}

const NAMES = RUN_IDS.map((runId) => `dipo-${runId}`);
const HOST_PATHS = ["/tmp/d265/in", "/Users/someone/code copy/a.txt"];
const BOX_PATHS = ["/work", "/work/src/index.ts", "/dipo/out:part"];
const COMMANDS: (readonly [string, ...string[]])[] = [
  ["sh", "-c", "echo ok"],
  ["bun", "run", "verify"],
  ["ls", "-v", "--volume", "--ssh", "-p", "--publish", "--virtualization"],
];
const ENVS = [undefined, {}, { HTTPS_PROXY: "http://proxy:1", NO_PROXY: "a,b" }];
const CWDS = [undefined, "/work"];

/** Every argv the builder can make for the inputs above, by builder name. */
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
  for (const input of createInputs()) add("createArgs", builders.createArgs(input));
  for (const name of NAMES) {
    add("startArgs", builders.startArgs(name));
    add("stopArgs", builders.stopArgs(name));
    add("deleteArgs", builders.deleteArgs(name));
    add("statsArgs", builders.statsArgs(name));
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
              // The command after the box name is the box's own; only what precedes it is checked.
              builders
                .execArgs({
                  name,
                  command,
                  interactive,
                  ...(env === undefined ? {} : { env }),
                  ...(cwd === undefined ? {} : { cwd }),
                })
                .slice(0, -command.length),
            );
  }
  return all;
}

describe("the Apple container argument builder", () => {
  it("covers every builder it exports", () => {
    const exported = Object.entries(builders)
      .filter(([name, value]) => typeof value === "function" && name.endsWith("Args"))
      .map(([name]) => name)
      .toSorted();
    expect([...everyArgv().keys()].toSorted()).toEqual(exported);
  });

  it("never passes a forbidden option, and a mount only on create", () => {
    for (const [builder, argvs] of everyArgv()) {
      for (const args of argvs) {
        // The box's keepalive command follows the image; it is not an option of `container`.
        const own = builder === "createArgs" ? args.slice(0, -(BOX_KEEPALIVE.length - 1)) : args;
        expect({ builder, forbidden: forbiddenIn(own) }).toEqual({ builder, forbidden: [] });
        if (builder !== "createArgs") expect(mounts(own)).toEqual([]);
      }
    }
  });

  it("creates every box on the host-only network with all the Mac's memory and CPUs", () => {
    for (const input of createInputs()) {
      const args = createArgs(input);
      expect(args[0]).toBe("create");
      expect(valueOf(args, "--name")).toBe(`dipo-${input.runId}`);
      expect(valueOf(args, "--label")).toBe(`dipo=${input.runId}`);
      expect(args.filter((arg) => arg === "--network")).toHaveLength(1);
      expect(valueOf(args, "--network")).toBe(BOX_NETWORK_NAME);
      expect(valueOf(args, "--memory")).toBe(`${Math.floor(input.host.memoryBytes / 1024 ** 2)}M`);
      expect(valueOf(args, "--cpus")).toBe(String(input.host.cpus));
      expect(mounts(args)).toEqual(
        input.packageCache === undefined
          ? []
          : [`type=bind,source=${input.packageCache},target=${BOX_PACKAGE_CACHE_PATH},readonly`],
      );
      expect(args.slice(-BOX_KEEPALIVE.length)).toEqual([input.image, ...BOX_KEEPALIVE.slice(1)]);
      expect(valueOf(args, "--entrypoint")).toBe(BOX_KEEPALIVE[0]);
    }
  });

  it("refuses any network that is not host-only", () => {
    for (const mode of ["nat", "bridge", "host", "", "HOSTONLY"]) {
      const error = refused(() =>
        createArgs({ ...createInputs()[0]!, network: { name: BOX_NETWORK_NAME, mode } }),
      );
      expect(error.details).toEqual({ network: BOX_NETWORK_NAME, mode });
    }
    refused(() =>
      createArgs({ ...createInputs()[0]!, network: { name: "--ssh", mode: "hostOnly" } }),
    );
  });

  it("refuses a package cache that is not one plain absolute folder", () => {
    for (const packageCache of [
      "relative/cache",
      "",
      "/cache,source=/Users/someone",
      "/cache,target=/etc",
      "/cache=x",
      "/cache\nreadonly",
    ]) {
      refused(() => createArgs({ ...createInputs()[0]!, packageCache }));
    }
  });

  it("refuses inputs that could be read as an option of container", () => {
    const base = createInputs()[0]!;
    for (const image of ["--ssh", "-v", " alpine", "alpine latest", ""]) {
      refused(() => createArgs({ ...base, image }));
    }
    for (const runId of ["", "-x", "a/b", "a:b", "x".repeat(60)]) {
      refused(() => createArgs({ ...base, runId }));
    }
    for (const host of [
      { memoryBytes: 0, cpus: 8 },
      { memoryBytes: 8 * 1024 ** 3, cpus: 0 },
      { memoryBytes: Number.NaN, cpus: 8 },
      { memoryBytes: 8 * 1024 ** 3, cpus: 1.5 },
    ]) {
      refused(() => createArgs({ ...base, host }));
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
    }
    for (const host of ["relative", "/tmp/a:b", "--ssh", "/tmp/a\u0000"]) {
      refused(() => builders.copyInArgs(name, host, "/work"));
      refused(() => builders.copyOutArgs(name, "/work", host));
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
});
