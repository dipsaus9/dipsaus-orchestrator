// The configuration a run started with (0019 section 4, 0020 section 5; the DIPO-303 review of
// 2026-10-22). `work.run` keeps the effective configuration of each run once per office and hash
// in `config_snapshots` and records the hash on the run (`runs.config_hash`). Since a change of
// `.dipo/office.yaml` on the base reloads the configuration in force at the next poll (DIPO-303),
// the stages of a run after its start read this snapshot instead: the story PR it opens and the
// required checks it waits for, its reviewer's model and adapter, and its merge (`mergeSlot`).
//
// A snapshot from an older configuration version lacks the keys added since; each such key takes
// the value of the configuration it falls back to, section by section, so a run started before a
// key existed behaves as the defaults of its own time did.

import { OFFICE_DEFAULTS, type OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";

import type { StoredRun } from "./records";

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pure: `over` laid on `under`, plain objects merged key by key, anything else replaced. */
export function layered(under: unknown, over: unknown): unknown {
  if (!plain(under) || !plain(over)) return over === undefined ? under : over;
  const out: Record<string, unknown> = { ...under };
  for (const [key, value] of Object.entries(over)) out[key] = layered(under[key], value);
  return out;
}

/**
 * The configuration the run started with: its `config_snapshots` row laid on `fallback` (the
 * configuration in force, or the defaults), so a key the snapshot lacks takes the fallback's
 * value. `fallback` alone when the run's snapshot is missing or unreadable.
 */
export function runConfigOf(
  office: OfficeHandle,
  run: Pick<StoredRun, "configHash">,
  fallback: OfficeConfig = OFFICE_DEFAULTS,
): OfficeConfig {
  const row = office.get<{ config: string }>(
    `select config from config_snapshots where office_id = $office_id and config_hash = $hash`,
    { hash: run.configHash },
  );
  if (row === null) return fallback;
  try {
    const parsed = JSON.parse(row.config) as unknown;
    return plain(parsed) ? (layered(fallback, parsed) as OfficeConfig) : fallback;
  } catch {
    return fallback;
  }
}
