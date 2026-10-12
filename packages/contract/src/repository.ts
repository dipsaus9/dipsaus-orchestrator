// How a path resolves to an office location (0007 section 2), shared by the engine and the CLI so
// both name the same main worktree. The contract has no I/O: the caller hands in how to run git
// and how to canonicalise a path (realpath).

/** The office location of a repository: its main worktree and its common git directory. */
export interface RepositoryLocation {
  readonly mainWorktree: string;
  readonly commonDir: string;
}

export interface GitOutput {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RepositoryProbe {
  /** Runs git with `args` in the path being resolved. */
  readonly git: (args: readonly string[]) => Promise<GitOutput>;
  /** The canonical form of an existing path (symlinks resolved); the path itself otherwise. */
  readonly canonical: (path: string) => string;
}

export type RepositoryResolution =
  | { readonly ok: true; readonly location: RepositoryLocation }
  | { readonly ok: false; readonly reason: "not-git" | "bare"; readonly detail: string };

/** The main worktree from `git worktree list --porcelain`: the first `worktree` record. */
export function mainWorktreeOf(porcelain: string): { path: string; bare: boolean } | null {
  const first = porcelain.split("\n\n")[0]?.split("\n") ?? [];
  const line = first.find((entry) => entry.startsWith("worktree "));
  if (line === undefined) return null;
  return { path: line.slice("worktree ".length), bare: first.includes("bare") };
}

/**
 * Resolves a path inside a repository: the common directory from
 * `git rev-parse --path-format=absolute --git-common-dir`, the main worktree from the first entry
 * of `git worktree list --porcelain`. A repository made with `--separate-git-dir` lists its git
 * directory there; from the main worktree itself `--show-toplevel` names it.
 */
export async function resolveRepositoryWith(probe: RepositoryProbe): Promise<RepositoryResolution> {
  const common = await probe.git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) {
    return { ok: false, reason: "not-git", detail: common.stderr.trim() || "not a git repository" };
  }
  const list = await probe.git(["worktree", "list", "--porcelain"]);
  const main = list.ok ? mainWorktreeOf(list.stdout) : null;
  if (main === null) {
    return { ok: false, reason: "not-git", detail: list.stderr.trim() || "no worktree listed" };
  }
  if (main.bare) return { ok: false, reason: "bare", detail: `${main.path} is a bare repository` };
  const commonDir = probe.canonical(common.stdout.trim());
  const listed = probe.canonical(main.path);
  if (listed !== commonDir) return { ok: true, location: { mainWorktree: listed, commonDir } };
  const own = await probe.git([
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--show-toplevel",
  ]);
  const [gitDir, top] = own.stdout.trim().split("\n");
  if (!own.ok || gitDir === undefined || top === undefined) {
    return { ok: false, reason: "not-git", detail: "cannot find the main worktree" };
  }
  if (probe.canonical(gitDir) !== commonDir) {
    return {
      ok: false,
      reason: "not-git",
      detail: `its git directory ${commonDir} is separate from the main worktree; open the main worktree instead`,
    };
  }
  return { ok: true, location: { mainWorktree: probe.canonical(top), commonDir } };
}
