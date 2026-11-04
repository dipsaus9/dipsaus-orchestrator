---
id: DIPO-444
title: >-
  Say refused in daemon status, remove code for older dipo versions, explain the
  Claude minimum
status: Refined
assignee: []
created_date: '2026-11-04 12:24'
labels:
  - 'tier:S'
milestone: m-2
dependencies: []
references:
  - packages/cli/src/daemon-commands.ts
  - packages/client/src/recovery.ts
  - packages/engine/src/records/worker-hosts.ts
  - packages/engine/test/host/pending-hosts.test.ts
  - packages/engine/test/run/conflicts.test.ts
  - packages/engine/test/backup/backup.test.ts
  - packages/client/test/unit/client.test.ts
  - packages/engine/test/create/surface.test.ts
  - packages/engine/src/workers/claude-cli/probe.ts
  - packages/engine/test/workers/probe.test.ts
priority: medium
type: chore
ordinal: 417000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the daemon status to say plainly when the daemon refused its database, code kept only for older dipo versions removed, and the minimum Claude version explained, so that what dipo tells me and keeps is true.

Three items the maintainer took from the not-now list into M2, planning interview 2026-11-04. Does not block M2.

- Status: a daemon that refused a database from before the migration squash (DatabaseBeforeSquashError) shows as "recovering" in dipo daemon status. It should say it refused the database and name the fix. The status text is built in packages/cli/src/daemon-commands.ts and packages/client/src/recovery.ts.
- Old code: the "older dipo" signalStop branch in packages/engine/src/records/worker-hosts.ts and its test in packages/engine/test/host/pending-hosts.test.ts, and tests that set up state no current dipo writes: packages/engine/test/run/conflicts.test.ts (around line 25), packages/engine/test/backup/backup.test.ts (around 47), packages/client/test/unit/client.test.ts (around 370) and packages/engine/test/create/surface.test.ts (around 490). The squashed database (0007) refuses older state, so these paths cannot run.
- Claude minimum: MIN_CLAUDE_VERSION in packages/engine/src/workers/claude-cli/probe.ts is 2.1.285, set for sandbox locks that are gone. Keep the value and write in one comment what needs it, or lower it to the lowest version whose features dipo uses and name that feature; a version is lowered only when the code shows nothing newer is needed.

```dipo
branch: "DIPO-444/status-refused-old-code-claude-min"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a daemon-status test: a daemon that refused its database shows refused with the reason, not recovering"
    - kind: "automated"
      check: "(unit) worker-hosts and pending-hosts tests pass without the older dipo branch"
    - kind: "automated"
      check: "(unit) probe.test.ts: a version below the minimum is refused and the minimum itself passes"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 dipo daemon status shows a daemon that refused its database as refused, with the reason and what to do, never as recovering
- [ ] #2 The older dipo signalStop branch and the tests that only set up state older than the squashed database are removed
- [ ] #3 MIN_CLAUDE_VERSION has one comment naming what needs it, and it is lowered only when the code shows no newer feature is used
<!-- AC:END -->
