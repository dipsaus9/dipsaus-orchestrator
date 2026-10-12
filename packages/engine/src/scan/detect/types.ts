// The probe (filesystem facts in) and the run profile (out) of the repository scan (0013).

/**
 * The file facts `detect` and `fingerprint` need, and nothing more. Built by `readProbe` from a
 * checkout, or by hand in tests. Paths are repo-relative POSIX paths; `""` is the root.
 */
export interface Probe {
  /**
   * Contents of the files the scan reads: each `package.json` (root and workspace packages),
   * `pnpm-workspace.yaml`, `.node-version`, `.nvmrc`, `.claude/backlog-workflow.json`, the dev
   * server and runtime config files, and the modules those configs import. Never an env file.
   */
  readonly texts: Readonly<Record<string, string>>;
  /** Lockfile names present at the root. Their contents are never read. */
  readonly lockfiles: readonly string[];
  /** Workspace package directories, expanded from the workspace patterns. */
  readonly workspaceDirs: readonly string[];
  /** For each dev server config file, the repo files it imports that were read into `texts`. */
  readonly configImports: Readonly<Record<string, readonly string[]>>;
  /** Env files by path, with presence and ignore status. Their contents are never read. */
  readonly envFiles: readonly EnvFile[];
}

export type EnvFile = {
  /** The example file (name contains `.example`), or null for an `includeGitignored` path. */
  readonly example: string | null;
  /** The expected real file: the example path with `.example` removed, or the declared path. */
  readonly path: string;
  /** Whether the real file exists in this checkout. */
  readonly present: boolean;
  /** Whether git ignores the real file. */
  readonly ignored: boolean;
};

/** Where a resolved value came from (0013 section 4). */
export type Source = "standard" | "declared" | "composed" | "default" | "inferred" | "maintainer";
export type Confidence = "high" | "medium" | "low";

export type Origin = {
  readonly source: Source;
  readonly confidence: Confidence;
  /** The file or field the value was read from, for the maintainer. */
  readonly evidence: string;
};

export type Candidate<T> = Origin & { readonly value: T };

/** A value resolved from one source, two sources that disagree, or nothing. */
export type Resolution<T> =
  | ({ readonly status: "resolved" } & Candidate<T>)
  | { readonly status: "conflict"; readonly candidates: readonly Candidate<T>[] }
  | { readonly status: "unresolved" };

export type PackageManagerName = "bun" | "pnpm" | "yarn" | "npm";

export type PackageManager = {
  readonly name: PackageManagerName;
  /** Version from the `packageManager` field, when given. */
  readonly version: string | null;
};

/** Argument lists run in order without a shell, from a working directory. */
export type CommandSpec = {
  readonly commands: readonly (readonly string[])[];
  /** Repo-relative working directory; `"."` is the root. */
  readonly cwd: string;
};

export const CAPABILITIES = [
  "install",
  "setup",
  "dev",
  "test",
  "lint",
  "typecheck",
  "verify",
  "build",
] as const;
export type CapabilityName = (typeof CAPABILITIES)[number];

export type WorkspacePackage = {
  readonly dir: string;
  readonly name: string | null;
};

export type Toolchain = {
  readonly packageManager: Resolution<PackageManager>;
  readonly runtimeVersion: Resolution<string>;
  readonly workspaces: readonly WorkspacePackage[];
};

export type DevPort = Origin & {
  readonly port: number;
  /** The package directory whose `dev` serves on this port; `"."` is the root. */
  readonly dir: string;
  /** True when the port is written in a script or config file. */
  readonly fixedInCode: boolean;
  /** True when the `PORT` environment variable overrides it. */
  readonly honoursPort: boolean;
};

export type ConformanceLevel = "conforming" | "partial" | "non-standard";

export type Deviation = {
  /** Stable code, for diffs between scans. */
  readonly code: string;
  /** True for two sources that disagree: the maintainer must choose (0013 section 3). */
  readonly conflict: boolean;
  readonly message: string;
};

export type RunProfile = {
  readonly fingerprint: string;
  readonly toolchain: Toolchain;
  readonly capabilities: Readonly<Record<CapabilityName, Resolution<CommandSpec>>>;
  /** Root scripts outside the capabilities, by name and command, for reference. */
  readonly extraScripts: readonly { readonly name: string; readonly command: string }[];
  readonly envFiles: readonly EnvFile[];
  readonly devPorts: readonly DevPort[];
  readonly conformance: {
    readonly level: ConformanceLevel;
    readonly deviations: readonly Deviation[];
  };
  /**
   * Why `run` must refuse this office, naming the script to add, when verify is not resolved
   * (0013 section 2 and its 2026-10-11 amendment); null when verify resolved.
   */
  readonly runRefusal: string | null;
};

export type DetectOptions = {
  /** The maintainer marked the product as having nothing to start (0013 section 2). */
  readonly nothingToStart?: boolean;
};
