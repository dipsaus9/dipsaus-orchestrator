// What the one retention rule does with every office-scoped table (0007). A schema test fails when
// a migration adds an office-scoped table that is not listed here, so a new table never grows
// without a decision on how long its rows are kept.
//
// `aged`: the retention pass deletes the table's rows once their run, or their own time, is more
// than `retention.days` old. Not aged: the rows are kept (the outcome rows and the daily rollup,
// for retro and trends, and the office's own facts) or their owner removes them.

export interface TablePolicy {
  readonly aged: boolean;
  /** What decides a row's age, or who removes it. */
  readonly rule: string;
}

const aged = (rule: string): TablePolicy => ({ aged: true, rule });
const kept = (rule: string): TablePolicy => ({ aged: false, rule });

export const TABLE_RETENTION: Readonly<Record<string, TablePolicy>> = {
  requests: aged("recorded more than a day ago"),
  change_log: aged("appended more than retention.days ago"),
  output_chunks: aged("stored more than retention.days ago"),
  usage_messages: aged("counted, or with its agent ended, more than retention.days ago"),
  ingest_cursors: aged("ended, or with its agent ended, more than retention.days ago"),
  agents: aged("ended more than retention.days ago"),
  usage_totals: aged("with its agent, ended more than retention.days ago"),
  compactions: aged("with its agent, ended more than retention.days ago"),
  worker_hosts: aged("ended more than retention.days ago"),
  backlog_journal: aged("closed more than retention.days ago; open entries are kept"),
  usage_daily: kept("kept: the daily rollup, for trends"),
  stories: kept("kept: story identity"),
  story_aliases: kept("kept: story identity"),
  backlog_mirror: kept("overwritten in place"),
  leftover_worktrees: kept("written again at each office load"),
  context_packs: kept("removed when the claim ends"),
  worker_notes: kept("removed when the claim ends"),
  prompt_parts: aged("recorded more than retention.days ago, once no agent of the run is running"),
  prompt_texts: aged("recorded more than retention.days ago"),
  claims: aged("released more than retention.days ago; a live claim is kept"),
  scans: aged("finished more than retention.days ago"),
  // 0007: the current and the previous profile; older ones are pruned, not aged.
  run_profiles: kept(
    "the current profile and its previous one (the two newest when none is current)",
  ),
  run_capabilities: kept("with its profile"),
  run_env_files: kept("with its profile"),
  run_extra_scripts: kept("with its profile"),
  // DIPO-310: the maintainer's confirmations and the pending proposals lay over every profile.
  capability_confirmations: kept("kept: the maintainer's confirmations"),
  capability_proposals: kept("replaced or removed by the scan"),
  office_scan_marks: kept("kept: one row per office"),
  released_branches: aged(
    "reclaimed more than retention.days ago; a branch not yet reclaimed is kept",
  ),
  gate_decisions: aged("decided more than retention.days ago"),
  gates: aged(
    "opened more than retention.days ago, with no decision left; a gate still waiting is kept",
  ),
  once_notices: kept("kept, so a once-per-office notice stays shown"),
  backlog_prs: aged("merged or closed more than retention.days ago; an open PR is kept"),
  backlog_pr_blocks: aged("cleared more than retention.days ago; a block still in force is kept"),
  backlog_config_previous: kept(
    "kept, so `office uninstall` can restore the settings office init changed",
  ),
  story_prs: aged("closed more than retention.days ago; an open PR is kept"),
  review_verdicts: aged("decided more than retention.days ago"),
  feedback_items: aged("with its run, ended more than retention.days ago"),
  // DIPO-309: the maintainer's tests of a story's pushed head.
  acceptance_tests: aged("with its run, ended more than retention.days ago; an open test is kept"),
  catch_ups: aged("with its run, ended more than retention.days ago"),
  runs: aged("ended more than retention.days ago; an active run is kept"),
  run_steps: aged("with its run, ended more than retention.days ago"),
  run_grants: aged("with its run, ended more than retention.days ago"),
  run_signals: aged("with its run, ended more than retention.days ago"),
  run_intents: aged("with its run, ended more than retention.days ago"),
  parks: aged("resolved more than retention.days ago; an open park is kept"),
  done_elsewhere: aged("cleared more than retention.days ago; leftovers not cleared are kept"),
  run_summaries: aged("with its run, ended more than retention.days ago"),
  done_reports: aged("with its run, ended more than retention.days ago"),
  report_sendbacks: aged("with its run, ended more than retention.days ago"),
  decision_notes: aged("decided more than retention.days ago; an open note is kept"),
  proposals: aged("decided more than retention.days ago; an open proposal is kept"),
  questions: aged("with its run, ended more than retention.days ago"),
  run_outcomes: kept("kept: the outcome row of every ended run, for retro"),
  starts_paused: kept("one row per office and reason, deleted when that pause lifts"),
  config_snapshots: aged(
    "first seen more than retention.days ago and named by no run that is kept",
  ),
};
