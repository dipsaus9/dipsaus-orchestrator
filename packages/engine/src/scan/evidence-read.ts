// Reads the evidence files of dipo's base copy (0013 section 6 step 1, 0021 amendment of
// 2026-10-22, DIPO-310): the file list, then only the files `evidenceFiles` names. A file is read
// only when it is a regular file inside the copy, not a symbolic link and not larger than
// `EVIDENCE_FILE_BYTES`, so a link committed in the repository cannot bring a file of the Mac into
// the request. No env file is ever opened: `evidenceFiles` never names one.

import { lstat, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

import type { RepoFiles } from "../platform/repo-files";

import { EVIDENCE_FILE_BYTES, evidenceFiles, isEnvName } from "./evidence";

export interface BaseEvidence {
  readonly files: readonly string[];
  readonly texts: Readonly<Record<string, string>>;
  /** Evidence files left out: a link, not a file, too large or outside the copy. */
  readonly skipped: readonly string[];
}

/** The text of one evidence file, or null when it must not be read. */
async function safeText(root: string, realRoot: string, path: string): Promise<string | null> {
  if (isEnvName(path)) return null;
  const full = join(root, path);
  try {
    const stat = await lstat(full);
    if (!stat.isFile() || stat.size > EVIDENCE_FILE_BYTES) return null;
    const real = await realpath(full);
    if (!real.startsWith(`${realRoot}${sep}`)) return null;
    return await readFile(real, "utf8");
  } catch {
    return null;
  }
}

/** The file list and evidence texts of the checkout at `root`. */
export async function readBaseEvidence(root: string, files: RepoFiles): Promise<BaseEvidence> {
  const listed = (await files.listFiles()).filter(
    (path) => !path.split("/").includes("node_modules"),
  );
  const realRoot = await realpath(root);
  const texts: Record<string, string> = {};
  const skipped: string[] = [];
  for (const path of evidenceFiles(listed)) {
    const text = await safeText(root, realRoot, path);
    if (text === null) skipped.push(path);
    else texts[path] = text;
  }
  return { files: listed, texts, skipped };
}
