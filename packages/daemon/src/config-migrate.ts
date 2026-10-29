// `dipo config migrate` (0017): the one command that rewrites a configuration file. It takes
// `.dipo/office.yaml` and `.dipo/office.local.yaml` of a repository from an earlier version to
// version 14 with `migrateOfficeFileText`, which keeps their comments, and says each key it moved
// or deleted. A file that would not load as version 14 is left alone and its errors are printed;
// the other file is still migrated. It needs no daemon: the CLI calls it as a daemon-side form with
// the main worktree of the repository it runs in.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  migrateOfficeFileText,
  OFFICE_CONFIG_VERSION,
  OFFICE_FILE,
  OFFICE_LOCAL_FILE,
} from "@dipsaus-orchestrator/engine/platform";

import type { DaemonIo } from "./io";

export const CONFIG_MIGRATE_USAGE = "dipo config migrate";

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
}

// Writes next to the file and renames over it, so a failed write never leaves half a file.
function replaceFile(path: string, text: string): void {
  const next = `${path}.dipo-migrate`;
  writeFileSync(next, text);
  renameSync(next, path);
}

/** Migrates the office files under `root`; resolves to the exit code (1 when a file is refused). */
export async function runConfigMigrateForm(args: readonly string[], io: DaemonIo): Promise<number> {
  const [root, ...rest] = args;
  if (root === undefined || rest.length > 0) {
    io.writeError(
      `dipo: config-migrate needs the repository's main worktree\nusage: ${CONFIG_MIGRATE_USAGE}`,
    );
    return 2;
  }
  let refused = false;
  let found = false;
  for (const file of [OFFICE_FILE, OFFICE_LOCAL_FILE]) {
    const path = join(root, file);
    let text: string | undefined;
    try {
      text = readOptional(path);
    } catch (error) {
      io.writeError(`dipo: ${file}: cannot read the file: ${(error as Error).message}`);
      refused = true;
      continue;
    }
    if (text === undefined) continue;
    found = true;
    const migrated = migrateOfficeFileText(file, text);
    if (!migrated.ok) {
      for (const error of migrated.errors) io.writeError(`dipo: ${error.message}`);
      io.writeError(`dipo: ${file} is left as it was`);
      refused = true;
      continue;
    }
    if (migrated.from === OFFICE_CONFIG_VERSION) {
      io.writeLine(`${file}: already version ${OFFICE_CONFIG_VERSION}`);
      continue;
    }
    replaceFile(path, migrated.text);
    io.writeLine(`${file}: version ${migrated.from} to ${OFFICE_CONFIG_VERSION}`);
    for (const change of migrated.changes) io.writeLine(`  ${change}`);
  }
  if (!found && !refused) io.writeLine(`no ${OFFICE_FILE} or ${OFFICE_LOCAL_FILE} to migrate`);
  return refused ? 1 : 0;
}
