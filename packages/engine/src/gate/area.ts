// The files each role kind may write (0012, R24): a design role writes only under its
// story's design folder, a docs role writes Markdown outside the decisions and designs, a code
// role writes any path. The gate and the run's scan of the story's part use this one module, so
// they agree on what is in an area.

import type { RoleKind } from "@dipsaus-orchestrator/contract";

const DESIGN_ROOT = "docs/design/";
const DECISIONS = "docs/decisions/";
const DOCS = "docs/";
const MARKDOWN = /\.md$/;

/** Whether a reference is a folder (ends in `/`), as opposed to a file. */
function isFolder(path: string): boolean {
  return path.endsWith("/");
}

/** The area a kind may write for a story, as text for a failure message. */
export function areaText(kind: RoleKind, id: string): string {
  if (kind === "design") return `${DESIGN_ROOT}${id}/`;
  if (kind === "docs") {
    return "Markdown under docs/ outside docs/decisions/ and docs/design/, or Markdown at the repository root";
  }
  return "any path";
}

/** Whether `path` (a repo-relative file or folder reference) is in the area of `kind` for `id`. */
export function inArea(kind: RoleKind, path: string, id: string): boolean {
  if (kind === "code") return true;
  if (kind === "design") return path.startsWith(`${DESIGN_ROOT}${id}/`);
  // A docs role: Markdown files, or folders, under docs/ outside decisions and designs.
  const underDocs =
    path.startsWith(DOCS) && !path.startsWith(DECISIONS) && !path.startsWith(DESIGN_ROOT);
  if (isFolder(path)) return underDocs;
  if (!MARKDOWN.test(path)) return false;
  return path.includes("/") ? underDocs : true;
}
