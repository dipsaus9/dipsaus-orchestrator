---
id: DIPO-434
title: Keep the Backlog CLI's config rewrite from emptying a list read
status: Refined
assignee: []
created_date: '2026-10-31 08:13'
updated_date: '2026-11-02 20:35'
labels:
  - 'tier:S'
milestone: m-2
dependencies: []
references:
  - packages/engine/src/backlog/list.ts
  - packages/engine/src/backlog/runner.ts
  - packages/engine/test/backlog/list.test.ts
  - scripts/check-backlog-pr.test.ts
priority: medium
type: bug
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a list read never returns an empty or partial backlog because the Backlog CLI was rewriting backlog/config.yml at that moment, in the daemon or in the Ready gate.

Filed from DRAFT-3 (proposed by the worker of DIPO-377). DIPO-377 found that the Backlog CLI rewrites backlog/config.yml on its first read when the file lacks its defaults (max_column_width, auto_open_browser, default_port, bypass_git_hooks, active_branch_days). `listAll` (packages/engine/src/backlog/list.ts) runs `<kind> list --plain` and its `--count` at once, so one of them can read the file half-written and see no tasks; when both see none they agree, and the count check of DIPO-323 lets the empty list through. DIPO-377 fixed only its test: `pr()` in scripts/check-backlog-pr.test.ts runs one Backlog read before the base commit. The race stays in the engine, so the Ready gate in CI and the daemon's reads can each see an empty backlog once.

Design: `listAll` reads one checkout one CLI call at a time: the list, then its count, and two `listAll` calls on the same checkout in one process never overlap (a per-checkout queue in list.ts). The first call does the CLI's rewrite alone and every later call reads a whole file. Calls on different checkouts still run at the same time. The warm-up read in scripts/check-backlog-pr.test.ts goes, since the engine now covers it (0001: the fix removes the mechanism it replaces). The count check and its one retry stay as they are. Two processes reading the same checkout at once is out of scope. 0001.

```dipo
branch: "DIPO-434/serial-list-reads"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) listAll calls on one checkout whose config.yml lacks the CLI defaults all return the full list, calls on different checkouts still overlap, and the test fixture's warm-up read is gone"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Several `listAll` calls at once on one checkout, with a stand-in CLI that shows no tasks while another call rewrites the config, each return the full list, shown by a test that fails against today's parallel reads
- [ ] #2 `listAll` calls on different checkouts still run at the same time, and the count check still retries once and then fails on a mismatch, shown by tests
- [ ] #3 The warm-up read in scripts/check-backlog-pr.test.ts is gone, and that test file passes 30 runs in a row on Linux
<!-- AC:END -->
