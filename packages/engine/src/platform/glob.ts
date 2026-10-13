// Glob matching for repo-relative paths (0010 section 10: component map globs use `Bun.Glob`
// behind the platform module). Matching is a pure string test; it never touches the disk.

/** Tests repo-relative POSIX paths against one glob pattern. */
export type GlobMatcher = (path: string) => boolean;

/** A matcher for `pattern`, for example `packages/engine/**`. */
export function globMatcher(pattern: string): GlobMatcher {
  const glob = new Bun.Glob(pattern);
  return (path) => glob.match(path);
}
