// The project settings check (0008). A `-p` run uses the project's hooks, `env` and `apiKeyHelper`
// without trust, so before every launch of a Mac session the engine reads `.claude/settings.json`
// and `.claude/settings.local.json` in the session's folder and refuses any top-level or
// `permissions.*` key that is not on the engine's safe list: no session loads other settings from a
// project file (0008). Unknown and future keys fail closed. A `sandbox` key always refuses: a
// project file never sets how a session is confined. In the local file, a key `LOCAL_REFUSED_KEYS`
// names refuses too.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { LaunchCheckFailure } from "../../run/starts-paused";

/** The engine's safe list (0008). The MCP keys are inert under `--strict-mcp-config`. */
export const SAFE_PROJECT_SETTINGS: readonly string[] = [
  "$schema",
  "permissions.deny",
  "permissions.disableBypassPermissionsMode",
  "includeCoAuthoredBy",
  "enableAllProjectMcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
];

/** Never allowed. */
export const NEVER_ALLOWED_SETTING = "sandbox";

/** Keys the check refuses in `.claude/settings.local.json`: they widen permissions or load MCP servers (0008). */
export const LOCAL_REFUSED_KEYS: readonly string[] = [
  "permissions.allow",
  "permissions.ask",
  "permissions.additionalDirectories",
  "permissions.defaultMode",
  "enableAllProjectMcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
];

export const PROJECT_SETTINGS_FILE = ".claude/settings.json";
export const LOCAL_SETTINGS_FILE = ".claude/settings.local.json";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Top-level keys plus every `permissions.*` key of one settings object, in file order. */
export function settingsKeys(settings: Json): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (key === "permissions" && isObject(value)) {
      for (const inner of Object.keys(value)) keys.push(`permissions.${inner}`);
    } else {
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Pure: the refusals for one parsed settings file. `file` is the path the notice names; `local`
 * marks `settings.local.json`, which refuses the keys `LOCAL_REFUSED_KEYS` names as well.
 */
export function checkSettings(
  file: string,
  settings: unknown,
  local: boolean,
): LaunchCheckFailure[] {
  if (!isObject(settings)) {
    return [{ check: "settings", detail: "the file does not hold a JSON object", file }];
  }
  if ("permissions" in settings && !isObject(settings["permissions"])) {
    return [
      {
        check: "settings",
        detail: "permissions is not an object",
        file,
        key: "permissions",
      },
    ];
  }
  const allowed = new Set(SAFE_PROJECT_SETTINGS);
  const failures: LaunchCheckFailure[] = [];
  for (const key of settingsKeys(settings)) {
    if (key === NEVER_ALLOWED_SETTING || key.startsWith(`${NEVER_ALLOWED_SETTING}.`)) {
      failures.push({
        check: "settings",
        detail:
          "a sandbox key refuses the run and can never be allowlisted: a project file never sets how a session is confined; remove it",
        file,
        key,
      });
    } else if (local && LOCAL_REFUSED_KEYS.includes(key)) {
      failures.push({
        check: "settings",
        detail: "the key is never allowed in the local settings file; remove it",
        file,
        key,
      });
    } else if (!allowed.has(key)) {
      failures.push({
        check: "settings",
        detail: "the key is not on the engine's safe list; no session loads it (0008)",
        file,
        key,
        fix: `Remove "${key}" from the file.`,
      });
    }
  }
  return failures;
}

/** Reads a file's text, or undefined when it does not exist. Injectable for tests. */
export type ReadOptionalText = (path: string) => Promise<string | undefined>;

export const readOptionalText: ReadOptionalText = async (path) => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
};

/** Reads both settings files of the worktree and checks them; missing files pass. */
export async function checkProjectSettings(
  workdir: string,
  read: ReadOptionalText = readOptionalText,
): Promise<LaunchCheckFailure[]> {
  const failures: LaunchCheckFailure[] = [];
  for (const [name, local] of [
    [PROJECT_SETTINGS_FILE, false],
    [LOCAL_SETTINGS_FILE, true],
  ] as const) {
    const file = join(workdir, name);
    let text: string | undefined;
    try {
      text = await read(file);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      failures.push({ check: "settings", detail: `the file could not be read: ${why}`, file });
      continue;
    }
    if (text === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      failures.push({ check: "settings", detail: "the file is not valid JSON", file });
      continue;
    }
    failures.push(...checkSettings(file, parsed, local));
  }
  return failures;
}
