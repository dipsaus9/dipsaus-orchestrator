// Builds the single `dipo` binary (0004 "Tooling", 0016 rules 1, 5 and 6). CI smoke jobs and the
// release build run this same script.
//
// Usage: bun scripts/build.ts --target bun-<os>-<arch> [--release] [--outfile <path>]
//
//   --target   one of TARGETS; defaults to the host
//   --release  print the root package.json version as is; without it `-dev` is appended
//   --outfile  defaults to dist/dipo

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

export const TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
] as const;

export type Target = (typeof TARGETS)[number];

const REPO = resolve(import.meta.dir, "..");

/** Build root: every entrypoint keeps its path below it inside the binary. */
export const ROOT = "packages";

/** Entry of the binary, followed by every Bun Worker it starts (each must be its own entrypoint). */
export const ENTRYPOINTS = [
  "packages/cli/src/main.ts",
  "packages/engine/src/platform/self-check-worker.ts",
  "packages/engine/src/platform/sqlite-worker.ts",
] as const;

/**
 * Imports left unresolved on purpose. Ink loads its optional `react-devtools-core` peer only when
 * `DEV=true` and the package resolves, so the binary runs without it. Any other unresolved import
 * fails the build, which is `bun build`'s default.
 */
export const EXTERNALS = ["react-devtools-core"] as const;

export type GitState = { commit: string; dirty: boolean; commitDate: string };

export function isTarget(value: string): value is Target {
  return (TARGETS as readonly string[]).includes(value);
}

export function hostTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): Target {
  const target = `bun-${platform}-${arch}`;
  if (!isTarget(target)) throw new Error(`no dipo target for host ${platform}-${arch}`);
  return target;
}

/** The version printed by the binary: the package.json version, with `-dev` outside a release. */
export function dipoVersion(packageVersion: string, release: boolean): string {
  return release ? packageVersion : `${packageVersion}-dev`;
}

/** The `--define` constants read by `packages/cli/src/version.ts`. Values are JS literals. */
export function buildDefines(
  packageVersion: string,
  release: boolean,
  git: GitState,
): Record<string, string> {
  return {
    DIPO_VERSION: JSON.stringify(dipoVersion(packageVersion, release)),
    DIPO_COMMIT: JSON.stringify(git.dirty ? `${git.commit}-dirty` : git.commit),
    DIPO_COMMIT_DATE: JSON.stringify(git.commitDate),
  };
}

export function buildCommand(options: {
  target: Target;
  outfile: string;
  defines: Record<string, string>;
  bun?: string;
}): string[] {
  return [
    options.bun ?? process.execPath,
    "build",
    "--compile",
    `--target=${options.target}`,
    `--outfile=${options.outfile}`,
    // Fixes the worker's path inside the binary (engine COMPILED_WORKER_PATH).
    `--root=${ROOT}`,
    // Code splitting keeps Ink's devtools module, the only importer of the external
    // `react-devtools-core`, in a chunk that loads only when Ink enables devtools.
    "--splitting",
    ...EXTERNALS.map((name) => `--external=${name}`),
    ...Object.entries(options.defines).map(([key, value]) => `--define=${key}=${value}`),
    ...ENTRYPOINTS,
  ];
}

function runGit(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: REPO,
    env: { ...process.env, TZ: "UTC" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

export function readGitState(): GitState {
  return {
    commit: runGit(["rev-parse", "--short=12", "HEAD"]),
    // A dirty tree has changes to tracked files; untracked files do not count.
    dirty: runGit(["status", "--porcelain", "--untracked-files=no"]) !== "",
    // Commit date, not build time, so builds stay reproducible (0016 rule 5).
    commitDate: runGit(["show", "-s", "--format=%cd", "--date=format-local:%Y-%m-%d", "HEAD"]),
  };
}

function run(command: string[]): void {
  const result = Bun.spawnSync(command, { cwd: REPO, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited with ${result.exitCode}`);
  }
}

/** Ad hoc signs a darwin binary when `codesign -v` fails (0016 rule 6). */
function ensureSigned(outfile: string): void {
  const verify = Bun.spawnSync(["codesign", "-v", outfile], { stdout: "pipe", stderr: "pipe" });
  if (verify.exitCode === 0) return;
  console.log(`codesign -v failed; signing ${outfile} ad hoc`);
  run(["codesign", "--sign", "-", "--force", outfile]);
}

async function build(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: "string" },
      release: { type: "boolean", default: false },
      outfile: { type: "string", default: "dist/dipo" },
    },
    strict: true,
  });
  const target = values.target ?? hostTarget();
  if (!isTarget(target)) {
    throw new Error(`unknown target ${target}; expected one of ${TARGETS.join(", ")}`);
  }
  const outfile = resolve(REPO, values.outfile);
  mkdirSync(dirname(outfile), { recursive: true });
  if (values.outfile === "dist/dipo") {
    // Keep build output out of git without touching the root .gitignore.
    writeFileSync(join(dirname(outfile), ".gitignore"), "*\n");
  }

  const packageJson = (await Bun.file(join(REPO, "package.json")).json()) as { version: string };
  const defines = buildDefines(packageJson.version, values.release, readGitState());
  run(buildCommand({ target, outfile, defines }));

  if (target.startsWith("bun-darwin-")) {
    if (process.platform === "darwin") {
      ensureSigned(outfile);
    } else {
      console.warn(`not on macOS: ${outfile} is not checked or signed with codesign`);
    }
  }
  console.log(`built ${outfile} for ${target}`);
}

if (import.meta.main) {
  try {
    await build(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
