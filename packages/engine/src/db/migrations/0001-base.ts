// Migration 1: the base schema (0007). The steps of the dipo versions before it were squashed into
// this one before 1.0, so a database those versions wrote is refused at open (`migrations.ts`).
// Every office-scoped table has `office_id` as the first column of its primary key; `offices` and
// `schema_migrations` are software-wide (0007).

import type { SqlMigration } from "../migrations";

export const base: SqlMigration = {
  version: 1,
  name: "base schema",
  sql: `
create table schema_migrations (
  version integer primary key,
  name text not null,
  checksum text not null,
  engine_version text not null,
  applied_at integer not null
) strict;

create table offices (
  office_id text primary key,
  path text not null,
  display_name text not null,
  added_at integer not null,
  forgotten_at integer,
  next_seq integer not null
) strict;

create table stories (
  office_id text not null references offices (office_id),
  key text not null,
  story_id text not null,
  provisional integer not null check (provisional in (0, 1)),
  frozen_branch text,
  first_seen_at integer not null,
  removed_at integer,
  primary key (office_id, key)
) strict;

create unique index stories_current_id on stories (office_id, story_id) where removed_at is null;

create table story_aliases (
  office_id text not null,
  key text not null,
  story_id text not null,
  valid_from integer not null,
  retired_at integer,
  primary key (office_id, key, story_id),
  foreign key (office_id, key) references stories (office_id, key)
) strict;

create index story_aliases_live on story_aliases (office_id, story_id) where retired_at is null;

create table change_log (
  office_id text not null references offices (office_id),
  seq integer not null,
  at integer not null,
  type text not null,
  key text,
  run_id text,
  caused_by text,
  delta text not null,
  view text,
  primary key (office_id, seq)
) strict;

create index change_log_at on change_log (office_id, at);

create table requests (
  office_id text not null references offices (office_id),
  request_id text not null,
  command text not null,
  args_hash text not null,
  reply text not null,
  at integer not null,
  primary key (office_id, request_id)
) strict;

create index requests_at on requests (office_id, at);

create table once_notices (
  office_id text not null references offices (office_id),
  code text not null,
  shown_at integer not null,
  primary key (office_id, code)
) strict;

create table office_scan_marks (
  office_id text primary key references offices (office_id),
  nothing_to_start integer not null check (nothing_to_start in (0, 1)),
  marked_at integer not null
) strict;

create table config_snapshots (
  office_id text not null references offices (office_id),
  config_hash text not null,
  config text not null,
  first_seen integer not null,
  primary key (office_id, config_hash)
) strict;

create table backlog_config_previous (
  office_id text not null references offices (office_id),
  setting text not null,
  value text,
  recorded_at integer not null,
  primary key (office_id, setting)
) strict;

create table backlog_journal (
  office_id text not null references offices (office_id),
  op_id integer not null,
  key text,
  subject text not null,
  op_kind text not null,
  target text not null,
  branch text,
  state text not null check (
    state in ('pending', 'applied', 'committed', 'pushed', 'merged', 'dropped', 'withdrawn',
      'failed')
  ),
  commit_sha text,
  pr_ref text,
  notice text,
  created_at integer not null,
  updated_at integer not null,
  closed_at integer,
  primary key (office_id, op_id)
) strict;

create index backlog_journal_open on backlog_journal (office_id, state, key);

create table backlog_mirror (
  office_id text not null,
  key text not null,
  content_hash text not null,
  kind text not null check (kind in ('task', 'draft')),
  status text not null,
  title text not null,
  tier text,
  role text,
  labels text not null,
  read_at integer not null,
  source text not null,
  waiting_on text,
  park text,
  park_since integer,
  criteria_met integer,
  criteria_total integer,
  criteria_numbers text,
  gate_sha text,
  gate_dependencies text,
  gate_branch text,
  primary key (office_id, key),
  foreign key (office_id, key) references stories (office_id, key)
) strict;

create table backlog_prs (
  office_id text not null references offices (office_id),
  pr_number integer not null,
  url text not null,
  branch text not null,
  title text not null,
  state text not null check (state in ('open', 'merged', 'closed')),
  checked_head text,
  checked_base text,
  check_error text,
  check_state text not null check (check_state in ('pending', 'passed', 'failed')),
  failures text not null,
  touched text not null,
  opened_at integer not null,
  updated_at integer not null,
  checked_at integer,
  closed_at integer,
  primary key (office_id, pr_number)
) strict;

create index backlog_prs_by_state on backlog_prs (office_id, state, closed_at);

create table backlog_pr_blocks (
  office_id text not null references offices (office_id),
  key text not null,
  pr_number integer not null,
  failures text not null,
  blocked_at integer not null,
  cleared_at integer,
  cleared_by integer,
  primary key (office_id, key, pr_number)
) strict;

create index backlog_pr_blocks_open on backlog_pr_blocks (office_id, key, cleared_at);

create table run_profiles (
  office_id text not null references offices (office_id),
  profile_id integer not null,
  scanned_at integer not null,
  commit_sha text not null,
  fingerprint text not null,
  toolchain text not null,
  conformance text not null check (conformance in ('conforming', 'partial', 'non-standard')),
  deviations text not null,
  run_refusal text,
  previous_profile_id integer,
  current integer not null check (current in (0, 1)),
  primary key (office_id, profile_id)
) strict;

create unique index run_profiles_current on run_profiles (office_id) where current = 1;

create table run_capabilities (
  office_id text not null,
  profile_id integer not null,
  capability text not null,
  status text not null check (status in ('resolved', 'conflict', 'unresolved')),
  commands text,
  working_dir text,
  source text,
  confidence text,
  evidence text,
  candidates text,
  confirmed integer not null default 0 check (confirmed in (0, 1)),
  pending integer not null default 0 check (pending in (0, 1)),
  stale integer not null default 0 check (stale in (0, 1)),
  primary key (office_id, profile_id, capability),
  foreign key (office_id, profile_id) references run_profiles (office_id, profile_id)
) strict;

create table run_env_files (
  office_id text not null,
  profile_id integer not null,
  path text not null,
  example text,
  present integer not null check (present in (0, 1)),
  ignored integer not null check (ignored in (0, 1)),
  primary key (office_id, profile_id, path),
  foreign key (office_id, profile_id) references run_profiles (office_id, profile_id)
) strict;

create table run_extra_scripts (
  office_id text not null,
  profile_id integer not null,
  name text not null,
  command text not null,
  primary key (office_id, profile_id, name),
  foreign key (office_id, profile_id) references run_profiles (office_id, profile_id)
) strict;

create table scans (
  office_id text not null references offices (office_id),
  scan_id integer not null,
  trigger text not null check (trigger in ('start', 'run', 'test', 'rescan')),
  started_at integer not null,
  finished_at integer not null,
  fingerprint text,
  commit_sha text,
  result text not null check (result in ('stored', 'unchanged', 'failed')),
  profile_id integer,
  diff text,
  error text,
  primary key (office_id, scan_id)
) strict;

create table capability_confirmations (
  office_id text not null references offices (office_id),
  capability text not null,
  source text not null check (source in ('inferred', 'maintainer')),
  commands text not null,
  working_dir text not null,
  evidence text not null,
  fingerprint text not null,
  confirmed_at integer not null,
  primary key (office_id, capability)
) strict;

create table capability_proposals (
  office_id text not null references offices (office_id),
  capability text not null,
  commands text not null,
  working_dir text not null,
  confidence text not null check (confidence = 'low'),
  model_confidence text not null check (model_confidence in ('high', 'medium', 'low')),
  evidence text not null,
  fingerprint text not null,
  run_id text,
  proposed_at integer not null,
  primary key (office_id, capability)
) strict;

create table runs (
  office_id text not null references offices (office_id),
  run_id text not null,
  kind text not null check (kind in ('story', 'session')),
  key text,
  story_id text,
  tier text,
  role text not null,
  model text not null,
  start_sha text,
  branch text,
  budget_unit text not null,
  budget_limit integer not null,
  loop_cap integer not null,
  review_round_cap integer,
  config_hash text not null,
  override_keys text,
  run_profile_id text,
  started_at integer not null,
  ended_at integer,
  end_kind text,
  scope text,
  gate_changes text,
  parked_ms integer not null default 0,
  criteria_known text,
  criteria_checked text,
  criteria_reported text,
  max_turns integer,
  max_minutes integer,
  waiting text,
  waiting_since integer,
  web_searches integer not null default 0,
  web_fetches integer not null default 0,
  ci_cap integer,
  conflict_cap integer,
  review_max_turns integer,
  review_max_minutes integer,
  review_max_tokens integer,
  safe_chain text,
  check (
    (kind = 'story' and key is not null and story_id is not null and branch is not null
      and start_sha is not null)
    or (kind = 'session' and key is null and story_id is null and branch is null)
  ),
  primary key (office_id, run_id)
) strict;

create index runs_active on runs (office_id, kind) where ended_at is null;
create index runs_key on runs (office_id, key);

create table run_steps (
  office_id text not null,
  run_id text not null,
  step integer not null,
  kind text not null check (kind in ('phase', 'loop', 'review', 'review-failed', 'ci',
    'conflict', 'override', 'cap', 'ci-none')),
  value text not null,
  at integer not null,
  primary key (office_id, run_id, step),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;

create table run_signals (
  office_id text not null,
  run_id text not null,
  signal text not null,
  since integer not null,
  cleared_at integer,
  stuck_at integer,
  primary key (office_id, run_id, signal, since),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;

create index run_signals_active on run_signals (office_id, run_id) where cleared_at is null;

create table run_intents (
  office_id text not null,
  run_id text not null,
  intent_id integer not null,
  kind text not null check (kind in ('steer', 'answer', 'stop', 'new-session', 'cap', 'park')),
  detail text not null,
  state text not null check (state in ('pending', 'sent', 'failed', 'resolved')),
  created_at integer not null,
  sent_at integer,
  error text,
  resolved_at integer,
  outcome text,
  primary key (office_id, run_id, intent_id),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;

create table run_grants (
  office_id text not null,
  run_id text not null,
  grant_id text not null,
  kind text not null check (kind in ('budget', 'round')),
  amount text not null,
  note text,
  origin text not null,
  client text,
  at integer not null,
  primary key (office_id, run_id, grant_id),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;

create table run_outcomes (
  office_id text not null references offices (office_id),
  run_id text not null,
  story_id text,
  tier text,
  role text not null,
  model text not null,
  outcome text not null,
  park_reasons text not null,
  loops integer not null,
  review_rounds integer not null,
  verify_failures integer not null,
  budget_tokens integer not null,
  minutes real not null,
  criteria_count integer,
  scope_size integer,
  ended_at integer not null,
  final integer not null default 0 check (final in (0, 1)),
  review_rounds_failed integer not null default 0,
  ci_attempts integer not null default 0,
  conflict_handoffs integer not null default 0,
  override integer not null default 0 check (override in (0, 1)),
  web_searches integer not null default 0,
  web_fetches integer not null default 0,
  primary key (office_id, run_id)
) strict;

create table run_summaries (
  office_id text not null,
  run_id text not null,
  report text,
  diffstat text not null,
  verify text,
  output_tail text not null,
  built_at integer not null,
  primary key (office_id, run_id),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;

create table claims (
  office_id text not null references offices (office_id),
  run_id text not null,
  key text not null,
  story_id text not null,
  branch text not null,
  base text not null,
  base_sha text not null,
  start_sha text not null,
  claim_sha text,
  reused integer not null check (reused in (0, 1)),
  claimed_at integer not null,
  pushed_at integer,
  released_at integer,
  release_reason text,
  teardown_started_at integer,
  no_remote_at integer,
  primary key (office_id, run_id)
) strict;

create index claims_branch on claims (office_id, branch);
create unique index claims_live_branch on claims (office_id, branch) where released_at is null;
create unique index claims_live_key on claims (office_id, key) where released_at is null;

create table released_branches (
  office_id text not null references offices (office_id),
  branch text not null,
  released_at integer not null,
  key text not null,
  reason text not null,
  reclaimed_at integer,
  reclaimed_by text,
  primary key (office_id, branch, released_at)
) strict;

create index released_branches_open on released_branches (office_id, key, branch)
  where reclaimed_at is null;

create table done_elsewhere (
  office_id text not null references offices (office_id),
  run_id text not null,
  key text not null,
  story_id text not null,
  branch text not null,
  start_sha text not null default '',
  base text not null,
  base_commit text,
  flagged_at integer,
  released_at integer,
  settled_at integer,
  branch_kept integer not null default 0 check (branch_kept in (0, 1)),
  commits text not null default '[]',
  cleared_at integer,
  cleared_how text check (cleared_how in ('discard')),
  check ((cleared_at is null) = (cleared_how is null)),
  primary key (office_id, run_id)
) strict;

create index done_elsewhere_key on done_elsewhere (office_id, key);

create table catch_ups (
  office_id text not null,
  run_id text not null,
  catch_up_id integer not null check (catch_up_id > 0),
  kind text not null check (kind in ('merged', 'found')),
  base text not null,
  onto_sha text not null,
  tip_sha text not null,
  commit_sha text,
  conflicts text not null,
  at integer not null,
  box_copy text check (box_copy in ('pending', 'done')),
  primary key (office_id, run_id, catch_up_id),
  check ((kind = 'merged') = (commit_sha is not null)),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;

create table parks (
  office_id text not null references offices (office_id),
  park_id integer not null,
  key text not null,
  story_id text not null,
  run_id text,
  reason text not null,
  detail text not null,
  last_good_commit text,
  at integer not null,
  resolved_at integer,
  resolved_how text check (resolved_how in ('resume', 'amend', 'drop', 'discard', 'reconcile',
    'done-elsewhere', 'override')),
  resolved_note text,
  resume_on_lift integer not null default 0 check (resume_on_lift in (0, 1)),
  check ((resolved_at is null) = (resolved_how is null)),
  primary key (office_id, park_id)
) strict;

create index parks_key on parks (office_id, key);
create index parks_open on parks (office_id) where resolved_at is null;

create table questions (
  office_id text not null,
  question_id text not null,
  run_id text not null,
  agent_id text not null,
  kind text not null check (kind in ('question')),
  text text not null,
  asked_at integer not null,
  answer text,
  answered_at integer,
  delivered text check (delivered in ('on-resume')),
  closed_at integer,
  closed_how text check (closed_how in ('answered', 'timeout', 'ended', 'expired')),
  park_id integer,
  check ((closed_at is null) = (closed_how is null)),
  primary key (office_id, question_id),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;

create index questions_open on questions (office_id, run_id) where closed_at is null;

create table starts_paused (
  office_id text not null references offices (office_id),
  reason text not null check (reason in ('plan-limit', 'adapter')),
  detail text not null,
  since integer not null,
  until_at integer,
  adapter text,
  failures text,
  check ((reason = 'adapter') = (adapter is not null and failures is not null)),
  check (reason = 'plan-limit' or until_at is null),
  primary key (office_id, reason)
) strict;

create table gates (
  office_id text not null references offices (office_id),
  gate_id text not null,
  kind text not null,
  key text,
  run_id text,
  opened_at integer not null,
  waiting_on text check (waiting_on in ('maintainer', 'rule')),
  summary text not null,
  head_sha text,
  override_of text,
  hand_merge text check (hand_merge in ('release-path')),
  waits text,
  primary key (office_id, gate_id),
  foreign key (office_id, key) references stories (office_id, key)
) strict;

create index gates_by_key on gates (office_id, key, kind);

create table gate_decisions (
  office_id text not null,
  gate_id text not null,
  decision text not null check (decision in ('approved', 'rejected')),
  decided_by text not null check (decided_by in ('maintainer', 'rule')),
  note text,
  rule_results text not null,
  content_hash text,
  decided_at integer not null,
  primary key (office_id, gate_id),
  foreign key (office_id, gate_id) references gates (office_id, gate_id)
) strict;

create index gate_decisions_by_hash on gate_decisions (office_id, content_hash, decision);

create table review_verdicts (
  office_id text not null,
  gate_id text not null,
  run_id text not null,
  key text not null,
  round integer not null check (round > 0),
  agent_id text,
  model text not null,
  commit_sha text not null,
  code_tree_key text not null,
  verdict text not null check (verdict in ('approved', 'blocked')),
  criteria text not null,
  findings text not null,
  summary text not null,
  validation_notes text not null,
  comment_url text,
  carried_from text,
  override_note text,
  override_at integer,
  decided_at integer not null,
  primary key (office_id, gate_id),
  check ((override_note is null) = (override_at is null))
) strict;

create index review_verdicts_key on review_verdicts (office_id, key, decided_at);
create index review_verdicts_tree on review_verdicts (office_id, run_id, code_tree_key);

create table story_prs (
  office_id text not null,
  run_id text not null,
  key text not null,
  pr_number integer not null,
  url text not null,
  branch text not null,
  base text not null,
  head_sha text not null,
  state text not null check (state in ('open', 'merged', 'closed')),
  title text not null,
  body_hash text not null,
  opened_at integer not null,
  closed_at integer,
  replaces integer,
  primary key (office_id, run_id)
) strict;

create index story_prs_key on story_prs (office_id, key);

create table acceptance_tests (
  office_id text not null,
  test_id text not null,
  key text not null,
  run_id text not null,
  head_sha text not null,
  gate_id text,
  box text not null,
  steps text not null,
  url text,
  forward_port integer,
  target_address text,
  target_port integer,
  started_at integer not null,
  ready_at integer,
  result text check (result in ('pass', 'fail')),
  note text,
  recorded_at integer,
  ended_at integer,
  end_reason text,
  primary key (office_id, test_id),
  foreign key (office_id, key) references stories (office_id, key),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;

create index acceptance_tests_by_run on acceptance_tests (office_id, run_id, head_sha);
create unique index acceptance_tests_open on acceptance_tests (office_id, key)
  where ended_at is null;

create table feedback_items (
  office_id text not null,
  run_id text not null,
  item_id integer not null check (item_id > 0),
  source text not null check (source in ('verify', 'ci', 'review', 'conflict', 'reject', 'test')),
  signature text not null,
  head_sha text not null,
  round integer not null check (round > 0),
  repeat integer not null check (repeat in (0, 1)),
  intent_id integer not null,
  sent_at integer,
  text text not null check (length(text) <= 3000),
  created_at integer not null,
  primary key (office_id, run_id, item_id),
  unique (office_id, run_id, signature, head_sha),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;

create index feedback_items_intent on feedback_items (office_id, run_id, intent_id);

create table done_reports (
  office_id text not null,
  run_id text not null,
  report integer not null check (report >= 1),
  test_plan text not null,
  deviations text not null,
  at integer not null,
  primary key (office_id, run_id, report),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;

create table proposals (
  office_id text not null,
  hash text not null,
  story_key text not null,
  run_id text not null,
  kind text not null check (kind in ('follow-up', 'spike', 'tool')),
  title text not null,
  story_line text not null,
  why text not null,
  paths text not null,
  state text not null default 'open' check (state in ('open', 'accepted', 'dismissed')),
  created_at integer not null,
  updated_at integer not null,
  decided_by text,
  draft_id text,
  primary key (office_id, hash)
) strict;

create index proposals_state on proposals (office_id, state, created_at);

create table decision_notes (
  office_id text not null,
  hash text not null,
  story_key text not null,
  run_id text not null,
  file text not null,
  section text not null,
  text text not null,
  state text not null default 'open' check (state in ('open', 'accepted', 'dismissed')),
  created_at integer not null,
  updated_at integer not null,
  primary key (office_id, hash)
) strict;

create index decision_notes_state on decision_notes (office_id, state, created_at);

create table report_sendbacks (
  office_id text not null,
  run_id text not null,
  kind text not null check (kind in ('decision-note', 'verify-run')),
  signature text not null,
  at integer not null,
  primary key (office_id, run_id, kind, signature),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;

create table agents (
  office_id text not null references offices (office_id),
  agent_id text not null,
  run_id text not null,
  role text not null,
  model text not null,
  effort text,
  session_id text,
  adapter_version text,
  init_rejected text,
  started_at integer not null,
  ended_at integer,
  end_reason text,
  primary key (office_id, agent_id)
) strict;

create index agents_run on agents (office_id, run_id);

create table worker_hosts (
  office_id text not null references offices (office_id),
  run_id text not null,
  agent_id text not null,
  pid integer not null,
  start_time_ms integer not null,
  socket_path text not null,
  protocol_version integer not null,
  run_dir text not null,
  event_file text not null,
  processed_offset integer not null default 0,
  exit_code integer,
  exit_signal text,
  final_offset integer,
  ended_at integer,
  mode text not null default 'steer' check (mode in ('steer', 'follow')),
  started_at integer not null,
  exit_signal_inferred integer not null default 0 check (exit_signal_inferred in (0, 1)),
  pending integer not null default 0 check (pending in (0, 1)),
  signal_stop integer not null default 0 check (signal_stop in (0, 1)),
  primary key (office_id, run_id, agent_id)
) strict;

create table worker_notes (
  office_id text not null references offices (office_id),
  branch text not null,
  agent_id text not null,
  run_id text not null,
  story_key text,
  role text not null,
  text text not null check (length(text) <= 1500),
  recorded_at integer not null,
  primary key (office_id, branch, agent_id)
) strict;

create table ingest_cursors (
  office_id text not null,
  run_id text not null,
  agent_id text not null,
  source_kind text not null check (source_kind in ('host-events')),
  path text not null,
  device integer,
  inode integer,
  size integer not null default 0,
  read_offset integer not null default 0,
  last_line_hash text,
  last_line_bytes integer,
  parse_state text not null,
  first_line_t integer,
  last_line_t integer,
  output_emitted_to integer not null default 0,
  ended_at integer,
  changed_at integer,
  changed_detail text,
  updated_at integer not null,
  drift_lines integer not null default 0,
  primary key (office_id, run_id, agent_id, source_kind),
  foreign key (office_id, agent_id) references agents (office_id, agent_id)
) strict;

create table compactions (
  office_id text not null references offices (office_id),
  seq integer not null,
  run_id text not null,
  agent_id text not null,
  pre_tokens integer,
  at integer not null,
  primary key (office_id, seq),
  foreign key (office_id, agent_id) references agents (office_id, agent_id)
) strict;

create index compactions_agent on compactions (office_id, agent_id, seq);

create table prompt_parts (
  office_id text not null references offices (office_id),
  run_id text not null,
  agent_id text not null,
  part text not null,
  sha256 text not null,
  bytes integer not null,
  est_tokens integer not null,
  nudges integer not null default 0,
  recorded_at integer not null,
  primary key (office_id, run_id, agent_id, part)
) strict;

create table prompt_texts (
  office_id text not null,
  run_id text not null,
  agent_id text not null,
  part text not null check (part in ('system', 'message')),
  text text not null,
  recorded_at integer not null,
  primary key (office_id, run_id, agent_id, part)
) strict;

create index prompt_texts_recorded on prompt_texts (office_id, recorded_at);

create table output_chunks (
  office_id text not null references offices (office_id),
  run_id text not null,
  source text not null check (source in ('worker', 'verify', 'script')),
  from_offset integer not null,
  to_offset integer not null,
  agent_id text,
  text text not null,
  at integer not null,
  primary key (office_id, run_id, source, from_offset)
) strict;

create index output_chunks_at on output_chunks (office_id, at);

create table usage_messages (
  office_id text not null,
  agent_id text not null,
  message_id text not null,
  run_id text not null,
  model text not null,
  input integer not null,
  output integer not null,
  cache_create integer not null,
  cache_create_5m integer not null,
  cache_create_1h integer not null,
  cache_read integer not null,
  at integer not null,
  check (cache_create = cache_create_5m + cache_create_1h),
  primary key (office_id, agent_id, message_id),
  foreign key (office_id, agent_id) references agents (office_id, agent_id)
) strict;

create index usage_messages_at on usage_messages (office_id, at);

create table usage_totals (
  office_id text not null,
  run_id text not null,
  agent_id text not null,
  model text not null,
  role text not null,
  tier text not null,
  input integer not null default 0,
  output integer not null default 0,
  cache_create integer not null default 0,
  cache_create_5m integer not null default 0,
  cache_create_1h integer not null default 0,
  cache_read integer not null default 0,
  turns integer not null default 0,
  elapsed_ms integer not null default 0,
  budget_unit text not null default 'tokens',
  budget_used integer not null default 0,
  budget_limit integer not null default 0,
  final integer not null default 0 check (final in (0, 1)),
  updated_at integer not null,
  cost_micros integer,
  live_turns integer not null default 0 check (live_turns >= 0),
  live_output integer not null default 0 check (live_output >= 0),
  check (cache_create = cache_create_5m + cache_create_1h),
  primary key (office_id, run_id, agent_id, model),
  foreign key (office_id, agent_id) references agents (office_id, agent_id)
) strict;

create table usage_daily (
  office_id text not null references offices (office_id),
  day text not null,
  role text not null,
  tier text not null,
  model text not null,
  input integer not null default 0,
  output integer not null default 0,
  cache_create integer not null default 0,
  cache_create_5m integer not null default 0,
  cache_create_1h integer not null default 0,
  cache_read integer not null default 0,
  turns integer not null default 0,
  runs integer not null default 0,
  cost_micros integer,
  budget_used integer not null default 0,
  budget_limit_sum integer not null default 0,
  check (cache_create = cache_create_5m + cache_create_1h),
  primary key (office_id, day, role, tier, model)
) strict;
`,
};
