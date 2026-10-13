// The office marker (0007 section 2): `<git-common-dir>/dipo/office.json` holds
// `{ officeId, createdAt }`, inside `.git/` so git never tracks it and every worktree shares it.
// The directory is `0700`. The marker is how `office.open` tells a moved repository from a copy.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { OfficeId } from "@dipsaus-orchestrator/contract";
import { z } from "zod";

export const OFFICE_DIR = "dipo";
export const MARKER_FILE = "office.json";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export const OfficeMarker = z.object({ officeId: OfficeId, createdAt: z.iso.datetime() });
export type OfficeMarker = z.infer<typeof OfficeMarker>;

/** `<git-common-dir>/dipo/`. */
export function officeDirectory(commonDir: string): string {
  return join(commonDir, OFFICE_DIR);
}

export function markerPath(commonDir: string): string {
  return join(officeDirectory(commonDir), MARKER_FILE);
}

export type MarkerRead =
  | { readonly kind: "none" }
  | { readonly kind: "marker"; readonly marker: OfficeMarker }
  | { readonly kind: "invalid"; readonly detail: string };

/** Reads the marker; a missing file is `none`, anything that is not a marker is `invalid`. */
export function readMarker(commonDir: string): MarkerRead {
  const path = markerPath(commonDir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return { kind: "none" };
    return { kind: "invalid", detail: `cannot read ${path}: ${String(error)}` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "invalid", detail: `${path} is not JSON` };
  }
  const parsed = OfficeMarker.safeParse(value);
  if (!parsed.success) {
    return { kind: "invalid", detail: `${path} is not an office marker: ${parsed.error.message}` };
  }
  return { kind: "marker", marker: parsed.data };
}

/** Writes the marker atomically (temp file, then rename) into a `0700` directory. */
export function writeMarker(commonDir: string, marker: OfficeMarker): void {
  const dir = officeDirectory(commonDir);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
  const path = markerPath(commonDir);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(marker, null, 2)}\n`, { mode: FILE_MODE });
  renameSync(temp, path);
}
