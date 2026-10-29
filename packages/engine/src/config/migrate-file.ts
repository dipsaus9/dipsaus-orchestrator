// `dipo config migrate` (0017): the new text of an office file of versions 1 to 13, at version 14.
// The steps are the ones the load applies in memory (`migrateOfficeDocument`), applied here to the
// `yaml` library's document, so every comment and the order of the keys that stay are kept and the
// change shows as a normal git diff. The new text is loaded again before it is returned: a file
// that would not load as version 14 is refused, and nothing is written.

import { configError, type ConfigError } from "@dipsaus-orchestrator/contract";
import { type Document, isMap, parseDocument } from "yaml";

import { OFFICE_FILE, OFFICE_LOCAL_FILE, readDocument, resolveOfficeConfig } from "./load";
import { migrateOfficeDocument, type MigrationStep, OFFICE_CONFIG_VERSION } from "./schema";

export type MigratedFile =
  | {
      readonly ok: true;
      /** The version the file had. */
      readonly from: number;
      /** The text to write; the same text when the file is version 14 already. */
      readonly text: string;
      /** One line per key the migration moved or deleted, naming the key and why. */
      readonly changes: readonly string[];
    }
  | { readonly ok: false; readonly errors: readonly ConfigError[] };

// Removes the key at `path` and every mapping above it that is left empty.
function remove(document: Document, path: readonly string[]): void {
  document.deleteIn(path);
  for (let depth = path.length - 1; depth > 0; depth -= 1) {
    const parent = document.getIn(path.slice(0, depth), true);
    if (!isMap(parent) || parent.items.length > 0) return;
    document.deleteIn(path.slice(0, depth));
  }
}

function apply(document: Document, step: MigrationStep): void {
  if (step.kind === "drop") {
    remove(document, step.path);
    return;
  }
  const node = document.getIn(step.from, true);
  remove(document, step.from);
  document.setIn(step.to, node);
}

/** What one step did, for the command's output. */
function change(step: MigrationStep): string {
  return step.kind === "move"
    ? `moved ${step.from.join(".")} to ${step.to.join(".")}`
    : `deleted ${step.path.join(".")}, because ${step.reason}`;
}

// The new text loaded as the file it is: every error it would give, or none.
function loadErrors(file: string, text: string): readonly ConfigError[] {
  const loaded = resolveOfficeConfig(file === OFFICE_FILE ? { office: text } : { local: text });
  return loaded.ok ? [] : loaded.errors;
}

/**
 * Pure: `text` of `file` (`.dipo/office.yaml` or `.dipo/office.local.yaml`) migrated to version 14
 * with its comments. A version 14 file comes back unchanged once it loads. Errors name the file
 * and the key, and mean nothing may be written.
 */
export function migrateOfficeFileText(file: string, text: string): MigratedFile {
  if (file !== OFFICE_FILE && file !== OFFICE_LOCAL_FILE) {
    throw new Error(`not an office file: ${file}`);
  }
  const read = readDocument(file, text);
  if (!read.ok) return read;
  if (read.version === OFFICE_CONFIG_VERSION) {
    const errors = loadErrors(file, text);
    return errors.length > 0
      ? { ok: false, errors }
      : { ok: true, from: read.version, text, changes: [] };
  }
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    const problem = `invalid YAML: ${document.errors[0]?.message ?? "unknown error"}`;
    return { ok: false, errors: [configError(file, "(top level)", "YAML", problem)] };
  }
  const { steps } = migrateOfficeDocument(read.version, read.value);
  for (const step of steps) apply(document, step);
  document.set("version", OFFICE_CONFIG_VERSION);
  const migrated = document.toString({ lineWidth: 0 });
  const errors = loadErrors(file, migrated);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    from: read.version,
    text: migrated,
    changes: steps.map(change),
  };
}
