// `backlog_config_previous` (0007 section 4): the Backlog.md settings office init changes, with the
// value each had on the base before dipo first changed it, for `office uninstall` (0010 section 11).
// A setting already recorded keeps its row, so a later init, which reads values dipo wrote, never
// replaces what was there before dipo.

import type { OfficeHandle } from "../../db/office";

/** A setting's value: a status list, a status name or a boolean; null when it was unset. */
export type SettingValue = readonly string[] | string | boolean | null;

export interface PreviousSetting {
  readonly setting: string;
  readonly value: SettingValue;
  readonly recordedAt: number;
}

/** A value as `backlog config get` prints it: `true` and `false` are booleans, empty is unset. */
export function settingValue(printed: string): SettingValue {
  const text = printed.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "" || text === "(not set)") return null;
  return text;
}

/**
 * Records each setting not recorded yet, inside the caller's transaction; returns the settings it
 * recorded.
 */
export function recordPrevious(
  office: OfficeHandle,
  values: Readonly<Record<string, SettingValue>>,
  now: number,
): string[] {
  const recorded: string[] = [];
  for (const [setting, value] of Object.entries(values)) {
    const changes = office.run(
      `insert into backlog_config_previous (office_id, setting, value, recorded_at)
       values ($office_id, $setting, $value, $now)
       on conflict (office_id, setting) do nothing`,
      { setting, value: value === null ? null : JSON.stringify(value), now },
    ).changes;
    if (changes > 0) recorded.push(setting);
  }
  return recorded;
}

/** Every recorded setting, by name. */
export function previousSettings(office: OfficeHandle): PreviousSetting[] {
  return office
    .all<{ setting: string; value: string | null; recorded_at: number }>(
      `select setting, value, recorded_at from backlog_config_previous
       where office_id = $office_id order by setting`,
    )
    .map((row) => ({
      setting: row.setting,
      value: row.value === null ? null : (JSON.parse(row.value) as SettingValue),
      recordedAt: row.recorded_at,
    }));
}
