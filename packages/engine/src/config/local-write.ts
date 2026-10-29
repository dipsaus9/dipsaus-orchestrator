// Changes one privacy setting in `.dipo/office.local.yaml` (0007 section 8, DIPO-136). The file is
// rewritten as a whole: every other key it holds stays, its comments do not (the YAML
// writer in `platform/yaml.ts` keeps none), so dipo puts a short header comment of its own on top.
// The result is validated before any text is returned, so a refused change leaves the file alone.

import { configError, type ConfigError } from "@dipsaus-orchestrator/contract";

import { stringifyYamlDocument } from "../platform/yaml";
import { describeValue } from "./keys";
import { OFFICE_LOCAL_FILE, readDocument, validate } from "./load";
import { OFFICE_CONFIG_VERSION, OfficeLocalFileSchema, PRIVACY_KEYS } from "./schema";

/** The comment on top of a file dipo wrote. */
export const LOCAL_FILE_HEADER =
  "# Written by dipo. dipo rewrites this file when a setting changes in the TUI;\n" +
  "# comments are not kept, every key stays.\n";

export type LocalPrivacyUpdate =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly errors: readonly ConfigError[] };

/**
 * The new text of `.dipo/office.local.yaml` with `privacy.<key>` set to `value`. `current` is the
 * file's text, `undefined` when it is missing: dipo then starts it at `OFFICE_CONFIG_VERSION`.
 * Pure; an unknown key, a value that is not a boolean or a file that does not validate is an error
 * naming the file and key.
 */
export function updateLocalPrivacy(
  current: string | undefined,
  key: string,
  value: unknown,
): LocalPrivacyUpdate {
  const path = `privacy.${key}`;
  if (!(PRIVACY_KEYS as readonly string[]).includes(key)) {
    return {
      ok: false,
      errors: [
        configError(
          OFFICE_LOCAL_FILE,
          path,
          `one of ${PRIVACY_KEYS.join(", ")}`,
          `unknown privacy setting ${key}; expected one of ${PRIVACY_KEYS.join(", ")}`,
        ),
      ],
    };
  }
  if (typeof value !== "boolean") {
    return {
      ok: false,
      errors: [
        configError(
          OFFICE_LOCAL_FILE,
          path,
          "boolean",
          `expected boolean, got ${describeValue(value)}`,
        ),
      ],
    };
  }

  let document: Record<string, unknown> = { version: OFFICE_CONFIG_VERSION };
  if (current !== undefined) {
    const read = readDocument(OFFICE_LOCAL_FILE, current);
    if (!read.ok) return read;
    // Only `dipo config migrate` migrates a file (0017), so an older file is refused here.
    if (read.version < OFFICE_CONFIG_VERSION) {
      const problem = `the file is version ${read.version}; run dipo config migrate, then change the setting`;
      return {
        ok: false,
        errors: [configError(OFFICE_LOCAL_FILE, "version", `${OFFICE_CONFIG_VERSION}`, problem)],
      };
    }
    const checked = validate(OFFICE_LOCAL_FILE, OfficeLocalFileSchema, read.value);
    if (!checked.ok) return checked;
    document = read.value;
  }
  const privacy = document["privacy"];
  const next = {
    ...document,
    privacy: { ...(typeof privacy === "object" && privacy !== null ? privacy : {}), [key]: value },
  };
  const checked = validate(OFFICE_LOCAL_FILE, OfficeLocalFileSchema, next);
  if (!checked.ok) return checked;
  return { ok: true, text: `${LOCAL_FILE_HEADER}${stringifyYamlDocument(next)}` };
}
