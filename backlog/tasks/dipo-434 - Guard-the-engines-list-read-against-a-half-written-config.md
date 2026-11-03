---
id: DIPO-434
title: >-
  Keep the Backlog CLI's config rewrite from hiding stories from a concurrent
  read
status: Ready
assignee: []
created_date: '2026-10-31 08:13'
updated_date: '2026-11-03 07:14'
labels:
  - 'tier:S'
milestone: m-2
dependencies: []
references:
  - packages/engine/src/backlog/runner.ts
  - packages/engine/src/backlog/list.ts
  - packages/engine/src/backlog/pr/diff.ts
  - packages/engine/test/backlog/runner.test.ts
  - packages/engine/test/backlog/list.test.ts
  - scripts/check-backlog-pr.test.ts
priority: medium
type: bug
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: in an office whose committed backlog/config.yml lacks the Backlog CLI's defaults (an office adopted from before dipo; this repository's config has them), no daemon read sees an empty or partial backlog because another CLI call was rewriting config.yml at that moment.

Filed from DRAFT-3 (proposed by the worker of DIPO-377). DIPO-377 found that the Backlog CLI rewrites backlog/config.yml on its first read when the file lacks its defaults (max_column_width, auto_open_browser, default_port, bypass_git_hooks, active_branch_days). Every CLI command does it: `task list`, `task view`, `draft list` and `milestone list` all rewrite such a file, and a later read leaves it alone. A call that reads the file while another writes it can see no tasks. In `listAll` (packages/engine/src/backlog/list.ts) the list and its `--count` run at once, and when both see none they agree, so the count check of DIPO-323 lets the empty list through. The daemon's PR diff (`sideAt` in packages/engine/src/backlog/pr/diff.ts, about lines 145-157) runs `git checkout --force`, which puts the unnormalized config back on every side, and then views stories four at a time (`VIEW_CONCURRENCY`, packages/engine/src/stories/read.ts about line 69); lane edits and other reads on the same `_backlog` checkout can be the rewriter too. DIPO-377 fixed only its test: `pr()` in scripts/check-backlog-pr.test.ts (about lines 86-89) runs one Backlog read before the base commit. `dipo office init` rewrites only the `statuses:` line (packages/engine/src/backlog/init/ops.ts), so an adopted office keeps a config without the defaults.

Design: the gate sits in `runBacklog` (packages/engine/src/backlog/runner.ts), where every CLI call passes. Per checkout (keyed on its resolved root, realpath), the runner remembers the content of backlog/config.yml as it was after the last call ended. A call that finds the file different from that, or finds none remembered, runs alone: it waits for the calls already running on that checkout, and later calls wait for it; after it ends, the runner remembers the file's new content. While the file stays as remembered, calls run at the same time as today. So the CLI's rewrite always happens in a call that runs alone, also after `sideAt` checks out an old config, without the engine knowing which defaults the CLI adds. The gate is released when a call fails or times out. `listAll` keeps its two reads at once and its count check with one retry; its header and docstring say why that is now safe. The warm-up read in scripts/check-backlog-pr.test.ts goes, since the runner now covers it (0001: the fix removes the mechanism it replaces). Two processes on one checkout at once are out of scope. 0001.

```dipo
branch: "DIPO-434/serial-list-reads"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) Backlog CLI calls at once on a checkout whose config.yml the CLI is about to rewrite each see the whole backlog, calls run at the same time again once the config is settled, and the test fixture's warm-up read is gone"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Several CLI calls at once (`listAll` and views) on a checkout whose config.yml a stand-in CLI rewrites on its first read, holding the half-written file on a timer, each see the whole backlog, shown by a test that fails against today's runner
- [ ] #2 Once config.yml is as the runner remembers it, calls on that checkout run at the same time, calls on different checkouts always do, a failed or timed-out call releases the gate, and a config changed by a checkout makes the next call run alone again, shown by tests
- [ ] #3 The warm-up read in scripts/check-backlog-pr.test.ts is gone, and that test file passes 30 runs in a row on Linux
<!-- AC:END -->
