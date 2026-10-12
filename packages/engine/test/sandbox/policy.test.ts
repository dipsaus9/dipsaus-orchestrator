// Policy translation for install and verify, on the darwin and linux path rules (DIPO-37). The
// translated files are compared with golden files; `DIPO_UPDATE_GOLDEN=1` rewrites them (run
// `bun run format:fix` after).

import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";

import type { DipoPlatform } from "../../src/platform/paths";
import {
  DENY_ALL_SETTINGS,
  expandHome,
  linuxLiteralPath,
  translatePolicy,
  type SandboxRun,
  type StepPolicyKind,
} from "../../src/sandbox/policy";

const GOLDEN = join(import.meta.dir, "golden");

function run(platform: DipoPlatform, kind: StepPolicyKind): SandboxRun {
  return {
    platform,
    kind,
    home: "/home/maintainer",
    mainCheckout: "/src/product",
    worktree: "/src/product.worktrees/PROD-7",
    tempRoot: "/tmp/dipo-s-AbC123",
    toolchainPaths: ["~/.bun/install/cache", "~/.npm/**", "/opt/cache/*.tmp", "~/.cache"],
    registryHosts: ["registry.npmjs.org", "*.npmjs.org"],
  };
}

describe("translatePolicy golden files", () => {
  for (const platform of ["darwin", "linux"] as const) {
    for (const kind of ["install", "verify"] as const) {
      it(`${platform} ${kind}`, () => {
        const translated = translatePolicy(run(platform, kind));
        const text = `${JSON.stringify(translated, null, 2)}\n`;
        const file = join(GOLDEN, `${platform}-${kind}.json`);
        if (process.env["DIPO_UPDATE_GOLDEN"] === "1") writeFileSync(file, text);
        // Compared as values: oxfmt formats the golden files.
        expect(translated).toEqual(JSON.parse(readFileSync(file, "utf8")));
        // The file is one srt 0.0.79 accepts.
        expect(SandboxRuntimeConfigSchema.safeParse(translated.settings).success).toBe(true);
      });
    }
  }
});

describe("translatePolicy", () => {
  it("allows writes to the worktree and the temp root and denies both .git paths", () => {
    const { settings } = translatePolicy(run("darwin", "verify"));
    expect(settings.filesystem.allowWrite).toEqual([
      "/src/product.worktrees/PROD-7",
      "/tmp/dipo-s-AbC123",
    ]);
    expect(settings.filesystem.denyWrite).toEqual([
      "/src/product/.git",
      "/src/product.worktrees/PROD-7/.git",
    ]);
  });

  it("denies reading the secret paths of 0008 under the given home", () => {
    const { settings } = translatePolicy(run("linux", "verify"));
    expect(settings.filesystem.denyRead).toEqual([
      "/home/maintainer/.ssh",
      "/home/maintainer/.aws",
      "/home/maintainer/.config/gh",
      "/home/maintainer/.gnupg",
      "/home/maintainer/.netrc",
    ]);
  });

  it("closes the network for verify and opens only the registry hosts for install", () => {
    const verify = translatePolicy(run("darwin", "verify")).settings.network;
    expect(verify.allowedDomains).toEqual([]);
    expect(verify.strictAllowlist).toBe(true);
    const install = translatePolicy(run("darwin", "install")).settings.network;
    expect(install.allowedDomains).toEqual(["registry.npmjs.org", "*.npmjs.org"]);
    expect(install.strictAllowlist).toBe(true);
  });

  it("adds the toolchain paths, with ~ expanded, to the writes of install only", () => {
    const install = translatePolicy(run("darwin", "install")).settings.filesystem.allowWrite;
    expect(install).toContain("/home/maintainer/.bun/install/cache");
    expect(install).toContain("/home/maintainer/.npm/**");
    const verify = translatePolicy(run("darwin", "verify")).settings.filesystem.allowWrite;
    expect(verify.some((path) => path.startsWith("/home/maintainer"))).toBe(false);
  });

  it("allows Unix sockets under the temp root on macOS, and all of them on Linux", () => {
    const darwin = translatePolicy(run("darwin", "verify")).settings.network;
    expect(darwin.allowUnixSockets).toEqual(["/tmp/dipo-s-AbC123"]);
    expect(darwin.allowAllUnixSockets).toBeUndefined();
    const linux = translatePolicy(run("linux", "verify")).settings.network;
    expect(linux.allowAllUnixSockets).toBe(true);
    expect(linux.allowUnixSockets).toBeUndefined();
  });

  it("makes Linux write paths literal and warns about each skipped glob", () => {
    const { settings, warnings } = translatePolicy(run("linux", "install"));
    expect(settings.filesystem.allowWrite).toContain("/home/maintainer/.npm");
    expect(settings.filesystem.allowWrite).not.toContain("/opt/cache/*.tmp");
    expect(warnings).toEqual([
      "allowWrite: skipped /opt/cache/*.tmp (a glob; Linux takes literal paths only)",
    ]);
    expect(translatePolicy(run("darwin", "install")).warnings).toEqual([]);
  });

  it("lists a path once when the worktree is the main checkout", () => {
    const { settings } = translatePolicy({
      ...run("darwin", "verify"),
      worktree: "/src/product",
    });
    expect(settings.filesystem.denyWrite).toEqual(["/src/product/.git"]);
  });

  it("has a deny-all settings file srt accepts", () => {
    expect(SandboxRuntimeConfigSchema.safeParse(DENY_ALL_SETTINGS).success).toBe(true);
  });
});

describe("expandHome", () => {
  it("expands ~ and ~/ only", () => {
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("~/.bun", "/h")).toBe("/h/.bun");
    expect(expandHome("~/.bun", "/h/")).toBe("/h/.bun");
    expect(expandHome("/opt/x", "/h")).toBe("/opt/x");
    expect(expandHome("~other/x", "/h")).toBe("~other/x");
  });
});

describe("linuxLiteralPath", () => {
  it("drops a trailing /** and refuses other globs", () => {
    expect(linuxLiteralPath("/a/b/**")).toBe("/a/b");
    expect(linuxLiteralPath("/a/b")).toBe("/a/b");
    expect(linuxLiteralPath("/a/*/c")).toBeNull();
    expect(linuxLiteralPath("/a/b?")).toBeNull();
    expect(linuxLiteralPath("/a/{b,c}")).toBeNull();
    expect(linuxLiteralPath("/a/**/c/**")).toBeNull();
  });
});
