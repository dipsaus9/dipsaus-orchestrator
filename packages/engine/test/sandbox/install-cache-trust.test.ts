// The trust check over `sandbox.installCachePaths` (0008 amendment of 2026-10-12): an install step
// may write the caches, so a cache that holds a PATH directory or the running dipo or bun binary
// refuses the step. The paths do not exist, so no spelling differs from the one given.

import { describe, expect, it } from "bun:test";

import { OFFICE_DEFAULTS } from "../../src/config";
import { checkTrust } from "../../src/platform/sandbox";
import { translatePolicy, type StepPolicyKind } from "../../src/sandbox/policy";

const HOME = "/nonexistent-dipo-test/home";
const BUN_BIN = `${HOME}/.bun/bin`;
const PATH = `${BUN_BIN}:/usr/bin:/bin`;

function trust(
  installCachePaths: readonly string[],
  options: { kind?: StepPolicyKind; binary?: string; PATH?: string } = {},
) {
  const { settings } = translatePolicy({
    platform: "darwin",
    kind: options.kind ?? "install",
    home: HOME,
    uid: 1000,
    mainCheckout: "/nonexistent-dipo-test/product",
    worktree: "/nonexistent-dipo-test/product.worktrees/PROD-7",
    tempRoot: "/nonexistent-dipo-test/tmp/dipo-s-AbC123",
    dipoDirs: [],
    installCachePaths,
    registryHosts: ["registry.npmjs.org"],
  });
  return checkTrust({
    settings,
    homes: [HOME],
    PATH: options.PATH ?? PATH,
    tools: { rg: "/usr/bin/rg", bwrap: null, socat: null },
    binary: options.binary ?? `${BUN_BIN}/bun`,
    code: [],
  });
}

describe("install cache trust check", () => {
  it("passes the default install caches with bun on PATH under ~/.bun/bin", async () => {
    expect(await trust(OFFICE_DEFAULTS.sandbox.installCachePaths)).toEqual([]);
  });

  it("never writes the toolchain read list", async () => {
    const { settings } = translatePolicy({
      platform: "darwin",
      kind: "install",
      home: HOME,
      uid: 1000,
      mainCheckout: "/nonexistent-dipo-test/product",
      worktree: "/nonexistent-dipo-test/product.worktrees/PROD-7",
      tempRoot: "/nonexistent-dipo-test/tmp/dipo-s-AbC123",
      dipoDirs: [],
      installCachePaths: OFFICE_DEFAULTS.sandbox.installCachePaths,
      registryHosts: [],
    });
    expect(settings.filesystem.allowWrite).toEqual([
      "/nonexistent-dipo-test/product.worktrees/PROD-7",
      "/nonexistent-dipo-test/tmp/dipo-s-AbC123",
      `${HOME}/.bun/install/cache`,
      `${HOME}/.npm/_cacache`,
    ]);
    expect(settings.filesystem.allowWrite).not.toContain(`${HOME}/.cache`);
  });

  it("refuses a cache that holds the running bun binary and a PATH directory", async () => {
    expect(await trust(["~/.bun"])).toEqual([
      `the dipo binary ${BUN_BIN}/bun is writable by the step (allowWrite ${HOME}/.bun)`,
      `PATH directory ${BUN_BIN} is writable by the step (allowWrite ${HOME}/.bun)`,
    ]);
  });

  it("refuses a cache that holds the compiled dipo binary", async () => {
    const reasons = await trust(["/opt/dipo"], { binary: "/opt/dipo/bin/dipo" });
    expect(reasons).toEqual([
      "the dipo binary /opt/dipo/bin/dipo is writable by the step (allowWrite /opt/dipo)",
    ]);
  });

  it("refuses an absolute cache that holds a PATH directory", async () => {
    const reasons = await trust(["/opt/tools"], { PATH: `/opt/tools/bin:${PATH}` });
    expect(reasons).toEqual([
      "PATH directory /opt/tools/bin is writable by the step (allowWrite /opt/tools)",
    ]);
  });

  it("ignores the install caches for verify, which writes none", async () => {
    expect(await trust(["~/.bun"], { kind: "verify" })).toEqual([]);
  });
});
