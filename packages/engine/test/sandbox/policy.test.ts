// The sandbox policy checks that still run (DIPO-37, DIPO-240): `dipo daemon sandbox-exec` reads
// every root a settings file makes writable (`writableRoots`), refuses a program, binary or PATH
// directory under one (`trustViolations`) and a deny that covers a root it must reach
// (`coveringDenies`), with `~` expanded (`expandHome`). The settings it runs today are the
// Safe-Chain proxy's own sandbox (`safeChainProxyPolicy`, for the box package cache and the box
// web route); the step policies of the Mac worker path are gone, so these tests use the proxy's.

import { describe, expect, it } from "bun:test";

import {
  coveringDenies,
  denyMatches,
  expandHome,
  globRoot,
  trustViolations,
  writableRoots,
} from "../../src/sandbox/policy";
import { safeChainProxyLayout, safeChainProxyPolicy } from "../../src/sandbox/safe-chain-proxy";

const LAYOUT = safeChainProxyLayout("/tmp/dipo-p/AbC123");

function proxyPolicy(platform: "darwin" | "linux") {
  return safeChainProxyPolicy({
    platform,
    home: "/home/maintainer",
    uid: 1000,
    layout: LAYOUT,
    dipoReads: ["/home/maintainer/.local/bin/dipo"],
    dipoDirs: ["/home/maintainer/.local/state/dipo", "/run/user/1000/dipo"],
  });
}

describe("expandHome", () => {
  it("expands ~ and ~/ only", () => {
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("~/.bun", "/h")).toBe("/h/.bun");
    expect(expandHome("~/.bun", "/h/")).toBe("/h/.bun");
    expect(expandHome("/opt/x", "/h")).toBe("/opt/x");
    expect(expandHome("~other/x", "/h")).toBe("~other/x");
  });
});

describe("writableRoots", () => {
  it("lists the proxy's allowWrite roots and srt's default write paths", () => {
    const roots = writableRoots(proxyPolicy("darwin"), ["/h"]);
    expect(roots.map((root) => root.path)).toEqual([
      "/tmp/dipo-p/AbC123/sc",
      "/tmp/dipo-p/AbC123/tmp",
      "/tmp/dipo-p/AbC123/home",
      "/tmp/dipo-p/AbC123/out",
      "/tmp/dipo-p/AbC123/sock",
      "/tmp/claude",
      "/private/tmp/claude",
      "/h/.claude/debug",
      "/h/.npm/_logs",
    ]);
    expect(roots[0]?.source).toBe("allowWrite /tmp/dipo-p/AbC123/sc");
    expect(roots.at(-1)?.source).toBe("srt default write path");
  });

  it("never makes the holder directory on the proxy's PATH writable", () => {
    const roots = writableRoots(proxyPolicy("linux"), ["/home/maintainer"]);
    expect(roots.some((root) => LAYOUT.holders.startsWith(root.path))).toBe(false);
  });

  it("cuts a glob back to its literal directory", () => {
    expect(globRoot("/a/b/**")).toBe("/a/b");
    expect(globRoot("/a/b*/c")).toBe("/a");
    expect(globRoot("/a/b")).toBe("/a/b");
  });
});

describe("trustViolations", () => {
  const writable = [
    { spellings: ["/w/tree", "/private/w/tree"], source: "allowWrite /w/tree" },
    { spellings: ["/home/m/.bun"], source: "allowWrite ~/.bun" },
  ];

  it("passes programs, binary and PATH outside every writable root", () => {
    expect(
      trustViolations({
        writable,
        candidates: [
          { label: "rg", spellings: ["/usr/bin/rg"] },
          { label: "PATH directory", spellings: ["/w/treehouse"] },
        ],
        pathEntries: ["/usr/bin", "/w/treehouse"],
      }),
    ).toEqual([]);
  });

  it("refuses a program, binary or PATH directory under a writable root in any spelling", () => {
    expect(
      trustViolations({
        writable,
        candidates: [
          { label: "bwrap", spellings: ["/w/tree/bin/bwrap"] },
          { label: "the dipo binary", spellings: ["/home/m/.bun/bin/bun"] },
          { label: "PATH directory", spellings: ["/link/bin", "/private/w/tree/bin"] },
        ],
        pathEntries: ["/link/bin"],
      }),
    ).toEqual([
      "bwrap /w/tree/bin/bwrap is writable by the step (allowWrite /w/tree)",
      "the dipo binary /home/m/.bun/bin/bun is writable by the step (allowWrite ~/.bun)",
      "PATH directory /link/bin is writable by the step (allowWrite /w/tree)",
    ]);
  });

  it("refuses relative and empty PATH entries", () => {
    expect(
      trustViolations({ writable, candidates: [], pathEntries: ["bin", "", "/usr/bin"] }),
    ).toEqual(['PATH holds a relative entry "bin"', 'PATH holds a relative entry ""']);
  });

  it("refuses a PATH directory in the proxy's writable install, and passes its holder directory", () => {
    const roots = writableRoots(proxyPolicy("darwin"), ["/home/maintainer"]).map((root) => ({
      spellings: [root.path],
      source: root.source,
    }));
    expect(
      trustViolations({
        writable: roots,
        candidates: [
          { label: "PATH directory", spellings: [LAYOUT.holders] },
          { label: "PATH directory", spellings: [`${LAYOUT.tmp}/bin`] },
        ],
        pathEntries: [LAYOUT.holders, `${LAYOUT.tmp}/bin`],
      }),
    ).toEqual([
      `PATH directory ${LAYOUT.tmp}/bin is writable by the step (allowWrite ${LAYOUT.tmp})`,
    ]);
  });
});

describe("denyMatches and coveringDenies", () => {
  it("matches paths at or under a literal deny and globs per segment", () => {
    expect(denyMatches("/run/user/1000", "/run/user/1000/dipo")).toBe(true);
    expect(denyMatches("/run/user/1000", "/run/user/10000")).toBe(false);
    expect(denyMatches("/tmp/ssh-*", "/tmp/ssh-AbC/agent.1")).toBe(true);
    expect(denyMatches("/tmp/ssh-*", "/tmp/dipo-s-AbC")).toBe(false);
    expect(denyMatches("/tmp/ssh-*", "/tmp")).toBe(false);
  });

  it("finds nothing for the proxy's own sandbox on either platform", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const settings = proxyPolicy(platform);
      const roots = [
        { label: "proxy directory", spellings: [LAYOUT.dir] },
        ...settings.filesystem.allowWrite.map((path) => ({
          label: "write path",
          spellings: [path],
        })),
      ];
      expect(coveringDenies(settings.filesystem.denyRead, roots)).toEqual([]);
    }
  });

  it("finds a deny that covers a root the proxy must reach", () => {
    expect(
      coveringDenies(["/tmp/dipo-p"], [{ label: "proxy directory", spellings: [LAYOUT.dir] }])
        .length,
    ).toBe(1);
  });
});
