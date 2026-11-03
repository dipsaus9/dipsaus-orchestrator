// Office configuration (0017): `.dipo/office.yaml` and `.dipo/office.local.yaml`.

import { z } from "zod";

import { OfficeFileSchema } from "./schema";

export {
  FLAGS_SOURCE,
  loadOfficeConfig,
  OFFICE_FILE,
  OFFICE_LOCAL_FILE,
  resolveOfficeConfig,
} from "./load";
export type { ConfigError, ConfigWarning, OfficeConfigResult, OfficeConfigSources } from "./load";
export { LOCAL_FILE_HEADER, updateLocalPrivacy } from "./local-write";
export type { LocalPrivacyUpdate } from "./local-write";
export { canonicalJson, configHash, mergeLayer } from "./merge";
export { migrateOfficeFileText } from "./migrate-file";
export type { MigratedFile } from "./migrate-file";
export { schemaKeyPaths } from "./keys";
export { loadSoftwareConfig, softwareConfigPath } from "./software";
export {
  LOCAL_ALLOWED_KEYS,
  LOCAL_ONLY_KEYS,
  migrateOfficeDocument,
  OFFICE_CONFIG_VERSION,
  OFFICE_UPGRADES,
  OLDEST_OFFICE_CONFIG_VERSION,
  OFFICE_DEFAULTS,
  OfficeConfigSchema,
  OfficeFileSchema,
  OfficeLocalFileSchema,
  OfficeOverridesSchema,
  PRIVACY_KEYS,
  privacyOptIns,
  RENAMED_KEYS,
  RETIRED_KEYS,
} from "./schema";
export type {
  Migration,
  MigrationStep,
  OfficeBoxSection,
  OfficeConfig,
  OfficeConfigVersion,
  OfficeFile,
  OfficeLocalFile,
  OfficeOverrides,
  OfficeUpgrade,
  RenamedKey,
} from "./schema";

/** The JSON Schema of `.dipo/office.yaml` at the current version, for editor completion (0017). */
export function officeJsonSchema(): Record<string, unknown> {
  return {
    ...(z.toJSONSchema(OfficeFileSchema, { io: "input" }) as Record<string, unknown>),
    title: "dipo office configuration (.dipo/office.yaml)",
  };
}
