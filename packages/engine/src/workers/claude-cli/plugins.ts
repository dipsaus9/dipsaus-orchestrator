// Claude Code plugins in worker runs (0008 section 2, amendment of 2026-10-12; DIPO-108). A worker
// session loads no plugin unless the office names it in `worker.plugins`:
//
// - the run settings file sets `enabledPlugins` to false for every installed plugin the office
//   does not name, so its hooks never start (a SessionStart hook runs before `system/init`);
// - the parser compares the `plugins` of `system/init` with `worker.plugins` as the backstop, and
//   a session that lists another plugin refuses with `startFailed` naming it.
//
// Where Claude Code keeps its plugins is Claude's business, so only this file knows the layout:
//
// - `<home>/.claude/plugins/installed_plugins.json`, `{ "plugins": { "<plugin>@<marketplace>": [...] } }`:
//   the plugins installed from a marketplace;
// - `<home>/.claude/plugins/synced/<bucket>/manifest.json`, `{ "plugins": [{ "name": ... }] }`: the
//   plugins synced from the claude.ai account, which `system/init` names `<name>@synced` (live run
//   of DIPO-108 with user settings loaded). That `enabledPlugins` takes the same id is assumed, not
//   measured; the `system/init` check refuses such a plugin either way.
//
// Plugins of the `builtin` marketplace ship inside Claude Code itself and are listed nowhere; the
// comparison lets them through (see `BUILTIN_MARKETPLACE`).

import { readdirSync, readFileSync } from "node:fs";

/** Claude Code's list of installed plugins, relative to the home directory. */
export const INSTALLED_PLUGINS_FILE = ".claude/plugins/installed_plugins.json";
/** Claude Code's directory of plugins synced from the account, relative to the home directory. */
export const SYNCED_PLUGINS_DIR = ".claude/plugins/synced";
/** The marketplace `system/init` names for a synced plugin. */
export const SYNCED_MARKETPLACE = "synced";

/**
 * The marketplace of the plugins Claude Code ships inside its own binary (live run of DIPO-108,
 * Claude Code 2.1.301: `cc-plugin-agents-md`, `cc-plugin-telemetry`, `cc-plugin-plugin-authoring`,
 * all `@builtin`). They are part of Claude Code, as trusted as the binary the plan runs, so a
 * `system/init` that lists them is not refused.
 */
export const BUILTIN_MARKETPLACE = "builtin";

/** What the plan and the parser need: the installed ids and the ones the office allows. */
export interface WorkerPlugins {
  /**
   * The installed plugin ids, sorted, or why the list could not be read; the plan then refuses,
   * because it cannot switch off what it cannot name.
   */
  readonly installed: readonly string[] | { readonly error: string };
  /** `worker.plugins` of the office. */
  readonly allowed: readonly string[];
}

/** The file reads this module needs; a test seam. Both throw for any failure but a missing path. */
export interface PluginFiles {
  /** A text file's content; `undefined` when it does not exist. */
  read(path: string): string | undefined;
  /** The names of a directory's subdirectories; empty when it does not exist. */
  dirs(path: string): string[];
}

function missing(error: unknown): boolean {
  return (error as { code?: unknown }).code === "ENOENT";
}

export const nodePluginFiles: PluginFiles = {
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  },
  dirs: (path) => {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pure: the plugin ids in the text of `installed_plugins.json`, sorted. Every scope counts, not
 * only `user`: a plugin that is not loaded is switched off at no cost. Throws when the text is
 * not that file's shape.
 */
export function parseInstalledPlugins(text: string): string[] {
  const value = JSON.parse(text) as unknown;
  if (!isRecord(value) || !isRecord(value["plugins"])) {
    throw new Error('expected an object with a "plugins" object');
  }
  return Object.keys(value["plugins"]).toSorted();
}

/**
 * Pure: the ids of the plugins in the text of a synced bucket's `manifest.json`, as `system/init`
 * names them (`<name>@synced`). Throws when the text is not that file's shape.
 */
export function parseSyncedPlugins(text: string): string[] {
  const value = JSON.parse(text) as unknown;
  const plugins = isRecord(value) ? value["plugins"] : undefined;
  if (!Array.isArray(plugins)) throw new Error('expected an object with a "plugins" list');
  return plugins.map((plugin: unknown) => {
    const name = isRecord(plugin) ? plugin["name"] : undefined;
    if (typeof name !== "string" || name === "") throw new Error("a plugin without a name");
    return `${name}@${SYNCED_MARKETPLACE}`;
  });
}

/**
 * The Claude Code plugins under `home`, installed and synced, sorted. A missing file is no plugin.
 * A file that cannot be read or parsed is returned as an error, so the adapter can still be built
 * for ingestion while the plan refuses (fail closed).
 */
export function readInstalledPlugins(
  home: string,
  files: PluginFiles = nodePluginFiles,
): readonly string[] | { readonly error: string } {
  const ids = new Set<string>();
  let path = `${home}/${INSTALLED_PLUGINS_FILE}`;
  try {
    const text = files.read(path);
    if (text !== undefined) for (const id of parseInstalledPlugins(text)) ids.add(id);
    const synced = `${home}/${SYNCED_PLUGINS_DIR}`;
    path = synced;
    for (const bucket of files.dirs(synced).toSorted()) {
      path = `${synced}/${bucket}/manifest.json`;
      const manifest = files.read(path);
      if (manifest !== undefined) for (const id of parseSyncedPlugins(manifest)) ids.add(id);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { error: `cannot read Claude Code's plugin list ${path}: ${reason}` };
  }
  return [...ids].toSorted();
}

/**
 * Pure: the run settings' `enabledPlugins`, every installed plugin the office does not name set to
 * false. Settings passed with `--settings` take precedence over the user's own settings file.
 */
export function enabledPluginsSetting(
  installed: readonly string[],
  allowed: readonly string[],
): Record<string, false> {
  const setting: Record<string, false> = {};
  for (const id of installed) if (!allowed.includes(id)) setting[id] = false;
  return setting;
}

/** Pure: the plugins of a `system/init` that the office does not allow, in listed order. */
export function refusedPlugins(listed: readonly string[], allowed: readonly string[]): string[] {
  return listed.filter((id) => !allowed.includes(id) && !id.endsWith(`@${BUILTIN_MARKETPLACE}`));
}

/** The `startFailed` detail of a session that loaded plugins the office does not allow. */
export function pluginRefusal(refused: readonly string[]): string {
  const names = refused.join(", ");
  return `system/init lists ${refused.length === 1 ? "plugin" : "plugins"} ${names}, not in worker.plugins: a plugin's hooks run outside the sandbox, so the session refuses to run (0008 amendment of 2026-10-12)`;
}
