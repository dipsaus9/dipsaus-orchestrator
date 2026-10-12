// Software-level configuration, `<state>/config.yaml` (0006 and 0017 amendments of 2026-10-12).
// The schema and its validation are the contract's, so the daemon and every client agree; the
// engine only reads the file and parses it through `platform/yaml.ts`.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  configError,
  resolveSoftwareConfig,
  SOFTWARE_CONFIG_FILE,
  type SoftwareConfigResult,
} from "@dipsaus-orchestrator/contract";

import { parseYamlDocument } from "../platform/yaml";

/** The path of the software configuration under `<state>`. */
export function softwareConfigPath(stateDir: string): string {
  return join(stateDir, SOFTWARE_CONFIG_FILE);
}

/**
 * Reads and validates `<state>/config.yaml`. An absent file gives the defaults. Errors name the
 * file by its full path. Never throws for a bad or unreadable file.
 */
export async function loadSoftwareConfig(stateDir: string): Promise<SoftwareConfigResult> {
  const path = softwareConfigPath(stateDir);
  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        errors: [
          configError(path, "(top level)", "readable file", `cannot read the file: ${reason}`),
        ],
      };
    }
  }
  return resolveSoftwareConfig(path, text === undefined ? undefined : parseYamlDocument(text));
}
