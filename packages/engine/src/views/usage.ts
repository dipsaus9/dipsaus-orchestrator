// Token spend over all offices (DIPO-311, 0009 section 8, 0007 section 4). Budget tokens (input,
// output and cache creation; cache reads left out, 0008 section 4) of every run kind are summed per
// office and over all offices for the UTC calendar day and month: the final rows in `usage_daily`
// plus the live rows of agents still open (`usage_totals` not final, with the output of a turn in
// progress). The limits and the level come from the software configuration; with no limit the
// tokens still show, with no share and no alert. Alerts only inform: nothing here holds a pickup.

import type { DayUsage, EvidenceMap, OfficeId, Clock } from "@dipsaus-orchestrator/contract";

import type { StateDatabase } from "../db/database";

/** The software configuration's `usage.alerts`; a limit left out keeps that window's alert off. */
export interface UsageLimits {
  readonly dayTokens?: number;
  readonly monthTokens?: number;
  /** The share of a limit at which the alert starts (default 0.8). */
  readonly level: number;
}

export const DEFAULT_USAGE_LIMITS: UsageLimits = { level: 0.8 };

/** How long a snapshot is reused, so the summary changes at most once a minute. */
export const USAGE_SNAPSHOT_MS = 60_000;

export type UsageWindow = "day" | "month";

/** Tokens and the cost the CLI reported, in micro-dollars (null when no row has one, 0008). */
export interface WindowSum {
  readonly tokens: number;
  readonly costMicros: number | null;
}

const NONE: WindowSum = { tokens: 0, costMicros: null };

function add(a: WindowSum, b: WindowSum): WindowSum {
  return {
    tokens: a.tokens + b.tokens,
    costMicros:
      a.costMicros === null && b.costMicros === null
        ? null
        : (a.costMicros ?? 0) + (b.costMicros ?? 0),
  };
}

export interface WindowSums {
  readonly day: WindowSum;
  readonly month: WindowSum;
}

/** The sums at one moment: per office and over every listed office. */
export interface UsageSnapshot {
  readonly at: number;
  /** `yyyy-mm-dd` (UTC) of the day window. */
  readonly dayKey: string;
  /** `yyyy-mm` (UTC) of the month window. */
  readonly monthKey: string;
  readonly offices: ReadonlyMap<string, WindowSums>;
  readonly total: WindowSums;
}

/** `yyyy-mm-dd` in UTC. */
export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The first moment after the window, in ms: when the window resets (UTC). */
export function windowResetsAt(window: UsageWindow, ms: number): number {
  const date = new Date(ms);
  return window === "day"
    ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
    : Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

interface SumRow {
  office_id: string;
  tokens: number;
  cost: number | null;
}

/**
 * Sums the windows at `at` for every listed office. Final rows count in the window of their
 * day; the live rows of open agents count in the window of `at`.
 */
export function sumUsage(database: StateDatabase, at: number): UsageSnapshot {
  const dayKey = utcDayKey(at);
  const monthKey = dayKey.slice(0, 7);
  const db = database.connection;
  const listed = db.all<{ office_id: string }>(
    "select office_id from offices where forgotten_at is null",
  );
  const finals = (from: string) =>
    db.all<SumRow>(
      `select office_id, coalesce(sum(input + output + cache_create), 0) as tokens,
         sum(cost_micros) as cost
       from usage_daily where day >= $from and day <= $to group by office_id`,
      { from, to: dayKey },
    );
  const lives = db.all<SumRow>(
    `select office_id, coalesce(sum(input + output + cache_create + live_output), 0) as tokens,
       sum(cost_micros) as cost
     from usage_totals where final = 0 group by office_id`,
  );
  const rowSum = (rows: readonly SumRow[], office: string): WindowSum => {
    const row = rows.find((candidate) => candidate.office_id === office);
    return row === undefined ? NONE : { tokens: row.tokens, costMicros: row.cost };
  };
  const dayRows = finals(dayKey);
  const monthRows = finals(`${monthKey}-01`);
  const offices = new Map<string, WindowSums>();
  let total: WindowSums = { day: NONE, month: NONE };
  for (const { office_id: office } of listed) {
    const live = rowSum(lives, office);
    const sums = {
      day: add(rowSum(dayRows, office), live),
      month: add(rowSum(monthRows, office), live),
    };
    offices.set(office, sums);
    total = { day: add(total.day, sums.day), month: add(total.month, sums.month) };
  }
  return { at, dayKey, monthKey, offices, total };
}

/**
 * One window as `DayUsage`: the office's own tokens and cost, with the limit, share and alert of the
 * all-office total. No limit gives no share and no alert.
 */
export function windowUsage(
  own: WindowSum,
  total: WindowSum,
  limit: number | undefined,
  level: number,
): DayUsage {
  const share = limit === undefined ? undefined : total.tokens / limit;
  return {
    tokens: own.tokens,
    ...(limit === undefined ? {} : { limit }),
    ...(share === undefined ? {} : { share }),
    alert: share !== undefined && share >= level,
    ...(own.costMicros === null ? {} : { estimatedCost: own.costMicros / 1_000_000 }),
  };
}

/** What an office summary takes from the usage (`SummarySettings.usage`). */
export interface SummaryUsage {
  readonly dayUsage: DayUsage;
  readonly monthUsage: DayUsage;
  readonly evidence: EvidenceMap;
}

export function summaryUsage(
  snapshot: UsageSnapshot,
  office: OfficeId,
  limits: UsageLimits,
): SummaryUsage {
  const own = snapshot.offices.get(office) ?? { day: NONE, month: NONE };
  const dayUsage = windowUsage(own.day, snapshot.total.day, limits.dayTokens, limits.level);
  const monthUsage = windowUsage(own.month, snapshot.total.month, limits.monthTokens, limits.level);
  // Tokens are the CLI's own claim; the cost is the catalog's estimate (0009 section 3).
  const evidence: EvidenceMap = {
    "dayUsage.tokens": "claimed",
    "monthUsage.tokens": "claimed",
    ...(dayUsage.estimatedCost === undefined ? {} : { "dayUsage.estimatedCost": "estimated" }),
    ...(monthUsage.estimatedCost === undefined ? {} : { "monthUsage.estimatedCost": "estimated" }),
  };
  return { dayUsage, monthUsage, evidence };
}

/**
 * Reuses one snapshot for `USAGE_SNAPSHOT_MS` (and until the UTC day changes), so the summaries
 * built from it change at most once a minute however fast usage grows.
 */
export class UsageMeter {
  readonly #database: () => StateDatabase | null;
  readonly #clock: Clock;
  readonly #limits: UsageLimits;
  #cached: UsageSnapshot | null = null;

  constructor(options: {
    readonly database: () => StateDatabase | null;
    readonly clock: Clock;
    readonly limits?: UsageLimits;
  }) {
    this.#database = options.database;
    this.#clock = options.clock;
    this.#limits = options.limits ?? DEFAULT_USAGE_LIMITS;
  }

  get limits(): UsageLimits {
    return this.#limits;
  }

  /** The current snapshot, or null before the state database is open. */
  snapshot(): UsageSnapshot | null {
    const now = this.#clock.now();
    const cached = this.#cached;
    if (
      cached !== null &&
      now >= cached.at &&
      now - cached.at < USAGE_SNAPSHOT_MS &&
      utcDayKey(now) === cached.dayKey
    ) {
      return cached;
    }
    return this.refresh();
  }

  /** Sums again now. */
  refresh(): UsageSnapshot | null {
    const database = this.#database();
    if (database === null) return null;
    const snapshot = database.connection.deferred(() => sumUsage(database, this.#clock.now()));
    this.#cached = snapshot;
    return snapshot;
  }

  /** The usage part of an office's summary settings; undefined before the database is open. */
  of(office: OfficeId): SummaryUsage | undefined {
    const snapshot = this.snapshot();
    return snapshot === null ? undefined : summaryUsage(snapshot, office, this.#limits);
  }
}
