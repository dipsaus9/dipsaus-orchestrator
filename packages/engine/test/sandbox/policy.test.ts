// Policy translation for install and verify, on the darwin and linux path rules (DIPO-37). The
// translated files are compared with golden files; `DIPO_UPDATE_GOLDEN=1` rewrites them (run
// `bun run format:fix` after).

import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";

import type { DipoPlatform } from "../../src/platform/paths";
import {
  coveringDenies,
  DENY_ALL_SETTINGS,
  denyMatches,
  expandHome,
  globRoot,
  linuxLiteralPath,
  translatePolicy,
  trustViolations,
  writableRoots,
  type SandboxRun,
  type StepPolicyKind,
} from "../../src/sandbox/policy";

const GOLDEN = join(import.meta.dir, "golden");

function run(platform: DipoPlatform, kind: StepPolicyKind): SandboxRun {
  return {
    platform,
    kind,
    home: "/home/maintainer",
    uid: 1000,
    mainCheckout: "/src/product",
    worktree: "/src/product.worktrees/PROD-7",
    tempRoot: "/tmp/dipo-s-AbC123",
    dipoDirs: ["/home/maintainer/.local/state/dipo", "/run/user/1000/dipo"],
    sshAuthSock: "/tmp/ssh-XyZ/agent.42",
    tools: { rg: "/usr/bin/rg", bwrap: "/usr/bin/bwrap", socat: "/usr/bin/socat" },
    installCachePaths: ["~/.bun/install/cache", "~/.npm/**", "/opt/cache/*.tmp", "~/.cache"],
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

  it("denies reading the secrets, dipo's own directories and the agent and daemon sockets", () => {
    const { settings } = translatePolicy(run("linux", "verify"));
    expect(settings.filesystem.denyRead).toEqual([
      "/home/maintainer/.ssh",
      "/home/maintainer/.aws",
      "/home/maintainer/.config/gh",
      "/home/maintainer/.gnupg",
      "/home/maintainer/.netrc",
      "/home/maintainer/.npmrc",
      "/home/maintainer/.git-credentials",
      "/home/maintainer/.claude",
      "/home/maintainer/.docker",
      "/home/maintainer/.kube",
      "/home/maintainer/.local/state/dipo",
      "/run/user/1000/dipo",
      "/run/user/1000",
      "/var/run/docker.sock",
      "/run/docker.sock",
      "/tmp/ssh-*",
      "/tmp/ssh-XyZ",
    ]);
  });

  it("denies the agent socket itself when its directory holds the temp root", () => {
    const { settings, warnings } = translatePolicy({
      ...run("darwin", "verify"),
      sshAuthSock: "/tmp/agent.sock",
    });
    expect(settings.filesystem.denyRead).toContain("/tmp/agent.sock");
    expect(settings.filesystem.denyRead).not.toContain("/tmp");
    expect(warnings).toEqual([]);
  });

  it("keeps a dipo directory that covers the temp root, for sandbox-exec to refuse", () => {
    const { settings } = translatePolicy({ ...run("linux", "verify"), dipoDirs: ["/tmp"] });
    expect(settings.filesystem.denyRead).toContain("/tmp");
    expect(
      coveringDenies(settings.filesystem.denyRead, [
        { label: "temp root", spellings: ["/tmp/dipo-s-AbC123"] },
      ]),
    ).toEqual(["denyRead /tmp covers the temp root /tmp/dipo-s-AbC123"]);
  });

  it("pins rg on both platforms and bwrap and socat on Linux", () => {
    const linux = translatePolicy(run("linux", "verify")).settings;
    expect(linux.ripgrep).toEqual({ command: "/usr/bin/rg" });
    expect(linux.bwrapPath).toBe("/usr/bin/bwrap");
    expect(linux.socatPath).toBe("/usr/bin/socat");
    const darwin = translatePolicy(run("darwin", "verify")).settings;
    expect(darwin.ripgrep).toEqual({ command: "/usr/bin/rg" });
    expect(darwin.bwrapPath).toBeUndefined();
  });

  it("closes the network for verify and opens only the registry hosts for install", () => {
    const verify = translatePolicy(run("darwin", "verify")).settings.network;
    expect(verify.allowedDomains).toEqual([]);
    expect(verify.strictAllowlist).toBe(true);
    const install = translatePolicy(run("darwin", "install")).settings.network;
    expect(install.allowedDomains).toEqual(["registry.npmjs.org", "*.npmjs.org"]);
    expect(install.strictAllowlist).toBe(true);
  });

  it("adds the install caches, with ~ expanded, to the writes of install only", () => {
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

describe("writableRoots", () => {
  it("lists allowWrite roots up to their first glob and srt's default write paths", () => {
    const roots = writableRoots(translatePolicy(run("darwin", "install")).settings, ["/h"]);
    expect(roots.map((root) => root.path)).toEqual([
      "/src/product.worktrees/PROD-7",
      "/tmp/dipo-s-AbC123",
      "/home/maintainer/.bun/install/cache",
      "/home/maintainer/.npm",
      "/opt/cache",
      "/home/maintainer/.cache",
      "/tmp/claude",
      "/private/tmp/claude",
      "/h/.claude/debug",
      "/h/.npm/_logs",
    ]);
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
});

describe("denyMatches and coveringDenies", () => {
  it("matches paths at or under a literal deny and globs per segment", () => {
    expect(denyMatches("/run/user/1000", "/run/user/1000/dipo")).toBe(true);
    expect(denyMatches("/run/user/1000", "/run/user/10000")).toBe(false);
    expect(denyMatches("/tmp/ssh-*", "/tmp/ssh-AbC/agent.1")).toBe(true);
    expect(denyMatches("/tmp/ssh-*", "/tmp/dipo-s-AbC")).toBe(false);
    expect(denyMatches("/tmp/ssh-*", "/tmp")).toBe(false);
  });

  it("finds nothing for the default policy of a step", () => {
    const { settings } = translatePolicy(run("linux", "install"));
    const roots = [
      { label: "working directory", spellings: ["/src/product.worktrees/PROD-7"] },
      { label: "temp root", spellings: ["/tmp/dipo-s-AbC123"] },
      ...settings.filesystem.allowWrite.map((path) => ({ label: "write path", spellings: [path] })),
    ];
    expect(coveringDenies(settings.filesystem.denyRead, roots)).toEqual([]);
  });
});
