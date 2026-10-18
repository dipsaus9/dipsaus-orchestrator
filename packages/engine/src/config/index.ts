// Office configuration (0017 section 5): `.dipo/office.yaml` and `.dipo/office.local.yaml`.

import { z } from "zod";

import { OfficeFileV4 } from "./schema";

export {
  FLAGS_SOURCE,
  loadOfficeConfig,
  OFFICE_FILE,
  OFFICE_LOCAL_FILE,
  resolveOfficeConfig,
} from "./load";
export type { ConfigError, OfficeConfigResult, OfficeConfigSources } from "./load";
export { canonicalJson, configHash, mergeLayer } from "./merge";
export { schemaKeyPaths } from "./keys";
export { loadSoftwareConfig, softwareConfigPath } from "./software";
export {
  LOCAL_ALLOWED_KEY_PATHS,
  LOCAL_ALLOWED_KEYS,
  LOCAL_ONLY_KEYS,
  migrateOfficeDocument,
  OFFICE_CONFIG_VERSION,
  OFFICE_CONFIG_VERSIONS,
  OFFICE_DEFAULTS,
  OfficeConfigV1,
  OfficeConfigV2,
  OfficeConfigV3,
  OfficeConfigV4,
  OfficeFileV1,
  OfficeFileV2,
  OfficeFileV3,
  OfficeFileV4,
  OfficeLocalFileV1,
  OfficeLocalFileV2,
  OfficeLocalFileV3,
  OfficeLocalFileV4,
  OfficeOverridesV1,
  OfficeOverridesV2,
  OfficeOverridesV3,
  OfficeOverridesV4,
  privacyOptIns,
} from "./schema";
export type {
  OfficeConfig,
  OfficeConfigVersion,
  OfficeFile,
  OfficeLocalFile,
  OfficeOverrides,
} from "./schema";

/**
 * The JSON Schema of `.dipo/office.yaml`, for editor completion (0017 section 5): the newest
 * version. dipo still reads older versions and migrates them in memory.
 */
export function officeJsonSchema(): Record<string, unknown> {
  return {
    ...(z.toJSONSchema(OfficeFileV4, { io: "input" }) as Record<string, unknown>),
    title: "dipo office configuration (.dipo/office.yaml)",
  };
}
