// The folders a story store keeps its stories in (0010): the engine never names them itself. It asks
// the store (`StoryStore.storyFolders`) and compares a repository path with them here, the one
// comparison every guard and filter uses (DIPO-379). A path is normalised before it is compared:
// `.` and `..` segments resolved, repeated, leading and trailing slashes dropped, and folded as the
// Mac's case- and normalisation-insensitive volume finds names (dipo runs on macOS only, 0004), so
// `./Backlog/` is the folder `backlog`. A folder matches whole path segments: `backlog-x/` is not the
// folder `backlog`. A path that leaves the repository (`../x`) is in no folder.

import { posix } from "node:path";

/**
 * `text` folded as a case- and normalisation-insensitive volume compares names: decomposed, then
 * upper- and lower-cased, so `ſ` and `K` (Kelvin) meet their ASCII letters as `.GitHub/` meets
 * `.github/`.
 */
export function foldName(text: string): string {
  return text.normalize("NFD").toUpperCase().toLowerCase();
}

/**
 * Pure: the repo-relative `path` as a folder comparison sees it: `.` and `..` segments resolved,
 * repeated slashes, a leading slash (a path from the repository's root) and a trailing slash
 * dropped. Null for a path that leaves the repository. Not folded.
 */
export function repoPathOf(path: string): string | null {
  const rooted = path.replace(/^\/+/, "");
  const normal = posix.normalize(rooted === "" ? "." : rooted).replace(/\/+$/, "");
  if (normal === ".." || normal.startsWith("../")) return null;
  return normal === "." || normal === "" ? "" : normal;
}

/** The segments of `path` as compared: normalised (`repoPathOf`), folded (`foldName`). */
function segmentsOf(path: string): string[] | null {
  const normal = repoPathOf(path);
  if (normal === null || normal === "") return null;
  return foldName(normal).split("/");
}

/**
 * Pure: true when the repo-relative `path` is one of `folders` or lies in one, compared normalised
 * and folded (see the file comment), whole segments only.
 */
export function inStoryFolder(path: string, folders: readonly string[]): boolean {
  const segments = segmentsOf(path);
  if (segments === null) return false;
  return folders.some((folder) => {
    const own = segmentsOf(folder);
    return own !== null && own.every((segment, at) => segments[at] === segment);
  });
}

/**
 * Pure: where a symlink at the repo-relative `link` whose target is `target` points, as a
 * repo-relative path; null when it points out of the repository (an absolute target, or `..` past
 * the root).
 */
export function linkTargetOf(link: string, target: string): string | null {
  if (target.startsWith("/")) return null;
  return repoPathOf(posix.join(posix.dirname(link), target));
}
