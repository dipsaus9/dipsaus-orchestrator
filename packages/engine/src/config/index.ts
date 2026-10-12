// Office configuration (0017 section 5): `.dipo/office.yaml` and `.dipo/office.local.yaml`.

import { z } from "zod";

import { OfficeFileV1 } from "./schema";

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
export {
  LOCAL_ALLOWED_KEYS,
  LOCAL_ONLY_KEYS,
  OFFICE_CONFIG_VERSION,
  OFFICE_DEFAULTS,
  OfficeConfigV1,
  OfficeFileV1,
  OfficeLocalFileV1,
  OfficeOverridesV1,
} from "./schema";
export type { OfficeConfig, OfficeFile, OfficeLocalFile, OfficeOverrides } from "./schema";

/** The JSON Schema of `.dipo/office.yaml`, for editor completion (0017 section 5). */
export function officeJsonSchema(): Record<string, unknown> {
  return {
    ...(z.toJSONSchema(OfficeFileV1, { io: "input" }) as Record<string, unknown>),
    title: "dipo office configuration (.dipo/office.yaml)",
  };
}
