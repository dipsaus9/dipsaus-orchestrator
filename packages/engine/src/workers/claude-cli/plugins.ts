// Claude Code plugins in worker runs (0008 section 2, amendment of 2026-10-12; DIPO-108). A worker
// session loads no plugin unless the office names it in `worker.plugins`:
//
// - the run settings file sets `enabledPlugins` to false for every installed plugin the office
//   does not name, so its hooks never start (a SessionStart hook runs before `system/init`);
// - the parser compares the `plugins` of `system/init` with `worker.plugins` as the backstop: a
//   session that lists another plugin is stopped at its `system/init` (`startRefused`) and ends
//   `startFailed` naming it.
//
// Where Claude Code keeps its plugins is Claude's business, so only this file knows the layout:
//
// - `<home>/.claude/plugins/installed_plugins.json`, version 2,
//   `{ "version": 2, "plugins": { "<plugin>@<marketplace>": [...] } }`: the plugins installed from a
//   marketplace. Another version or shape refuses the plan;
// - `<home>/.claude/plugins/known_marketplaces.json`, `{ "<marketplace>": {...} }`: the marketplaces
//   added, read only to make sure none is called `builtin`;
// - `<home>/.claude/plugins/synced/<bucket>/manifest.json`, `{ "plugins": [{ "name": ... }] }`: the
//   plugins synced from the claude.ai account, which `system/init` names `<name>@synced` (live run
//   of DIPO-108 with user settings loaded). That `enabledPlugins` takes the same id is assumed, not
//   measured; the `system/init` check refuses such a plugin either way.
//
// Plugins of the `builtin` marketplace ship inside Claude Code itself and are listed nowhere; the
// comparison lets them through (see `BUILTIN_MARKETPLACE`). That exemption fails closed: a
// marketplace, installed plugin or synced plugin that calls itself `builtin` refuses the plan, and
// an `@builtin` id that is also installed or synced is compared like any other.

import { readdirSync, readFileSync } from "node:fs";

/** Claude Code's list of installed plugins, relative to the home directory. */
export const INSTALLED_PLUGINS_FILE = ".claude/plugins/installed_plugins.json";
/** The `installed_plugins.json` version this adapter reads; another one refuses the plan. */
export const INSTALLED_PLUGINS_VERSION = 2;
/** Claude Code's list of added marketplaces, relative to the home directory. */
export const KNOWN_MARKETPLACES_FILE = ".claude/plugins/known_marketplaces.json";
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

/** A plugin id as `enabledPlugins` names it: `<plugin>@<marketplace>`. */
const PLUGIN_ID = /^[^@\s]+@([^@\s]+)$/;
const PLUGIN_NAME = /^[^@\s]+$/;

function marketplaceOf(id: string): string | undefined {
  return PLUGIN_ID.exec(id)?.[1];
}

function notBuiltin(what: string, marketplace: string | undefined): void {
  if (marketplace === BUILTIN_MARKETPLACE) {
    throw new Error(
      `${what} names the marketplace "${BUILTIN_MARKETPLACE}", which is Claude Code's own; its plugins could pass as Claude Code's builtin ones`,
    );
  }
}

/**
 * Pure: the plugin ids in the text of `installed_plugins.json`, sorted. Every scope counts, not
 * only `user`: a plugin that is not loaded is switched off at no cost. Throws when the text is
 * not version 2 of that file, when a key is not a `<plugin>@<marketplace>` id or its value not a
 * list, and when a plugin comes from a marketplace called `builtin`.
 */
export function parseInstalledPlugins(text: string): string[] {
  const value = JSON.parse(text) as unknown;
  if (!isRecord(value)) throw new Error("expected an object");
  if (value["version"] !== INSTALLED_PLUGINS_VERSION) {
    throw new Error(
      `expected version ${INSTALLED_PLUGINS_VERSION}, got ${JSON.stringify(value["version"] ?? null)}`,
    );
  }
  const plugins = value["plugins"];
  if (!isRecord(plugins)) throw new Error('expected a "plugins" object');
  for (const [id, entries] of Object.entries(plugins)) {
    const marketplace = marketplaceOf(id);
    if (marketplace === undefined) {
      throw new Error(`${JSON.stringify(id)} is not a <plugin>@<marketplace> id`);
    }
    if (!Array.isArray(entries)) throw new Error(`${id}: expected a list of installs`);
    notBuiltin(`installed plugin ${id}`, marketplace);
  }
  return Object.keys(plugins).toSorted();
}

/**
 * Pure: checks the text of `known_marketplaces.json`, an object keyed by marketplace name. Throws
 * when it is not one, or when a marketplace is called `builtin`.
 */
export function checkKnownMarketplaces(text: string): void {
  const value = JSON.parse(text) as unknown;
  if (!isRecord(value)) throw new Error("expected an object keyed by marketplace");
  for (const name of Object.keys(value)) notBuiltin(`marketplace ${name}`, name);
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
    if (typeof name !== "string" || !PLUGIN_NAME.test(name)) {
      throw new Error(`a plugin without a plain name: ${JSON.stringify(name ?? null)}`);
    }
    const marketplace = isRecord(plugin) ? plugin["marketplaceName"] : undefined;
    notBuiltin(`synced plugin ${name}`, typeof marketplace === "string" ? marketplace : undefined);
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
    path = `${home}/${KNOWN_MARKETPLACES_FILE}`;
    const marketplaces = files.read(path);
    if (marketplaces !== undefined) checkKnownMarketplaces(marketplaces);
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

/**
 * Pure: the plugins of a `system/init` that the office does not allow, in listed order. An
 * `@builtin` id passes only when it is not one of the installed or synced plugins (`known`).
 */
export function refusedPlugins(
  listed: readonly string[],
  allowed: readonly string[],
  known: readonly string[] = [],
): string[] {
  return listed.filter(
    (id) =>
      !allowed.includes(id) && !(marketplaceOf(id) === BUILTIN_MARKETPLACE && !known.includes(id)),
  );
}

/** The `startFailed` detail of a session that loaded plugins the office does not allow. */
export function pluginRefusal(refused: readonly string[]): string {
  const names = refused.join(", ");
  return `system/init lists ${refused.length === 1 ? "plugin" : "plugins"} ${names}, not in worker.plugins: a plugin's hooks run outside the sandbox, so the session refuses to run (0008 amendment of 2026-10-12)`;
}
