// install.sh (0016 rule 7) run with /bin/sh against local fake releases. PATH holds only a sandbox
// bin directory: links to the few real tools the script needs, plus stubs for `uname`, `curl`,
// `ldd`, `sysctl` and, when a test wants it, `gh`. Nothing touches the network or ~/.local/bin;
// every file lives under a temp directory below DIPO_TMP (0017).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { makeTempDir, removeTempDir } from "../../packages/testkit/src/temp";

const INSTALL_SH = resolve(import.meta.dir, "../../install.sh");
const RELEASES = "https://github.com/dipsaus9/dipsaus-orchestrator/releases/";
const PINNED_VERIFY = [
  "attestation verify",
  "--repo dipsaus9/dipsaus-orchestrator",
  "--signer-workflow dipsaus9/dipsaus-orchestrator/.github/workflows/release.yml",
  "--source-ref refs/heads/main",
];

/** Real tools install.sh may call. Missing ones (sha256sum on macOS) are skipped. */
const REAL_TOOLS = [
  "awk",
  "cat",
  "chmod",
  "cp",
  "cut",
  "dirname",
  "grep",
  "gzip",
  "mkdir",
  "mktemp",
  "mv",
  "rm",
  "sh",
  "sha256sum",
  "shasum",
  "tar",
];

const STUBS: Record<string, string> = {
  uname: `#!/bin/sh
case "$1" in
  -s) echo "$FAKE_UNAME_S" ;;
  -m) echo "$FAKE_UNAME_M" ;;
  *) exit 2 ;;
esac
`,
  // Serves "<RELEASES><path>" from "$FAKE_RELEASES/<path>"; logs every URL.
  curl: `#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --proto|--tlsv1.2|-fsSL) [ "$1" = --proto ] && shift; shift ;;
    *) url="$1"; shift ;;
  esac
done
echo "$url" >> "$FAKE_LOG"
path="\${url#${RELEASES}}"
[ "$path" != "$url" ] || exit 6
[ -f "$FAKE_RELEASES/$path" ] || exit 22
cp "$FAKE_RELEASES/$path" "$out"
`,
  ldd: `#!/bin/sh
echo "$FAKE_LDD"
`,
  sysctl: `#!/bin/sh
[ "$1 $2" = "-n sysctl.proc_translated" ] || exit 1
[ -n "$FAKE_TRANSLATED" ] || exit 1
echo "$FAKE_TRANSLATED"
`,
};

const GH_STUB = `#!/bin/sh
echo "gh $*" >> "$FAKE_LOG"
exit "\${FAKE_GH_EXIT:-0}"
`;

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

const ASSETS = ["dipo-linux-arm64.tar.gz", "dipo-linux-x64.tar.gz", "dipo-darwin-arm64.tar.gz"];

// Shared by every test: the sandbox bin directories and one fake archive per asset, built once.
let shared = "";
let bin = "";
let ghBin = "";
let archives = "";

beforeAll(() => {
  shared = makeTempDir();
  bin = join(shared, "bin");
  ghBin = join(shared, "gh-bin");
  archives = join(shared, "archives");
  mkdirSync(bin);
  mkdirSync(ghBin);
  mkdirSync(archives);
  for (const tool of REAL_TOOLS) {
    const found = Bun.which(tool, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
    if (found !== null) symlinkSync(found, join(bin, tool));
  }
  for (const [name, content] of Object.entries(STUBS)) writeExecutable(join(bin, name), content);
  writeExecutable(join(ghBin, "gh"), GH_STUB);
  for (const asset of ASSETS) {
    const stage = join(shared, `stage-${asset}`);
    mkdirSync(stage);
    writeExecutable(join(stage, "dipo"), `#!/bin/sh\necho "dipo fake ${asset}"\n`);
    writeFileSync(join(stage, "LICENSE"), "MIT\n");
    writeFileSync(join(stage, "README.md"), "# dipo\n");
    const result = Bun.spawnSync(
      ["tar", "-czf", join(archives, asset), "dipo", "LICENSE", "README.md"],
      { cwd: stage, stdout: "pipe", stderr: "pipe" },
    );
    if (result.exitCode !== 0) throw new Error(`tar: ${result.stderr.toString()}`);
  }
});

afterAll(() => {
  removeTempDir(shared);
});

// Per test: a home, a TMPDIR, the fake release tree and the curl/gh log.
let dir = "";
let releases = "";
let installDir = "";
let log = "";

beforeEach(() => {
  dir = makeTempDir();
  releases = join(dir, "releases");
  installDir = join(dir, "home", ".local", "bin");
  log = join(dir, "log");
  mkdirSync(join(dir, "home"));
  mkdirSync(join(dir, "tmp"));
  writeFileSync(log, "");
});

afterEach(() => {
  removeTempDir(dir);
});

function sha256(path: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}

/** Publishes a fake release under `releasePath` (`latest/download` or `download/<tag>`). */
function publish(releasePath: string, asset: string, options: { badSum?: boolean } = {}): void {
  const target = join(releases, releasePath);
  mkdirSync(target, { recursive: true });
  copyFileSync(join(archives, asset), join(target, asset));
  const sum = options.badSum === true ? "0".repeat(64) : sha256(join(target, asset));
  writeFileSync(
    join(target, "SHA256SUMS"),
    `${"1".repeat(64)}  dipo-other.tar.gz\n${sum}  ${asset}\n`,
  );
}

type Run = { code: number; stdout: string; stderr: string; log: string };

function install(env: Record<string, string>, options: { gh?: boolean; path?: string } = {}): Run {
  const path = [bin, ...(options.gh === true ? [ghBin] : [])].join(":");
  const result = Bun.spawnSync(["/bin/sh", INSTALL_SH], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: options.path === undefined ? path : `${path}:${options.path}`,
      HOME: join(dir, "home"),
      TMPDIR: join(dir, "tmp"),
      FAKE_RELEASES: releases,
      FAKE_LOG: log,
      FAKE_UNAME_S: "Linux",
      FAKE_UNAME_M: "x86_64",
      FAKE_LDD: "ldd (GNU libc) 2.39",
      ...env,
    },
  });
  return {
    code: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    log: readFileSync(log, "utf8"),
  };
}

/** True when `path` holds nothing but (at most) `dipo`: no temporary file was left behind. */
function onlyDipoIn(path: string): boolean {
  return readdirSync(path).every((name) => name === "dipo");
}

describe("install.sh", () => {
  it("installs the latest release for the host to ~/.local/bin and prints the attestation command without gh", () => {
    publish("latest/download", "dipo-linux-arm64.tar.gz");
    const result = install({ FAKE_UNAME_M: "aarch64" });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.log).toBe(
      `${RELEASES}latest/download/dipo-linux-arm64.tar.gz\n${RELEASES}latest/download/SHA256SUMS\n`,
    );
    expect(result.stdout).toContain("dipo fake dipo-linux-arm64.tar.gz");
    expect(result.stdout).toContain(
      `gh attestation verify dipo-linux-arm64.tar.gz ${PINNED_VERIFY.slice(1).join(" ")}`,
    );
    expect(result.stdout).toContain("is not on your PATH");
    expect(statSync(join(installDir, "dipo")).mode & 0o777).toBe(0o755);
    expect(onlyDipoIn(installDir)).toBe(true);
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
  });

  it("honours DIPO_VERSION and DIPO_INSTALL_DIR, runs the pinned gh check and replaces dipo by rename", () => {
    // An x64 shell under Rosetta 2 on Apple silicon still gets the arm64 build.
    publish("download/v0.3.0", "dipo-darwin-arm64.tar.gz");
    const target = join(dir, "custom");
    mkdirSync(target);
    writeExecutable(join(target, "dipo"), "#!/bin/sh\necho old\n");
    const oldInode = statSync(join(target, "dipo")).ino;
    const result = install(
      {
        DIPO_VERSION: "v0.3.0",
        DIPO_INSTALL_DIR: target,
        FAKE_UNAME_S: "Darwin",
        FAKE_UNAME_M: "x86_64",
        FAKE_TRANSLATED: "1",
      },
      { gh: true, path: target },
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const lines = result.log.trim().split("\n");
    expect(lines[0]).toBe(`${RELEASES}download/v0.3.0/dipo-darwin-arm64.tar.gz`);
    const gh = lines.find((line) => line.startsWith("gh "));
    expect(gh).toBeDefined();
    expect(gh).toContain("/dipo-darwin-arm64.tar.gz ");
    for (const part of PINNED_VERIFY) expect(gh).toContain(part);
    expect(result.stdout).toContain("dipo fake dipo-darwin-arm64.tar.gz");
    expect(result.stdout).not.toContain("is not on your PATH");
    // A rename gives the path a new inode; a running process keeps the old file.
    expect(statSync(join(target, "dipo")).ino).not.toBe(oldInode);
    expect(onlyDipoIn(target)).toBe(true);
    expect(existsSync(installDir)).toBe(false);
  });

  it("stops without installing when the attestation does not verify", () => {
    publish("latest/download", "dipo-linux-x64.tar.gz");
    const result = install({ FAKE_GH_EXIT: "1" }, { gh: true });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("attestation verification failed");
    expect(existsSync(installDir)).toBe(false);
  });

  it("stops without installing on a checksum mismatch", () => {
    publish("latest/download", "dipo-linux-x64.tar.gz", { badSum: true });
    const result = install({});
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("checksum mismatch");
    expect(existsSync(installDir)).toBe(false);
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
  });

  it("stops when SHA256SUMS has no entry for the archive", () => {
    publish("latest/download", "dipo-linux-x64.tar.gz");
    writeFileSync(join(releases, "latest/download/SHA256SUMS"), `${"1".repeat(64)}  other\n`);
    const result = install({});
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("SHA256SUMS has no entry for dipo-linux-x64.tar.gz");
    expect(existsSync(installDir)).toBe(false);
  });

  it.each([
    ["Windows", { FAKE_UNAME_S: "MINGW64_NT-10.0" }, "Windows is not supported"],
    ["musl", { FAKE_LDD: "musl libc (x86_64)" }, "musl-based Linux"],
    ["an unknown architecture", { FAKE_UNAME_M: "riscv64" }, "unsupported architecture: riscv64"],
    ["a malformed DIPO_VERSION", { DIPO_VERSION: "v1/../x" }, "DIPO_VERSION must be a release tag"],
  ])("refuses %s before downloading anything", (_name, env, message) => {
    const result = install(env);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(result.log).toBe("");
  });
});
