// `probeSandbox` judgement (DIPO-37 AC #7): rg on both platforms; bubblewrap 0.5 or newer, socat
// and an unrestricted user namespace on Linux.

import { describe, expect, it } from "bun:test";

import { parseOsRelease } from "../../src/platform/sandbox";
import { evaluateProbe, parseBwrapVersion, type SandboxFacts } from "../../src/sandbox/probe";

const DARWIN_OK: SandboxFacts = {
  platform: "darwin",
  rg: "/opt/homebrew/bin/rg",
  bwrap: null,
  socat: null,
  restrictUserns: null,
  os: null,
};

const LINUX_OK: SandboxFacts = {
  platform: "linux",
  rg: "/usr/bin/rg",
  bwrap: { path: "/usr/bin/bwrap", version: "bubblewrap 0.9.0" },
  socat: "/usr/bin/socat",
  restrictUserns: "0",
  os: { id: "ubuntu", versionId: "24.04" },
};

function reasons(facts: SandboxFacts): readonly string[] {
  const result = evaluateProbe(facts);
  return result.ok ? [] : result.reasons;
}

describe("evaluateProbe", () => {
  it("passes a complete macOS and Linux machine", () => {
    expect(evaluateProbe(DARWIN_OK)).toEqual({ ok: true });
    expect(evaluateProbe(LINUX_OK)).toEqual({ ok: true });
    expect(evaluateProbe({ ...LINUX_OK, restrictUserns: null, os: null })).toEqual({ ok: true });
  });

  it("reports a missing rg on macOS and on Linux", () => {
    expect(reasons({ ...DARWIN_OK, rg: null })).toEqual([
      "ripgrep (rg) is not installed or not on PATH",
    ]);
    expect(reasons({ ...LINUX_OK, rg: null })).toEqual([
      "ripgrep (rg) is not installed or not on PATH",
    ]);
  });

  it("does not ask for bubblewrap or socat on macOS", () => {
    expect(evaluateProbe({ ...DARWIN_OK, restrictUserns: "1" })).toEqual({ ok: true });
  });

  it("reports a missing bubblewrap and socat on Linux", () => {
    expect(reasons({ ...LINUX_OK, bwrap: null, socat: null })).toEqual([
      "bubblewrap (bwrap) is not installed or not on PATH",
      "socat is not installed or not on PATH",
    ]);
  });

  it("reports bubblewrap 0.4.1 as older than 0.5.0", () => {
    expect(
      reasons({ ...LINUX_OK, bwrap: { path: "/usr/bin/bwrap", version: "bubblewrap 0.4.1" } }),
    ).toEqual(["bubblewrap 0.4.1 is older than 0.5.0"]);
    expect(
      evaluateProbe({ ...LINUX_OK, bwrap: { path: "/usr/bin/bwrap", version: "bubblewrap 0.5" } }),
    ).toEqual({ ok: true });
  });

  it("reports an unreadable bubblewrap version", () => {
    expect(reasons({ ...LINUX_OK, bwrap: { path: "/usr/bin/bwrap", version: null } })).toEqual([
      "could not read the bubblewrap version at /usr/bin/bwrap",
    ]);
  });

  it("reports a user namespace stripped by AppArmor on Ubuntu 24.04", () => {
    expect(reasons({ ...LINUX_OK, restrictUserns: "1" })).toEqual([
      "unprivileged user namespaces are restricted by AppArmor on ubuntu 24.04 " +
        "(kernel.apparmor_restrict_unprivileged_userns=1), so bubblewrap cannot start",
    ]);
  });
});

describe("parseBwrapVersion", () => {
  it("reads major, minor and patch", () => {
    expect(parseBwrapVersion("bubblewrap 0.9.0")).toEqual([0, 9, 0]);
    expect(parseBwrapVersion("bubblewrap 0.4.1")).toEqual([0, 4, 1]);
    expect(parseBwrapVersion("bubblewrap 0.11")).toEqual([0, 11, 0]);
    expect(parseBwrapVersion("bubblewrap")).toBeNull();
  });
});

describe("parseOsRelease", () => {
  it("reads ID and VERSION_ID with or without quotes", () => {
    expect(parseOsRelease('NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n')).toEqual({
      id: "ubuntu",
      versionId: "24.04",
    });
    expect(parseOsRelease("ID=arch\n")).toEqual({ id: "arch", versionId: "" });
    expect(parseOsRelease("NAME=x\n")).toBeNull();
  });
});
