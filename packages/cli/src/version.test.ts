import { describe, expect, it } from "bun:test";

import { compiledStamp, formatVersion, formatVersionJson, versionInfo } from "./version";

const runtime = { bun: "1.4.3", os: "darwin", arch: "arm64" };

describe("version", () => {
  it("formats a build stamp", () => {
    const info = versionInfo(
      { version: "0.3.0", commit: "3f2a9c1e7b20", commitDate: "2026-11-02" },
      runtime,
    );
    expect(formatVersion(info)).toBe("dipo 0.3.0 (3f2a9c1e7b20 2026-11-02) bun 1.4.3 darwin-arm64");
  });

  it("keeps the -dirty marker of a dirty tree", () => {
    const info = versionInfo(
      { version: "0.0.0-dev", commit: "3f2a9c1e7b20-dirty", commitDate: "2026-11-02" },
      { bun: "1.4.2", os: "linux", arch: "x64" },
    );
    expect(formatVersion(info)).toBe(
      "dipo 0.0.0-dev (3f2a9c1e7b20-dirty 2026-11-02) bun 1.4.2 linux-x64",
    );
  });

  it("falls back to dev (unknown commit) without a build stamp", () => {
    expect(formatVersion(versionInfo(undefined, runtime))).toBe(
      "dipo dev (unknown commit) bun 1.4.3 darwin-arm64",
    );
  });

  it("prints the same fields as JSON", () => {
    const stamped = versionInfo(
      { version: "0.3.0", commit: "3f2a9c1e7b20", commitDate: "2026-11-02" },
      runtime,
    );
    expect(JSON.parse(formatVersionJson(stamped))).toEqual({
      name: "dipo",
      version: "0.3.0",
      commit: "3f2a9c1e7b20",
      commitDate: "2026-11-02",
      bun: "1.4.3",
      os: "darwin",
      arch: "arm64",
    });
    expect(JSON.parse(formatVersionJson(versionInfo(undefined, runtime)))).toMatchObject({
      version: "dev",
      commit: null,
      commitDate: null,
    });
  });

  it("has no build stamp when running from source", () => {
    expect(compiledStamp()).toBeUndefined();
  });
});
