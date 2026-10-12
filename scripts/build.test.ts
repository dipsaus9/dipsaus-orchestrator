import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildCommand,
  buildDefines,
  dipoVersion,
  ENTRYPOINTS,
  EXTERNALS,
  hostTarget,
  ROOT,
  TARGETS,
} from "./build";

// Temp files only under DIPO_TMP (0017), falling back to /tmp.
const TMP_ROOT = process.env["DIPO_TMP"] || "/tmp";

const clean = { commit: "3f2a9c1e7b20", dirty: false, commitDate: "2026-11-02" };

describe("dipoVersion", () => {
  it("appends -dev outside a release", () => {
    expect(dipoVersion("0.3.0", false)).toBe("0.3.0-dev");
  });

  it("keeps the package.json version for a release", () => {
    expect(dipoVersion("0.3.0", true)).toBe("0.3.0");
  });
});

describe("buildDefines", () => {
  it("defines version, commit and commit date as string literals", () => {
    expect(buildDefines("0.3.0", true, clean)).toEqual({
      DIPO_VERSION: '"0.3.0"',
      DIPO_COMMIT: '"3f2a9c1e7b20"',
      DIPO_COMMIT_DATE: '"2026-11-02"',
    });
  });

  it("marks a dirty tree with -dirty", () => {
    expect(buildDefines("0.0.0", false, { ...clean, dirty: true })).toEqual({
      DIPO_VERSION: '"0.0.0-dev"',
      DIPO_COMMIT: '"3f2a9c1e7b20-dirty"',
      DIPO_COMMIT_DATE: '"2026-11-02"',
    });
  });
});

describe("buildCommand", () => {
  const command = buildCommand({
    target: "bun-linux-arm64",
    outfile: "dist/dipo",
    defines: buildDefines("0.0.0", false, clean),
    bun: "bun",
  });

  it("compiles packages/cli for the target with the defines", () => {
    expect(command.slice(0, 4)).toEqual(["bun", "build", "--compile", "--target=bun-linux-arm64"]);
    expect(command).toContain("--outfile=dist/dipo");
    expect(command).toContain('--define=DIPO_VERSION="0.0.0-dev"');
    expect(command).toContain('--define=DIPO_COMMIT="3f2a9c1e7b20"');
    expect(command).toContain('--define=DIPO_COMMIT_DATE="2026-11-02"');
    expect(command.at(-ENTRYPOINTS.length)).toBe("packages/cli/src/main.ts");
  });

  it("passes the self-check worker as an extra entrypoint below the build root", () => {
    expect(ENTRYPOINTS).toContain("packages/engine/src/platform/self-check-worker.ts");
    expect(ENTRYPOINTS).toContain("packages/engine/src/platform/sqlite-worker.ts");
    expect(command).toContain(`--root=${ROOT}`);
    for (const entry of ENTRYPOINTS) expect(entry.startsWith(`${ROOT}/`)).toBe(true);
  });

  it("leaves only react-devtools-core unresolved", () => {
    expect(EXTERNALS).toEqual(["react-devtools-core"]);
    expect(command.filter((arg) => arg.startsWith("--external"))).toEqual([
      "--external=react-devtools-core",
    ]);
  });
});

describe("hostTarget", () => {
  it("maps supported hosts to the four targets", () => {
    expect(hostTarget("darwin", "arm64")).toBe("bun-darwin-arm64");
    expect(hostTarget("linux", "x64")).toBe("bun-linux-x64");
    expect(TARGETS).toHaveLength(4);
  });

  it("refuses an unsupported host", () => {
    expect(() => hostTarget("win32", "x64")).toThrow("no dipo target");
  });
});

// Bundles one source file with the build's externals, without --compile so the check stays fast.
function bundle(source: string): number {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, "dipo-build-"));
  try {
    writeFileSync(join(dir, "entry.ts"), source);
    const result = Bun.spawnSync(
      [
        process.execPath,
        "build",
        "--target=bun",
        ...EXTERNALS.map((name) => `--external=${name}`),
        `--outdir=${join(dir, "out")}`,
        join(dir, "entry.ts"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    return result.exitCode;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("unresolved imports", () => {
  it("fail the build", () => {
    expect(bundle('import x from "dipo-no-such-package";\nconsole.log(x);\n')).not.toBe(0);
  });

  it("are allowed for react-devtools-core", () => {
    expect(bundle('import x from "react-devtools-core";\nconsole.log(x);\n')).toBe(0);
  });
});
