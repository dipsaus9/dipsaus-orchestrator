// Software-level configuration for clients, `<state>/config.yaml` (0006 and 0017 amendments of
// 2026-10-12). A client reads it before it starts the daemon (`daemon.autostart`, DIPO-70). The
// schema, the one-document rule and the error shape are the contract's, so a client and the
// daemon accept and refuse the same files; this file is the only client code that parses YAML.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  configError,
  parseSingleYamlDocument,
  resolveSoftwareConfig,
  SOFTWARE_CONFIG_FILE,
  type SoftwareConfigResult,
} from "@dipsaus-orchestrator/contract";

/** The path of the software configuration under `<state>`. */
export function softwareConfigPath(state: string): string {
  return join(state, SOFTWARE_CONFIG_FILE);
}

/**
 * Reads and validates `<state>/config.yaml`. An absent file gives the defaults. Errors name the
 * file by its full path. Never throws for a bad or unreadable file.
 */
export function readSoftwareConfig(state: string): SoftwareConfigResult {
  const path = softwareConfigPath(state);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return resolveSoftwareConfig(path, undefined);
    }
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      errors: [
        configError(path, "(top level)", "readable file", `cannot read the file: ${reason}`),
      ],
    };
  }
  return resolveSoftwareConfig(
    path,
    parseSingleYamlDocument((source) => Bun.YAML.parse(source), text),
  );
}
