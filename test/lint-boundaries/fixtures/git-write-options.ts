// Git writes behind options that take a value: `-c key=value` and `-C dir`. A read behind the
// same options is not a write.
interface Session {
  readonly repository: unknown;
  ok(location: unknown, args: readonly string[]): Promise<string>;
}

export async function writes(git: Session): Promise<void> {
  await git.ok(git.repository, ["-c", "user.name=dipo", "commit", "--quiet", "-m", "x"]);
  await git.ok(git.repository, ["-C", "/repo", "push", "origin", "HEAD"]);
  await git.ok(git.repository, ["-c", "push.default=current", "status"]);
}
