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
  worker_notes: { tier: "T", rule: "removed at worktree teardown" },
  prompt_parts: {
    tier: "S",
    rule: "recorded more than stateDays ago, once no agent of the run is running",
  },
  claims: { tier: "S", rule: "released more than stateDays ago; a live claim is kept" },
  scans: { tier: "S", rule: "finished more than stateDays ago" },
  // 0007: P for the current and the previous profile; older ones are pruned, not aged.
  run_profiles: {
    tier: "P",
    rule: "the current profile and its previous one (the two newest when none is current)",
  },
  run_capabilities: { tier: "P", rule: "with its profile" },
  run_env_files: { tier: "P", rule: "with its profile" },
  run_ports: { tier: "P", rule: "with its profile" },
  run_extra_scripts: { tier: "P", rule: "with its profile" },
  released_branches: {
    tier: "S",
    rule: "reclaimed more than stateDays ago; a branch not yet reclaimed is kept",
  },
  pricing_checks: { tier: "S", rule: "raised more than stateDays ago" },
  gate_decisions: { tier: "S", rule: "decided more than stateDays ago" },
  gates: {
    tier: "S",
    rule: "opened more than stateDays ago, with no decision left; a gate still waiting is kept",
  },
  once_notices: { tier: "P", rule: "kept until purge, so a once-per-office notice stays shown" },
  backlog_prs: { tier: "S", rule: "merged or closed more than stateDays ago; an open PR is kept" },
  backlog_pr_blocks: {
    tier: "S",
    rule: "cleared more than stateDays ago; a block still in force is kept",
  },
  backlog_config_previous: {
    tier: "P",
    rule: "kept until purge, so `office uninstall` can restore the settings office init changed",
  },
  runs: { tier: "S", rule: "ended more than stateDays ago; an active run is kept" },
  run_steps: { tier: "S", rule: "with its run, ended more than stateDays ago" },
  run_signals: { tier: "S", rule: "with its run, ended more than stateDays ago" },
  run_intents: { tier: "S", rule: "with its run, ended more than stateDays ago" },
  parks: { tier: "S", rule: "resolved more than stateDays ago; an open park is kept" },
  verify_results: { tier: "S", rule: "with its run, ended more than stateDays ago" },
  run_summaries: { tier: "S", rule: "with its run, ended more than stateDays ago" },
  run_outcomes: { tier: "P", rule: "kept until purge, for retro and tier tuning" },
  config_snapshots: {
    tier: "S",
    rule: "first seen more than stateDays ago and named by no run that is kept",
  },
};
