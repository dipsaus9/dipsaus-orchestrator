// Git steps that write, run outside the git writer: a push, a commit, a ref change in a
// conditional, a branch delete bound to a name, a branch made by `worktree add -b`, and a reset
// behind a global option.
interface Session {
  readonly repository: unknown;
  ok(location: unknown, args: readonly string[]): Promise<string>;
}

export async function writes(git: Session, quiet: boolean, branch: string): Promise<void> {
  await git.ok(git.repository, ["push", "--quiet", "origin", `refs/heads/${branch}`]);
  await git.ok(git.repository, ["commit-tree", "tree", "-p", "parent", "-m", "subject"]);
  await git.ok(git.repository, quiet ? ["update-ref", "-d", branch] : ["rev-parse", branch]);
  const args = ["branch", "-D", branch];
  await git.ok(git.repository, args);
  await git.ok(git.repository, ["worktree", "add", "--quiet", "-b", branch, "/wt", "main"]);
  await git.ok(git.repository, ["--literal-pathspecs", "reset", "--hard", "HEAD"]);
}
