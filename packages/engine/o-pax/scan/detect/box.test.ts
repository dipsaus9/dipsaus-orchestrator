import { describe, expect, it } from "bun:test";

import { detectBoxToolchain, exactVersion } from "./box";
import { detect } from "./detect";
import type { Probe } from "./types";

/** A probe of a repository root with these files and lockfiles; no file system involved. */
function probeOf(
  manifest: Record<string, unknown>,
  texts: Record<string, string> = {},
  lockfiles: string[] = [],
): Probe {
  return {
    texts: { "package.json": JSON.stringify({ name: "repo", ...manifest }), ...texts },
    lockfiles,
    workspaceDirs: [],
    envFiles: [],
  };
}

const detected = (probe: Probe) => detectBoxToolchain(probe, detect(probe).toolchain);

describe("the box toolchain from the repository scan", () => {
  it("takes the Bun version from .bun-version, then packageManager", () => {
    expect(detected(probeOf({}, { ".bun-version": "1.4.2\n" }, ["bun.lock"])).bun).toEqual({
      version: "1.4.2",
      evidence: ".bun-version",
    });
    expect(
      detected(probeOf({ packageManager: "bun@1.3.9" }, { ".bun-version": "1.4.2" }, ["bun.lock"]))
        .bun,
    ).toEqual({ version: "1.4.2", evidence: ".bun-version" });
    expect(detected(probeOf({ packageManager: "bun@1.3.9" }, {}, ["bun.lock"])).bun).toEqual({
      version: "1.3.9",
      evidence: "package.json packageManager",
    });
    expect(detected(probeOf({}, {}, ["bun.lock"])).bun).toEqual({
      version: null,
      evidence: "bun is the package manager; no exact version",
    });
  });

  it("detects the package manager and its pinned version", () => {
    expect(detected(probeOf({ packageManager: "pnpm@12.14.0" }, {}, ["pnpm-lock.yaml"]))).toEqual({
      node: expect.objectContaining({ version: null }),
      pnpm: { version: "12.14.0", evidence: "package.json packageManager" },
    });
    expect(detected(probeOf({}, {}, ["pnpm-lock.yaml"])).pnpm?.version).toBeNull();
    expect(detected(probeOf({ packageManager: "yarn@1.22.22" }, {}, ["yarn.lock"])).yarn).toEqual({
      version: "1.22.22",
      evidence: "package.json packageManager",
    });
    // Yarn 2+ installs as Yarn 1 from npm, which runs the repository's committed release.
    expect(detected(probeOf({ packageManager: "yarn@4.5.0" }, {}, ["yarn.lock"])).yarn).toEqual({
      version: null,
      evidence: "yarn is the package manager; no Yarn 1 version",
    });
    // npm comes with Node: no extra tool.
    expect(Object.keys(detected(probeOf({}, {}, ["package-lock.json"])))).toEqual(["node"]);
  });

  it("takes an exact Node version from .node-version, .nvmrc or engines.node, else none", () => {
    expect(detected(probeOf({}, { ".nvmrc": "v24.22.1\n" })).node).toEqual({
      version: "24.22.1",
      evidence: ".nvmrc",
    });
    expect(detected(probeOf({ engines: { node: "22.12.0" } })).node).toEqual({
      version: "22.12.0",
      evidence: "package.json engines.node",
    });
    for (const range of ["24", ">=22", "lts/*", "^24.1.0"]) {
      expect(detected(probeOf({}, { ".node-version": range })).node?.version).toBeNull();
    }
  });

  it("keeps every manager of a lockfile conflict, so the box can run either", () => {
    const both = detected(probeOf({}, {}, ["bun.lock", "pnpm-lock.yaml"]));
    expect(Object.keys(both).toSorted()).toEqual(["bun", "node", "pnpm"]);
  });

  it("reads only exact versions", () => {
    expect(exactVersion("1.4.2")).toBe("1.4.2");
    expect(exactVersion(" v1.4.2\n")).toBe("1.4.2");
    expect(exactVersion("bun-v1.4.2")).toBe("1.4.2");
    for (const text of ["1.4", "latest", "^1.4.2", "1.4.2-canary.1", "", undefined, null]) {
      expect(exactVersion(text)).toBeNull();
    }
  });
});
