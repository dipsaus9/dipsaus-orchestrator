// The retention tier of every office-scoped table (0007 sections 4 and 7). A schema test fails when
// a migration adds an office-scoped table that is not listed here, so a new table never grows
// without a decision on how long its rows are kept.
//
// D 24 hours, R the short tier (`retention.shortDays`), S the state tier (`retention.stateDays`),
// T until worktree teardown (deleted by the teardown, not by age), P until `office purge`.

export type RetentionTier = "D" | "R" | "S" | "T" | "P";

export interface TablePolicy {
  readonly tier: RetentionTier | "R+S";
  /** What decides the age of a row, as the retention pass reads it. */
  readonly rule: string;
}

export const TABLE_RETENTION: Readonly<Record<string, TablePolicy>> = {
  requests: { tier: "D", rule: "recorded more than 24 hours ago" },
  change_log: {
    tier: "R+S",
    rule: "by the entry's tier: R entries after shortDays, S after stateDays",
  },
  output_chunks: { tier: "R", rule: "stored more than shortDays ago" },
  usage_messages: {
    tier: "R",
    rule: "counted more than shortDays ago, or with its agent after stateDays",
  },
  ingest_cursors: {
    tier: "R",
    rule: "ended more than shortDays ago, or with its agent after stateDays",
  },
  agents: { tier: "S", rule: "ended more than stateDays ago" },
  usage_totals: { tier: "S", rule: "with its agent, ended more than stateDays ago" },
  worker_hosts: { tier: "S", rule: "ended more than stateDays ago" },
  backlog_journal: { tier: "S", rule: "closed more than stateDays ago; open entries are kept" },
  usage_daily: { tier: "P", rule: "kept until purge" },
  stories: { tier: "P", rule: "kept until purge" },
  story_aliases: { tier: "P", rule: "kept until purge" },
  backlog_mirror: { tier: "P", rule: "overwritten in place, kept until purge" },
  context_packs: { tier: "T", rule: "removed at worktree teardown" },
};
