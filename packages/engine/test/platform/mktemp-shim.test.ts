// The macOS mktemp shim (DIPO-200): built around a recording fake in place of /usr/bin/mktemp, it
// adds -p "$TMPDIR" to a call without a template and passes every other call unchanged; the shim
// directory leads the step's PATH on darwin only, is vetted by the trust check and is removed again.

import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { mktempShimText, prepareStepDir, removeStepDir } from "../../src/platform/mktemp-shim";
import { checkTrust } from "../../src/platform/sandbox";

/** A fake `mktemp` that records its arguments, one per line. */
function fakeMktemp(dir: string): { path: string; calls: () => string[] } {
  const path = join(dir, "real-mktemp");
  const record = join(dir, "calls");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\necho made\n`);
  chmodSync(path, 0o755);
  return {
    path,
    calls: () => readFileSync(record, "utf8").split("\n").slice(0, -1),
  };
}

async function runShim(dir: string, args: string[], env: Record<string, string> = {}) {
  const real = fakeMktemp(dir);
  const shim = join(dir, "shim");
  writeFileSync(shim, mktempShimText(real.path), { mode: 0o755 });
  const child = Bun.spawn({
    cmd: ["/bin/sh", shim, ...args],
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", TMPDIR: "/step/tmp", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
  expect((await new Response(child.stdout).text()).trim()).toBe("made");
  return real.calls();
}

describe("mktempShimText", () => {
  const P = ["-p", "/step/tmp"];
  const added: [string, string[], string[]][] = [
    ["no arguments", [], P],
    ["-d", ["-d"], [...P, "-d"]],
    ["-q", ["-q"], [...P, "-q"]],
    ["-u", ["-u"], [...P, "-u"]],
    ["-dq", ["-dq"], [...P, "-dq"]],
    ["-t prefix", ["-t", "pre"], [...P, "-t", "pre"]],
    ["-dt prefix", ["-dt", "pre"], [...P, "-dt", "pre"]],
    ["-tpre", ["-tpre"], [...P, "-tpre"]],
    // Long forms macOS mktemp accepts without a template.
    ["--directory", ["--directory"], [...P, "--directory"]],
    ["--quiet --dry-run", ["--quiet", "--dry-run"], [...P, "--quiet", "--dry-run"]],
  ];
  for (const [name, args, expected] of added) {
    it(`adds -p "$TMPDIR" for ${name}`, () =>
      withTempDir(async (dir) => {
        expect(await runShim(dir, args)).toEqual(expected);
      }));
  }

  const unchanged: [string, string[]][] = [
    ["a template", ["/x/tmp.XXXXXX"]],
    ["a relative template", ["tmp.XXXXXX"]],
    ["a template after -d", ["-d", "tmp.XXXXXX"]],
    ["an explicit -p dir", ["-p", "/other"]],
    ["an explicit -p dir with a template", ["-p", "/other", "tmp.XXXXXX"]],
    ["-p with -t", ["-t", "pre", "-p", "/other"]],
    ["-dp dir", ["-dp", "/other"]],
    ["a template after --", ["--", "tmp.XXXXXX"]],
    ["--tmpdir=dir", ["--tmpdir=/other", "--dry-run"]],
  ];
  for (const [name, args] of unchanged) {
    it(`passes ${name} unchanged, with no second -p`, () =>
      withTempDir(async (dir) => {
        expect(await runShim(dir, args)).toEqual(args);
      }));
  }

  it("passes the call unchanged when TMPDIR is empty", () =>
    withTempDir(async (dir) => {
      expect(await runShim(dir, ["-d"], { TMPDIR: "" })).toEqual(["-d"]);
    }));
});

async function prepare(dir: string, platform: "darwin" | "linux") {
  const base = join(dir, "base");
  await Bun.$`mkdir -p ${base}`.quiet();
  const writable = join(dir, "step-temp");
  const seen: (string | undefined)[] = [];
  const prepared = await prepareStepDir({
    platform,
    baseDir: base,
    path: "/usr/bin:/bin",
    trust: (PATH) => {
      seen.push(PATH);
      return checkTrust({
        settings: {
          network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
          filesystem: { denyRead: [], allowWrite: [writable], denyWrite: [] },
        },
        homes: [join(dir, "home")],
        PATH,
        tools: { rg: null, bwrap: null, socat: null },
        binary: process.execPath,
        code: [],
      });
    },
  });
  return { prepared, seen, base };
}

describe("prepareStepDir", () => {
  it("on darwin makes the shim first on PATH, read-only, and the trust check vets it", () =>
    withTempDir(async (dir) => {
      const { prepared, seen, base } = await prepare(dir, "darwin");
      const bin = join(prepared.privateDir, "bin");
      expect(prepared.privateDir.startsWith(join(base, "dipo-sx-"))).toBe(true);
      expect(prepared.path).toBe(`${bin}:/usr/bin:/bin`);
      // The trust check got the shim-prefixed PATH and finds the shim directory outside every write path.
      expect(seen).toEqual([prepared.path]);
      expect(prepared.distrust).toEqual([]);
      expect(statSync(join(bin, "mktemp")).mode & 0o777).toBe(0o555);
      expect(statSync(bin).mode & 0o222).toBe(0);
      await removeStepDir(prepared.privateDir);
      expect(existsSync(prepared.privateDir)).toBe(false);
    }));

  it("on darwin the trust check reports a shim directory under a writable path", () =>
    withTempDir(async (dir) => {
      const base = join(dir, "base");
      await Bun.$`mkdir -p ${base}`.quiet();
      const prepared = await prepareStepDir({
        platform: "darwin",
        baseDir: base,
        path: "/usr/bin",
        trust: (PATH) =>
          checkTrust({
            settings: {
              network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
              filesystem: { denyRead: [], allowWrite: [base], denyWrite: [] },
            },
            homes: [join(dir, "home")],
            PATH,
            tools: { rg: null, bwrap: null, socat: null },
            binary: process.execPath,
            code: [],
          }),
      });
      expect(prepared.distrust.join("\n")).toContain("PATH directory");
      await removeStepDir(prepared.privateDir);
    }));

  it("on linux leaves PATH unchanged and adds no shim", () =>
    withTempDir(async (dir) => {
      const { prepared, seen } = await prepare(dir, "linux");
      expect(prepared.path).toBe("/usr/bin:/bin");
      expect(seen).toEqual(["/usr/bin:/bin"]);
      expect(existsSync(join(prepared.privateDir, "bin"))).toBe(false);
      await removeStepDir(prepared.privateDir);
    }));

  it("removes the directory again when the trust check throws", () =>
    withTempDir(async (dir) => {
      const base = join(dir, "base");
      await Bun.$`mkdir -p ${base}`.quiet();
      await expect(
        prepareStepDir({
          platform: "darwin",
          baseDir: base,
          path: undefined,
          trust: () => Promise.reject(new Error("boom")),
        }),
      ).rejects.toThrow("boom");
      expect(
        await Array.fromAsync(new Bun.Glob("*").scan({ cwd: base, onlyFiles: false })),
      ).toEqual([]);
    }));
});
