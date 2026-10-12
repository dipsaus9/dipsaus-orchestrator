// `dipo --version` (0016 rule 5). `scripts/build.ts` passes DIPO_VERSION, DIPO_COMMIT and
// DIPO_COMMIT_DATE as `--define` constants; running from source has none of them.

declare const DIPO_VERSION: string | undefined;
declare const DIPO_COMMIT: string | undefined;
declare const DIPO_COMMIT_DATE: string | undefined;

export type BuildStamp = {
  readonly version: string;
  readonly commit: string;
  readonly commitDate: string;
};

export type VersionInfo = {
  readonly version: string;
  readonly commit: string | null;
  readonly commitDate: string | null;
  readonly bun: string;
  readonly os: string;
  readonly arch: string;
};

export type Runtime = { readonly bun: string; readonly os: string; readonly arch: string };

/** The build stamp compiled into the binary, or undefined when running from source. */
export function compiledStamp(): BuildStamp | undefined {
  // `typeof` keeps an undefined identifier from throwing when the defines are absent.
  if (
    typeof DIPO_VERSION !== "string" ||
    typeof DIPO_COMMIT !== "string" ||
    typeof DIPO_COMMIT_DATE !== "string"
  ) {
    return undefined;
  }
  return { version: DIPO_VERSION, commit: DIPO_COMMIT, commitDate: DIPO_COMMIT_DATE };
}

export function currentRuntime(): Runtime {
  return { bun: Bun.version, os: process.platform, arch: process.arch };
}

export function versionInfo(stamp: BuildStamp | undefined, runtime: Runtime): VersionInfo {
  if (stamp === undefined) {
    return { version: "dev", commit: null, commitDate: null, ...runtime };
  }
  return { ...stamp, ...runtime };
}

export function formatVersion(info: VersionInfo): string {
  const build =
    info.commit === null || info.commitDate === null
      ? "unknown commit"
      : `${info.commit} ${info.commitDate}`;
  return `dipo ${info.version} (${build}) bun ${info.bun} ${info.os}-${info.arch}`;
}

export function formatVersionJson(info: VersionInfo): string {
  return JSON.stringify({
    name: "dipo",
    version: info.version,
    commit: info.commit,
    commitDate: info.commitDate,
    bun: info.bun,
    os: info.os,
    arch: info.arch,
  });
}
