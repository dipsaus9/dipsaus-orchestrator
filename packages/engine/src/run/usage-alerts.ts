// Usage alerts (DIPO-311, 0009 section 8): once a minute the daemon sums the tokens of all offices
// (`views/usage.ts`), tells the offices' subscribers the summaries may have changed, and raises one
// `engine.notice` on the software stream when the all-office total crosses the alert level (warn)
// or the limit (error) of the UTC day or month. Each notice is recorded in `once_notices` under the
// window it is for, so a daemon restart never repeats it and the next window raises a new one. It
// only alerts: no pickup is held and no story parks; per-story budgets and the office's starts
// paused stay the only stops.

import type { Clock, OfficeId, TimerHandle } from "@dipsaus-orchestrator/contract";

import type { FeatureModule } from "../commands/registry";
import type { StateDatabase } from "../db/database";
import type { Logger } from "../log/logger";
import { background } from "../platform/background";
import type { SoftwareStream } from "../software-stream";
import {
  USAGE_SNAPSHOT_MS,
  type UsageLimits,
  type UsageMeter,
  type UsageSnapshot,
  type UsageWindow,
} from "../views/usage";

/** The `engine.notice` codes of usage alerts; each is recorded with `:<window key>` appended. */
export const USAGE_NOTICES = {
  dayLevel: "usage.dayLevel",
  dayLimit: "usage.dayLimit",
  monthLevel: "usage.monthLevel",
  monthLimit: "usage.monthLimit",
} as const;

export interface UsageAlertsDeps {
  readonly meter: UsageMeter;
  readonly database: () => StateDatabase | null;
  readonly software: SoftwareStream;
  readonly clock: Clock;
  /** Offices whose summary may have changed; the server debounces and sends it when it differs. */
  readonly onOfficeChanged: (office: OfficeId) => void;
  readonly logger?: Logger;
}

function tokens(count: number): string {
  return count.toLocaleString("en-US");
}

export class UsageAlerts {
  readonly #deps: UsageAlertsDeps;
  #timer: TimerHandle | null = null;
  #stopped = false;

  constructor(deps: UsageAlertsDeps) {
    this.#deps = deps;
  }

  /** The feature module: the first office load starts the minute timer. */
  get feature(): FeatureModule {
    return {
      name: "usage.alerts",
      register: (features) => {
        features.registerLoadStep("usage.alerts", () => {
          this.start();
        });
      },
    };
  }

  /** Starts the timer when it is not running, and checks now. */
  start(): void {
    if (this.#stopped || this.#timer !== null) return;
    this.check();
    this.#arm();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) this.#deps.clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #arm(): void {
    if (this.#stopped) return;
    this.#timer = this.#deps.clock.setTimeout(() => {
      this.#timer = null;
      background(async () => this.check(), {
        failed: "usage check failed",
        log: (message, fields) => this.#deps.logger?.warn(message, fields),
        settled: () => this.#arm(),
      });
    }, USAGE_SNAPSHOT_MS);
  }

  /** Sums again, raises the notices that are due and tells every office's subscribers. */
  check(): void {
    const database = this.#deps.database();
    const snapshot = this.#deps.meter.refresh();
    if (database === null || snapshot === null) return;
    for (const notice of dueNotices(snapshot, this.#deps.meter.limits)) {
      const first = database.connection.immediate(
        () =>
          database.connection.run(
            `insert into once_notices (office_id, code, shown_at)
             select office_id, $code, $at from offices order by added_at, office_id limit 1
             on conflict do nothing`,
            { code: `${notice.code}:${notice.key}`, at: this.#deps.clock.now() },
          ).changes > 0,
      );
      if (!first) continue;
      this.#deps.software.append("engine.notice", {
        level: notice.level,
        code: notice.code,
        text: notice.text,
      });
    }
    for (const office of snapshot.offices.keys()) this.#deps.onOfficeChanged(office as OfficeId);
  }
}

export interface DueNotice {
  readonly code: string;
  /** The window the notice is for: the UTC day or month. */
  readonly key: string;
  readonly level: "warn" | "error";
  readonly text: string;
}

/**
 * The notices the total warrants now: per window, the limit's when the limit is reached, else the
 * level's when the level is. Which of them were raised before is `once_notices`' to say. A limit
 * reached at once, without the level having been seen, raises only the limit's notice.
 */
export function dueNotices(snapshot: UsageSnapshot, limits: UsageLimits): DueNotice[] {
  const notices: DueNotice[] = [];
  const windows: readonly [UsageWindow, number | undefined, number, string, string][] = [
    ["day", limits.dayTokens, snapshot.total.day.tokens, snapshot.dayKey, "UTC day"],
    ["month", limits.monthTokens, snapshot.total.month.tokens, snapshot.monthKey, "UTC month"],
  ];
  for (const [window, limit, used, key, name] of windows) {
    if (limit === undefined) continue;
    const share = `${Math.round((used / limit) * 100)}%`;
    if (used >= limit) {
      notices.push({
        code: window === "day" ? USAGE_NOTICES.dayLimit : USAGE_NOTICES.monthLimit,
        key,
        level: "error",
        text: `Token use of all offices reached the limit of the ${name} ${key}: ${tokens(used)} of ${tokens(limit)} tokens (${share}). dipo only alerts; nothing is held or parked.`,
      });
    } else if (used >= limits.level * limit) {
      notices.push({
        code: window === "day" ? USAGE_NOTICES.dayLevel : USAGE_NOTICES.monthLevel,
        key,
        level: "warn",
        text: `Token use of all offices passed ${Math.round(limits.level * 100)}% of the limit of the ${name} ${key}: ${tokens(used)} of ${tokens(limit)} tokens (${share}). dipo only alerts; nothing is held or parked.`,
      });
    }
  }
  return notices;
}
