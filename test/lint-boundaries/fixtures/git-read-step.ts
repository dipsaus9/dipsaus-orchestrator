// Git steps that only read, or touch an index or a detached worktree: allowed anywhere.
interface Session {
  readonly repository: unknown;
  ok(location: unknown, args: readonly string[]): Promise<string>;
}

export async function reads(git: Session, branch: string): Promise<void> {
  await git.ok(git.repository, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  await git.ok(git.repository, ["merge-base", "--is-ancestor", "a", "b"]);
  await git.ok(git.repository, ["merge-tree", "--write-tree", "a", "b"]);
  await git.ok(git.repository, ["worktree", "add", "--detach", "/wt", "main"]);
  await git.ok(git.repository, ["checkout", "--quiet", "--detach", "main"]);
  await git.ok(git.repository, ["ls-remote", "--heads", "origin", branch]);
}
